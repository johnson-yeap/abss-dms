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
const { createAdminApi, parseAllowlist } = require("./admin");

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

(async () => {
  await allowlist();
  await gate();
  await layouts();
  console.log(failures ? `\n${failures} failed` : "\nall passed");
  process.exit(failures ? 1 : 0);
})();
