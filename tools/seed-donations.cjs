/*
 * Puts donations into Firestore, so the Donations module has something to be
 * looked at with.
 *
 * A stopgap with a known end, like seed-campaigns.cjs, but a shorter one. Real
 * donations arrive through the public form; these exist because the searching
 * and filtering in the portal cannot be judged against three records, and
 * because half the cases that matter — a status nobody has moved, a campaign
 * that has been deleted, a date that falls on the other side of midnight in
 * Singapore — are ones a donor cannot produce on demand. Delete this file once
 * the temple is running on real data.
 *
 * It writes what the office would have written by hand. Every record here
 * carries a status, and the ones marked paid carry a receipt number and a paid
 * date, because nothing in this system sets those: see the note in
 * publicapi.js about what does not watch a bank account.
 *
 * Like seed-campaigns.cjs it talks to the Firestore REST API with a token from
 * gcloud rather than using firebase-admin, so there is no application-default
 * credential cached on this machine afterwards.
 *
 *   gcloud auth login                          once, if you have not
 *   node tools/seed-donations.cjs --dry-run    see what it would write
 *   node tools/seed-donations.cjs              write it
 *
 * Documents are keyed by reference, so running it twice updates rather than
 * duplicates. It never deletes.
 */

const { execFileSync } = require("child_process");

const PROJECT = process.env.PROJECT || "abss-dms";
const ACCOUNT = process.env.ACCOUNT || "amitabha.abss.tech@gmail.com";
const DRY = process.argv.includes("--dry-run");

// The campaigns these belong to, by the slug seed-campaigns.cjs writes. The
// document id is looked up rather than assumed, because a campaign keyed by
// slug has an id equal to its slug — and writing that assumption in here
// would be a second place for it to be true.
const VESAK = "vesak-2026";
const KATHINA = "kathina-2026";

/**
 * @param {Object} fields - What differs from the common shape.
 * @returns {Object} One donation, as the public form would have stored it,
 *   plus whatever the office has since written on it.
 */
function donation(fields) {
  return {
    contact: ["whatsapp"],
    recipients: [],
    wishes: "",
    payBy: "paynow",
    locale: "zh-Hans",
    status: "pending-payment",
    receiptNo: null,
    paidAt: null,
    ...fields,
  };
}

// Deliberately varied. Each of these is a case the module has to draw without
// looking broken, and several are cases a tidy fixture set would miss:
//
//   all three statuses, and both payment methods
//   a donation with no recipients, and one naming more than a card can show
//   names in Simplified Chinese, in Traditional Chinese, and in English
//   a Singaporean name with a slash in it, which the search must not fold away
//   a donation whose paid date is in a different month from its submitted one
//   one just after midnight Singapore time, which is the previous day in UTC
const DONATIONS = [
  donation({
    reference: "VSK-7Q2M9C",
    campaignSlug: VESAK,
    name: "Tan Mei Ling",
    phone: "+65 9123 4567",
    amount: 300,
    recipients: ["Tan Ah Kow", "Lim Siew Hoon"],
    wishes: "合家平安，身体健康",
    status: "paid",
    receiptNo: "R-2026-00841",
    paidAt: "2026-09-12T06:41:00.000Z",
    createdAt: "2026-09-11T02:10:00.000Z",
  }),
  donation({
    reference: "VSK-3TAWQE",
    campaignSlug: VESAK,
    name: "Kavitha d/o Raman",
    phone: "+65 9887 2200",
    amount: 100,
    recipients: ["Raman s/o Kumar"],
    contact: [],
    locale: "en",
    status: "paid",
    receiptNo: "R-2026-00840",
    paidAt: "2026-09-04T01:15:00.000Z",
    createdAt: "2026-08-30T23:40:00.000Z",
  }),
  donation({
    reference: "KTH-9MPX3C",
    campaignSlug: KATHINA,
    name: "陈美玲",
    phone: "+65 9011 7788",
    amount: 300,
    recipients: ["陈大明", "陈小明", "陈美玲", "陈家全体"],
    wishes: "愿以此功德，回向法界众生",
    locale: "zh-Hant",
    status: "pending-confirmation",
    createdAt: "2026-09-17T11:30:00.000Z",
  }),
  donation({
    reference: "KTH-8DQR2M",
    campaignSlug: KATHINA,
    name: "Sasi Nair",
    phone: "+65 8123 9090",
    amount: 300,
    payBy: "cash",
    contact: ["call"],
    locale: "en",
    status: "pending-confirmation",
    // 1 October, 1am, in Singapore. Here so that a date range ending on 30
    // September can be seen not to include it.
    createdAt: "2026-09-30T17:00:00.000Z",
  }),
  donation({
    reference: "VSK-6HNPQD",
    campaignSlug: VESAK,
    name: "Lim Guan Choo",
    phone: "+65 8222 1111",
    amount: 100,
    recipients: ["Lim Ah Bee"],
    wishes: "🙏",
    locale: "en",
    createdAt: "2026-08-29T05:00:00.000Z",
  }),
  donation({
    reference: "VSK-5RKT8W",
    campaignSlug: VESAK,
    name: "Goh Hui Min",
    phone: "+65 9445 3321",
    amount: 100,
    payBy: "cash",
    contact: ["sms"],
    createdAt: "2026-09-19T01:05:00.000Z",
  }),
];

/**
 * @param {*} value - Anything JSON-ish.
 * @returns {Object} A Firestore Value.
 */
function toValue(value) {
  if (value === null || value === undefined) {
    return { nullValue: null };
  }
  if (typeof value === "boolean") {
    return { booleanValue: value };
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ?
      { integerValue: String(value) } :
      { doubleValue: value };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(toValue) } };
  }
  if (typeof value === "object") {
    return { mapValue: { fields: toFields(value) } };
  }
  return { stringValue: String(value) };
}

/**
 * @param {Object} object - A plain object.
 * @returns {Object} Firestore fields.
 */
function toFields(object) {
  const fields = {};
  for (const [key, value] of Object.entries(object)) {
    // The two dates are timestamps rather than strings. Firestore orders
    // timestamps properly and the portal reads them through adminDonation(),
    // which turns whichever shape it is handed into one ISO string.
    if ((key === "createdAt" || key === "paidAt") && value) {
      fields[key] = { timestampValue: value };
      continue;
    }
    fields[key] = toValue(value);
  }
  return fields;
}

/**
 * @returns {string} An access token for the Firestore API.
 */
function token() {
  return execFileSync("gcloud", ["auth", "print-access-token", `--account=${ACCOUNT}`], {
    encoding: "utf8",
  }).trim();
}

/**
 * Finds the document id of a campaign by its slug.
 *
 * Looked up rather than assumed. seed-campaigns.cjs happens to key campaigns
 * by slug, so the two are the same string today — but the donation stores
 * both, and a seeded record whose campaignId was a guess would join to
 * nothing the day that stops being true.
 *
 * @param {string} slug - The campaign's slug.
 * @param {string} bearer - The access token.
 * @returns {Promise<string|null>} Its document id, or null.
 */
async function campaignId(slug, bearer) {
  const url =
    `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)` +
    `/documents:runQuery`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${bearer}`,
      "Content-Type": "application/json",
      "x-goog-user-project": PROJECT,
    },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: "campaigns" }],
        where: {
          fieldFilter: {
            field: { fieldPath: "slug" },
            op: "EQUAL",
            value: { stringValue: slug },
          },
        },
        limit: 1,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`campaign ${slug}: HTTP ${response.status}`);
  }
  const rows = await response.json();
  const found = rows.find((row) => row.document);
  return found ? found.document.name.split("/").pop() : null;
}

/**
 * @param {Object} one - One donation, with its campaignId resolved.
 * @param {string} bearer - The access token.
 * @returns {Promise<void>} When written.
 */
async function write(one, bearer) {
  const url =
    `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)` +
    `/documents/donations/${encodeURIComponent(one.reference)}`;

  const response = await fetch(url, {
    method: "PATCH",
    headers: {
      "Authorization": `Bearer ${bearer}`,
      "Content-Type": "application/json",
      "x-goog-user-project": PROJECT,
    },
    body: JSON.stringify({ fields: toFields(one) }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`${one.reference}: HTTP ${response.status} ${detail.slice(0, 300)}`);
  }
  console.log(`  wrote donations/${one.reference}`);
}

(async () => {
  if (DRY) {
    console.log(`Would write ${DONATIONS.length} donations to ${PROJECT}:`);
    for (const one of DONATIONS) {
      const forWhom = one.recipients.length ?
        `  for ${one.recipients.join(", ")}` :
        "";
      console.log(`  ${one.reference}  ${one.name}  S$${one.amount}  ` +
        `${one.campaignSlug}  [${one.status}]${one.receiptNo ? `  ${one.receiptNo}` : ""}` +
        forWhom);
    }
    return;
  }

  console.log(`Writing ${DONATIONS.length} donations to ${PROJECT} as ${ACCOUNT}`);
  const bearer = token();

  // Resolved once per campaign rather than once per donation.
  const ids = new Map();
  for (const slug of new Set(DONATIONS.map((one) => one.campaignSlug))) {
    const id = await campaignId(slug, bearer);
    if (!id) {
      throw new Error(
        `No campaign with slug "${slug}". Run tools/seed-campaigns.cjs first.`
      );
    }
    ids.set(slug, id);
  }

  for (const one of DONATIONS) {
    await write({ ...one, campaignId: ids.get(one.campaignSlug) }, bearer);
  }
  console.log("done");
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
