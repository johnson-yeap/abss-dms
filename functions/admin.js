/*
 * The admin portal's API.
 *
 * The first question it answers is still "may the person holding this token be
 * here", and that question remains the whole security boundary — every route
 * below /config is behind it, and a route added without going through
 * authorize() is a hole rather than a feature.
 *
 * Behind the gate, two modules. Layouts: the grids of a physical space that
 * campaigns allot to donors — the list, one write to create a layout and one
 * to switch a layout off. Donations: one read, and nothing else. What a
 * layout and a donation *are* lives in layout.js and donation.js, both pure —
 * this file is routing, status codes and the database, and nothing in it
 * decides whether a grid or a donation is acceptable.
 *
 * The donations route is a read and only a read. Every status here is set by
 * hand elsewhere for now, and there is deliberately no route in this file
 * that moves one: see the note in publicapi.js about what does not watch a
 * bank account, which is the same reason.
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

const { adminDonation } = require("./donation");

// The ceiling on the donations list, and the one number in this file that is
// a design decision rather than a guard.
//
// The portal loads every donation once and searches them in the browser —
// see the head of admin/donations.mjs for why that is the right shape for
// this office. This is where that choice stops being free. Past it, the
// answer is not a bigger number: it is paging, a query per filter change,
// and prefix-only name search, which is a different module.
//
// The list route says how many it held back, so the portal can tell an admin
// that what they are searching is not everything — the one failure mode of
// searching in the browser that must never be silent.
const DONATIONS_CAP = 5000;

// How many campaigns are loaded to put names on donations. The temple runs a
// handful; this is a guard, not a paging scheme.
const CAMPAIGNS_LIMIT = 200;

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
   * Every donation the portal will search, with its campaign's name attached.
   *
   * The campaigns are read once and used as a lookup rather than fetched per
   * donation: a thousand donations across four campaigns is four reads this
   * way and a thousand the other, and Firestore bills the difference.
   *
   * Ordered here rather than by the query, and the reason is worth stating.
   * orderBy("createdAt") would refuse every document that has no createdAt —
   * Firestore omits documents missing the ordered field — and those are
   * exactly the malformed records an admin needs to be able to find. So the
   * cap is applied by the query and the ordering in memory, which means the
   * cap cuts an arbitrary five thousand rather than the newest five thousand.
   * That is the honest trade at this size, and `held` is what tells the
   * portal to say so.
   *
   * @returns {Promise<Object>} {donations, held}.
   */
  async function listDonations() {
    const db = getDb();

    const [donations, campaigns] = await Promise.all([
      db.collection("donations").limit(DONATIONS_CAP + 1).get(),
      db.collection("campaigns").limit(CAMPAIGNS_LIMIT).get(),
    ]);

    const byId = new Map();
    const bySlug = new Map();
    for (const doc of campaigns.docs) {
      byId.set(doc.id, doc.data());
      const slug = doc.data().slug;
      if (slug) {
        bySlug.set(slug, doc.data());
      }
    }

    // One more than the cap was asked for, purely so this can be known.
    const held = Math.max(0, donations.docs.length - DONATIONS_CAP);
    const rows = donations.docs.slice(0, DONATIONS_CAP);

    return {
      donations: rows
        .map((doc) => {
          const data = doc.data();
          // By id first, by slug second. A donation stores both, and the slug
          // is the one that still resolves if a campaign was recreated.
          const campaign = byId.get(data.campaignId) ||
            bySlug.get(data.campaignSlug) || null;
          return adminDonation(doc.id, data, campaign);
        })
        .sort((a, b) =>
          String(b.createdAt || "").localeCompare(String(a.createdAt || ""))),
      held,
    };
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

      // One route, no query parameters, and the whole list. The narrowing is
      // the browser's — see the head of admin/donations.mjs. `held` is the
      // part of this answer that must not be dropped: it is how the portal
      // knows to say that the search is not over everything.
      if (req.method === "GET" && path === "/donations") {
        const { donations, held } = await listDonations();
        res.status(200).json({ donations, held, cap: DONATIONS_CAP });
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
    const known = path === "/session" ||
      /^\/layouts(\/|$)/.test(path) ||
      /^\/donations(\/|$)/.test(path);
    res.status(known ? 405 : 404).json({
      error: known ? "method-not-allowed" : "not-found",
    });
  };
}

module.exports = {
  DONATIONS_CAP,
  createAdminApi,
  parseAllowlist,
};
