/*
 * ABSS DMS — Cloud Functions.
 *
 * One function today: the admin portal's API, which exists to answer whether
 * the caller may open the portal at all.
 */

const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

const { createAdminApi, parseAllowlist } = require("./admin");

admin.initializeApp();

// Closest region to the people using this. Note it must match the `region` in
// firebase.json's rewrite — Hosting routes to a named region, and a mismatch
// is a 404 at the rewrite rather than an error at deploy.
const REGION = "asia-southeast1";

// Who may open the admin portal, as a list of Google account emails. A secret
// rather than a constant here or a document in Firestore, for two different
// reasons: in the repository it would be a published list of the people worth
// phishing, and in Firestore it would be a list that the console reading it can
// also reach — an authorisation rule stored inside the thing it authorises.
//
// The format is a JSON array or a separated list; parseAllowlist() takes both,
// because this is a value pasted into `firebase functions:secrets:set` at some
// remove from anything that would say which was expected.
//
//   firebase functions:secrets:set ADMIN_EMAILS
//
let cachedAdminEmails = null;
const ADMIN_EMAILS = defineSecret("ADMIN_EMAILS");

/**
 * Decides whether one request may be here.
 *
 * Two checks, not one, and they answer different questions: verifyIdToken()
 * says the caller is who the token claims, and only the allowlist says that
 * person may be here — anybody with a Google account can obtain a valid token
 * for this project.
 *
 * The email must be verified as well, because the allowlist is keyed on one and
 * a provider that handed over an unverified address would let an attacker pick
 * the address it is compared against.
 *
 * @param {Object} req - The HTTP request.
 * @returns {Promise<Object>} {ok, email, reason}.
 */
async function authorizeAdmin(req) {
  const header = req.get("authorization") || "";
  const bearer = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!bearer) {
    return { ok: false, reason: "no-token" };
  }

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(bearer[1]);
  } catch (error) {
    logger.warn("Admin token rejected", { error: error.message });
    return { ok: false, reason: "bad-token" };
  }

  const email = (decoded.email || "").toLowerCase();
  if (!email || decoded.email_verified !== true) {
    return { ok: false, reason: "unverified-email" };
  }

  // Read once per instance. The secret is immutable for the life of a
  // deployment, so re-parsing it per request would buy nothing.
  if (!cachedAdminEmails) {
    cachedAdminEmails = parseAllowlist(ADMIN_EMAILS.value());
  }
  if (!cachedAdminEmails.has(email)) {
    return { ok: false, reason: "not-allowed", email };
  }

  return { ok: true, email };
}

const adminApiHandler = createAdminApi({ authorize: authorizeAdmin });

/**
 * The admin portal's API.
 *
 * Reached same-origin through the abss-dms-admin site's rewrite, which is what
 * lets the page's Content-Security-Policy keep connect-src at 'self'. It is
 * reachable at its own cloudfunctions.net address too, and that is not a hole:
 * every request carries its own credential and is checked here rather than by
 * where it arrived from.
 *
 * @param {Object} req - The HTTP request object.
 * @param {Object} res - The HTTP response object.
 */
exports.adminApi = onRequest(
  { region: REGION, secrets: [ADMIN_EMAILS] },
  adminApiHandler
);
