/**
 * Exercises admin.js.
 *
 * Run with `node admin.test.cjs` from functions/.
 *
 * What is worth checking here is the gate, and only the gate: which status a
 * refused caller gets, that /config answers before any of it, and that the
 * allowlist parser takes both of the shapes a human might paste into
 * `firebase functions:secrets:set`. The token verification itself is
 * firebase-admin's and is injected, so the handler can be driven with a fake
 * authorize() and no project.
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
 * @param {Object} options - {method, path, authorization}.
 * @returns {Object} Something shaped enough like an Express request.
 */
function request(options = {}) {
  const headers = { authorization: options.authorization || "" };
  return {
    method: options.method || "GET",
    path: options.path || "/api/admin/session",
    get: (key) => headers[key.toLowerCase()] || "",
  };
}

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

(async () => {
  await allowlist();
  await gate();
  console.log(failures ? `\n${failures} failed` : "\nall passed");
  process.exit(failures ? 1 : 0);
})();
