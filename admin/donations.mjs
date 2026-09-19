/*
 * Searching and filtering donations, and the words a donation is shown in.
 *
 * Pure: no DOM, no fetch, no clock it is not handed. Everything in here is a
 * function of its arguments, which is what lets donations.test.mjs run it
 * under Node with no browser and no Firebase project.
 *
 * Why this is a separate file, and why it is .mjs
 * ----------------------------------------------
 * The filter is the module. An admin looking up one donation on a phone is
 * doing exactly one thing — narrowing a few thousand records to the one they
 * are being asked about on the telephone — so a date boundary that is out by
 * a day, or a search that misses a name because of its case, is not a rough
 * edge but the whole feature failing. That is worth testing, and testing it
 * means importing it, and importing it means it cannot touch the DOM.
 *
 * The extension is .mjs because this repository has no package.json above
 * admin/ and no build step, so Node reads a bare .js as CommonJS and chokes
 * on `export`. The browser does not care about the extension at all; it is
 * the .mjs that lets the same file be both the page's module and the test's.
 *
 * Why the filtering is here and not in the API
 * --------------------------------------------
 * The portal loads every donation once and narrows in memory. It is the
 * right shape for a few thousand records and the wrong one for a million,
 * and LIST_CAP in admin.js is where that ceiling is written down. What it
 * buys is the thing the office actually wanted: results that change as you
 * type, substring matching rather than prefix matching, and any combination
 * of filters at once — none of which Firestore will do, and all of which are
 * free once the records are already in hand.
 */

// The three states, in the order they happen, with the words the office uses
// for them. The server stores the key; every place a reader sees one of these
// phrases, it comes from here.
export const STATUS_LABELS = {
  "pending-payment": "Pending payment",
  "pending-confirmation": "Pending payment confirmation",
  "paid": "Paid",
};

export const STATUS_ORDER = [
  "pending-payment",
  "pending-confirmation",
  "paid",
];

// Which date a record is shown and filtered by. Both are offered because the
// office asks two different questions of the same list: "what came in last
// week" is about when donors gave, and "what did we bank in September" is
// about when it cleared.
export const DATE_BASIS = ["submitted", "paid"];

const CONTACT_LABELS = {
  whatsapp: "WhatsApp",
  sms: "SMS",
  call: "Phone call",
};

const PAY_LABELS = {
  paynow: "PayNow",
  cash: "Cash",
};

// Every date in this module is a Singapore date.
//
// This is not a default; it is the fix for a bug that would otherwise be
// almost impossible to see. A stored donation is an instant in UTC. If the
// range filter compared those instants against UTC days while the column
// rendered them in whatever zone the admin's phone is set to, then a donation
// made at 1am on 1 October in Singapore — 5pm on 30 September in UTC — would
// be listed under "September" and displayed as "1 Oct 2026" in the same row.
// Both halves therefore work in one fixed zone, and this is the office's.
//
// A fixed offset rather than a timezone name, because Singapore has not
// observed daylight saving since 1935 and never will again, and a fixed
// offset needs no timezone database to be correct in a browser or in Node.
const TZ = "+08:00";
const TZ_MINUTES = 8 * 60;

// Written out rather than left to toLocaleDateString, which renders September
// as "Sept" under en-SG and as "Sep" under en-GB, and whose output depends on
// which ICU data the browser happens to ship. A list of dates that changes
// spelling between two admins' phones is a list that invites the question of
// which one is right.
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * Reads a stored date as an instant, however it was stored.
 *
 * A plain "2026-09-12" is a Singapore day, not a UTC midnight. Date.parse
 * reads a bare date as UTC, which would put it at 8am Singapore time —
 * harmless until it is a date near the edge of a filter range.
 *
 * @param {string|null} value - An ISO instant or a plain day.
 * @returns {Date|null} The instant, or null if it cannot be read.
 */
function instant(value) {
  const raw = text(value);
  if (!raw) {
    return null;
  }
  const at = new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00${TZ}` : raw);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * The year, month and day an instant falls on in Singapore.
 *
 * Shifted and then read in UTC rather than handed to toLocaleDateString with
 * a timeZone option: the arithmetic is the same, it cannot be undone by an
 * ICU build, and it is the same three numbers the day boundaries below are
 * built from.
 *
 * @param {Date} at - The instant.
 * @returns {Object} {year, month, day, hour, minute}.
 */
function parts(at) {
  const local = new Date(at.getTime() + TZ_MINUTES * 60 * 1000);
  return {
    year: local.getUTCFullYear(),
    month: local.getUTCMonth(),
    day: local.getUTCDate(),
    hour: local.getUTCHours(),
    minute: local.getUTCMinutes(),
  };
}

/**
 * @param {*} value - Anything.
 * @returns {string} The value as a trimmed string, or "".
 */
function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Folds a string to what a search should match on.
 *
 * Three things happen, and the third is the one that matters here. Case is
 * flattened. Runs of whitespace become one space, so "Tan  Ah Kow" typed with
 * a double space still finds "Tan Ah Kow". And the string is put through NFKC,
 * which is what makes a search box usable in this temple's two scripts at
 * once: full-width characters typed on a Chinese IME — Ａ, １, the full-width
 * space — fold onto the ASCII ones the same name was stored with.
 *
 * Deliberately not stripping accents or punctuation. "d/o" and "s/o" appear
 * in Singaporean names as written, and a fold that removed the slash would
 * make them unfindable by typing them.
 *
 * @param {*} value - Anything.
 * @returns {string} The folded form.
 */
export function fold(value) {
  return text(value).normalize("NFKC").toLowerCase().replace(/\s+/g, " ");
}

/**
 * Everything about one donation that the free-text box searches.
 *
 * Built once per record and cached on it by the caller, because it is
 * rebuilt for every record on every keystroke otherwise. Joined with a
 * newline rather than a space so that the end of one field and the start of
 * the next cannot combine into a match that is in neither: searching for
 * "ling vesak" should find nothing, not the record whose donor is Mei Ling
 * and whose campaign is Vesak.
 *
 * @param {Object} donation - As the API answers with.
 * @returns {string} The folded haystack.
 */
export function haystack(donation) {
  return [
    donation.donor,
    ...(donation.recipients || []),
    donation.receiptNo || "",
    donation.reference || "",
    // Not the phone number. It is on the detail view and not in the search
    // index: an admin searching "9123" should not be shown every donor whose
    // number happens to contain it, and the office looks people up by name.
  ]
    .map(fold)
    .join("\n");
}

/**
 * Which date a donation is shown and ordered by.
 *
 * Paid records are dated by when they were paid, everything else by when it
 * was submitted — and a paid record with no paid date falls back rather than
 * showing nothing, because a record can be marked paid by somebody who never
 * filled the date in.
 *
 * @param {Object} donation - As the API answers with.
 * @returns {string|null} An ISO string, or null.
 */
export function displayDate(donation) {
  if (donation.status === "paid" && donation.paidAt) {
    return donation.paidAt;
  }
  return donation.createdAt || null;
}

/**
 * The date a given basis filters on.
 *
 * @param {Object} donation - As the API answers with.
 * @param {string} basis - "submitted" or "paid".
 * @returns {string|null} An ISO string, or null.
 */
export function basisDate(donation, basis) {
  return basis === "paid" ? donation.paidAt || null : donation.createdAt || null;
}

/**
 * Whether an instant falls inside a range of whole Singapore days.
 *
 * The range is given as two plain days — what a date input produces — and is
 * inclusive of both, which is what "1 to 30 September" means to the person
 * who typed it. The end day is therefore taken to its own last millisecond,
 * not its midnight: the other reading loses every donation made on the last
 * day of the range, which is the one an admin is most often looking for.
 *
 * Both ends are read as Singapore days, so they line up with the dates in the
 * column beside them. See the note on TZ above for why that is not a detail.
 *
 * @param {string|null} iso - The instant, or null.
 * @param {string} from - "YYYY-MM-DD", or "" for no lower bound.
 * @param {string} to - "YYYY-MM-DD", or "" for no upper bound.
 * @returns {boolean} Whether it is in range.
 */
export function withinDays(iso, from, to) {
  const start = text(from);
  const end = text(to);
  if (!start && !end) {
    return true;
  }
  // A record with no date on the basis being filtered cannot be shown to be
  // inside the range, so it is out. This is why the basis toggle matters:
  // filtering by paid date hides everything unpaid, which is the point.
  const at = instant(iso);
  if (!at) {
    return false;
  }
  if (start) {
    const lower = new Date(`${start}T00:00:00.000${TZ}`);
    if (!Number.isNaN(lower.getTime()) && at < lower) {
      return false;
    }
  }
  if (end) {
    const upper = new Date(`${end}T23:59:59.999${TZ}`);
    if (!Number.isNaN(upper.getTime()) && at > upper) {
      return false;
    }
  }
  return true;
}

/**
 * Whether one donation survives the filters.
 *
 * Every filter is ANDed, and every empty filter passes everything. The
 * campaign and status filters are sets: an empty set means "all", not
 * "none" — the other reading gives an admin an empty screen the moment they
 * open the filter sheet and tick nothing.
 *
 * `query` and `recipient` are separate boxes on purpose. The first is the one
 * an admin types a half-remembered name into and searches everything; the
 * second is the specific question "which donations name this person", which
 * would otherwise be drowned by donors of the same name.
 *
 * @param {Object} donation - As the API answers with, plus a cached `_hay`.
 * @param {Object} filters - {query, donor, recipient, campaigns, statuses,
 *   receiptNo, from, to, basis}.
 * @returns {boolean} Whether it should be listed.
 */
export function matches(donation, filters = {}) {
  const query = fold(filters.query);
  if (query && !(donation._hay ?? haystack(donation)).includes(query)) {
    return false;
  }

  const donor = fold(filters.donor);
  if (donor && !fold(donation.donor).includes(donor)) {
    return false;
  }

  const recipient = fold(filters.recipient);
  if (recipient &&
      !(donation.recipients || []).some((one) => fold(one).includes(recipient))) {
    return false;
  }

  const receiptNo = fold(filters.receiptNo);
  if (receiptNo && !fold(donation.receiptNo).includes(receiptNo)) {
    return false;
  }

  const campaigns = filters.campaigns || [];
  if (campaigns.length && !campaigns.includes(donation.campaignId)) {
    return false;
  }

  const statuses = filters.statuses || [];
  if (statuses.length && !statuses.includes(donation.status)) {
    return false;
  }

  const basis = DATE_BASIS.includes(filters.basis) ? filters.basis : "submitted";
  return withinDays(basisDate(donation, basis), filters.from || "", filters.to || "");
}

/**
 * Narrows and orders a list of donations.
 *
 * Newest first, by the date each record is shown under, so the order on
 * screen is the order of the column being read. A record with no date at all
 * sorts last rather than first: it is a record something is wrong with, and
 * the top of the list belongs to today's donations.
 *
 * @param {Array} donations - Every donation held.
 * @param {Object} filters - As matches() takes.
 * @returns {Array} Those that survive, newest first.
 */
export function search(donations, filters = {}) {
  return (donations || [])
    .filter((one) => matches(one, filters))
    .sort((a, b) => {
      const left = displayDate(a) || "";
      const right = displayDate(b) || "";
      if (left === right) {
        return 0;
      }
      if (!left) {
        return 1;
      }
      if (!right) {
        return -1;
      }
      return right.localeCompare(left);
    });
}

/**
 * @param {Object} filters - As matches() takes.
 * @returns {number} How many filters are narrowing the list.
 *
 * Shown as a count on the filter button, because on a phone the filter sheet
 * is closed and an admin who has forgotten they left a status ticked would
 * otherwise be looking at an unexplained empty list. The free-text box is not
 * counted — it is on screen and visibly full.
 */
export function activeCount(filters = {}) {
  let count = 0;
  for (const key of ["donor", "recipient", "receiptNo", "from", "to"]) {
    if (text(filters[key])) {
      count += 1;
    }
  }
  for (const key of ["campaigns", "statuses"]) {
    if ((filters[key] || []).length) {
      count += 1;
    }
  }
  return count;
}

/* ── Words ──────────────────────────────────────────────────────────────── */

/**
 * A campaign's name as the listing shows it: English and Chinese together.
 *
 * Both, because neither alone is enough in this office. The portal is in
 * English and its readers scan it in English, but the campaigns are known and
 * spoken of by their Chinese names, and a donor on the telephone will say one
 * of those. Where a campaign has only one of the two, the separator is not
 * drawn — "Vesak Day Offering · " reads as a missing value rather than as a
 * campaign with no Chinese name.
 *
 * @param {Object} donation - As the API answers with.
 * @returns {string} The name, or the slug if there is none.
 */
export function campaignLabel(donation) {
  const name = donation.campaignName || {};
  const parts = [text(name.en), text(name["zh-Hans"])].filter(Boolean);
  if (parts.length) {
    return parts.join(" · ");
  }
  // The campaign has been deleted, or was never joined. The slug is what is
  // still known, and it is more use than an empty cell.
  return donation.campaignSlug || "Unknown campaign";
}

/**
 * @param {number} amount - Whole dollars.
 * @returns {string} e.g. "SGD 300".
 *
 * Written out rather than "$300". The temple takes donations from people who
 * bank in more than one currency, and a bare dollar sign on a receipt number
 * that will be quoted back over the telephone is the kind of ambiguity that
 * is cheap to remove here and expensive to discover later.
 */
export function amountLabel(amount) {
  return `SGD ${Number(amount || 0).toLocaleString("en-SG")}`;
}

/**
 * A date as the office writes it: 12 Sep 2026.
 *
 * Day before month, because that is how it is written in Singapore and the
 * alternative is a list in which 09/12 is ambiguous to half its readers. The
 * day is the Singapore one, not the reader's — an admin abroad should see the
 * date the temple's own records carry.
 *
 * @param {string|null} iso - An ISO instant.
 * @param {boolean} [withTime] - Whether to add the time of day.
 * @returns {string} The date, or "—".
 */
export function dateLabel(iso, withTime = false) {
  const at = instant(iso);
  if (!at) {
    return "—";
  }
  const { year, month, day, hour, minute } = parts(at);
  const date = `${day} ${MONTHS[month]} ${year}`;
  if (!withTime) {
    return date;
  }
  // A twelve-hour clock, because that is how the office says a time out loud.
  const suffix = hour < 12 ? "am" : "pm";
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${date}, ${twelve}:${String(minute).padStart(2, "0")}${suffix}`;
}

/**
 * @param {string} status - A stored status.
 * @returns {string} What a reader is shown.
 */
export function statusLabel(status) {
  return STATUS_LABELS[status] || STATUS_LABELS["pending-payment"];
}

/**
 * @param {Array} contact - The methods the donor agreed to.
 * @returns {string} Them, worded, or "—".
 */
export function contactLabel(contact) {
  const parts = (contact || []).map((one) => CONTACT_LABELS[one]).filter(Boolean);
  return parts.length ? parts.join(", ") : "—";
}

/**
 * @param {string} payBy - "paynow" or "cash".
 * @returns {string} Its word.
 */
export function payLabel(payBy) {
  return PAY_LABELS[payBy] || "—";
}

/**
 * The recipients as one line, and how many are not on it.
 *
 * A card has room for a line, not a list, and a donation naming eight people
 * would otherwise set the height of every card beside it. The overflow is
 * counted rather than cut mid-name: "and 5 more" is a number an admin can act
 * on, where a truncated name is one they cannot search for.
 *
 * @param {Array} recipients - The names.
 * @param {number} [limit] - How many to name.
 * @returns {string} The line, or "" when there are none.
 */
export function recipientsLabel(recipients, limit = 2) {
  const names = (recipients || []).filter(Boolean);
  if (!names.length) {
    return "";
  }
  if (names.length <= limit) {
    return names.join(", ");
  }
  const rest = names.length - limit;
  return `${names.slice(0, limit).join(", ")} and ${rest} more`;
}
