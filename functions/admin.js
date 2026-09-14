/*
 * The admin portal's API.
 *
 * One module, deliberately thin. Today the portal has a sign-in gate and one
 * empty module behind it, so the only question this answers is "may the person
 * holding this token be here" — but that question is the whole security
 * boundary, and it is worth having in a file of its own from the start rather
 * than inlined into index.js and untangled later.
 *
 * The authorisation itself is injected rather than done here: verifying a token
 * needs firebase-admin and reading the allowlist needs a secret binding, and
 * neither belongs in a module whose behaviour should be checkable without a
 * Firebase project. See admin.test.cjs.
 */

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
 * @param {Object} deps - {authorize, authMode}.
 * @returns {Function} An Express-style handler.
 */
function createAdminApi(deps) {
  const { authorize } = deps;

  return async function handle(req, res) {
    // Never cached, and never by anything in between: every response here is
    // about one signed-in person, with Hosting in front of it.
    res.set("Cache-Control", "no-store");

    if (req.method !== "GET") {
      res.status(405).json({ error: "method-not-allowed" });
      return;
    }

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

    // The portal's only authenticated route today. It carries no data — the
    // 200 itself is the answer, and the email is what the sidebar draws.
    if (path === "/session") {
      res.status(200).json({ viewer: identity.email });
      return;
    }

    res.status(404).json({ error: "not-found" });
  };
}

module.exports = {
  createAdminApi,
  parseAllowlist,
};
