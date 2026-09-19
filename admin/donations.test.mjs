/**
 * Exercises donations.mjs.
 *
 * Run with `node donations.test.mjs` from admin/, or through `npm test` in
 * functions/, which runs it along with the rest.
 *
 * The searching is most of what is here, and it is worth the space. This
 * module is what an admin uses on a phone while somebody is waiting on the
 * telephone to be told whether their donation came through, and the failures
 * that matter are all quiet ones: a date range that drops its last day, a
 * name that will not match because of the case it was typed in, a filter that
 * empties the list without saying why. None of those look like errors. They
 * look like the donation is not there.
 */

import assert from "assert";
import {
  activeCount,
  amountLabel,
  basisDate,
  campaignLabel,
  contactLabel,
  dateLabel,
  displayDate,
  fold,
  haystack,
  matches,
  recipientsLabel,
  search,
  statusLabel,
  withinDays,
} from "./donations.mjs";

let failures = 0;

/**
 * @param {string} name - What is being checked.
 * @param {Function} body - The check.
 * @returns {void}
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

/**
 * @param {Object} extra - Fields to override.
 * @returns {Object} A donation as the API answers with one.
 */
function donation(extra = {}) {
  return {
    id: "d1",
    donor: "Tan Mei Ling",
    phone: "+65 9123 4567",
    contact: ["whatsapp"],
    amount: 300,
    recipients: ["Tan Ah Kow", "Lim Siew Hoon"],
    wishes: "合家平安",
    payBy: "paynow",
    campaignId: "c1",
    campaignSlug: "vesak-2026",
    campaignName: { "en": "Vesak Day Offering", "zh-Hans": "卫塞节供僧大典" },
    reference: "VSK-7Q2M9C",
    status: "paid",
    receiptNo: "R-2026-00841",
    paidAt: "2026-09-12T06:41:00.000Z",
    createdAt: "2026-09-11T02:10:00.000Z",
    ...extra,
  };
}

/* ── Folding ────────────────────────────────────────────────────────────── */

function folding() {
  suite("Folding what is typed onto what is stored");

  test("case does not matter", () => {
    assert.strictEqual(fold("Tan Mei LING"), "tan mei ling");
  });

  test("runs of whitespace collapse", () => {
    // Typed with a double space, stored with one.
    assert.strictEqual(fold("Tan  Ah   Kow"), "tan ah kow");
  });

  test("full-width characters fold onto ASCII", () => {
    // The case this exists for: a Chinese IME produces these, and a receipt
    // number typed on one would otherwise match nothing at all. NFKC folds
    // the full-width hyphen too, which is why this is the whole string.
    assert.strictEqual(fold("Ｒ－２０２６－００８４１"), "r-2026-00841");
    assert.strictEqual(fold("ＡＢＣ１２３"), "abc123");
  });

  test("slashes survive, because Singaporean names contain them", () => {
    assert.strictEqual(fold("Kavitha d/o Raman"), "kavitha d/o raman");
  });

  test("anything that is not a string folds to nothing", () => {
    assert.strictEqual(fold(null), "");
    assert.strictEqual(fold(undefined), "");
    assert.strictEqual(fold(42), "");
  });
}

/* ── The haystack ───────────────────────────────────────────────────────── */

function searching() {
  suite("What the free-text box searches");

  test("the donor, the recipients, the receipt and the reference", () => {
    const hay = haystack(donation());
    assert.ok(hay.includes("tan mei ling"), "donor");
    assert.ok(hay.includes("lim siew hoon"), "a recipient");
    assert.ok(hay.includes("r-2026-00841"), "receipt number");
    assert.ok(hay.includes("vsk-7q2m9c"), "reference");
  });

  test("not the phone number", () => {
    // On the detail view, out of the index. An admin searching "9123" wants
    // one donor, not everybody whose number contains it.
    assert.ok(!haystack(donation()).includes("9123"));
  });

  test("not the wishes", () => {
    assert.ok(!haystack(donation()).includes("合家平安"));
  });

  test("fields do not run into one another", () => {
    // "ling vesak" is in neither the donor nor the campaign. Joining the
    // haystack with a space instead of a newline would make this match.
    const one = donation({ _hay: undefined });
    one._hay = haystack(one);
    assert.strictEqual(matches(one, { query: "ling tan" }), false);
  });

  test("a substring in the middle of a name matches", () => {
    // The whole reason this is filtered in the browser: Firestore would only
    // match a prefix, and "mei" is how an admin half-remembers this donor.
    assert.strictEqual(matches(donation(), { query: "mei" }), true);
  });

  test("a cached haystack is used when it is there", () => {
    const stale = donation({ _hay: "something else entirely" });
    assert.strictEqual(matches(stale, { query: "tan mei" }), false);
    assert.strictEqual(matches(stale, { query: "entirely" }), true);
  });
}

/* ── Date ranges ────────────────────────────────────────────────────────── */

function dates() {
  suite("Date ranges");

  test("both ends are inclusive", () => {
    assert.strictEqual(withinDays("2026-09-01T00:00:00.000Z", "2026-09-01", "2026-09-30"), true);
    assert.strictEqual(withinDays("2026-09-30T00:00:00.000Z", "2026-09-01", "2026-09-30"), true);
  });

  test("the last day is included right up to its end", () => {
    // The failure this pins down: comparing against the end day's midnight
    // drops every donation made on the last day of the range, which is the
    // one an admin looking at "this month" most often wants.
    //
    // 30 September in Singapore ends at 15:59:59.999Z, and the millisecond
    // after it is October.
    assert.strictEqual(withinDays("2026-09-30T15:59:59.999Z", "", "2026-09-30"), true);
    assert.strictEqual(withinDays("2026-09-30T16:00:00.000Z", "", "2026-09-30"), false);
  });

  test("outside either end is out", () => {
    assert.strictEqual(withinDays("2026-08-25T00:00:00.000Z", "2026-09-01", ""), false);
  });

  test("the range is in Singapore days, not UTC ones", () => {
    // The bug this pins down. 2026-09-30T17:00Z is 1 October, 1am, in
    // Singapore. Comparing raw UTC strings would file it under September
    // while the column beside it read "1 Oct 2026".
    assert.strictEqual(withinDays("2026-09-30T17:00:00.000Z", "", "2026-09-30"), false);
    assert.strictEqual(withinDays("2026-09-30T17:00:00.000Z", "2026-10-01", ""), true);

    // And the other edge: 2026-08-31T16:00Z is 1 September in Singapore.
    assert.strictEqual(withinDays("2026-08-31T16:00:00.000Z", "2026-09-01", ""), true);
    assert.strictEqual(withinDays("2026-08-31T15:59:00.000Z", "2026-09-01", ""), false);
  });

  test("a date stored as a plain day is a Singapore day", () => {
    assert.strictEqual(withinDays("2026-09-30", "2026-09-30", "2026-09-30"), true);
  });

  test("an unreadable date is out of any range", () => {
    assert.strictEqual(withinDays("soon", "2026-09-01", "2026-09-30"), false);
  });

  test("an open end does not bound that side", () => {
    assert.strictEqual(withinDays("2020-01-01T00:00:00.000Z", "", "2026-09-30"), true);
    assert.strictEqual(withinDays("2099-01-01T00:00:00.000Z", "2026-09-01", ""), true);
  });

  test("no range at all passes everything, including a record with no date", () => {
    assert.strictEqual(withinDays(null, "", ""), true);
  });

  test("a record with no date on the basis being filtered is out", () => {
    assert.strictEqual(withinDays(null, "2026-09-01", ""), false);
  });

  test("the basis picks which date is filtered", () => {
    const one = donation();
    assert.strictEqual(basisDate(one, "submitted"), "2026-09-11T02:10:00.000Z");
    assert.strictEqual(basisDate(one, "paid"), "2026-09-12T06:41:00.000Z");
  });

  test("filtering by paid date excludes what has not been paid", () => {
    // Not a quirk — the reason the toggle exists. "What did we bank in
    // September" should not list pledges nobody has collected.
    const unpaid = donation({ status: "pending-payment", paidAt: null });
    assert.strictEqual(
      matches(unpaid, { basis: "paid", from: "2026-09-01", to: "2026-09-30" }),
      false
    );
    assert.strictEqual(
      matches(unpaid, { basis: "submitted", from: "2026-09-01", to: "2026-09-30" }),
      true
    );
  });

  test("the displayed date is the paid one, and falls back when it is missing", () => {
    assert.strictEqual(displayDate(donation()), "2026-09-12T06:41:00.000Z");
    assert.strictEqual(
      displayDate(donation({ status: "pending-payment" })),
      "2026-09-11T02:10:00.000Z"
    );
    // Marked paid by somebody who never filled the date in.
    assert.strictEqual(
      displayDate(donation({ paidAt: null })),
      "2026-09-11T02:10:00.000Z"
    );
  });
}

/* ── The filters together ───────────────────────────────────────────────── */

function filtering() {
  suite("The filters");

  test("no filters passes everything", () => {
    assert.strictEqual(matches(donation(), {}), true);
    assert.strictEqual(matches(donation(), undefined), true);
  });

  test("an empty set of campaigns or statuses means all, not none", () => {
    // The other reading empties the screen the moment the filter sheet is
    // opened and nothing is ticked.
    assert.strictEqual(matches(donation(), { campaigns: [], statuses: [] }), true);
  });

  test("status filters on the set", () => {
    assert.strictEqual(matches(donation(), { statuses: ["paid"] }), true);
    assert.strictEqual(matches(donation(), { statuses: ["pending-payment"] }), false);
    assert.strictEqual(
      matches(donation(), { statuses: ["paid", "pending-payment"] }),
      true
    );
  });

  test("campaign filters on the id", () => {
    assert.strictEqual(matches(donation(), { campaigns: ["c1"] }), true);
    assert.strictEqual(matches(donation(), { campaigns: ["c2"] }), false);
  });

  test("the recipient box searches only the recipients", () => {
    assert.strictEqual(matches(donation(), { recipient: "siew" }), true);
    // The donor's own name is not a recipient of this donation.
    assert.strictEqual(matches(donation(), { recipient: "mei ling" }), false);
  });

  test("the donor box searches only the donor", () => {
    assert.strictEqual(matches(donation(), { donor: "mei" }), true);
    assert.strictEqual(matches(donation(), { donor: "siew" }), false);
  });

  test("the receipt box matches part of a number", () => {
    assert.strictEqual(matches(donation(), { receiptNo: "00841" }), true);
    assert.strictEqual(matches(donation(), { receiptNo: "00842" }), false);
  });

  test("a record with no receipt number is out of a receipt search", () => {
    assert.strictEqual(
      matches(donation({ receiptNo: null }), { receiptNo: "841" }),
      false
    );
  });

  test("filters are ANDed", () => {
    const one = donation();
    assert.strictEqual(matches(one, { donor: "mei", statuses: ["paid"] }), true);
    assert.strictEqual(
      matches(one, { donor: "mei", statuses: ["pending-payment"] }),
      false
    );
    assert.strictEqual(matches(one, { donor: "wong", statuses: ["paid"] }), false);
  });

  test("whitespace typed into a box is not a filter", () => {
    assert.strictEqual(matches(donation(), { donor: "   " }), true);
  });
}

/* ── Ordering ───────────────────────────────────────────────────────────── */

function ordering() {
  suite("Searching a list");

  const list = [
    donation({ id: "a", createdAt: "2026-09-01T00:00:00.000Z", status: "pending-payment", paidAt: null }),
    donation({ id: "b", createdAt: "2026-09-20T00:00:00.000Z", status: "pending-payment", paidAt: null }),
    donation({ id: "c", createdAt: "2026-09-10T00:00:00.000Z", status: "pending-payment", paidAt: null }),
  ];

  test("newest first, by the date on screen", () => {
    assert.deepStrictEqual(search(list, {}).map((one) => one.id), ["b", "c", "a"]);
  });

  test("a record with no date at all sorts last", () => {
    const withNone = [...list, donation({ id: "z", createdAt: null, paidAt: null, status: "pending-payment" })];
    assert.strictEqual(search(withNone, {}).at(-1).id, "z");
  });

  test("ordering follows the paid date once a record is paid", () => {
    // 'a' was submitted first and banked last, so marking it paid moves it to
    // the top — the column being read is the column being sorted.
    const paidLate = list.map((one) => one.id === "a" ?
      { ...one, status: "paid", paidAt: "2026-09-30T00:00:00.000Z" } :
      one);
    assert.deepStrictEqual(search(paidLate, {}).map((one) => one.id), ["a", "b", "c"]);
  });

  test("an empty list searches to an empty list", () => {
    assert.deepStrictEqual(search([], { query: "anything" }), []);
    assert.deepStrictEqual(search(null, {}), []);
  });
}

/* ── The count on the filter button ─────────────────────────────────────── */

function counting() {
  suite("How many filters are narrowing the list");

  test("nothing set is nothing counted", () => {
    assert.strictEqual(activeCount({}), 0);
  });

  test("the free-text box is not counted", () => {
    // It is on screen and visibly full; the count is for what the closed
    // sheet is hiding.
    assert.strictEqual(activeCount({ query: "tan" }), 0);
  });

  test("each set filter counts once", () => {
    assert.strictEqual(activeCount({ donor: "tan", statuses: ["paid"] }), 2);
    assert.strictEqual(
      activeCount({ from: "2026-09-01", to: "2026-09-30", campaigns: ["c1"] }),
      3
    );
  });

  test("whitespace is not a filter", () => {
    assert.strictEqual(activeCount({ donor: "  ", receiptNo: "" }), 0);
  });
}

/* ── Words ──────────────────────────────────────────────────────────────── */

function words() {
  suite("The words a donation is shown in");

  test("a campaign shows both its names", () => {
    assert.strictEqual(
      campaignLabel(donation()),
      "Vesak Day Offering · 卫塞节供僧大典"
    );
  });

  test("one name alone draws no separator", () => {
    assert.strictEqual(
      campaignLabel(donation({ campaignName: { en: "Vesak Day Offering" } })),
      "Vesak Day Offering"
    );
    assert.strictEqual(
      campaignLabel(donation({ campaignName: { "zh-Hans": "卫塞节供僧大典" } })),
      "卫塞节供僧大典"
    );
  });

  test("a campaign that has gone falls back to its slug", () => {
    assert.strictEqual(campaignLabel(donation({ campaignName: {} })), "vesak-2026");
    assert.strictEqual(
      campaignLabel(donation({ campaignName: {}, campaignSlug: null })),
      "Unknown campaign"
    );
  });

  test("the currency is written out", () => {
    assert.strictEqual(amountLabel(300), "SGD 300");
    assert.strictEqual(amountLabel(1500), "SGD 1,500");
    assert.strictEqual(amountLabel(null), "SGD 0");
  });

  test("dates are written day-first, in Singapore time", () => {
    assert.strictEqual(dateLabel("2026-09-12T06:41:00.000Z"), "12 Sep 2026");
    // 5pm UTC is next-day 1am in Singapore, and the office's date is the one
    // shown. This is the display half of the range check above.
    assert.strictEqual(dateLabel("2026-09-30T17:00:00.000Z"), "1 Oct 2026");
  });

  test("the time of day is Singapore's, on a twelve-hour clock", () => {
    assert.strictEqual(
      dateLabel("2026-09-12T06:41:00.000Z", true),
      "12 Sep 2026, 2:41pm"
    );
    assert.strictEqual(
      dateLabel("2026-09-12T16:05:00.000Z", true),
      "13 Sep 2026, 12:05am"
    );
    assert.strictEqual(
      dateLabel("2026-09-12T04:00:00.000Z", true),
      "12 Sep 2026, 12:00pm"
    );
  });

  test("the month is spelled the same wherever it is read", () => {
    // Not toLocaleDateString: en-SG renders this month as "Sept" and en-GB
    // as "Sep", and which one an admin sees would depend on their browser.
    assert.strictEqual(dateLabel("2026-09-01T02:00:00.000Z"), "1 Sep 2026");
  });

  test("a missing or unreadable date is a dash, not a crash", () => {
    assert.strictEqual(dateLabel(null), "—");
    assert.strictEqual(dateLabel("soon"), "—");
  });

  test("statuses have the office's words", () => {
    assert.strictEqual(statusLabel("paid"), "Paid");
    assert.strictEqual(statusLabel("pending-payment"), "Pending payment");
    assert.strictEqual(
      statusLabel("pending-confirmation"),
      "Pending payment confirmation"
    );
  });

  test("an unknown status still reads as something", () => {
    assert.strictEqual(statusLabel("nonsense"), "Pending payment");
  });

  test("contact methods are worded, and none is a dash", () => {
    assert.strictEqual(contactLabel(["whatsapp", "sms"]), "WhatsApp, SMS");
    assert.strictEqual(contactLabel([]), "—");
    assert.strictEqual(contactLabel(null), "—");
  });

  test("recipients fit on one line, and the rest are counted", () => {
    assert.strictEqual(recipientsLabel(["A", "B"]), "A, B");
    assert.strictEqual(recipientsLabel(["A", "B", "C"]), "A, B and 1 more");
    assert.strictEqual(
      recipientsLabel(["A", "B", "C", "D", "E", "F", "G"]),
      "A, B and 5 more"
    );
  });

  test("no recipients is an empty line, so the card can leave it out", () => {
    assert.strictEqual(recipientsLabel([]), "");
    assert.strictEqual(recipientsLabel(null), "");
  });
}

folding();
searching();
dates();
filtering();
ordering();
counting();
words();
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
