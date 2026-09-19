/**
 * Exercises admin.js.
 *
 * Run with `node admin.test.cjs` from functions/.
 *
 * The gate first: which status a refused caller gets, that /config answers
 * before any of it, and that the allowlist parser takes both of the shapes a
 * human might paste into `firebase functions:secrets:set`. The token
 * verification itself is firebase-admin's and is injected, so the handler can
 * be driven with a fake authorize() and no project.
 *
 * Then the layouts routes, which are checked here for what this file decides —
 * the verbs, the statuses, the order the list comes back in, and that every
 * one of them is behind the gate. Whether a grid is acceptable is layout.js's
 * question and is checked in layout.test.cjs.
 */

const assert = require("assert");
const { DONATIONS_CAP, createAdminApi, parseAllowlist } = require("./admin");

let failures = 0;

/**
 * @param {string} name - What is being checked.
 * @param {Function} body - The check, sync or async.
 * @returns {Promise<void>} When it has run.
 */
async function test(name, body) {
  try {
    await body();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL ${name}\n       ${error.message}`);
  }
}

/**
 * @param {string} name - A group of checks.
 */
function suite(name) {
  console.log(`\n${name}`);
}

/**
 * Something shaped enough like an Express response to record what was sent.
 *
 * @returns {Object} The recorder, with .code, .body and .headers on it.
 */
function recorder() {
  const res = {
    code: null,
    body: null,
    headers: {},
    set(key, value) {
      res.headers[key] = value;
      return res;
    },
    status(code) {
      res.code = code;
      return res;
    },
    json(body) {
      res.body = body;
      return res;
    },
  };
  return res;
}

/**
 * @param {Object} options - {method, path, authorization, body}.
 * @returns {Object} Something shaped enough like an Express request.
 */
function request(options = {}) {
  const headers = { authorization: options.authorization || "" };
  return {
    method: options.method || "GET",
    path: options.path || "/api/admin/session",
    body: options.body,
    get: (key) => headers[key.toLowerCase()] || "",
  };
}

/**
 * Enough of Firestore for the routes this file has.
 *
 * Deliberately not more. A fake that grows features the real one is not being
 * asked for is a fake that can pass a check the database would fail.
 *
 * @param {Object} seed - Documents by id.
 * @returns {Object} {db, docs}, the second being the store itself.
 */
function database(seed = {}) {
  const docs = { ...seed };
  let written = 0;

  const db = {
    collection: () => {
      const api = {
        limit: () => api,
        get: async () => ({
          docs: Object.entries(docs).map(([id, doc]) => ({
            id,
            data: () => doc,
          })),
        }),
        add: async (record) => {
          written += 1;
          const id = `new${written}`;
          docs[id] = record;
          return { id };
        },
        doc: (id) => ({
          get: async () => ({
            exists: Boolean(docs[id]),
            id,
            data: () => docs[id],
          }),
          update: async (patch) => Object.assign(docs[id], patch),
        }),
      };
      return api;
    },
  };
  return { db, docs };
}

/**
 * The same fake, for routes that read more than one collection.
 *
 * database() above answers every collection with the same documents, which is
 * all the layouts routes need and is a trap for anything that joins: a
 * donations route reading campaigns would be handed donations and would look
 * as though the join worked. This one keys on the name.
 *
 * @param {Object} seed - Documents by collection, then by id.
 * @returns {Object} {db}.
 */
function collections(seed = {}) {
  const db = {
    collection: (name) => {
      const api = {
        limit: () => api,
        get: async () => ({
          docs: Object.entries(seed[name] || {}).map(([id, doc]) => ({
            id,
            data: () => doc,
          })),
        }),
      };
      return api;
    },
  };
  return { db };
}

// A clock that does not move, so an updatedAt written by a route is a value a
// check can name rather than one it has to be lenient about.
const FROZEN = "2026-09-14T12:00:00.000Z";
const clock = () => ({ now: () => FROZEN });

/* ── parseAllowlist ───────────────────────────────────────────────────── */

/**
 * @returns {Promise<void>} When the allowlist parser's checks have run.
 */
async function allowlist() {
  suite("parseAllowlist");

  await test("takes a JSON array", () => {
    const set = parseAllowlist(`["One@Example.com", "two@example.com"]`);
    assert.deepStrictEqual([...set], ["one@example.com", "two@example.com"]);
  });

  await test("takes a separated list", () => {
    const set = parseAllowlist("one@example.com, two@example.com;three@example.com");
    assert.strictEqual(set.size, 3);
    assert.ok(set.has("three@example.com"));
  });

  await test("lowercases, because the comparison is on a lowercased email", () => {
    assert.ok(parseAllowlist("MixedCase@Example.COM").has("mixedcase@example.com"));
  });

  await test("an unset secret is an empty allowlist, not a crash", () => {
    assert.strictEqual(parseAllowlist(undefined).size, 0);
    assert.strictEqual(parseAllowlist("").size, 0);
  });

  await test("malformed JSON is empty rather than a thrown 500", () => {
    // An allowlist nobody is on refuses everybody, which is the safe way for
    // this particular parse to fail.
    assert.strictEqual(parseAllowlist(`["unclosed`).size, 0);
  });
}

/* ── The gate ─────────────────────────────────────────────────────────── */

/**
 * @returns {Promise<void>} When the gate's checks have run.
 */
async function gate() {
  suite("createAdminApi — the gate");

  const allowed = async () => ({ ok: true, email: "ops@example.com" });
  const stranger = async () => ({ ok: false, reason: "no-token" });
  const wrongAccount = async () => ({
    ok: false,
    reason: "not-allowed",
    email: "someone@example.com",
  });

  await test("/config answers without a token", async () => {
    const handle = createAdminApi({ authorize: stranger });
    const res = recorder();
    await handle(request({ path: "/api/admin/config" }), res);
    assert.strictEqual(res.code, 200);
    assert.strictEqual(res.body.auth, "firebase");
  });

  await test("/config reports the harness when told to", async () => {
    const handle = createAdminApi({ authorize: stranger, authMode: "none" });
    const res = recorder();
    await handle(request({ path: "/api/admin/config" }), res);
    assert.strictEqual(res.body.auth, "none");
  });

  await test("no token is 401", async () => {
    const handle = createAdminApi({ authorize: stranger });
    const res = recorder();
    await handle(request(), res);
    assert.strictEqual(res.code, 401);
  });

  await test("a signed-in stranger is 403 and is told which account", async () => {
    // The distinction the portal's refusal screen is built on: 401 means sign
    // in, 403 means you are signed in as the wrong person.
    const handle = createAdminApi({ authorize: wrongAccount });
    const res = recorder();
    await handle(request(), res);
    assert.strictEqual(res.code, 403);
    assert.strictEqual(res.body.email, "someone@example.com");
  });

  await test("an allowlisted caller gets their email back", async () => {
    const handle = createAdminApi({ authorize: allowed });
    const res = recorder();
    await handle(request(), res);
    assert.strictEqual(res.code, 200);
    assert.strictEqual(res.body.viewer, "ops@example.com");
  });

  await test("an unknown path is 404, and only after the gate", async () => {
    const handle = createAdminApi({ authorize: stranger });
    const res = recorder();
    await handle(request({ path: "/api/admin/nothing" }), res);
    assert.strictEqual(res.code, 401);
  });

  await test("a write verb is refused whoever is asking", async () => {
    const handle = createAdminApi({ authorize: allowed });
    const res = recorder();
    await handle(request({ method: "POST" }), res);
    assert.strictEqual(res.code, 405);
  });

  await test("an authorize() that throws is 401, not 500", async () => {
    const handle = createAdminApi({
      authorize: async () => {
        throw new Error("network");
      },
    });
    const res = recorder();
    await handle(request(), res);
    assert.strictEqual(res.code, 401);
  });

  await test("nothing here may be cached", async () => {
    const handle = createAdminApi({ authorize: allowed });
    const res = recorder();
    await handle(request(), res);
    assert.strictEqual(res.headers["Cache-Control"], "no-store");
  });
}

/* ── Layouts ──────────────────────────────────────────────────────────── */

/**
 * @returns {Promise<void>} When the layouts routes' checks have run.
 */
async function layouts() {
  suite("createAdminApi — layouts");

  const allowed = async () => ({ ok: true, email: "ops@example.com" });
  const stranger = async () => ({ ok: false, reason: "no-token" });

  const seed = {
    old: {
      name: "Main Hall Seating",
      rows: 12,
      columns: 10,
      allottedBy: "cell",
      active: false,
      createdAt: "2026-08-02T09:30:00.000Z",
    },
    recent: {
      name: "Lantern Table — 600×600",
      rows: 4,
      columns: 18,
      allottedBy: "node",
      active: true,
      createdAt: "2026-09-10T02:00:00.000Z",
    },
  };

  /**
   * @param {Object} store - From database().
   * @param {Function} authorize - Who is asking.
   * @returns {Function} The handler.
   */
  function api(store, authorize = allowed) {
    return createAdminApi({
      authorize,
      getDb: () => store.db,
      getTimestamp: clock,
    });
  }

  await test("the list is refused without a token", async () => {
    // The whole point of the file: a route added behind the gate stays behind
    // it, and this is the check that fails if one is ever wired in front.
    const res = recorder();
    await api(database(seed), stranger)(
      request({ path: "/api/admin/layouts" }), res
    );
    assert.strictEqual(res.code, 401);
    assert.strictEqual(res.body.layouts, undefined);
  });

  await test("the list comes back newest first", async () => {
    // So the layout somebody has just created is the first card they see when
    // the form closes, rather than somewhere down in the Ms.
    const res = recorder();
    await api(database(seed))(request({ path: "/api/admin/layouts" }), res);
    assert.strictEqual(res.code, 200);
    assert.deepStrictEqual(res.body.layouts.map((l) => l.id), ["recent", "old"]);
  });

  await test("an inactive layout is still listed", async () => {
    // This is the console where one is switched back on; hiding it would hide
    // the only control that undoes it.
    const res = recorder();
    await api(database(seed))(request({ path: "/api/admin/layouts" }), res);
    assert.strictEqual(res.body.layouts.find((l) => l.id === "old").active, false);
  });

  await test("each listed layout carries its counts", async () => {
    const res = recorder();
    await api(database(seed))(request({ path: "/api/admin/layouts" }), res);
    const table = res.body.layouts.find((l) => l.id === "recent");
    assert.strictEqual(table.nodes, 95);
    assert.strictEqual(table.units, 95);
  });

  await test("a posted layout is stored and answered with", async () => {
    const store = database();
    const res = recorder();
    await api(store)(request({
      method: "POST",
      path: "/api/admin/layouts",
      body: { name: "New", rows: 8, columns: 5, allottedBy: "node" },
    }), res);

    assert.strictEqual(res.code, 201);
    assert.strictEqual(res.body.layout.units, 54);
    assert.strictEqual(res.body.layout.active, true);
    assert.strictEqual(store.docs.new1.name, "New");
    assert.strictEqual(store.docs.new1.createdAt, FROZEN);
  });

  await test("a refused layout is 400 with its fields, and nothing is stored", async () => {
    const store = database();
    const res = recorder();
    await api(store)(request({
      method: "POST",
      path: "/api/admin/layouts",
      body: { rows: 8 },
    }), res);

    assert.strictEqual(res.code, 400);
    assert.ok(res.body.fields.some((f) => f.field === "name"));
    assert.deepStrictEqual(Object.keys(store.docs), []);
  });

  await test("posting is refused without a token, before the database", async () => {
    const store = database();
    const res = recorder();
    await api(store, stranger)(request({
      method: "POST",
      path: "/api/admin/layouts",
      body: { name: "New", rows: 8, columns: 5, allottedBy: "cell" },
    }), res);

    assert.strictEqual(res.code, 401);
    assert.deepStrictEqual(Object.keys(store.docs), []);
  });

  await test("a layout is switched off, and says so", async () => {
    const store = database(seed);
    const res = recorder();
    await api(store)(request({
      method: "PATCH",
      path: "/api/admin/layouts/recent",
      body: { active: false },
    }), res);

    assert.strictEqual(res.code, 200);
    assert.strictEqual(res.body.layout.active, false);
    assert.strictEqual(store.docs.recent.active, false);
    assert.strictEqual(store.docs.recent.updatedAt, FROZEN);
  });

  await test("the answer to a patch is the whole layout, not the patch", async () => {
    // The card is redrawn from it, so a reply of {active: false} would leave
    // the portal to merge the two halves itself and guess at the counts.
    const res = recorder();
    await api(database(seed))(request({
      method: "PATCH",
      path: "/api/admin/layouts/recent",
      body: { active: false },
    }), res);
    assert.strictEqual(res.body.layout.name, "Lantern Table — 600×600");
    assert.strictEqual(res.body.layout.nodes, 95);
  });

  await test("patching a layout that is not there is 404", async () => {
    const res = recorder();
    await api(database(seed))(request({
      method: "PATCH",
      path: "/api/admin/layouts/gone",
      body: { active: false },
    }), res);
    assert.strictEqual(res.code, 404);
  });

  await test("a patch that is not a status is 400 and changes nothing", async () => {
    const store = database(seed);
    const res = recorder();
    await api(store)(request({
      method: "PATCH",
      path: "/api/admin/layouts/recent",
      body: { rows: 400 },
    }), res);
    assert.strictEqual(res.code, 400);
    assert.strictEqual(store.docs.recent.rows, 4);
  });

  await test("a verb no route takes is 405, not 404", async () => {
    // Told apart on purpose: 404 is a stale portal asking for something that
    // was never here, 405 is this file and the page disagreeing about a verb.
    const res = recorder();
    await api(database(seed))(request({
      method: "DELETE",
      path: "/api/admin/layouts/recent",
    }), res);
    assert.strictEqual(res.code, 405);
  });

  await test("a database that throws is 500, and says nothing about why", async () => {
    const broken = {
      db: {
        collection: () => {
          throw new Error("firestore: quota");
        },
      },
    };
    const res = recorder();
    await api(broken)(request({ path: "/api/admin/layouts" }), res);
    assert.strictEqual(res.code, 500);
    assert.strictEqual(res.body.error, "unavailable");
    assert.ok(!JSON.stringify(res.body).includes("quota"));
  });
}

/* ── GET /donations ───────────────────────────────────────────────────── */

/**
 * @returns {Promise<void>} When the donations route's checks have run.
 */
async function donations() {
  suite("GET /donations");

  const allowed = async () => ({ ok: true, email: "ops@example.com" });
  const stranger = async () => ({ ok: false, reason: "no-token" });

  const seed = {
    donations: {
      old: {
        name: "Wong Kah Hoe",
        amount: 100,
        campaignId: "c1",
        campaignSlug: "vesak-2026",
        status: "pending-payment",
        createdAt: "2026-09-01T02:00:00.000Z",
      },
      recent: {
        name: "Tan Mei Ling",
        amount: 300,
        recipients: ["Tan Ah Kow"],
        campaignId: "c2",
        campaignSlug: "kathina-2026",
        status: "paid",
        receiptNo: "R-2026-00841",
        paidAt: "2026-09-12T06:41:00.000Z",
        createdAt: "2026-09-11T02:10:00.000Z",
      },
    },
    campaigns: {
      c1: { slug: "vesak-2026", name: { en: "Vesak Day Offering", "zh-Hans": "卫塞节供僧大典" } },
      c2: { slug: "kathina-2026", name: { en: "Kathina Robe Offering" } },
    },
  };

  /**
   * @param {Object} store - From collections().
   * @param {Function} authorize - Who is asking.
   * @returns {Function} The handler.
   */
  function api(store, authorize = allowed) {
    return createAdminApi({
      authorize,
      getDb: () => store.db,
      getTimestamp: clock,
    });
  }

  await test("the list is refused without a token", async () => {
    // The same check the layouts list gets, and for the same reason: this one
    // serves donors' names and phone numbers.
    const res = recorder();
    await api(collections(seed), stranger)(
      request({ path: "/api/admin/donations" }), res
    );
    assert.strictEqual(res.code, 401);
    assert.strictEqual(res.body.donations, undefined);
  });

  await test("the list comes back newest first", async () => {
    const res = recorder();
    await api(collections(seed))(request({ path: "/api/admin/donations" }), res);
    assert.strictEqual(res.code, 200);
    assert.deepStrictEqual(res.body.donations.map((d) => d.id), ["recent", "old"]);
  });

  await test("each donation carries its campaign's names", async () => {
    // The join. Not stored on the donation, because a name copied at donation
    // time is a second copy that goes stale when a campaign is renamed.
    const res = recorder();
    await api(collections(seed))(request({ path: "/api/admin/donations" }), res);
    const [paid, pending] = res.body.donations;
    assert.strictEqual(paid.campaignName.en, "Kathina Robe Offering");
    assert.strictEqual(pending.campaignName["zh-Hans"], "卫塞节供僧大典");
  });

  await test("a donation whose campaign has gone still lists", async () => {
    // It is exactly the record an admin is most likely to be chasing.
    const orphan = {
      donations: { d1: { name: "Tan", campaignId: "gone", campaignSlug: "gone-2020" } },
      campaigns: {},
    };
    const res = recorder();
    await api(collections(orphan))(request({ path: "/api/admin/donations" }), res);
    assert.strictEqual(res.code, 200);
    assert.strictEqual(res.body.donations.length, 1);
    assert.deepStrictEqual(res.body.donations[0].campaignName, {});
  });

  await test("a campaign is found by slug when the id does not match", async () => {
    const recreated = {
      donations: { d1: { name: "Tan", campaignId: "old-id", campaignSlug: "vesak-2026" } },
      campaigns: { newId: { slug: "vesak-2026", name: { en: "Vesak Day Offering" } } },
    };
    const res = recorder();
    await api(collections(recreated))(request({ path: "/api/admin/donations" }), res);
    assert.strictEqual(res.body.donations[0].campaignName.en, "Vesak Day Offering");
  });

  await test("the answer says how many were held back, and the cap", async () => {
    // The one failure mode of searching in the browser that must not be
    // silent: an admin whose search is over part of the data.
    const res = recorder();
    await api(collections(seed))(request({ path: "/api/admin/donations" }), res);
    assert.strictEqual(res.body.held, 0);
    assert.strictEqual(res.body.cap, DONATIONS_CAP);
  });

  await test("past the cap, the extra is held back and counted", async () => {
    const many = { donations: {}, campaigns: {} };
    for (let i = 0; i < DONATIONS_CAP + 3; i += 1) {
      many.donations[`d${i}`] = { name: `Donor ${i}`, createdAt: "2026-09-01T00:00:00.000Z" };
    }
    const res = recorder();
    await api(collections(many))(request({ path: "/api/admin/donations" }), res);
    assert.strictEqual(res.body.donations.length, DONATIONS_CAP);
    assert.strictEqual(res.body.held, 3);
  });

  await test("a phone number reaches the portal but a stray field does not", async () => {
    // Both halves matter. The office rings donors back, so the number is
    // served; the allowlist is what keeps a field nobody has thought about
    // from arriving with it.
    const withNote = {
      donations: { d1: { name: "Tan", phone: "+65 9123 4567", internalNote: "called twice" } },
      campaigns: {},
    };
    const res = recorder();
    await api(collections(withNote))(request({ path: "/api/admin/donations" }), res);
    assert.strictEqual(res.body.donations[0].phone, "+65 9123 4567");
    assert.strictEqual(res.body.donations[0].internalNote, undefined);
  });

  await test("a write to the donations route is refused", async () => {
    // This module is a read. Nothing here moves a donation's status, and a
    // POST that quietly created one would be the worst kind of surprise.
    for (const method of ["POST", "PATCH", "DELETE"]) {
      const res = recorder();
      await api(collections(seed))(
        request({ method, path: "/api/admin/donations", body: {} }), res
      );
      assert.strictEqual(res.code, 405, `${method} should be refused`);
    }
  });

  await test("a database that throws is 500, and says nothing about why", async () => {
    const broken = {
      db: {
        collection: () => {
          throw new Error("firestore: quota");
        },
      },
    };
    const res = recorder();
    await api(broken)(request({ path: "/api/admin/donations" }), res);
    assert.strictEqual(res.code, 500);
    assert.strictEqual(res.body.error, "unavailable");
    assert.ok(!JSON.stringify(res.body).includes("quota"));
  });
}

(async () => {
  await allowlist();
  await gate();
  await layouts();
  await donations();
  console.log(failures ? `\n${failures} failed` : "\nall passed");
  process.exit(failures ? 1 : 0);
})();
