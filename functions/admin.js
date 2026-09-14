/*
 * The admin portal's API.
 *
 * The first question it answers is still "may the person holding this token be
 * here", and that question remains the whole security boundary — every route
 * below /config is behind it, and a route added without going through
 * authorize() is a hole rather than a feature.
 *
 * Behind the gate, Layouts: the grids of a physical space that campaigns allot
 * to donors. The list, one write to create a layout and one to switch a layout
 * off. What a layout *is* lives in layout.js, which is pure — this file is
 * routing, status codes and the database, and nothing in it decides whether a
 * grid is acceptable.
 *
 * The authorisation and the database are both injected rather than reached for:
 * verifying a token needs firebase-admin, reading the allowlist needs a secret
 * binding, and neither belongs in a module whose behaviour should be checkable
 * without a Firebase project. See admin.test.cjs.
 */

const {
  LIST_LIMIT,
  adminLayout,
  validateLayout,
  validateLayoutPatch,
} = require("./layout");

/**
 * Splits the allowlist secret into the emails it names.
 *
 * Accepts a JSON array or a separated list, because this is a value a human
 * pastes into `firebase functions:secrets:set` at some remove from any code
 * that would tell them which form was expected. Both forms cost one branch.
 *
 * @param {string} raw - The secret's value, or nothing.
 * @returns {Set<string>} The emails, lowercased.
 */
function parseAllowlist(raw) {
  if (!raw) {
    return new Set();
  }

  let entries;
  const text = String(raw).trim();
  if (text.startsWith("[")) {
    try {
      entries = JSON.parse(text);
    } catch (error) {
      entries = [];
    }
  } else {
    entries = text.split(/[\s,;]+/);
  }

  return new Set(
    (Array.isArray(entries) ? entries : [])
      .map((entry) => String(entry).trim().toLowerCase())
      .filter(Boolean)
  );
}

/**
 * Builds the request handler.
 *
 * @param {Object} deps - {authorize, authMode, getDb, getTimestamp}.
 * @returns {Function} An Express-style handler.
 */
function createAdminApi(deps) {
  const { authorize, getDb, getTimestamp } = deps;

  /**
   * The layouts, newest first.
   *
   * Newest rather than alphabetical so that the layout somebody has just
   * created is the first card they see when the form closes and puts them back
   * on the list — the alternative is a form that appears to have done nothing
   * until you go looking in the Ms.
   *
   * Inactive ones are listed too. This is the console where a layout is
   * switched back on, so hiding the switched-off ones would hide the only
   * control that undoes it.
   *
   * @returns {Promise<Array>} Every layout, as the portal reads them.
   */
  async function listLayouts() {
    const snapshot = await getDb()
      .collection("layouts")
      .limit(LIST_LIMIT)
      .get();

    return snapshot.docs
      .map((doc) => adminLayout(doc.id, doc.data()))
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  }

  /**
   * Stores one layout.
   *
   * @param {Object} req - The HTTP request.
   * @param {Object} res - The HTTP response.
   * @returns {Promise<void>} When answered.
   */
  async function createLayout(req, res) {
    const checked = validateLayout(req.body);
    if (!checked.ok) {
      res.status(400).json({ error: "invalid", fields: checked.errors });
      return;
    }

    const Timestamp = getTimestamp();
    const record = {
      ...checked.value,
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    };
    const written = await getDb().collection("layouts").add(record);

    // The stored record is echoed back rather than the submitted one, and it
    // comes back through adminLayout() — so the card the portal draws next is
    // built from the same shape the list route would have given it, counts
    // and all, and a field this file quietly dropped cannot look saved.
    res.status(201).json({ layout: adminLayout(written.id, record) });
  }

  /**
   * Switches one layout on or off.
   *
   * @param {string} id - The layout's document id.
   * @param {Object} req - The HTTP request.
   * @param {Object} res - The HTTP response.
   * @returns {Promise<void>} When answered.
   */
  async function patchLayout(id, req, res) {
    const checked = validateLayoutPatch(req.body);
    if (!checked.ok) {
      res.status(400).json({ error: "invalid", fields: checked.errors });
      return;
    }

    const ref = getDb().collection("layouts").doc(id);
    const found = await ref.get();
    if (!found.exists) {
      res.status(404).json({ error: "no-layout" });
      return;
    }

    const update = { ...checked.value, updatedAt: getTimestamp().now() };
    await ref.update(update);
    res.status(200).json({ layout: adminLayout(id, { ...found.data(), ...update }) });
  }

  return async function handle(req, res) {
    // Never cached, and never by anything in between: every response here is
    // about one signed-in person, with Hosting in front of it.
    res.set("Cache-Control", "no-store");

    const path = (req.path || "").replace(/^\/api\/admin/, "") || "/";

    // Answered before the allowlist check, because it is what the page reads to
    // find out how to sign in — a browser that cannot get past this has no way
    // to obtain the token every other route wants. It says nothing about who is
    // allowed near the portal, only that a sign-in is required.
    if (path === "/config") {
      res.status(200).json({ auth: deps.authMode || "firebase" });
      return;
    }

    let identity;
    try {
      identity = await authorize(req);
    } catch (error) {
      console.error("Admin authorisation failed", { error: error.message });
      res.status(401).json({ error: "unauthorised" });
      return;
    }

    if (!identity.ok) {
      // The two failures are answered differently on purpose. The person on the
      // other end of a 403 is a colleague who has just signed in with the wrong
      // Google account, and a flat "unauthorised" would send them looking for a
      // bug instead of at the allowlist. The email handed back is their own; it
      // is not a disclosure.
      const status = identity.reason === "not-allowed" ? 403 : 401;
      console.warn("Admin request rejected", {
        reason: identity.reason,
        email: identity.email || null,
      });
      res.status(status).json({
        error: identity.reason,
        email: identity.email || null,
      });
      return;
    }

    // Carries no data — the 200 itself is the answer, and the email is what
    // the sidebar draws.
    if (req.method === "GET" && path === "/session") {
      res.status(200).json({ viewer: identity.email });
      return;
    }

    try {
      if (req.method === "GET" && path === "/layouts") {
        res.status(200).json({ layouts: await listLayouts() });
        return;
      }

      if (req.method === "POST" && path === "/layouts") {
        await createLayout(req, res);
        return;
      }

      const one = /^\/layouts\/([A-Za-z0-9_-]{1,120})$/.exec(path);
      if (req.method === "PATCH" && one) {
        await patchLayout(one[1], req, res);
        return;
      }
    } catch (error) {
      // Logged, not sent. Everyone reaching this line is on the allowlist, so
      // a Firestore message here would not be a disclosure to a stranger — but
      // it would be an error string in a card where a layout should be, which
      // helps nobody who is not reading the logs anyway.
      console.error("Admin API failed", {
        path,
        method: req.method,
        error: error.message,
      });
      res.status(500).json({ error: "unavailable" });
      return;
    }

    // A path that no route above claimed. Told apart from a method that no
    // route accepts, because the two are different mistakes: the first is a
    // stale portal asking for something that was never here, the second is
    // this file and the page disagreeing about a verb.
    const known = path === "/session" || /^\/layouts(\/|$)/.test(path);
    res.status(known ? 405 : 404).json({
      error: known ? "method-not-allowed" : "not-found",
    });
  };
}

module.exports = {
  createAdminApi,
  parseAllowlist,
};
