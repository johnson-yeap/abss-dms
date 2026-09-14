/*
 * The donor-facing API: three routes, one of them a write.
 *
 * One function rather than two, which is the opposite of how the admin side is
 * split. The reason is that the write is not independent of the reads: posting
 * a donation has to load the campaign it names, both to check the amount came
 * from that campaign's own dropdown and to take its reference prefix. Split
 * across two functions that lookup exists twice, and the second copy is the
 * one that drifts.
 *
 * Everything here is reachable by anyone, unauthenticated, because that is
 * what a donation form is. Two consequences run through the file:
 *
 *   Nothing trusts the body. donation.js decides what is acceptable, and the
 *   only fields that reach Firestore are the ones it returns.
 *
 *   Nothing echoes the body back. An error says which field was refused and
 *   why, as codes, and never repeats what was sent — a reflected value is how
 *   an endpoint like this becomes someone else's payload delivery.
 */

const {
  isOpen,
  makeReference,
  publicCampaign,
  validateDonation,
} = require("./donation");

// How many campaigns the list route will return. The temple runs a handful at
// a time; this is a guard against a runaway query, not a paging scheme.
const LIST_LIMIT = 50;

// A crude per-instance throttle, keyed on the caller's address: how many
// donations one address may post inside the window.
//
// Honest about what it is. Cloud Run runs many instances and this map is not
// shared between them, so a determined flood gets through in proportion to how
// many instances it spins up. It stops the accident and the idle script; it is
// not a defence, and the note in docs says what a real one looks like.
const POST_WINDOW_MS = 60 * 1000;
const POST_PER_WINDOW = 5;

/**
 * @param {Object} req - The HTTP request.
 * @returns {string} The caller's address, as far as it can be known.
 */
function callerAddress(req) {
  const forwarded = req.get("x-forwarded-for") || "";
  return forwarded.split(",")[0].trim() || req.ip || "unknown";
}

/**
 * Builds the request handler.
 *
 * @param {Object} deps - {getDb, getTimestamp, now, random}.
 * @returns {Function} An Express-style handler.
 */
function createPublicApi(deps) {
  const {
    getDb,
    getTimestamp,
    now = () => Date.now(),
    random = Math.random,
  } = deps;

  const recentPosts = new Map();

  /**
   * @param {string} address - Who is posting.
   * @returns {boolean} Whether they have posted too often.
   */
  function tooMany(address) {
    const at = now();
    const seen = (recentPosts.get(address) || []).filter((t) => at - t < POST_WINDOW_MS);
    seen.push(at);
    recentPosts.set(address, seen);

    // Bounded, so a long-lived instance being probed from many addresses does
    // not grow this map until it is the problem.
    if (recentPosts.size > 5000) {
      recentPosts.clear();
    }
    return seen.length > POST_PER_WINDOW;
  }

  /**
   * @param {string} slug - The campaign's slug, or its document id.
   * @returns {Promise<Object|null>} {id, doc} or null.
   */
  async function findCampaign(slug) {
    const db = getDb();

    const bySlug = await db
      .collection("campaigns")
      .where("slug", "==", slug)
      .limit(1)
      .get();
    if (!bySlug.empty) {
      return { id: bySlug.docs[0].id, doc: bySlug.docs[0].data() };
    }

    // A campaign linked by document id still resolves. The slug is the URL the
    // temple hands out, but an id is what an admin screen will copy.
    const byId = await db.collection("campaigns").doc(slug).get();
    return byId.exists ? { id: byId.id, doc: byId.data() } : null;
  }

  /**
   * @returns {Promise<Array>} The campaigns open right now, soonest event first.
   */
  async function listCampaigns() {
    const db = getDb();
    const snapshot = await db
      .collection("campaigns")
      .where("active", "==", true)
      .limit(LIST_LIMIT)
      .get();

    const at = now();
    // The date window is applied here rather than in the query because two
    // range filters on different fields is not something Firestore will do,
    // and `active` has already cut this to a handful of documents.
    return snapshot.docs
      .filter((d) => isOpen(d.data(), at))
      .map((d) => publicCampaign(d.id, d.data()))
      .sort((a, b) => String(a.eventStart || a.campaignStart || "")
        .localeCompare(String(b.eventStart || b.campaignStart || "")));
  }

  /**
   * Stores one donation and answers with its reference.
   *
   * @param {Object} req - The HTTP request.
   * @param {Object} res - The HTTP response.
   * @returns {Promise<void>} When answered.
   */
  async function donate(req, res) {
    if (tooMany(callerAddress(req))) {
      res.status(429).json({ error: "too-many" });
      return;
    }

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const found = await findCampaign(String(body.campaign || ""));
    if (!found) {
      res.status(404).json({ error: "no-campaign" });
      return;
    }

    // Checked again here, not only when the form was drawn. A campaign can
    // close between a page being opened and its form being submitted, and the
    // browser holding a stale page has no way to know.
    if (!isOpen(found.doc, now())) {
      res.status(409).json({ error: "campaign-closed" });
      return;
    }

    const checked = validateDonation(body, publicCampaign(found.id, found.doc));
    if (!checked.ok) {
      res.status(400).json({ error: "invalid", fields: checked.errors });
      return;
    }

    const reference = makeReference(
      found.doc.referencePrefix || found.doc.slug || "",
      random
    );
    const Timestamp = getTimestamp();

    await getDb().collection("donations").add({
      ...checked.value,
      campaignId: found.id,
      campaignSlug: found.doc.slug || found.id,
      reference,
      // What the temple has been told, not what has been received. Nothing in
      // this system watches a bank account, so no code here may ever move a
      // record past this on its own.
      status: "pending",
      createdAt: Timestamp.now(),
    });

    res.status(201).json({
      reference,
      amount: checked.value.amount,
      payBy: checked.value.payBy,
    });
  }

  return async function handle(req, res) {
    // Personal data in the request and a per-donation reference in the
    // response; nothing in between may keep any of it.
    res.set("Cache-Control", "no-store");

    const path = (req.path || "").replace(/^\/api/, "") || "/";

    try {
      if (req.method === "GET" && path === "/campaigns") {
        res.status(200).json({ campaigns: await listCampaigns() });
        return;
      }

      const one = /^\/campaigns\/([A-Za-z0-9_-]{1,120})$/.exec(path);
      if (req.method === "GET" && one) {
        const found = await findCampaign(one[1]);
        if (!found || !isOpen(found.doc, now())) {
          // One answer for "no such campaign" and "that campaign has closed"
          // would be simpler and would leave a donor staring at a page that
          // does not say which happened. They are told apart.
          res.status(found ? 410 : 404).json({
            error: found ? "campaign-closed" : "no-campaign",
          });
          return;
        }
        res.status(200).json({ campaign: publicCampaign(found.id, found.doc) });
        return;
      }

      if (req.method === "POST" && path === "/donate") {
        await donate(req, res);
        return;
      }

      res.status(404).json({ error: "not-found" });
    } catch (error) {
      // The message is logged and not sent. A stack trace or a Firestore error
      // string on a public endpoint tells a stranger about the inside of this.
      console.error("Public API failed", { path, method: req.method, error: error.message });
      res.status(500).json({ error: "unavailable" });
    }
  };
}

module.exports = { createPublicApi, LIST_LIMIT, POST_PER_WINDOW, POST_WINDOW_MS };
