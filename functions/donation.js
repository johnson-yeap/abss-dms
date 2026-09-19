/*
 * What a donation is, and what the public API will accept as one.
 *
 * Pure: no Firestore, no network, no clock it does not take as an argument.
 * Everything here is the part worth being sure about — this is the one place
 * in the project that takes input from an anonymous stranger on the internet
 * and turns it into a stored record with somebody's phone number in it.
 *
 * The validator is deliberately not a schema library. There are seven fields,
 * their rules are specific ("at most 100 characters" is the product's rule,
 * not a type), and the errors have to be translatable keys rather than
 * sentences, because the page asking for them is in one of three languages.
 */

// The locales the app is published in. The order is the order the language
// toggle draws them.
const LOCALES = ["zh-Hans", "zh-Hant", "en"];

// What the app opens in when the URL says nothing. Simplified Chinese, which
// is what most of this temple's donors read.
const DEFAULT_LOCALE = "zh-Hans";

// The amounts the form offers, in whole dollars. A closed set rather than a
// minimum, because the dropdown is closed: an amount that is not one of these
// did not come from the form.
const AMOUNTS = [100, 300];

const PAY_METHODS = ["paynow", "cash"];

const CONTACT_METHODS = ["whatsapp", "sms", "call"];

// The product's limit, stated once. The textarea says maxlength and the
// counter counts down to it, but neither is a check — both are in the browser.
const WISHES_MAX = 100;

const NAME_MAX = 80;

// The names a donation is offered on behalf of. Optional, and separate from
// `wishes` rather than parsed out of it: a wish is a sentence and a recipient
// is a name, and the office searches for the second by typing a name into a
// box. Splitting a sentence into names is guesswork that would be wrong in
// three languages at once.
//
// Ten because that is a family, and a donation naming more than ten people is
// a list somebody meant to attach rather than type. Each name gets the donor's
// own limit, since they are the same kind of thing.
const RECIPIENTS_MAX = 10;
const RECIPIENT_MAX = NAME_MAX;

// What has happened to the money, in the three states the office distinguishes.
//
//   pending-payment       nothing has arrived. Every donation starts here,
//                         whichever method was chosen: a PayNow donor who has
//                         been shown a QR has not thereby transferred, and a
//                         cash pledge is not cash.
//   pending-confirmation  money has been observed — a transfer seen, an
//                         envelope taken — and has not been reconciled.
//   paid                  reconciled, and a receipt number issued.
//
// Nothing in this system moves a donation along on its own; see the note in
// publicapi.js about what does not watch a bank account.
const STATUSES = ["pending-payment", "pending-confirmation", "paid"];


// Loose on purpose. This is Singapore-first but a donor may be reachable on a
// foreign mobile, and a phone validator that is stricter than the world is a
// validator that turns away real donations. Digits, spaces and the usual
// punctuation, eight to twenty digits once the punctuation is out.
const PHONE_ALLOWED = /^[+0-9()\-.\s]+$/;
const PHONE_MIN_DIGITS = 8;
const PHONE_MAX_DIGITS = 15;

// The alphabet a reference code is drawn from: no 0/O, no 1/I/L. These are
// read off a screen and typed into a banking app by somebody who is not
// looking at the screen any more, and those are the pairs that get confused.
const REFERENCE_ALPHABET = "23456789ACDEFGHJKMNPQRTUVWXY";
const REFERENCE_BODY = 6;

/**
 * @param {*} value - Anything.
 * @returns {string} The value as a trimmed string, or "".
 */
function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Counts what a person would call characters.
 *
 * [...string] rather than .length, because .length counts UTF-16 code units
 * and the wishes on this form are mostly Chinese — and, on a phone keyboard,
 * frequently emoji. "🙏🙏" is two characters to a donor and four to .length,
 * and a limit that disagrees with the counter under the box is a limit that
 * looks broken.
 *
 * @param {string} value - The text.
 * @returns {number} Characters, as counted by a reader.
 */
function countCharacters(value) {
  return [...value].length;
}

/**
 * @param {string} value - A phone number as typed.
 * @returns {number} How many digits are in it.
 */
function countDigits(value) {
  return (value.match(/[0-9]/g) || []).length;
}

/**
 * Builds the code the donor is asked to type into PayNow's reference field.
 *
 * A static PayNow QR carries no amount and no reference, so the transfer that
 * arrives at the bank says only that somebody sent money. This code is the
 * only thread between that line on a bank statement and a row in `donations`.
 *
 * The campaign's own prefix leads, so the office can see which campaign a
 * payment belongs to without looking anything up.
 *
 * @param {string} prefix - The campaign's reference prefix, e.g. "VSK".
 * @param {Function} random - () => number in [0, 1). Injected to be testable.
 * @returns {string} e.g. "VSK-7Q2M9C".
 */
function makeReference(prefix, random = Math.random) {
  let body = "";
  for (let i = 0; i < REFERENCE_BODY; i += 1) {
    body += REFERENCE_ALPHABET[Math.floor(random() * REFERENCE_ALPHABET.length)];
  }
  const head = text(prefix).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
  return head ? `${head}-${body}` : body;
}

/**
 * @param {*} value - Anything.
 * @returns {string} A known locale, falling back to the default.
 */
function normaliseLocale(value) {
  return LOCALES.includes(value) ? value : DEFAULT_LOCALE;
}

/**
 * Checks one submitted donation form.
 *
 * Returns the errors as field/code pairs rather than sentences: the page that
 * asked for these is in Simplified Chinese, Traditional Chinese or English,
 * and the server does not know which of its three phrasings to send back.
 * The browser owns the wording; this owns whether the value is acceptable.
 *
 * @param {Object} body - The posted JSON.
 * @param {Object} campaign - The campaign it claims to be for.
 * @returns {Object} {ok, errors: [{field, code}], value}.
 */
function validateDonation(body, campaign) {
  const errors = [];
  const input = body && typeof body === "object" ? body : {};

  const name = text(input.name);
  if (!name) {
    errors.push({ field: "name", code: "required" });
  } else if (countCharacters(name) > NAME_MAX) {
    errors.push({ field: "name", code: "too-long" });
  }

  const phone = text(input.phone);
  if (!phone) {
    errors.push({ field: "phone", code: "required" });
  } else if (!PHONE_ALLOWED.test(phone)) {
    errors.push({ field: "phone", code: "invalid" });
  } else {
    const digits = countDigits(phone);
    if (digits < PHONE_MIN_DIGITS || digits > PHONE_MAX_DIGITS) {
      errors.push({ field: "phone", code: "invalid" });
    }
  }

  // Optional, and deduplicated rather than rejected for repeats: a repeated
  // value is a browser sending the same checkbox twice, which is not the
  // donor's mistake to be told about.
  const rawContact = Array.isArray(input.contact) ? input.contact : [];
  const contact = [...new Set(rawContact.filter((m) => CONTACT_METHODS.includes(m)))];

  // Number(...) rather than parseInt: "100abc" is not 100, and a dropdown
  // cannot produce it. Anything that is not exactly an offered amount is
  // refused rather than rounded to the nearest one.
  const amount = Number(input.amount);
  const offered = campaign && Array.isArray(campaign.amounts) && campaign.amounts.length ?
    campaign.amounts :
    AMOUNTS;
  if (!offered.includes(amount)) {
    errors.push({ field: "amount", code: "invalid" });
  }

  // Blank rows are dropped rather than refused. The form adds a row when the
  // donor presses Add, and an empty one left behind is a row they thought
  // better of — not a mistake to stop the donation for.
  //
  // Not deduplicated, unlike contact above. Two people really can share a
  // name, and a family offering on behalf of two relatives called 陈美玲 would
  // find one of them silently dropped.
  const rawRecipients = Array.isArray(input.recipients) ? input.recipients : [];
  const recipients = rawRecipients.map(text).filter(Boolean);
  if (recipients.length > RECIPIENTS_MAX) {
    errors.push({ field: "recipients", code: "too-many" });
  }
  if (recipients.some((one) => countCharacters(one) > RECIPIENT_MAX)) {
    errors.push({ field: "recipients", code: "too-long" });
  }

  const wishes = text(input.wishes);
  if (countCharacters(wishes) > WISHES_MAX) {
    errors.push({ field: "wishes", code: "too-long" });
  }

  const payBy = text(input.payBy).toLowerCase();
  if (!PAY_METHODS.includes(payBy)) {
    errors.push({ field: "payBy", code: "invalid" });
  }

  return {
    ok: errors.length === 0,
    errors,
    value: {
      name,
      phone,
      contact,
      amount,
      recipients,
      wishes,
      payBy,
      locale: normaliseLocale(input.locale),
    },
  };
}

/**
 * Reduces a stored campaign to what the public app is allowed to see.
 *
 * An allowlist rather than a delete-list. The admin portal will grow fields on
 * these documents — an internal note, who created it, a target the temple has
 * not published — and the safe default for a field nobody has thought about
 * yet is that the public site does not serve it.
 *
 * @param {string} id - The document id.
 * @param {Object} doc - The stored campaign.
 * @returns {Object} The public shape.
 */
function publicCampaign(id, doc) {
  return {
    id,
    slug: doc.slug || id,
    photoUrl: doc.photoUrl || null,
    name: doc.name || {},
    description: doc.description || {},
    campaignStart: doc.campaignStart || null,
    campaignEnd: doc.campaignEnd || null,
    eventStart: doc.eventStart || null,
    eventEnd: doc.eventEnd || null,
    amounts: Array.isArray(doc.amounts) && doc.amounts.length ? doc.amounts : AMOUNTS,
  };
}

/**
 * Reads a stored status as one of the three.
 *
 * Everything unrecognised falls to pending-payment, and the fall is the point
 * rather than a default. Records written by the first version of the donor
 * form carry a flat "pending", which meant exactly this. And a status this
 * file has never heard of is a record the office has not finished with —
 * reading it as paid would be the one mistake here that loses money quietly.
 *
 * @param {*} value - Anything a stored donation's `status` might be.
 * @returns {string} One of STATUSES.
 */
function normaliseStatus(value) {
  const status = text(value);
  return STATUSES.includes(status) ? status : STATUSES[0];
}

/**
 * Reduces a stored donation to what the admin portal reads.
 *
 * An allowlist, for the same reason publicCampaign() is one — but note what
 * it is protecting against here, which is different. Nobody outside the
 * allowlist reaches this. What it buys is that a field added to a donation
 * later (an internal note, who reconciled it, a bank reference) does not
 * appear in the portal's search index and on a phone screen because somebody
 * wrote it to the document.
 *
 * The campaign's name is passed in rather than read off the donation. It is
 * not stored on the donation on purpose: a name copied at donation time is a
 * second copy that goes stale the first time a campaign is renamed, and the
 * office would then have two spellings of one campaign in its filter.
 *
 * @param {string} id - The document id.
 * @param {Object} doc - The stored donation.
 * @param {Object} [campaign] - The campaign it belongs to, if it was found.
 * @returns {Object} The shape the portal reads.
 */
function adminDonation(id, doc, campaign = null) {
  return {
    id,
    donor: doc.name || "",
    phone: doc.phone || "",
    contact: Array.isArray(doc.contact) ? doc.contact : [],
    amount: typeof doc.amount === "number" ? doc.amount : 0,
    recipients: Array.isArray(doc.recipients) ? doc.recipients : [],
    wishes: doc.wishes || "",
    payBy: doc.payBy || "",
    locale: doc.locale || DEFAULT_LOCALE,
    campaignId: doc.campaignId || null,
    campaignSlug: doc.campaignSlug || null,
    // An empty object rather than null when the campaign has gone: the portal
    // then has one shape to read and shows the slug it still has, instead of
    // a card with a hole where a campaign should be.
    campaignName: (campaign && campaign.name) || {},
    reference: doc.reference || "",
    status: normaliseStatus(doc.status),
    // Both nullable, and both only ever set by hand. A receipt number on a
    // record that is not paid, or a paid date on one with no number, is a
    // disagreement the portal shows rather than hides — see the note in
    // donations.mjs about why neither is derived from the other.
    receiptNo: doc.receiptNo || null,
    paidAt: stamp(doc.paidAt),
    createdAt: stamp(doc.createdAt),
  };
}

/**
 * Reads a stored timestamp as an ISO string.
 *
 * Firestore hands back a Timestamp, the local harness hands back the ISO
 * string it stored, and a seeded record may carry either. All three become
 * one string here, because the portal sorts and filters on these and
 * comparing a Timestamp with a string silently orders neither.
 *
 * @param {*} value - A Timestamp, a Date, an ISO string, or nothing.
 * @returns {string|null} An ISO string, or null.
 */
function stamp(value) {
  if (!value) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value.toDate === "function") {
    return value.toDate().toISOString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return null;
}

/**
 * Whether a campaign should be listed or accept a donation right now.
 *
 * `active` is the temple's switch and is checked first: an unpublished
 * campaign is invisible whatever its dates say. The window is inclusive of
 * both ends, and a missing end date means it has not closed rather than that
 * it closed at the epoch — the failure mode of the other reading is a
 * campaign that silently refuses money.
 *
 * @param {Object} doc - The stored campaign.
 * @param {number} now - Milliseconds since the epoch.
 * @returns {boolean} Whether it is open.
 */
function isOpen(doc, now) {
  if (!doc || doc.active !== true) {
    return false;
  }
  const start = doc.campaignStart ? Date.parse(doc.campaignStart) : null;
  const end = doc.campaignEnd ? Date.parse(doc.campaignEnd) : null;
  if (start !== null && !Number.isNaN(start) && now < start) {
    return false;
  }
  if (end !== null && !Number.isNaN(end) && now > end) {
    return false;
  }
  return true;
}

module.exports = {
  AMOUNTS,
  CONTACT_METHODS,
  DEFAULT_LOCALE,
  LOCALES,
  NAME_MAX,
  PAY_METHODS,
  RECIPIENTS_MAX,
  RECIPIENT_MAX,
  REFERENCE_ALPHABET,
  STATUSES,
  WISHES_MAX,
  adminDonation,
  countCharacters,
  isOpen,
  makeReference,
  normaliseLocale,
  normaliseStatus,
  publicCampaign,
  validateDonation,
};
