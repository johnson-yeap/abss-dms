/**
 * Exercises publicapi.js against a fake Firestore.
 *
 * Run with `node publicapi.test.cjs` from functions/.
 *
 * The fake agrees with itself about field names, which is exactly the weakness
 * a fake has — so what is checked here is the routing and the refusals, the
 * behaviour that does not depend on the database being real: that a closed
 * campaign cannot be donated to, that a stale page is caught at submit, that
 * nothing a stranger posts is echoed back, and that only validated fields are
 * written.
 */

const assert = require("assert");
const { createPublicApi, POST_PER_WINDOW } = require("./publicapi");

let failures = 0;

/**
 * @param {string} name - What is being checked.
 * @param {Function} body - The check.
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

const NOW = Date.parse("2026-06-15T00:00:00Z");

const OPEN = {
  slug: "vesak-2026",
  active: true,
  referencePrefix: "VSK",
  campaignStart: "2026-01-01",
  campaignEnd: "2026-12-31",
  name: { en: "Vesak Day" },
  amounts: [100, 300],
  internalNote: "do not publish this",
};

const CLOSED = { ...OPEN, slug: "past-2025", campaignEnd: "2025-01-01" };
const DRAFT = { ...OPEN, slug: "draft-2027", active: false };

/**
 * A Firestore stand-in holding the three campaigns above.
 *
 * @returns {Object} {db, written}.
 */
function fakeDb() {
  const campaigns = {
    c1: OPEN,
    c2: CLOSED,
    c3: DRAFT,
  };
  const written = [];

  const docsFor = (filter) =>
    Object.entries(campaigns)
      .filter(([, doc]) => filter(doc))
      .map(([id, doc]) => ({ id, data: () => doc }));

  const collection = (name) => {
    if (name === "donations") {
      return { add: async (record) => {
 written.push(record); return { id: "d1" };
} };
    }
    let predicate = () => true;
    const api = {
      where(field, _op, value) {
        const previous = predicate;
        predicate = (doc) => previous(doc) && doc[field] === value;
        return api;
      },
      limit: () => api,
      get: async () => {
        const docs = docsFor(predicate);
        return { empty: docs.length === 0, docs };
      },
      doc: (id) => ({
        get: async () => ({
          exists: Boolean(campaigns[id]),
          id,
          data: () => campaigns[id],
        }),
      }),
    };
    return api;
  };

  return { db: { collection }, written };
}

/**
 * @param {Object} options - {written} to share a write log.
 * @returns {Object} {handle, written}.
 */
function api(options = {}) {
  const { db, written } = options.fake || fakeDb();
  const handle = createPublicApi({
    getDb: () => db,
    getTimestamp: () => ({ now: () => "TS" }),
    now: () => NOW,
    random: () => 0,
  });
  return { handle, written };
}

/**
 * @param {Object} options - {method, path, body, ip}.
 * @returns {Object} A request-shaped object.
 */
function request(options = {}) {
  const headers = { "x-forwarded-for": options.ip || "1.2.3.4" };
  return {
    method: options.method || "GET",
    path: options.path || "/api/campaigns",
    body: options.body,
    ip: options.ip || "1.2.3.4",
    get: (key) => headers[key.toLowerCase()] || "",
  };
}

/**
 * @returns {Object} A response recorder.
 */
function recorder() {
  const res = {
    code: null,
    body: null,
    headers: {},
    set(k, v) {
 res.headers[k] = v; return res;
},
    status(c) {
 res.code = c; return res;
},
    json(b) {
 res.body = b; return res;
},
  };
  return res;
}

/**
 * @param {Object} over - Fields to override.
 * @returns {Object} A valid post body.
 */
function post(over = {}) {
  return {
    campaign: "vesak-2026",
    name: "Tan Wei Ming",
    phone: "+65 9123 4567",
    contact: ["whatsapp"],
    amount: 100,
    wishes: "願吉祥",
    payBy: "paynow",
    locale: "zh-Hant",
    ...over,
  };
}

/* ── Reading campaigns ────────────────────────────────────────────────── */

/**
 * @returns {Promise<void>} When the campaign-reading checks have run.
 */
async function reading() {
  suite("GET /campaigns");

  await test("lists only what is open", async () => {
    const { handle } = api();
    const res = recorder();
    await handle(request({ path: "/api/campaigns" }), res);
    assert.strictEqual(res.code, 200);
    assert.deepStrictEqual(res.body.campaigns.map((c) => c.slug), ["vesak-2026"]);
  });

  await test("never serves an internal field", async () => {
    const { handle } = api();
    const res = recorder();
    await handle(request({ path: "/api/campaigns" }), res);
    assert.strictEqual(res.body.campaigns[0].internalNote, undefined);
    assert.ok(!JSON.stringify(res.body).includes("do not publish"));
  });

  await test("one campaign by slug", async () => {
    const { handle } = api();
    const res = recorder();
    await handle(request({ path: "/api/campaigns/vesak-2026" }), res);
    assert.strictEqual(res.code, 200);
    assert.strictEqual(res.body.campaign.slug, "vesak-2026");
  });

  await test("one campaign by document id", async () => {
    const { handle } = api();
    const res = recorder();
    await handle(request({ path: "/api/campaigns/c1" }), res);
    assert.strictEqual(res.code, 200);
  });

  await test("a closed campaign is 410, not 404", async () => {
    // A donor following last year's link is told it has ended rather than
    // that it never existed.
    const { handle } = api();
    const res = recorder();
    await handle(request({ path: "/api/campaigns/past-2025" }), res);
    assert.strictEqual(res.code, 410);
    assert.strictEqual(res.body.error, "campaign-closed");
  });

  await test("an unpublished campaign is not reachable by guessing its slug", async () => {
    const { handle } = api();
    const res = recorder();
    await handle(request({ path: "/api/campaigns/draft-2027" }), res);
    assert.strictEqual(res.code, 410);
  });

  await test("a slug that does not exist is 404", async () => {
    const { handle } = api();
    const res = recorder();
    await handle(request({ path: "/api/campaigns/nothing-here" }), res);
    assert.strictEqual(res.code, 404);
  });

  await test("a path-traversal slug does not route", async () => {
    const { handle } = api();
    const res = recorder();
    await handle(request({ path: "/api/campaigns/../../secrets" }), res);
    assert.strictEqual(res.code, 404);
    assert.strictEqual(res.body.error, "not-found");
  });

  await test("nothing here may be cached", async () => {
    const { handle } = api();
    const res = recorder();
    await handle(request({ path: "/api/campaigns" }), res);
    assert.strictEqual(res.headers["Cache-Control"], "no-store");
  });
}

/* ── Donating ─────────────────────────────────────────────────────────── */

/**
 * @returns {Promise<void>} When the donation-posting checks have run.
 */
async function donating() {
  suite("POST /donate");

  await test("stores a donation and answers with its reference", async () => {
    const { handle, written } = api();
    const res = recorder();
    await handle(request({ method: "POST", path: "/api/donate", body: post() }), res);
    assert.strictEqual(res.code, 201);
    assert.strictEqual(res.body.reference, "VSK-222222");
    assert.strictEqual(written.length, 1);
    assert.strictEqual(written[0].name, "Tan Wei Ming");
    assert.strictEqual(written[0].campaignId, "c1");
    assert.strictEqual(written[0].status, "pending-payment");
    // Both written, both null. A donation the office has not touched has the
    // same shape as one it has, so nothing downstream has to tell "not paid"
    // apart from "field not there".
    assert.strictEqual(written[0].receiptNo, null);
    assert.strictEqual(written[0].paidAt, null);
  });

  await test("writes only validated fields, not whatever was posted", async () => {
    const { handle, written } = api();
    const res = recorder();
    await handle(request({
      method: "POST",
      path: "/api/donate",
      body: post({ status: "paid", isAdmin: true, amount: 300 }),
    }), res);
    assert.strictEqual(res.code, 201);
    // The two that matter: a poster cannot mark their own donation received,
    // and cannot add a field of their choosing to the temple's database.
    assert.strictEqual(written[0].status, "pending-payment");
    assert.strictEqual(written[0].isAdmin, undefined);
  });

  await test("refuses an amount that is not on the campaign's dropdown", async () => {
    const { handle, written } = api();
    const res = recorder();
    await handle(request({ method: "POST", path: "/api/donate", body: post({ amount: 1 }) }), res);
    assert.strictEqual(res.code, 400);
    assert.deepStrictEqual(res.body.fields, [{ field: "amount", code: "invalid" }]);
    assert.strictEqual(written.length, 0);
  });

  await test("does not echo what was posted", async () => {
    // A reflected value is how an endpoint like this becomes somebody else's
    // delivery mechanism.
    const { handle } = api();
    const res = recorder();
    const marker = "<img src=x onerror=alert(1)>";
    await handle(request({
      method: "POST",
      path: "/api/donate",
      body: post({ phone: marker }),
    }), res);
    assert.strictEqual(res.code, 400);
    assert.ok(!JSON.stringify(res.body).includes(marker));
  });

  await test("a campaign that closed while the page was open is caught", async () => {
    const { handle, written } = api();
    const res = recorder();
    await handle(request({
      method: "POST",
      path: "/api/donate",
      body: post({ campaign: "past-2025" }),
    }), res);
    assert.strictEqual(res.code, 409);
    assert.strictEqual(written.length, 0);
  });

  await test("an unpublished campaign cannot be donated to", async () => {
    const { handle, written } = api();
    const res = recorder();
    await handle(request({
      method: "POST",
      path: "/api/donate",
      body: post({ campaign: "draft-2027" }),
    }), res);
    assert.strictEqual(res.code, 409);
    assert.strictEqual(written.length, 0);
  });

  await test("a campaign that does not exist is 404", async () => {
    const { handle } = api();
    const res = recorder();
    await handle(request({
      method: "POST",
      path: "/api/donate",
      body: post({ campaign: "made-up" }),
    }), res);
    assert.strictEqual(res.code, 404);
  });

  await test("no body at all does not crash", async () => {
    const { handle } = api();
    const res = recorder();
    await handle(request({ method: "POST", path: "/api/donate" }), res);
    assert.strictEqual(res.code, 404);
  });

  await test("the same address posting repeatedly is throttled", async () => {
    const fake = fakeDb();
    const { handle } = api({ fake });
    let last = null;
    for (let i = 0; i < POST_PER_WINDOW + 1; i += 1) {
      last = recorder();
      await handle(request({ method: "POST", path: "/api/donate", body: post() }), last);
    }
    assert.strictEqual(last.code, 429);
    assert.strictEqual(fake.written.length, POST_PER_WINDOW);
  });

  await test("a different address is not caught by another's throttle", async () => {
    const fake = fakeDb();
    const { handle } = api({ fake });
    for (let i = 0; i < POST_PER_WINDOW + 1; i += 1) {
      await handle(request({ method: "POST", path: "/api/donate", body: post(), ip: "9.9.9.9" }),
        recorder());
    }
    const res = recorder();
    await handle(request({ method: "POST", path: "/api/donate", body: post(), ip: "5.5.5.5" }), res);
    assert.strictEqual(res.code, 201);
  });

  await test("GET on the donate route does not route", async () => {
    const { handle } = api();
    const res = recorder();
    await handle(request({ method: "GET", path: "/api/donate" }), res);
    assert.strictEqual(res.code, 404);
  });
}

/* ── Failing ──────────────────────────────────────────────────────────── */

/**
 * @returns {Promise<void>} When the Firestore-failure checks have run.
 */
async function failing() {
  suite("when Firestore is unhappy");

  await test("answers 500 without leaking the reason", async () => {
    const handle = createPublicApi({
      getDb: () => {
 throw new Error("Missing index on campaigns.active");
},
      getTimestamp: () => ({ now: () => "TS" }),
      now: () => NOW,
    });
    const res = recorder();
    await handle(request({ path: "/api/campaigns" }), res);
    assert.strictEqual(res.code, 500);
    assert.deepStrictEqual(res.body, { error: "unavailable" });
  });
}

(async () => {
  await reading();
  await donating();
  await failing();
  console.log(failures ? `\n${failures} failed` : "\nall passed");
  process.exit(failures ? 1 : 0);
})();
