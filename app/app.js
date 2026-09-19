/*
 * The donor app.
 *
 * Three views behind a path: a list of open campaigns, one campaign's form,
 * and what to do once it is submitted. No framework, no bundler, same as the
 * admin portal.
 *
 * The locale is in the path rather than in a cookie or a header, because the
 * temple hands these links out: a poster with a QR code on it, a WhatsApp
 * message to a group. /zh-Hant/c/vesak-2026 opens in Traditional Chinese for
 * whoever taps it, on a phone that has never been here and has no preference
 * stored.
 *
 * Nothing here builds markup from a string. Campaign names, descriptions and
 * anything a donor typed reach the page through textContent or a cloned
 * <template> — this app shows text written by other people, and innerHTML
 * would be the one place that stops being safe.
 */

import { DEFAULT_LOCALE, LOCALES, LOCALE_NAMES, fill, t } from "./i18n.js";

const el = (id) => document.getElementById(id);

const state = {
  locale: DEFAULT_LOCALE,
  route: { view: "list" },
  campaign: null,
};

/* ── The path ───────────────────────────────────────────────────────────── */

/**
 * Reads the route out of the address bar.
 *
 * Shapes, all under a locale:
 *   /zh-Hans/                    the list
 *   /zh-Hans/c/<slug>            one campaign's form
 *   /zh-Hans/done/<reference>    after submitting
 *
 * A path with no known locale in front keeps whatever is left and is given the
 * default, which is what makes a bare / work.
 *
 * @param {string} pathname - location.pathname.
 * @returns {Object} {locale, view, slug, reference, hadLocale}.
 */
export function parsePath(pathname) {
  const parts = String(pathname).split("/").filter(Boolean);
  const hadLocale = LOCALES.includes(parts[0]);
  const locale = hadLocale ? parts[0] : DEFAULT_LOCALE;
  const rest = hadLocale ? parts.slice(1) : parts;

  if (rest[0] === "c" && rest[1]) {
    return { locale, view: "form", slug: decodeURIComponent(rest[1]), hadLocale };
  }
  if (rest[0] === "done" && rest[1]) {
    return {
      locale,
      view: "done",
      reference: decodeURIComponent(rest[1]),
      hadLocale,
    };
  }
  return { locale, view: "list", hadLocale };
}

/**
 * The address for a route in a given language.
 *
 * @param {string} locale - One of LOCALES.
 * @param {Object} route - {view, slug, reference}.
 * @returns {string} A path.
 */
export function buildPath(locale, route) {
  if (route.view === "form" && route.slug) {
    return `/${locale}/c/${encodeURIComponent(route.slug)}`;
  }
  if (route.view === "done" && route.reference) {
    return `/${locale}/done/${encodeURIComponent(route.reference)}`;
  }
  return `/${locale}/`;
}

/* ── Saying it in the right language ────────────────────────────────────── */

/**
 * Writes every phrase on the page in the current language.
 *
 * Walks data-i18n rather than keeping a list, so markup added later is
 * translated by existing in the document. Placeholders are a separate pass
 * because a placeholder is an attribute, not a text node.
 */
function applyStrings() {
  const locale = state.locale;

  for (const node of document.querySelectorAll("[data-i18n]")) {
    node.textContent = t(locale, node.dataset.i18n);
  }

  el("f-name").placeholder = t(locale, "form.namePlaceholder");
  el("f-phone").placeholder = t(locale, "form.phonePlaceholder");
  el("f-wishes").placeholder = t(locale, "form.wishesPlaceholder");
  // The recipient rows are built by this file rather than written in the
  // markup, so [data-i18n] above does not reach them. They are re-worded
  // here instead, which also covers the rows a donor has already added when
  // they switch language halfway through filling the form in.
  applyRecipientStrings();

  // The <html lang> decides which glyphs a browser picks for characters that
  // Simplified and Traditional share codepoints for, and which dictionary a
  // screen reader uses. Getting it wrong is not cosmetic.
  document.documentElement.lang = locale;
  document.title = `${t(locale, "app.donations")} · ABSS`;

  updateWishesCounter();
}

/**
 * Draws the language toggle.
 *
 * Real links, not buttons, so the languages can be opened in a new tab and are
 * seen by anything that reads links — the same page in another language is a
 * different address, and saying so is the honest markup.
 */
function drawLangs() {
  const nav = el("langs");
  nav.replaceChildren();

  for (const locale of LOCALES) {
    const link = document.createElement("a");
    link.className = "lang";
    link.textContent = LOCALE_NAMES[locale];
    link.href = buildPath(locale, state.route);
    link.lang = locale;
    if (locale === state.locale) {
      link.classList.add("is-current");
      link.setAttribute("aria-current", "true");
    }
    link.addEventListener("click", (event) => {
      // Left-click stays in the page; anything with a modifier is somebody
      // asking their browser for a new tab, and taking that over would be
      // rude.
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) {
        return;
      }
      event.preventDefault();
      go(buildPath(locale, state.route));
    });
    nav.append(link);
  }
}

/**
 * @param {Object} value - A {en, zh-Hans, zh-Hant} field from a campaign.
 * @returns {string} The best available text for the current language.
 */
function localised(value) {
  if (!value || typeof value !== "object") {
    return typeof value === "string" ? value : "";
  }
  // Falls back through the other two rather than showing nothing. A campaign
  // whose English description has not been written yet should still be
  // readable by an English reader — in Chinese, which is better than a blank
  // panel where the description goes.
  const order = [state.locale, DEFAULT_LOCALE, ...LOCALES];
  for (const key of order) {
    if (typeof value[key] === "string" && value[key].trim()) {
      return value[key];
    }
  }
  return "";
}

/**
 * @param {string} iso - A date as stored, or nothing.
 * @returns {string} The date written for the current language.
 */
function formatDate(iso) {
  if (!iso) {
    return "";
  }
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) {
    return "";
  }
  return new Intl.DateTimeFormat(state.locale, {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "Asia/Singapore",
  }).format(at);
}

/**
 * @param {string} from - Start date.
 * @param {string} to - End date.
 * @returns {string} "1 May – 3 May 2026", or one date, or "".
 */
function formatRange(from, to) {
  const a = formatDate(from);
  const b = formatDate(to);
  if (a && b) {
    return a === b ? a : `${a} – ${b}`;
  }
  return a || b || "";
}

/* ── Talking to the API ─────────────────────────────────────────────────── */

/**
 * @param {string} path - Below /api.
 * @param {Object} [options] - fetch options.
 * @returns {Promise<Object>} {ok, status, body}.
 */
async function api(path, options) {
  const response = await fetch(`/api${path}`, options);
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, body };
}

/* ── Views ──────────────────────────────────────────────────────────────── */

/**
 * @param {string} name - loading | error | list | form | done.
 */
function show(name) {
  el("view-loading").hidden = name !== "loading";
  el("view-error").hidden = name !== "error";
  el("view-list").hidden = name !== "list";
  el("view-form").hidden = name !== "form";
  el("view-done").hidden = name !== "done";
}

/**
 * @param {string} message - What went wrong, already translated.
 */
function showError(message) {
  el("error-text").textContent = message;
  show("error");
}

/**
 * Draws the list of open campaigns.
 *
 * @returns {Promise<void>} When it is on screen.
 */
async function renderList() {
  show("loading");
  const { ok, body } = await api("/campaigns");
  if (!ok) {
    showError(t(state.locale, "app.error"));
    return;
  }

  const cards = el("cards");
  cards.replaceChildren();
  const template = el("tpl-card");

  for (const campaign of body.campaigns || []) {
    const node = template.content.cloneNode(true);
    const link = node.querySelector(".card-link");
    link.href = buildPath(state.locale, { view: "form", slug: campaign.slug });
    link.addEventListener("click", (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) {
        return;
      }
      event.preventDefault();
      go(link.getAttribute("href"));
    });

    const photo = node.querySelector(".card-photo");
    if (campaign.photoUrl) {
      photo.src = campaign.photoUrl;
      photo.hidden = false;
    }

    node.querySelector(".card-name").textContent = localised(campaign.name);
    node.querySelector(".card-desc").textContent = localised(campaign.description);
    node.querySelector(".card-dates").textContent =
      formatRange(campaign.eventStart, campaign.eventEnd) ||
      formatRange(campaign.campaignStart, campaign.campaignEnd);
    node.querySelector(".card-go").textContent = t(state.locale, "list.donate");

    cards.append(node);
  }

  el("list-empty").hidden = (body.campaigns || []).length > 0;
  show("list");
}

/**
 * Draws one campaign and its form.
 *
 * @param {string} slug - Which campaign.
 * @returns {Promise<void>} When it is on screen.
 */
async function renderForm(slug) {
  show("loading");
  const { ok, status, body } = await api(`/campaigns/${encodeURIComponent(slug)}`);

  if (!ok) {
    // 410 and 404 are told apart, because "this ended" and "this never
    // existed" send a donor to two different places.
    showError(t(state.locale, status === 410 ? "campaign.closed" : "campaign.missing"));
    return;
  }

  const campaign = body.campaign;
  state.campaign = campaign;

  const photo = el("campaign-photo");
  if (campaign.photoUrl) {
    photo.src = campaign.photoUrl;
    photo.alt = localised(campaign.name);
    photo.hidden = false;
  } else {
    photo.hidden = true;
  }

  el("campaign-name").textContent = localised(campaign.name);
  el("campaign-desc").textContent = localised(campaign.description);

  const dates = el("campaign-dates");
  dates.replaceChildren();
  const rows = [
    ["campaign.period", formatRange(campaign.campaignStart, campaign.campaignEnd)],
    ["campaign.event", formatRange(campaign.eventStart, campaign.eventEnd)],
  ];
  for (const [key, value] of rows) {
    if (!value) {
      continue;
    }
    const dt = document.createElement("dt");
    dt.textContent = t(state.locale, key);
    const dd = document.createElement("dd");
    dd.textContent = value;
    dates.append(dt, dd);
  }

  const amount = el("f-amount");
  amount.replaceChildren();
  const choose = document.createElement("option");
  choose.value = "";
  choose.textContent = t(state.locale, "form.choose");
  amount.append(choose);
  for (const value of campaign.amounts || []) {
    const option = document.createElement("option");
    option.value = String(value);
    // Written here rather than translated: a dollar amount is the same number
    // in all three languages, and the currency is Singapore's in all three.
    option.textContent = `S$${value}`;
    amount.append(option);
  }

  clearErrors();
  show("form");
}

/**
 * Draws the page after a submission.
 *
 * The reference is in the path and the rest in the query, so this page
 * survives a reload and can be screenshotted — which is what the note on it
 * asks the donor to do. None of it is personal: an amount, a method, and a
 * code meant to be typed into a banking app.
 *
 * @param {string} reference - The donation's reference.
 */
function renderDone(reference) {
  const params = new URLSearchParams(location.search);
  const payBy = params.get("m") === "cash" ? "cash" : "paynow";
  const amount = params.get("a");

  el("done-reference").textContent = reference;
  el("done-amount").textContent = amount ? `S$${Number(amount)}` : "";
  el("done-paynow").hidden = payBy !== "paynow";
  el("done-cash").hidden = payBy !== "cash";
  el("done-home").href = buildPath(state.locale, { view: "list" });

  show("done");
}

/* ── Blessing recipients ────────────────────────────────────────────────── */

// The same limit the server holds, and the reason it is repeated rather than
// fetched: the button has to stop being pressable at the right moment, and a
// form that lets a donor type an eleventh name and then refuses the whole
// submission is a form that wasted their time. donation.js is still the one
// that decides; this only keeps the page from offering what it would refuse.
const RECIPIENTS_MAX = 10;

/**
 * Adds one empty recipient row.
 *
 * @param {boolean} [focus] - Whether to put the cursor in it.
 * @returns {void}
 */
function addRecipient(focus = false) {
  const rows = el("recipients-rows");
  if (rows.children.length >= RECIPIENTS_MAX) {
    return;
  }

  const row = el("tpl-recipient").content.firstElementChild.cloneNode(true);
  rows.appendChild(row);
  applyRecipientStrings();
  updateRecipientControls();

  if (focus) {
    row.querySelector(".recipient-name").focus();
  }
}

/**
 * Words every recipient row in the reader's language.
 *
 * @returns {void}
 */
function applyRecipientStrings() {
  const rows = el("recipients-rows");
  if (!rows) {
    return;
  }
  const placeholder = t(state.locale, "form.recipientsPlaceholder");
  const remove = t(state.locale, "form.recipientRemove");

  for (const row of rows.children) {
    row.querySelector(".recipient-name").placeholder = placeholder;
    // Both, and not a visible label: the ✕ is the whole button, so the
    // accessible name has to be the attribute, and the title is what a
    // pointer user gets. Ten rows of "Remove this name" read out in sequence
    // is the cost of the alternative being no name at all.
    const button = row.querySelector(".recipient-remove");
    button.setAttribute("aria-label", remove);
    button.title = remove;
  }
}

/**
 * Keeps the Add button and the remove buttons honest.
 *
 * The last remaining row keeps its remove button, and pressing it empties
 * that row rather than deleting it — see the handler. A form that can arrive
 * at zero rows is a form with a field that has vanished, and the donor has
 * no way to get it back except by pressing Add and wondering what happened.
 *
 * @returns {void}
 */
function updateRecipientControls() {
  const rows = el("recipients-rows");
  el("recipients-add").disabled = rows.children.length >= RECIPIENTS_MAX;
}

/**
 * @returns {Array<string>} What is typed in the rows, blanks dropped.
 */
function recipientValues() {
  return [...document.querySelectorAll(".recipient-name")]
    .map((input) => input.value.trim())
    .filter(Boolean);
}

/**
 * Puts the rows back to one empty one.
 *
 * @returns {void}
 */
function resetRecipients() {
  el("recipients-rows").replaceChildren();
  addRecipient();
}

/* ── The form ───────────────────────────────────────────────────────────── */

const ERROR_NODES = {
  name: "e-name",
  phone: "e-phone",
  amount: "e-amount",
  recipients: "e-recipients",
  wishes: "e-wishes",
  payBy: "e-payby",
};

/**
 * Clears every field error and the summary.
 */
function clearErrors() {
  for (const id of Object.values(ERROR_NODES)) {
    const node = el(id);
    node.hidden = true;
    node.textContent = "";
  }
  for (const input of document.querySelectorAll(".field [aria-invalid]")) {
    input.removeAttribute("aria-invalid");
  }
  el("form-error").hidden = true;
}

/**
 * Shows what the server refused, in the reader's language.
 *
 * The server sends field/code pairs rather than sentences, because it does not
 * know which of three phrasings the page is in. This is where they become
 * words.
 *
 * @param {Array} fields - [{field, code}].
 */
function showFieldErrors(fields) {
  clearErrors();
  const inputs = {
    name: el("f-name"),
    phone: el("f-phone"),
    amount: el("f-amount"),
    // The first row stands in for the group: a refusal on recipients is
    // about one of several boxes, and the server says which rule was broken
    // rather than which row broke it.
    recipients: document.querySelector(".recipient-name"),
    wishes: el("f-wishes"),
    payBy: el("f-payby"),
  };

  for (const { field, code } of fields || []) {
    const node = el(ERROR_NODES[field]);
    if (!node) {
      continue;
    }
    node.textContent = t(state.locale, `error.${field}.${code}`);
    node.hidden = false;
    if (inputs[field]) {
      inputs[field].setAttribute("aria-invalid", "true");
    }
  }

  el("form-error").textContent = t(state.locale, "error.form");
  el("form-error").hidden = false;

  const first = (fields || [])[0];
  if (first && inputs[first.field]) {
    inputs[first.field].focus();
  }
}

/**
 * Counts the wishes box down, in characters as a reader counts them.
 */
function updateWishesCounter() {
  const box = el("f-wishes");
  if (!box) {
    return;
  }
  // [...value] and not .length, matching the server: a phone keyboard's emoji
  // are one character each to the person typing them and two to .length, and a
  // counter that disagrees with the limit looks broken.
  const left = 100 - [...box.value].length;
  el("wishes-left").textContent = fill(t(state.locale, "form.wishesLeft"), Math.max(0, left));
}

/**
 * Sends the form.
 *
 * @param {Event} event - The submit.
 * @returns {Promise<void>} When the page has moved on or said why not.
 */
async function submitForm(event) {
  event.preventDefault();
  if (!state.campaign) {
    return;
  }

  const button = el("submit");
  button.disabled = true;
  button.textContent = t(state.locale, "form.submitting");
  clearErrors();

  const contact = [...document.querySelectorAll('input[name="contact"]:checked')]
    .map((box) => box.value);

  const payload = {
    campaign: state.campaign.slug,
    name: el("f-name").value,
    phone: el("f-phone").value,
    contact,
    amount: Number(el("f-amount").value),
    recipients: recipientValues(),
    wishes: el("f-wishes").value,
    payBy: el("f-payby").value,
    locale: state.locale,
  };

  let result;
  try {
    result = await api("/donate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    result = { ok: false, status: 0, body: {} };
  }

  button.disabled = false;
  button.textContent = t(state.locale, "form.submit");

  if (result.ok) {
    const { reference, amount, payBy } = result.body;
    const path = buildPath(state.locale, { view: "done", reference });
    go(`${path}?m=${encodeURIComponent(payBy)}&a=${encodeURIComponent(amount)}`);
    return;
  }

  if (result.status === 400) {
    showFieldErrors(result.body.fields);
    return;
  }

  const message =
    result.status === 409 ? "error.closed" :
    result.status === 429 ? "error.tooMany" :
    "error.send";
  el("form-error").textContent = t(state.locale, message);
  el("form-error").hidden = false;
}

/* ── Getting from one view to another ───────────────────────────────────── */

/**
 * @param {string} path - Where to go.
 */
function go(path) {
  history.pushState(null, "", path);
  render();
}

/**
 * Draws whatever the address bar currently says.
 *
 * @returns {Promise<void>} When it is on screen.
 */
async function render() {
  const route = parsePath(location.pathname);
  state.locale = route.locale;
  state.route = route;

  // A bare / has no language in it. The address is corrected rather than left
  // alone, so that whatever the donor bookmarks or shares says which language
  // it opens in — replaceState, so Back still leaves the site rather than
  // bouncing between / and /zh-Hans/.
  if (!route.hadLocale) {
    history.replaceState(null, "", buildPath(route.locale, route) + location.search);
  }

  applyStrings();
  drawLangs();
  el("brand").href = buildPath(state.locale, { view: "list" });

  if (route.view === "form") {
    await renderForm(route.slug);
    return;
  }
  if (route.view === "done") {
    renderDone(route.reference);
    return;
  }
  await renderList();
}

/* ── Wiring ─────────────────────────────────────────────────────────────── */

el("form").addEventListener("submit", submitForm);
el("f-wishes").addEventListener("input", updateWishesCounter);

el("recipients-add").addEventListener("click", () => addRecipient(true));

// One listener on the group rather than one per row, so a row added later
// needs no wiring of its own.
el("recipients-rows").addEventListener("click", (event) => {
  const button = event.target.closest(".recipient-remove");
  if (!button) {
    return;
  }
  const row = button.closest(".recipient");
  const rows = el("recipients-rows");

  // The last row is emptied, not removed. A form that can reach zero rows is
  // a form whose field has disappeared, and the donor is left pressing Add to
  // find out where it went.
  if (rows.children.length === 1) {
    row.querySelector(".recipient-name").value = "";
  } else {
    row.remove();
  }
  updateRecipientControls();
});

// One row from the start, so the field is visible without pressing Add.
resetRecipients();
el("error-retry").addEventListener("click", () => render());

el("brand").addEventListener("click", (event) => {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) {
    return;
  }
  event.preventDefault();
  go(buildPath(state.locale, { view: "list" }));
});

el("done-home").addEventListener("click", (event) => {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) {
    return;
  }
  event.preventDefault();
  go(buildPath(state.locale, { view: "list" }));
});

window.addEventListener("popstate", () => render());

render();
