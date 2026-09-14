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
  REFERENCE_ALPHABET,
  WISHES_MAX,
  countCharacters,
  isOpen,
  makeReference,
  normaliseLocale,
  publicCampaign,
  validateDonation,
};
