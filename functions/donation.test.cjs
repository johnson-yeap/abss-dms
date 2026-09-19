/**
 * Exercises donation.js.
 *
 * Run with `node donation.test.cjs` from functions/.
 *
 * This is the module that decides what an anonymous stranger may store in the
 * temple's database, so the cases here are mostly the ones a form cannot
 * produce and a script can: an amount that is not on the dropdown, a phone
 * field with a script tag in it, a wishes field one emoji over the limit.
 */

const assert = require("assert");
const {
  AMOUNTS,
  DEFAULT_LOCALE,
  RECIPIENTS_MAX,
  RECIPIENT_MAX,
  REFERENCE_ALPHABET,
  WISHES_MAX,
  adminDonation,
  countCharacters,
  isOpen,
  makeReference,
  normaliseLocale,
  normaliseStatus,
  publicCampaign,
  validateDonation,
} = require("./donation");

let failures = 0;

/**
 * @param {string} name - What is being checked.
 * @param {Function} body - The check.
 */
function test(name, body) {
  try {
    body();
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

const campaign = { amounts: AMOUNTS };

/**
 * @param {Object} over - Fields to override.
 * @returns {Object} A form submission that passes.
 */
function good(over = {}) {
  return {
    name: "Tan Wei Ming",
    phone: "+65 9123 4567",
    contact: ["whatsapp"],
    amount: 100,
    wishes: "願一切眾生離苦得樂",
    payBy: "paynow",
    locale: "zh-Hant",
    ...over,
  };
}

/**
 * @param {Object} result - What validateDonation returned.
 * @param {string} field - The field expected to have failed.
 */
function failedOn(result, field) {
  assert.ok(!result.ok, `expected ${field} to be refused`);
  assert.ok(
    result.errors.some((e) => e.field === field),
    `expected an error on ${field}, got ${JSON.stringify(result.errors)}`
  );
}

/* ── Blessing recipients ──────────────────────────────────────────────── */

/**
 * @returns {void} Runs the checks on the names a donation is offered for.
 */
function recipients() {
  suite("validateDonation — blessing recipients");

  test("a list of names is kept, in the order it was given", () => {
    const result = validateDonation(
      good({ recipients: ["Tan Ah Kow", "Lim Siew Hoon"] }),
      campaign
    );
    assert.ok(result.ok, JSON.stringify(result.errors));
    assert.deepStrictEqual(result.value.recipients, ["Tan Ah Kow", "Lim Siew Hoon"]);
  });

  test("none at all is an empty list, not a missing field", () => {
    // The portal reads .length on this without checking it exists.
    assert.deepStrictEqual(validateDonation(good(), campaign).value.recipients, []);
  });

  test("blank rows are dropped rather than refused", () => {
    // The form adds a row when Add is pressed; one left empty is a donor
    // thinking better of it, not a mistake to stop the donation for.
    const result = validateDonation(
      good({ recipients: ["Tan Ah Kow", "", "   ", "Lim Siew Hoon"] }),
      campaign
    );
    assert.ok(result.ok, JSON.stringify(result.errors));
    assert.deepStrictEqual(result.value.recipients, ["Tan Ah Kow", "Lim Siew Hoon"]);
  });

  test("names are trimmed", () => {
    assert.deepStrictEqual(
      validateDonation(good({ recipients: ["  Tan Ah Kow  "] }), campaign).value.recipients,
      ["Tan Ah Kow"]
    );
  });

  test("repeats are kept, unlike contact methods", () => {
    // Two people really can share a name, and a family offering for two
    // relatives called 陈美玲 should not silently lose one of them.
    assert.deepStrictEqual(
      validateDonation(good({ recipients: ["陈美玲", "陈美玲"] }), campaign).value.recipients,
      ["陈美玲", "陈美玲"]
    );
  });

  test("more than the limit is refused", () => {
    const many = Array.from({ length: RECIPIENTS_MAX + 1 }, (x, i) => `Name ${i}`);
    failedOn(validateDonation(good({ recipients: many }), campaign), "recipients");
  });

  test("exactly the limit is accepted", () => {
    const many = Array.from({ length: RECIPIENTS_MAX }, (x, i) => `Name ${i}`);
    assert.ok(validateDonation(good({ recipients: many }), campaign).ok);
  });

  test("one name over the length is refused", () => {
    failedOn(
      validateDonation(good({ recipients: ["ok", "x".repeat(RECIPIENT_MAX + 1)] }), campaign),
      "recipients"
    );
  });

  test("length is counted in characters a reader would count", () => {
    // Chinese names are half as long to .length as they are to the person
    // who typed them, and an emoji is a quarter.
    const chinese = "陈".repeat(RECIPIENT_MAX);
    assert.ok(validateDonation(good({ recipients: [chinese] }), campaign).ok);
  });

  test("anything that is not a list is no recipients", () => {
    // A posted string, a posted object, a posted number: none of them are a
    // list of names, and none of them is worth an error message.
    for (const junk of ["Tan Ah Kow", { name: "Tan" }, 42, null]) {
      const result = validateDonation(good({ recipients: junk }), campaign);
      assert.ok(result.ok, JSON.stringify(result.errors));
      assert.deepStrictEqual(result.value.recipients, []);
    }
  });

  test("a list of things that are not strings comes out empty", () => {
    assert.deepStrictEqual(
      validateDonation(good({ recipients: [1, null, {}, []] }), campaign).value.recipients,
      []
    );
  });
}

/* ── Status, and what the portal reads ────────────────────────────────── */

/**
 * @returns {void} Runs the checks on statuses and the admin shape.
 */
function statuses() {
  suite("normaliseStatus and adminDonation");

  test("the three known statuses pass through", () => {
    assert.strictEqual(normaliseStatus("paid"), "paid");
    assert.strictEqual(normaliseStatus("pending-payment"), "pending-payment");
    assert.strictEqual(normaliseStatus("pending-confirmation"), "pending-confirmation");
  });

  test("the old flat pending reads as pending-payment", () => {
    // Records written by the first version of the donor form.
    assert.strictEqual(normaliseStatus("pending"), "pending-payment");
  });

  test("anything unrecognised falls to pending-payment, never to paid", () => {
    // The direction is the point: reading an unknown status as paid is the
    // one mistake here that loses money quietly.
    for (const junk of ["", null, undefined, 7, "PAID", "settled"]) {
      assert.strictEqual(normaliseStatus(junk), "pending-payment");
    }
  });

  test("the portal is given the fields it draws", () => {
    const one = adminDonation("d1", {
      name: "Tan Mei Ling",
      phone: "+65 9123 4567",
      contact: ["whatsapp"],
      amount: 300,
      recipients: ["Tan Ah Kow"],
      wishes: "合家平安",
      payBy: "paynow",
      campaignId: "c1",
      campaignSlug: "vesak-2026",
      reference: "VSK-7Q2M9C",
      status: "paid",
      receiptNo: "R-2026-00841",
      paidAt: "2026-09-12T06:41:00.000Z",
      createdAt: "2026-09-11T02:10:00.000Z",
    }, { name: { en: "Vesak Day Offering" } });

    assert.strictEqual(one.id, "d1");
    assert.strictEqual(one.donor, "Tan Mei Ling");
    assert.strictEqual(one.amount, 300);
    assert.deepStrictEqual(one.recipients, ["Tan Ah Kow"]);
    assert.strictEqual(one.receiptNo, "R-2026-00841");
    assert.deepStrictEqual(one.campaignName, { en: "Vesak Day Offering" });
  });

  test("a field nobody has thought about yet is not served", () => {
    // The allowlist, and the reason for it: a note added to a donation later
    // should not appear on a phone screen because somebody wrote it.
    const one = adminDonation("d1", { name: "Tan", internalNote: "called twice" });
    assert.strictEqual(one.internalNote, undefined);
  });

  test("a missing campaign leaves an empty name, not a hole", () => {
    const one = adminDonation("d1", { name: "Tan", campaignSlug: "vesak-2026" });
    assert.deepStrictEqual(one.campaignName, {});
    assert.strictEqual(one.campaignSlug, "vesak-2026");
  });

  test("every absent field comes back as something the portal can draw", () => {
    const one = adminDonation("d1", {});
    assert.strictEqual(one.donor, "");
    assert.strictEqual(one.amount, 0);
    assert.deepStrictEqual(one.recipients, []);
    assert.deepStrictEqual(one.contact, []);
    assert.strictEqual(one.status, "pending-payment");
    assert.strictEqual(one.receiptNo, null);
    assert.strictEqual(one.paidAt, null);
    assert.strictEqual(one.createdAt, null);
  });

  test("a Firestore Timestamp becomes an ISO string", () => {
    // Three shapes reach this: a Timestamp from Firestore, an ISO string
    // from the local harness, a Date from a seeder. Sorting and filtering
    // compare these as strings, and a Timestamp compared with a string
    // orders neither.
    const one = adminDonation("d1", {
      createdAt: { toDate: () => new Date("2026-09-11T02:10:00.000Z") },
      paidAt: new Date("2026-09-12T06:41:00.000Z"),
    });
    assert.strictEqual(one.createdAt, "2026-09-11T02:10:00.000Z");
    assert.strictEqual(one.paidAt, "2026-09-12T06:41:00.000Z");
  });
}

/* ── The happy path ───────────────────────────────────────────────────── */

/**
 * @returns {void} Runs the checks for what the validator accepts.
 */
function accepts() {
  suite("validateDonation — what it accepts");

  test("a filled-in form", () => {
    const result = validateDonation(good(), campaign);
    assert.ok(result.ok, JSON.stringify(result.errors));
    assert.strictEqual(result.value.amount, 100);
    assert.strictEqual(result.value.payBy, "paynow");
  });

  test("no wishes and no contact preference", () => {
    // Both optional: a donor who wants no follow-up and has nothing to say is
    // still making a donation.
    const result = validateDonation(good({ wishes: "", contact: [] }), campaign);
    assert.ok(result.ok, JSON.stringify(result.errors));
  });

  test("trims, so a stray space is not a name", () => {
    const result = validateDonation(good({ name: "  Lim  " }), campaign);
    assert.strictEqual(result.value.name, "Lim");
  });

  test("deduplicates contact preferences rather than refusing them", () => {
    const result = validateDonation(good({ contact: ["sms", "sms"] }), campaign);
    assert.ok(result.ok);
    assert.deepStrictEqual(result.value.contact, ["sms"]);
  });

  test("drops a contact method that is not offered", () => {
    const result = validateDonation(good({ contact: ["sms", "carrier-pigeon"] }), campaign);
    assert.ok(result.ok);
    assert.deepStrictEqual(result.value.contact, ["sms"]);
  });

  test("a local number without a country code", () => {
    assert.ok(validateDonation(good({ phone: "91234567" }), campaign).ok);
  });

  test("PAY BY in the wrong case, because a URL or a script may send it", () => {
    const result = validateDonation(good({ payBy: "PayNow" }), campaign);
    assert.ok(result.ok);
    assert.strictEqual(result.value.payBy, "paynow");
  });
}

/* ── What it refuses ──────────────────────────────────────────────────── */

/**
 * @returns {void} Runs the checks for what the validator refuses.
 */
function refuses() {
  suite("validateDonation — what it refuses");

  test("no name", () => failedOn(validateDonation(good({ name: "   " }), campaign), "name"));
  test("no phone", () => failedOn(validateDonation(good({ phone: "" }), campaign), "phone"));

  test("a phone number that is prose", () => {
    failedOn(validateDonation(good({ phone: "call me maybe" }), campaign), "phone");
  });

  test("a phone number too short to be one", () => {
    failedOn(validateDonation(good({ phone: "12345" }), campaign), "phone");
  });

  test("an amount that is not on the dropdown", () => {
    // The point of the closed set: a script posting 1 cent, or 1,000,000.
    failedOn(validateDonation(good({ amount: 1 }), campaign), "amount");
    failedOn(validateDonation(good({ amount: 250 }), campaign), "amount");
  });

  test("an amount that is a string with a number in it", () => {
    failedOn(validateDonation(good({ amount: "100abc" }), campaign), "amount");
  });

  test("a negative amount", () => {
    failedOn(validateDonation(good({ amount: -100 }), campaign), "amount");
  });

  test("a payment method that does not exist", () => {
    failedOn(validateDonation(good({ payBy: "bitcoin" }), campaign), "payBy");
  });

  test("wishes one character over the limit", () => {
    const result = validateDonation(good({ wishes: "字".repeat(WISHES_MAX + 1) }), campaign);
    failedOn(result, "wishes");
  });

  test("wishes exactly at the limit are fine", () => {
    assert.ok(validateDonation(good({ wishes: "字".repeat(WISHES_MAX) }), campaign).ok);
  });

  test("emoji count as one character each, as a donor counts them", () => {
    // .length would call this 2 per emoji and refuse at half the stated limit,
    // disagreeing with the counter drawn under the box.
    const wishes = "🙏".repeat(WISHES_MAX);
    assert.strictEqual(countCharacters(wishes), WISHES_MAX);
    assert.ok(validateDonation(good({ wishes }), campaign).ok);
  });

  test("a body that is not an object at all", () => {
    const result = validateDonation(null, campaign);
    assert.ok(!result.ok);
    failedOn(result, "name");
  });

  test("everything wrong at once reports every field, not the first", () => {
    const result = validateDonation(
      { name: "", phone: "", amount: 7, payBy: "", wishes: "x".repeat(200) },
      campaign
    );
    const fields = new Set(result.errors.map((e) => e.field));
    assert.deepStrictEqual([...fields].sort(), ["amount", "name", "payBy", "phone", "wishes"]);
  });

  test("markup in a name is stored as typed, not rejected", () => {
    // The browser puts every one of these through textContent, so this is a
    // name with angle brackets in it rather than an attack. Rejecting it would
    // refuse real names with apostrophes and hyphens on the same logic.
    const result = validateDonation(good({ name: "<script>alert(1)</script>" }), campaign);
    assert.ok(result.ok);
    assert.strictEqual(result.value.name, "<script>alert(1)</script>");
  });

  test("a campaign's own amounts win over the defaults", () => {
    const special = { amounts: [50] };
    assert.ok(validateDonation(good({ amount: 50 }), special).ok);
    failedOn(validateDonation(good({ amount: 100 }), special), "amount");
  });
}

/* ── Locale ───────────────────────────────────────────────────────────── */

/**
 * @returns {void} Runs the locale checks.
 */
function locale() {
  suite("normaliseLocale");

  test("keeps the three that exist", () => {
    for (const l of ["en", "zh-Hans", "zh-Hant"]) {
      assert.strictEqual(normaliseLocale(l), l);
    }
  });

  test("anything else becomes Simplified Chinese", () => {
    assert.strictEqual(normaliseLocale("fr"), DEFAULT_LOCALE);
    assert.strictEqual(normaliseLocale(undefined), DEFAULT_LOCALE);
    assert.strictEqual(normaliseLocale("../../etc/passwd"), DEFAULT_LOCALE);
  });
}

/* ── The reference code ───────────────────────────────────────────────── */

/**
 * @returns {void} Runs the reference-code checks.
 */
function reference() {
  suite("makeReference");

  test("leads with the campaign's prefix", () => {
    assert.ok(makeReference("VSK").startsWith("VSK-"));
  });

  test("avoids the glyphs people mistype", () => {
    // 0/O and 1/I/L, read off a screen and typed into a banking app later.
    for (let i = 0; i < 200; i += 1) {
      const body = makeReference("VSK").split("-")[1];
      assert.ok(/^[23456789ACDEFGHJKMNPQRTUVWXY]{6}$/.test(body), body);
    }
    for (const bad of ["0", "O", "1", "I", "L"]) {
      assert.ok(!REFERENCE_ALPHABET.includes(bad), `alphabet contains ${bad}`);
    }
  });

  test("survives a prefix that is punctuation or missing", () => {
    assert.strictEqual(makeReference("", () => 0).length, 6);
    assert.ok(makeReference("!!!", () => 0).length === 6);
    assert.ok(makeReference("新年-2026").startsWith("2026-"));
  });

  test("is stable when the randomness is", () => {
    assert.strictEqual(makeReference("A", () => 0), "A-222222");
  });
}

/* ── Campaign shaping ─────────────────────────────────────────────────── */

/**
 * @returns {void} Runs the campaign shaping and window checks.
 */
function campaigns() {
  suite("publicCampaign and isOpen");

  test("serves only the fields the public app needs", () => {
    const shaped = publicCampaign("abc", {
      slug: "vesak",
      name: { en: "Vesak" },
      internalNote: "chase the printer",
      createdBy: "ops@example.com",
      target: 50000,
    });
    assert.strictEqual(shaped.slug, "vesak");
    assert.strictEqual(shaped.internalNote, undefined);
    assert.strictEqual(shaped.createdBy, undefined);
    assert.strictEqual(shaped.target, undefined);
  });

  test("falls back to the default amounts", () => {
    assert.deepStrictEqual(publicCampaign("a", {}).amounts, AMOUNTS);
  });

  const now = Date.parse("2026-06-15T00:00:00Z");

  test("inactive is closed whatever the dates say", () => {
    assert.strictEqual(
      isOpen({ active: false, campaignStart: "2026-01-01", campaignEnd: "2026-12-31" }, now),
      false
    );
  });

  test("open inside its window", () => {
    assert.strictEqual(
      isOpen({ active: true, campaignStart: "2026-01-01", campaignEnd: "2026-12-31" }, now),
      true
    );
  });

  test("closed before it starts and after it ends", () => {
    assert.strictEqual(isOpen({ active: true, campaignStart: "2026-07-01" }, now), false);
    assert.strictEqual(isOpen({ active: true, campaignEnd: "2026-05-01" }, now), false);
  });

  test("no end date means it has not closed", () => {
    // The other reading — a missing date parsing to 0 — is a campaign that
    // silently refuses money.
    assert.strictEqual(isOpen({ active: true, campaignStart: "2026-01-01" }, now), true);
    assert.strictEqual(isOpen({ active: true }, now), true);
  });

  test("an unparseable date does not close a campaign", () => {
    assert.strictEqual(isOpen({ active: true, campaignEnd: "soon" }, now), true);
  });
}

accepts();
refuses();
recipients();
statuses();
locale();
reference();
campaigns();
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
