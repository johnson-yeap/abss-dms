/*
 * Puts campaigns into Firestore.
 *
 * A stopgap with a known end: the admin portal's Campaigns module is where
 * these will be written from, and when it exists this file should be deleted
 * rather than kept as a second way to do the same thing.
 *
 * It talks to the Firestore REST API with an access token from gcloud rather
 * than using firebase-admin, and that is deliberate: firebase-admin wants
 * application-default credentials, which means another interactive login and a
 * key cached in a well-known place on this machine. A token minted for one
 * command and thrown away is less to leave lying around.
 *
 *   gcloud auth login                          once, if you have not
 *   node tools/seed-campaigns.cjs --dry-run    see what it would write
 *   node tools/seed-campaigns.cjs              write it
 *
 * Documents are keyed by slug, so running it twice updates rather than
 * duplicates. It never deletes: a campaign taken down is `active: false` in
 * the admin portal, not a row removed from under a donor mid-donation.
 */

const { execFileSync } = require("child_process");

const PROJECT = process.env.PROJECT || "abss-dms";
const ACCOUNT = process.env.ACCOUNT || "amitabha.abss.tech@gmail.com";
const DRY = process.argv.includes("--dry-run");

// Dates are stored as plain ISO days, not timestamps. A campaign runs for a
// day in Singapore, not from an instant — and a timestamp would invite the
// question of whose midnight it means every time somebody read one.
const CAMPAIGNS = [
  {
    slug: "vesak-2026",
    active: true,
    referencePrefix: "VSK",
    photoUrl: null,
    name: {
      "zh-Hans": "卫塞节供僧大典",
      "zh-Hant": "衛塞節供僧大典",
      "en": "Vesak Day Offering",
    },
    description: {
      "zh-Hans": "谨订于卫塞节举行供僧大典，恭请十方善信随喜护持，共沾法喜。所得善款将用于道场日常运作及弘法活动。",
      "zh-Hant": "謹訂於衛塞節舉行供僧大典，恭請十方善信隨喜護持，共沾法喜。所得善款將用於道場日常運作及弘法活動。",
      "en": "An offering ceremony held on Vesak Day. All are warmly invited to take part. Gifts received support the temple's daily running and its teaching work.",
    },
    campaignStart: "2026-03-01",
    campaignEnd: "2026-12-31",
    eventStart: "2026-05-31",
    eventEnd: "2026-05-31",
    amounts: [100, 300],
  },
  {
    slug: "kathina-2026",
    active: true,
    referencePrefix: "KTH",
    photoUrl: null,
    name: {
      "zh-Hans": "卡提那功德衣法会",
      "zh-Hant": "卡提那功德衣法會",
      "en": "Kathina Robe Offering",
    },
    description: {
      "zh-Hans": "雨安居圆满，谨设卡提那功德衣法会，广邀善信共襄盛举，同种福田。",
      "zh-Hant": "雨安居圓滿，謹設卡提那功德衣法會，廣邀善信共襄盛舉，同種福田。",
      "en": "Marking the end of the rains retreat with the traditional offering of robes. All are welcome to join.",
    },
    campaignStart: "2026-08-01",
    campaignEnd: "2026-11-30",
    eventStart: "2026-10-25",
    eventEnd: "2026-10-25",
    amounts: [100, 300],
  },
];

/**
 * Turns a plain value into Firestore's typed JSON.
 *
 * Integers are tagged integerValue and sent as strings, which is what the REST
 * API wants: a JSON number would come back as a double, and an amount of 100.0
 * would not match the `includes(amount)` check the API does on the way in.
 *
 * @param {*} value - Anything storable.
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
 * @param {Object} campaign - One campaign.
 * @param {string} bearer - The access token.
 * @returns {Promise<void>} When written.
 */
async function write(campaign, bearer) {
  const url =
    `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)` +
    `/documents/campaigns/${encodeURIComponent(campaign.slug)}`;

  const response = await fetch(url, {
    method: "PATCH",
    headers: {
      "Authorization": `Bearer ${bearer}`,
      "Content-Type": "application/json",
      "x-goog-user-project": PROJECT,
    },
    body: JSON.stringify({ fields: toFields(campaign) }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`${campaign.slug}: HTTP ${response.status} ${detail.slice(0, 300)}`);
  }
  console.log(`  wrote campaigns/${campaign.slug}`);
}

(async () => {
  if (DRY) {
    console.log(`Would write ${CAMPAIGNS.length} campaigns to ${PROJECT}:`);
    for (const c of CAMPAIGNS) {
      console.log(`  ${c.slug}  ${c.name["zh-Hans"]}  ${c.campaignStart}..${c.campaignEnd}  ` +
        `amounts ${c.amounts.join("/")}`);
    }
    return;
  }

  console.log(`Writing ${CAMPAIGNS.length} campaigns to ${PROJECT} as ${ACCOUNT}`);
  const bearer = token();
  for (const campaign of CAMPAIGNS) {
    await write(campaign, bearer);
  }
  console.log("done");
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
