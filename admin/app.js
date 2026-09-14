/*
 * The admin portal's client half.
 *
 * No framework and no bundler: this is a side menu, seven empty pages and a
 * router that swaps [hidden] between them, and a build step would be more
 * machinery than the thing it builds. An ES module rather
 * than an IIFE, because the Firebase Auth SDK is loaded with a dynamic
 * import() — and only when it is actually needed.
 *
 * Nothing here builds markup from a string. The one piece of text that is not
 * ours is the signed-in email, and it reaches the DOM through textContent.
 */

const el = (id) => document.getElementById(id);

// Where the collapsed/expanded choice is kept. Per browser rather than per
// account on purpose: this is about the screen somebody is sitting at, not
// about who they are, and it should not follow them onto a different machine.
const RAIL_KEY = "abss-dms.rail";

const state = {
  // Set once the Auth SDK is loaded. Null until then, and the button says so
  // rather than doing nothing — see the handler at the bottom of this file.
  signIn: null,
  signOut: null,
  // Set once the identity is settled: () => Promise<string|null>. Null is the
  // local harness, where the server is not checking a token.
  token: async () => null,
};

/* ── Talking to the API ─────────────────────────────────────────────────── */

/**
 * One call against the admin API, with the caller's identity attached.
 *
 * The token is fetched per request rather than held, because the SDK refreshes
 * it in the background and a copy kept here would be the stale one an hour into
 * a session.
 *
 * A refusal is thrown rather than returned, and it carries what the caller
 * needs to say why: the status, the account for a 403, and the field/code
 * pairs for a 400 — which are codes rather than sentences, so the wording of
 * a refusal stays in the page beside the box that caused it.
 *
 * @param {string} path - Below /api/admin.
 * @param {Object} [options] - {method, body}.
 * @returns {Promise<Object>} The parsed payload.
 */
async function api(path, options = {}) {
  const headers = {};
  const token = await state.token();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const init = { method: options.method || "GET", headers };
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }

  const response = await fetch(`/api/admin${path}`, init);
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(payload.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.email = payload.email || null;
    error.fields = payload.fields || [];
    throw error;
  }
  return payload;
}

/* ── Signing in ─────────────────────────────────────────────────────────── */

/**
 * Settles who is reading, then opens the portal.
 *
 * The server is asked first, and it is the server that decides which of the two
 * modes applies. The alternative — the page deciding it is in development
 * because of where it is being served from — puts a bypass in the deployed
 * bundle, one condition away from being true in production.
 *
 * @returns {Promise<void>} When the portal or the gate is on screen.
 */
async function boot() {
  restoreRail();

  let config;
  try {
    config = await api("/config");
  } catch (error) {
    showGate("The portal's API is not reachable. Reload to try again.");
    return;
  }

  if (config.auth === "none") {
    // The local harness. It says so on screen, so a screenshot from it is never
    // mistaken for the deployed portal.
    await start("local harness — authentication off");
    return;
  }

  // A failure here is the SDK not loading or init.json not being there — the
  // second of which is what a deploy to a site without a web app configured
  // looks like. Uncaught it rejects boot() and leaves a blank page, which is
  // the one outcome worse than a gate saying what went wrong.
  let sdk;
  try {
    sdk = await firebaseAuth();
  } catch (error) {
    showGate(
      "Could not load Google sign-in. If this site was just created, check " +
        "that it has a Firebase web app attached."
    );
    return;
  }

  const { auth, provider, config: project, signIn, signOut, onUser } = sdk;

  onUser(async (user) => {
    if (!user) {
      showGate(null);
      return;
    }
    state.token = () => user.getIdToken();
    try {
      await start(user.email);
    } catch (error) {
      if (error.status === 403) {
        showGate(
          `${error.email || user.email} is signed in but is not on the ` +
            `administrator allowlist.`
        );
        return;
      }
      showGate("Could not open the portal. Reload to try again.");
    }
  });

  state.signIn = () => signIn(auth, provider);
  state.signOut = () => signOut(auth);

  // Asked before anybody presses the button, because the answer decides whether
  // pressing it can work at all. A project whose Authentication has never been
  // set up fails the sign-in with auth/internal-error and nothing else — no
  // server response, no reason — so the code alone cannot tell that case from
  // any other. This endpoint can, and it needs no credentials to say so.
  const available = await authAvailable(project.apiKey);
  if (!available.ok) {
    el("signin").disabled = true;
    showGate(available.reason);
  }
}

/**
 * Asks whether this project has Authentication configured at all.
 *
 * A probe rather than a guess. A probe that cannot complete answers ok: its job
 * is to explain a failure that has already happened or is certain to, not to
 * stand between a working project and its sign-in button.
 *
 * @param {string} apiKey - The project's web API key, from init.json.
 * @returns {Promise<Object>} {ok} or {ok: false, reason}.
 */
async function authAvailable(apiKey) {
  try {
    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/projects?key=${apiKey}`
    );
    if (response.ok) {
      return { ok: true };
    }

    const body = await response.json().catch(() => ({}));
    const message = (body.error && body.error.message) || "";
    if (message.includes("CONFIGURATION_NOT_FOUND")) {
      return {
        ok: false,
        reason:
          "This Firebase project has no Authentication set up yet, so there " +
          "is nothing to sign in to. In the Firebase console: Authentication " +
          "→ Get started → enable Google, then add this site under " +
          "Authentication → Settings → Authorized domains.",
      };
    }
    return {
      ok: false,
      reason: `Sign-in is unavailable: ${message || response.status}`,
    };
  } catch (error) {
    return { ok: true };
  }
}

/**
 * Loads Firebase Auth and the project's own web config.
 *
 * The config comes from /__/firebase/init.json, which Hosting serves for the
 * site it is deployed to. That is the reason there is no API key written into
 * this repository: the page asks the host it was served by which project it
 * belongs to, so nothing here has to be kept in step with the console.
 *
 * @returns {Promise<Object>} {auth, provider, config, signIn, signOut, onUser}.
 */
async function firebaseAuth() {
  const [{ initializeApp }, authModule, config] = await Promise.all([
    import("https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js"),
    import("https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js"),
    fetch("/__/firebase/init.json").then((response) => response.json()),
  ]);

  const app = initializeApp(config);
  const auth = authModule.getAuth(app);
  const provider = new authModule.GoogleAuthProvider();
  // Only an email is ever wanted from the provider; the allowlist is keyed on
  // one and nothing here reads a profile.
  provider.addScope("email");

  return {
    auth,
    provider,
    config,
    signIn: (a, p) => authModule.signInWithPopup(a, p),
    signOut: (a) => authModule.signOut(a),
    onUser: (handler) => authModule.onAuthStateChanged(auth, handler),
  };
}

/**
 * @param {string|null} message - Why the gate is showing, if there is a reason.
 */
function showGate(message) {
  el("app").hidden = true;
  el("gate").hidden = false;
  const error = el("gate-error");
  error.hidden = !message;
  error.textContent = message || "";
}

/**
 * Confirms the session against the API, then draws the portal.
 *
 * The call matters even though its payload barely does: it is the round trip
 * that turns "signed in to Google" into "allowed in here", and letting the
 * portal draw before it would show the frame of a console to somebody who is
 * about to be refused.
 *
 * @param {string} email - Who is signed in, for the rail's foot.
 * @returns {Promise<void>} When the portal is on screen.
 */
async function start(email) {
  const session = await api("/session");
  const who = session.viewer || email || "";

  el("viewer-email").textContent = who;
  el("viewer-email").title = who;
  el("viewer-avatar").textContent = who ? who.trim()[0] : "";

  el("gate").hidden = true;
  el("app").hidden = false;

  // After the portal is on screen, because until then the menu is inside a
  // hidden subtree and the heading it writes would not be read out.
  const route = routeFromHash();
  showModule(route.module || "", route.id);
}

/* ── Which module is open ───────────────────────────────────────────────── */

/**
 * Shows one module and hides the rest.
 *
 * The label in the menu is the only place a module's name is written: the
 * heading is copied from it rather than kept in a table here, so the two
 * cannot drift. An unknown key falls back to the first item rather than
 * leaving the reader on a blank frame — a stale bookmark is the ordinary way
 * to arrive with one.
 *
 * @param {string} key - A data-module value.
 * @param {string|null} [id] - Something inside the module, for a sub-page.
 * @param {boolean} [remember] - Whether to put it in the address bar.
 */
function showModule(key, id = null, remember = true) {
  const buttons = [...document.querySelectorAll(".module")];
  const matched = buttons.find((button) => button.dataset.module === key);
  const chosen = matched || buttons[0];
  const open = chosen.dataset.module;

  for (const button of buttons) {
    const isOpen = button === chosen;
    button.classList.toggle("is-active", isOpen);
    // Removed rather than set to "false": aria-current has no falsy value that
    // means "not the current page", and every other string is treated as one.
    if (isOpen) {
      button.setAttribute("aria-current", "page");
    } else {
      button.removeAttribute("aria-current");
    }
  }

  for (const page of document.querySelectorAll(".page")) {
    page.hidden = page.dataset.page !== open;
  }

  el("page-title").textContent =
    chosen.querySelector(".module-label").textContent.trim();

  // The one thing a module gets told: that it is on screen, and what inside it
  // was asked for. Adding an eighth is still markup alone — this fires for
  // every module and only the ones that have asked to hear it do anything,
  // rather than the router holding a table of pages it knows are special.
  if (open === "layouts") {
    openLayouts(id);
  }
  // Short form here, unlike the document's own <title>: this is a browser tab,
  // and the module is the part worth reading when six of them are open.
  document.title = `${el("page-title").textContent} — ABSS DMS`;

  // Corrected even when the caller said not to remember, if the key asked for
  // was not a module: that is the stale-bookmark case, and leaving the address
  // bar naming a page that is not the one on screen is worse than rewriting it.
  const wanted = id ? `#/${open}/${id}` : `#/${open}`;
  if ((remember || !matched) && location.hash !== wanted) {
    // replaceState rather than assigning location.hash: the menu is not a
    // history stack, and a reader who clicked through four modules should not
    // have to press Back four times to leave the portal.
    //
    // Opening a sub-page is the exception and pushes — see openLayout(). Going
    // into one layout out of twelve is a step somebody means to take, and Back
    // is how anybody expects to leave it.
    history.replaceState(null, "", wanted);
  }
}

/**
 * Reads the address bar.
 *
 * Two shapes: a module on its own, and a module with something inside it —
 * `#/layouts/8f3kQ2`, the first sub-page in the portal. The id keeps its own
 * alphabet rather than sharing the module's, because a module key is a word
 * somebody wrote in this repository and an id is whatever Firestore minted.
 *
 * @returns {Object} {module, id}, either of which may be null.
 */
function routeFromHash() {
  const match = /^#\/([a-z-]+)(?:\/([A-Za-z0-9_-]{1,120}))?$/.exec(location.hash);
  return {
    module: match ? match[1] : null,
    id: match && match[2] ? match[2] : null,
  };
}

/* ── The side menu ──────────────────────────────────────────────────────── */

/**
 * Applies a collapsed/expanded state to the rail.
 *
 * The chevron is not touched here — it is one path in the markup, rotated by
 * CSS off the same class. What does have to move is what a screen reader and a
 * tooltip are told, because neither can see a rotation.
 *
 * @param {boolean} collapsed - Whether the rail should be narrow.
 */
function setRail(collapsed) {
  const rail = el("rail");
  const toggle = el("rail-toggle");

  rail.classList.toggle("is-collapsed", collapsed);
  toggle.setAttribute("aria-expanded", String(!collapsed));

  const label = collapsed ? "Expand side menu" : "Collapse side menu";
  toggle.setAttribute("aria-label", label);
  toggle.title = label;
}

/**
 * The state the rail opens in.
 *
 * A remembered choice wins. Without one, the rail starts collapsed on a narrow
 * screen — where it overlays the page rather than sitting beside it — and
 * expanded everywhere else.
 *
 * localStorage is read inside a try: it throws rather than returning null in a
 * browser with site data blocked, and a portal that will not load because it
 * could not remember a menu width is a bad trade.
 */
function restoreRail() {
  let stored = null;
  try {
    stored = localStorage.getItem(RAIL_KEY);
  } catch (error) {
    stored = null;
  }

  const narrow = window.matchMedia("(max-width: 720px)").matches;
  setRail(stored === null ? narrow : stored === "collapsed");
}

/* ── Layouts ────────────────────────────────────────────────────────────── */

// The two allotments, worded. The server stores the key; every place a reader
// sees one of these words, it comes from here.
const ALLOTMENTS = {
  cell: { name: "Cell", plural: "Cells" },
  node: { name: "Intersection node", plural: "Nodes" },
};

// How many marks a drawing will place before it gives up and draws the lines
// alone. A hundred by a hundred is ten thousand rects in a thumbnail 132px
// tall, which is a second of layout for a picture in which no single cell is
// visible anyway. The lines still show the shape, which is all a card is for.
const MARK_LIMIT = 2400;

// Beyond this the letters and numbers around a preview are too small to read
// at the size the box gives them, so they are left off rather than drawn as
// grey fuzz.
const LABEL_LIMIT = 26;

const SVG_NS = "http://www.w3.org/2000/svg";

// One grid square, in the drawing's own units. Everything else is a multiple
// or a fraction of it, and the viewBox is what turns the result into pixels —
// so a 4 × 18 wall and a 12 × 10 hall are drawn by the same code at the same
// weight and scaled to fit whatever box they are put in.
const STEP = 10;

const layouts = {
  // Loaded on the first visit and kept, so returning to the module from
  // another one is not a round trip. A create or a status change updates this
  // in place from what the server answered with, rather than re-fetching.
  items: null,
  loading: false,
};

/**
 * @param {string} name - An SVG element's name.
 * @param {Object} attributes - What to set on it.
 * @returns {Element} The element.
 */
function svg(name, attributes = {}) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) {
    node.setAttribute(key, String(value));
  }
  return node;
}

/**
 * Draws a layout's grid.
 *
 * This is the "snapshot" on a card and the preview in the form — one drawing
 * routine for both, because they are pictures of the same thing and a card
 * that disagreed with the form that made it would be worse than either.
 *
 * Nothing is stored. A layout is its rows, its columns and its allotment, and
 * the picture is derived from those every time it is wanted: a saved image
 * would be a copy that goes stale the first time a layout is edited, and it
 * would cost a Storage bucket and a hole in the CSP to keep.
 *
 * The two allotments are drawn as what they are — cells as the spaces the
 * lines enclose, nodes as points on the crossings — so the thumbnail says
 * which one a layout uses without reading the card.
 *
 * @param {Object} layout - {rows, columns, allottedBy}.
 * @param {Object} [options] - {labels} to draw the row and column addresses.
 * @returns {Element} An <svg>.
 */
function drawGrid(layout, options = {}) {
  const rows = Math.max(0, layout.rows || 0);
  const columns = Math.max(0, layout.columns || 0);
  const byNode = layout.allottedBy === "node";

  const width = columns * STEP;
  const height = rows * STEP;
  // Room for the dots that sit on the outer lines, which would otherwise be
  // half cut off by the edge of the viewBox.
  const edge = byNode ? 3 : 0.6;
  const labels = Boolean(options.labels) &&
    rows <= LABEL_LIMIT && columns <= LABEL_LIMIT;
  const gutter = labels ? 13 : 0;

  // A viewBox and no width or height. The drawing is then sized entirely by
  // the box it is put in — max-width and max-height in the stylesheet — and a
  // 4 × 18 wall and a 12 × 10 hall come out as two thumbnails of the same
  // height in a row of cards that line up. An SVG carrying its own width is an
  // SVG that decides how tall a card is.
  const frame = svg("svg", {
    viewBox: [
      -(edge + gutter),
      -(edge + gutter),
      width + gutter + edge * 2,
      height + gutter + edge * 2,
    ].join(" "),
    preserveAspectRatio: "xMidYMid meet",
    fill: "none",
  });
  if (!rows || !columns) {
    return frame;
  }

  const marks = byNode ? (rows + 1) * (columns + 1) : rows * columns;

  // Cells first, so the lines are drawn over their fill rather than under it.
  if (!byNode && marks <= MARK_LIMIT) {
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < columns; c += 1) {
        frame.appendChild(svg("rect", {
          class: "grid-cell",
          x: c * STEP + 1,
          y: r * STEP + 1,
          width: STEP - 2,
          height: STEP - 2,
          rx: 1.2,
        }));
      }
    }
  }

  for (let r = 0; r <= rows; r += 1) {
    frame.appendChild(svg("line", {
      class: "grid-line", x1: 0, y1: r * STEP, x2: width, y2: r * STEP,
    }));
  }
  for (let c = 0; c <= columns; c += 1) {
    frame.appendChild(svg("line", {
      class: "grid-line", x1: c * STEP, y1: 0, x2: c * STEP, y2: height,
    }));
  }

  if (byNode && marks <= MARK_LIMIT) {
    for (let r = 0; r <= rows; r += 1) {
      for (let c = 0; c <= columns; c += 1) {
        frame.appendChild(svg("circle", {
          class: "grid-node", cx: c * STEP, cy: r * STEP, r: 2.2,
        }));
      }
    }
  }

  if (labels) {
    // The addresses sit where the things they name are: against the lines when
    // a layout allots by node, and against the middles of the cells when it
    // allots by cell. This is the picture of the temple's own plan, which is
    // lettered down the side and numbered across the top.
    const count = byNode ? 1 : 0;
    const offset = byNode ? 0 : STEP / 2;

    for (let r = 0; r < rows + count; r += 1) {
      const label = svg("text", {
        class: "grid-label", x: -gutter / 2, y: r * STEP + offset,
      });
      label.textContent = rowLabel(r);
      frame.appendChild(label);
    }
    for (let c = 0; c < columns + count; c += 1) {
      const label = svg("text", {
        class: "grid-label", x: c * STEP + offset, y: -gutter / 2,
      });
      label.textContent = String(c + 1);
      frame.appendChild(label);
    }
  }

  return frame;
}

/**
 * The letter a row is addressed by: A, B ... Z, AA, AB.
 *
 * The same rule as rowLabel() in functions/layout.js, and the duplication is
 * on purpose — the alternative is the page importing from the functions
 * directory, which would tie what the portal can draw to what is deployed
 * beside it. layout.test.cjs is where the rule is pinned down.
 *
 * @param {number} index - Zero-based row number.
 * @returns {string} Its label.
 */
function rowLabel(index) {
  let label = "";
  let n = index;
  while (n >= 0) {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  }
  return label;
}

/**
 * Opens the module, loading the layouts the first time it is looked at.
 *
 * The router has already shown the cards page and hidden the view — it knows
 * only about modules — so if an id was asked for, this is what swaps between
 * the module's own two pages. Keeping that here rather than in the router is
 * what stops the router from having to hold a table of pages it knows are
 * special.
 *
 * @param {string|null} [id] - A layout to open, from #/layouts/<id>.
 * @returns {Promise<void>} When the cards or one layout are up.
 */
async function openLayouts(id = null) {
  if (!layouts.items && !layouts.loading) {
    layouts.loading = true;
    el("layouts-note").textContent = "Loading…";
    try {
      const payload = await api("/layouts");
      layouts.items = payload.layouts || [];
      drawLayouts();
    } catch (error) {
      // The module stays empty and says so. It is not the gate's business —
      // the reader is already signed in and past the allowlist — so this is a
      // failure of one request, and reopening the module retries it.
      el("layouts-note").textContent =
        "Could not load the layouts. Reopen the module to try again.";
    } finally {
      layouts.loading = false;
    }
  }

  showLayout(id);
}

/**
 * Shows one layout, or the cards when there is none to show.
 *
 * An id that matches nothing falls back to the cards and rewrites the address,
 * for the same reason an unknown module does: a stale bookmark is the ordinary
 * way to arrive with one, and an address naming a layout that is not on screen
 * is worse than an address that has been corrected.
 *
 * @param {string|null} id - Which layout, if any.
 * @returns {void}
 */
function showLayout(id) {
  const found = id && (layouts.items || []).find((one) => one.id === id);

  if (id && !found && !layouts.loading) {
    history.replaceState(null, "", "#/layouts");
  }

  el("page-layouts").hidden = Boolean(found);
  el("page-layout").hidden = !found;

  if (!found) {
    // Nothing is left running behind the cards: the pointer handler is bound
    // once and reads state.layout, which is what stops a stale tooltip from
    // appearing over a grid that is no longer there.
    view.layout = null;
    el("view-tip").hidden = true;
    exitFullscreen();
    return;
  }

  // A zoom belongs to the layout being read, not to the module: 273% chosen
  // for a four-row wall is not a sensible place to open a forty-row hall, and
  // arriving at a grid already scrolled off its own corner is the kind of
  // state nobody can account for. Reopening the same layout keeps it.
  if (!view.layout || view.layout.id !== found.id) {
    view.step = STEP_BASE;
  }

  view.layout = found;
  drawView();
}

/**
 * Draws every card, and the line above them.
 *
 * @returns {void}
 */
function drawLayouts() {
  const cards = el("layouts-cards");
  cards.replaceChildren();

  const items = layouts.items || [];
  for (const layout of items) {
    cards.appendChild(layoutCard(layout));
  }

  const active = items.filter((one) => one.active).length;
  el("layouts-note").textContent = items.length
    ? `${items.length} layout${items.length === 1 ? "" : "s"}, ` +
      `${active} active`
    : "";
  el("layouts-empty").hidden = items.length > 0;
}

/**
 * One card.
 *
 * Cloned from the template in index.html and filled in through textContent.
 * The only thing inserted as elements is the drawing, which is built node by
 * node — a layout's name is typed by a person, and this is the file that must
 * never hand one to a parser.
 *
 * @param {Object} layout - As the API answers with.
 * @returns {Element} The card.
 */
function layoutCard(layout) {
  const card = el("tpl-layout-card").content.firstElementChild.cloneNode(true);
  const find = (selector) => card.querySelector(selector);

  card.dataset.layout = layout.id;
  find(".card-snapshot").appendChild(drawGrid(layout));
  find(".card-name").textContent = layout.name;

  // Building, floor and location are optional, and a card for a temple with
  // one hall should read "Main Hall" rather than "— · Floor — · Main Hall".
  // Only what was filled in is shown; a layout with none of the three says so
  // once, which is also the prompt to go and fill them in.
  const place = [
    layout.building,
    layout.floor ? `Floor ${layout.floor}` : "",
    layout.location,
  ].filter(Boolean);
  find(".card-place").textContent = place.length
    ? place.join(" · ")
    : "No building, floor or location recorded";

  const allotment = ALLOTMENTS[layout.allottedBy] || ALLOTMENTS.cell;
  find(".card-grid").textContent = `${layout.rows} × ${layout.columns}`;
  find(".card-allotment").textContent = allotment.name;
  find(".card-units-label").textContent = allotment.plural;
  find(".card-units").textContent = layout.units.toLocaleString();

  const status = find(".status");
  status.classList.toggle("is-active", layout.active);
  find(".status-text").textContent = layout.active ? "Active" : "Inactive";

  // The visible label is one word, which is enough beside the name it sits
  // under and not enough on a list of twelve buttons read out in sequence.
  find(".card-view").setAttribute("aria-label", `View ${layout.name}`);
  return card;
}

/**
 * Switches one layout on or off.
 *
 * The card is redrawn from what the server answered with rather than from
 * what was asked for: if the write did not happen, nothing on screen should
 * say it did.
 *
 * @param {string} id - Which layout.
 * @param {Element} button - The button pressed, disabled while it is in flight.
 * @returns {Promise<void>} When the card is redrawn.
 */
async function toggleLayout(id, button) {
  const current = (layouts.items || []).find((one) => one.id === id);
  if (!current) {
    return;
  }

  button.disabled = true;
  try {
    const payload = await api(`/layouts/${id}`, {
      method: "PATCH",
      body: { active: !current.active },
    });
    layouts.items = layouts.items.map((one) =>
      one.id === id ? payload.layout : one);
    drawLayouts();
    button.disabled = false;
    if (view.layout && view.layout.id === id) {
      view.layout = payload.layout;
      drawViewHead();
    }
  } catch (error) {
    button.disabled = false;
    el("layouts-note").textContent =
      `Could not change ${current.name}. Try again.`;
  }
}

/* ── One layout, opened ─────────────────────────────────────────────────── */

// The size of one unit's box at 100%, in pixels, and the range the zoom moves
// it through. A unit box is the square a cell fills or a node sits in the
// middle of — see drawView() for why both allotments are laid out the same
// way.
const STEP_BASE = 44;
const STEP_MIN = 12;
const STEP_MAX = 120;

// What the row letters and column numbers get. It follows the zoom so the
// headers stay in proportion, but stops either side: below about 26px the
// letters are unreadable and above about 56px the gutter is wider than the
// thing it labels.
const GUTTER_MIN = 26;
const GUTTER_MAX = 56;

const view = {
  layout: null,
  step: STEP_BASE,
  // Which unit the tooltip is naming. Kept so a pointermove that has not left
  // the box it was in does not rebuild the tooltip sixty times a second.
  at: null,
};

/**
 * @param {Object} layout - Anything with rows, columns and allottedBy.
 * @returns {Object} {across, down} — how many unit boxes the grid is.
 */
function unitBoxes(layout) {
  // A grid of r rows has r + 1 row lines, so a layout allotted by node is one
  // box wider and one taller than the same grid allotted by cell. This is the
  // (r + 1) from layoutCounts(), in the one other place it has to be right.
  const extra = layout.allottedBy === "node" ? 1 : 0;
  return {
    across: layout.columns + extra,
    down: layout.rows + extra,
  };
}

/**
 * Draws the whole view: the head, the headers and the grid.
 *
 * @returns {void}
 */
function drawView() {
  drawViewHead();
  drawViewGrid();
}

/**
 * The name, the place, the status and the specification line.
 *
 * @returns {void}
 */
function drawViewHead() {
  const layout = view.layout;
  const allotment = ALLOTMENTS[layout.allottedBy] || ALLOTMENTS.cell;
  const boxes = unitBoxes(layout);

  el("view-name").textContent = layout.name;
  el("view-name").title = layout.name;

  const place = [
    layout.building,
    layout.floor ? `Floor ${layout.floor}` : "",
    layout.location,
  ].filter(Boolean);
  el("view-place").textContent = place.length
    ? place.join(" · ")
    : "No building, floor or location recorded";

  // The addresses are named here for the same reason they are named in the
  // form: they are the thing somebody came to this page to read off.
  el("view-specs").textContent =
    `${layout.rows} × ${layout.columns}, allotted by ` +
    `${allotment.name.toLowerCase()} · ` +
    `${layout.units.toLocaleString()} ${allotment.plural.toLowerCase()} · ` +
    `A1 to ${rowLabel(boxes.down - 1)}${boxes.across}`;

  const status = el("view-status");
  status.classList.toggle("is-active", layout.active);
  status.querySelector(".status-text").textContent =
    layout.active ? "Active" : "Inactive";

  const toggle = el("view-toggle");
  toggle.textContent = layout.active ? "Deactivate" : "Activate";
  toggle.disabled = false;
}

/**
 * Draws the grid and the two header strips at the current zoom.
 *
 * Every unit owns a box of `step` pixels square, whichever allotment is in
 * use: a cell fills its box, and a node sits at its box's centre. That one
 * decision is what lets the header strips, the hit testing and the tooltip be
 * written once instead of twice — the address under a pointer is the box it is
 * in, and the box is (x / step, y / step) either way.
 *
 * @returns {void}
 */
function drawViewGrid() {
  const layout = view.layout;
  const step = view.step;
  const boxes = unitBoxes(layout);
  const byNode = layout.allottedBy === "node";
  const width = boxes.across * step;
  const height = boxes.down * step;
  const gutter = Math.min(GUTTER_MAX, Math.max(GUTTER_MIN, Math.round(step * 0.85)));

  el("view-corner").style.width = `${gutter}px`;
  el("view-corner").style.height = `${gutter}px`;
  el("view-rows").style.width = `${gutter}px`;
  el("view-columns").style.height = `${gutter}px`;

  // The headers are elements rather than part of the drawing, because sticky
  // is what freezes them and there is no sticky inside an SVG.
  const columns = el("view-columns");
  columns.replaceChildren();
  for (let c = 0; c < boxes.across; c += 1) {
    columns.appendChild(headCell(String(c + 1), step, gutter, "column", c));
  }

  const rows = el("view-rows");
  rows.replaceChildren();
  for (let r = 0; r < boxes.down; r += 1) {
    rows.appendChild(headCell(rowLabel(r), gutter, step, "row", r));
  }

  const frame = svg("svg", {
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
    fill: "none",
  });

  // Drawn before the grid so the lines sit over it, and moved rather than
  // rebuilt as the pointer travels.
  frame.appendChild(svg("rect", {
    class: "grid-hover", x: 0, y: 0, width: step, height: step, hidden: "",
  }));

  // In cell mode the lines are the edges of the boxes; in node mode they run
  // through their centres, because the lines are what the nodes sit on.
  const offset = byNode ? step / 2 : 0;
  const lines = byNode ? boxes.across - 1 : boxes.across;
  const downLines = byNode ? boxes.down - 1 : boxes.down;

  for (let r = 0; r <= downLines; r += 1) {
    const y = r * step + offset;
    frame.appendChild(svg("line", {
      class: "grid-line", x1: offset, y1: y, x2: width - offset, y2: y,
    }));
  }
  for (let c = 0; c <= lines; c += 1) {
    const x = c * step + offset;
    frame.appendChild(svg("line", {
      class: "grid-line", x1: x, y1: offset, x2: x, y2: height - offset,
    }));
  }

  if (byNode) {
    const radius = Math.max(2, Math.min(9, step * 0.16));
    for (let r = 0; r < boxes.down; r += 1) {
      for (let c = 0; c < boxes.across; c += 1) {
        frame.appendChild(svg("circle", {
          class: "grid-node",
          cx: c * step + offset,
          cy: r * step + offset,
          r: radius,
        }));
      }
    }
  }

  el("view-grid").replaceChildren(frame);
  el("zoom-level").textContent = `${Math.round((step / STEP_BASE) * 100)}%`;
  el("zoom-out").disabled = step <= STEP_MIN;
  el("zoom-in").disabled = step >= STEP_MAX;
  view.at = null;
}

/**
 * @param {string} label - What it says.
 * @param {number} width - In pixels.
 * @param {number} height - In pixels.
 * @param {string} axis - "row" or "column".
 * @param {number} index - Which one along that axis.
 * @returns {Element} A header cell.
 */
function headCell(label, width, height, axis, index) {
  const cell = document.createElement("div");
  cell.className = "head-cell";
  cell.style.width = `${width}px`;
  cell.style.height = `${height}px`;
  cell.dataset.axis = axis;
  cell.dataset.index = String(index);
  cell.textContent = label;
  return cell;
}

/**
 * Names the unit under the pointer.
 *
 * One listener on the grid rather than one per unit: a hundred by a hundred
 * allotted by node is 10,201 of them, and that many listeners — or that many
 * title attributes — is a page that stops responding to a scroll. The address
 * is arithmetic on the pointer's position instead, which costs the same
 * whatever the grid is.
 *
 * @param {PointerEvent} event - The move.
 * @returns {void}
 */
function trackPointer(event) {
  if (!view.layout) {
    return;
  }

  const grid = el("view-grid");
  const box = grid.getBoundingClientRect();
  const step = view.step;
  const boxes = unitBoxes(view.layout);

  const column = Math.floor((event.clientX - box.left) / step);
  const row = Math.floor((event.clientY - box.top) / step);
  const inside =
    column >= 0 && column < boxes.across && row >= 0 && row < boxes.down;

  const tip = el("view-tip");
  if (!inside) {
    tip.hidden = true;
    litHeaders(null, null);
    hoverMark(null);
    view.at = null;
    return;
  }

  // The tooltip follows the pointer every time, but everything that touches
  // the DOM by more than two numbers only runs when the address changes.
  const at = `${row}:${column}`;
  if (at !== view.at) {
    view.at = at;
    tip.textContent = `${rowLabel(row)}${column + 1}`;
    tip.hidden = false;
    litHeaders(row, column);
    hoverMark({ row, column });
  }

  // Above and to the right of the pointer, and flipped back inside the window
  // at the two edges where that would put it off-screen.
  const width = tip.offsetWidth;
  const left = Math.min(event.clientX + 14, window.innerWidth - width - 8);
  const top = Math.max(8, event.clientY - tip.offsetHeight - 12);
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

/**
 * @param {number|null} row - The row to light, or none.
 * @param {number|null} column - The column to light, or none.
 * @returns {void}
 */
function litHeaders(row, column) {
  for (const cell of document.querySelectorAll(".head-cell.is-lit")) {
    cell.classList.remove("is-lit");
  }
  if (row === null) {
    return;
  }
  const rows = el("view-rows").children;
  const columns = el("view-columns").children;
  if (rows[row]) {
    rows[row].classList.add("is-lit");
  }
  if (columns[column]) {
    columns[column].classList.add("is-lit");
  }
}

/**
 * @param {Object|null} at - {row, column}, or none to hide it.
 * @returns {void}
 */
function hoverMark(at) {
  const mark = el("view-grid").querySelector(".grid-hover");
  if (!mark) {
    return;
  }
  if (!at) {
    mark.setAttribute("hidden", "");
    return;
  }
  mark.removeAttribute("hidden");
  mark.setAttribute("x", String(at.column * view.step));
  mark.setAttribute("y", String(at.row * view.step));
}

/**
 * Changes the zoom, keeping the middle of the view where it was.
 *
 * Without that, zooming in on a sixty-column grid walks the reader back to
 * column 1 every time they press the button.
 *
 * @param {number} step - The new box size, before clamping.
 * @returns {void}
 */
function setZoom(step) {
  const body = el("view-body");
  const next = Math.round(Math.max(STEP_MIN, Math.min(STEP_MAX, step)));
  if (next === view.step) {
    return;
  }

  const ratio = next / view.step;
  const midX = body.scrollLeft + body.clientWidth / 2;
  const midY = body.scrollTop + body.clientHeight / 2;

  view.step = next;
  drawViewGrid();

  body.scrollLeft = midX * ratio - body.clientWidth / 2;
  body.scrollTop = midY * ratio - body.clientHeight / 2;
}

/**
 * @returns {void}
 */
function toggleFullscreen() {
  const target = el("view");
  if (document.fullscreenElement) {
    exitFullscreen();
    return;
  }
  // A browser that refuses still gets the icon and the state it implies; what
  // it does not get is the display. requestFullscreen rejects rather than
  // throwing, and an unhandled rejection here would be a button that appears
  // to do nothing at all.
  const asked = target.requestFullscreen && target.requestFullscreen();
  if (asked && asked.catch) {
    asked.catch(() => markFullscreen(false));
  }
}

/**
 * @returns {void}
 */
function exitFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  }
  markFullscreen(false);
}

/**
 * @param {boolean} on - Whether the grid has the display.
 * @returns {void}
 */
function markFullscreen(on) {
  const target = el("view");
  target.classList.toggle("is-fullscreen", on);
  const label = on ? "Leave full screen" : "Full screen";
  el("view-fullscreen").setAttribute("aria-label", label);
  el("view-fullscreen").title = label;
}

/* ── Creating one ───────────────────────────────────────────────────────── */

/**
 * @returns {Object} What the form currently says, unvalidated.
 */
function formValues() {
  const chosen = document.querySelector("input[name=allottedBy]:checked");
  return {
    name: el("layout-name").value.trim(),
    building: el("layout-building").value.trim(),
    floor: el("layout-floor").value.trim(),
    location: el("layout-location").value.trim(),
    rows: Number(el("layout-rows").value),
    columns: Number(el("layout-columns").value),
    allottedBy: chosen ? chosen.value : "cell",
  };
}

/**
 * Redraws the grid and the two counts under the form.
 *
 * Both counts are shown whichever allotment is chosen, because the point of
 * showing them is the comparison — 8 × 5 is 40 of one and 54 of the other,
 * and that difference is the whole reason the choice exists. The one being
 * allotted by is the one drawn in the accent.
 *
 * @returns {void}
 */
function refreshPreview() {
  const values = formValues();
  const rows = Number.isInteger(values.rows) ? values.rows : 0;
  const columns = Number.isInteger(values.columns) ? values.columns : 0;
  const drawable = rows > 0 && columns > 0;

  el("layout-preview").replaceChildren(
    drawGrid({ rows, columns, allottedBy: values.allottedBy }, { labels: true })
  );
  // A box with nothing in it does not say whether it is waiting for a number
  // or has failed to draw one.
  el("layout-preview-hint").hidden = drawable;

  // Rows and columns are the spaces between the lines, so a grid of 4 rows is
  // drawn with 5 row lines and allots by 5 of them when it allots by node.
  // That is the one thing here somebody can get wrong without noticing — a
  // wall of 4 rails is 3 rows, not 4 — so the addresses the grid produces are
  // named outright rather than left to be counted off the drawing.
  const note = el("layout-grid-note");
  note.hidden = !drawable;
  if (drawable) {
    const lastRow = rowLabel(values.allottedBy === "node" ? rows : rows - 1);
    const lastColumn = values.allottedBy === "node" ? columns + 1 : columns;
    note.textContent =
      `Addresses run A1 to ${lastRow}${lastColumn} — ` +
      `${lastRow === "A" ? "one row" : `rows A to ${lastRow}`}, ` +
      `${lastColumn === 1 ? "one column" : `columns 1 to ${lastColumn}`}.`;
  }

  el("layout-count-cells").textContent =
    drawable ? (rows * columns).toLocaleString() : "—";
  el("layout-count-nodes").textContent =
    drawable ? ((rows + 1) * (columns + 1)).toLocaleString() : "—";

  for (const count of document.querySelectorAll(".count")) {
    count.classList.toggle("is-chosen", count.dataset.count === values.allottedBy);
  }
}

/**
 * @param {Object} field - {field, code} from the API.
 * @returns {string} What to say about it.
 */
function refusal(field) {
  if (field.code === "too-long") {
    return "That is too long.";
  }
  if (field.code === "out-of-range") {
    return "Rows and columns are each between 1 and 100.";
  }
  return field.field === "allottedBy"
    ? "Choose how this layout is allotted."
    : "This is needed.";
}

/**
 * Marks the boxes the server refused.
 *
 * Server-side, not the browser's own required attributes, because the server
 * is the half that decides — the markup's min and max are a convenience and
 * anything that reached the API without them is what this has to explain.
 *
 * @param {Array} fields - {field, code} pairs, or none to clear.
 * @returns {void}
 */
function showRefusals(fields = []) {
  for (const field of document.querySelectorAll(".field")) {
    field.classList.remove("is-wrong");
  }
  el("layout-name-error").hidden = true;
  el("layout-grid-error").hidden = true;

  for (const item of fields) {
    const input = el(`layout-${item.field === "allottedBy" ? "rows" : item.field}`);
    if (input && input.closest(".field")) {
      input.closest(".field").classList.add("is-wrong");
    }
    const message = item.field === "name"
      ? el("layout-name-error")
      : el("layout-grid-error");
    message.textContent = refusal(item);
    message.hidden = false;
  }
}

/**
 * Opens the form, empty.
 *
 * Rows and columns start blank rather than at some plausible default. A
 * default is a number somebody can leave in by accident, and a layout is not
 * a thing you want created at a size nobody chose.
 *
 * @returns {void}
 */
function openLayoutForm() {
  el("layout-fields").reset();
  showRefusals();
  el("layout-error").hidden = true;
  el("layout-submit").disabled = false;
  refreshPreview();
  el("layout-form").showModal();
  el("layout-name").focus();
}

/**
 * Sends the form, and on success puts the new layout at the top of the list.
 *
 * The card is built from what came back rather than from what was typed, so
 * what is on screen after a create is what is in the database.
 *
 * @returns {Promise<void>} When the form has closed or said why it has not.
 */
async function submitLayout() {
  const submit = el("layout-submit");
  submit.disabled = true;
  showRefusals();
  el("layout-error").hidden = true;

  try {
    const payload = await api("/layouts", {
      method: "POST",
      body: formValues(),
    });
    layouts.items = [payload.layout, ...(layouts.items || [])];
    drawLayouts();
    el("layout-form").close();
  } catch (error) {
    submit.disabled = false;
    if (error.status === 400 && error.fields.length) {
      showRefusals(error.fields);
      return;
    }
    el("layout-error").textContent = "Could not save this layout. Try again.";
    el("layout-error").hidden = false;
  }
}

/* ── Wiring ─────────────────────────────────────────────────────────────── */

// One listener on the list rather than one per item: the modules are markup,
// and a handler bound per button would be a second place to remember to touch
// when the eighth is added.
document.querySelector(".modules").addEventListener("click", (event) => {
  const button = event.target.closest(".module");
  if (button) {
    showModule(button.dataset.module);
  }
});

// The address bar is part of the interface: Back, Forward and a pasted link
// all arrive here.
// The address bar is part of the interface: Back, Forward and a pasted link
// all arrive here. Back out of a layout lands on the cards, because that is
// the address the push replaced.
window.addEventListener("hashchange", () => {
  const route = routeFromHash();
  showModule(route.module || "", route.id, false);
});

el("rail-toggle").addEventListener("click", () => {
  const collapsed = !el("rail").classList.contains("is-collapsed");
  setRail(collapsed);
  try {
    localStorage.setItem(RAIL_KEY, collapsed ? "collapsed" : "expanded");
  } catch (error) {
    // A browser that will not store it still gets the toggle; it just forgets.
  }
});

el("signin").addEventListener("click", async () => {
  const button = el("signin");
  if (!state.signIn) {
    // The SDK has not finished loading. Saying so beats a button that swallows
    // the press.
    showGate("Still starting up. Try again in a moment.");
    return;
  }

  button.disabled = true;
  try {
    await state.signIn();
    // Nothing else here: onUser() above is what opens the portal, and doing it
    // twice would race the allowlist check against itself.
  } catch (error) {
    // A popup the operator closed is not a failure worth a red box.
    const benign =
      error.code === "auth/popup-closed-by-user" ||
      error.code === "auth/cancelled-popup-request";
    if (!benign) {
      showGate(`Sign-in failed: ${error.code || error.message}`);
    }
  } finally {
    button.disabled = false;
  }
});

el("signout").addEventListener("click", async () => {
  if (state.signOut) {
    await state.signOut();
  }
  // onUser() fires with null and shows the gate. In the harness, where there is
  // no SDK, do it here.
  showGate(null);
});

// One listener for every card's button, on the container they are drawn into:
// the cards are replaced wholesale on every change, and handlers bound per
// card would be handlers bound again on every redraw.
el("layouts-cards").addEventListener("click", (event) => {
  const button = event.target.closest(".card-view");
  if (button) {
    openLayout(button.closest(".card").dataset.layout);
  }
});

/**
 * Opens one layout, and puts it in the address bar.
 *
 * pushState here rather than the replaceState the menu uses: going into one
 * layout out of twelve is a step somebody means to take, and Back is how
 * anybody expects to leave it. It is also the only navigation in the portal
 * that a reader would want to send to somebody else.
 *
 * @param {string} id - Which layout.
 * @returns {void}
 */
function openLayout(id) {
  history.pushState(null, "", `#/layouts/${id}`);
  showLayout(id);
  el("view-body").scrollTo(0, 0);
}

el("view-back").addEventListener("click", () => {
  // Back rather than a rewrite, so the address the push added is taken off the
  // stack instead of buried under another one.
  history.back();
});

el("view-toggle").addEventListener("click", (event) => {
  if (view.layout) {
    toggleLayout(view.layout.id, event.currentTarget);
  }
});

el("zoom-in").addEventListener("click", () => setZoom(view.step * 1.25));
el("zoom-out").addEventListener("click", () => setZoom(view.step / 1.25));
el("zoom-level").addEventListener("click", () => setZoom(STEP_BASE));

el("view-fullscreen").addEventListener("click", toggleFullscreen);

// The browser is the authority on whether the display was actually handed
// over: Escape and the window chrome both leave without going through the
// button, and the icon has to follow either way.
document.addEventListener("fullscreenchange", () => {
  markFullscreen(Boolean(document.fullscreenElement));
});

// pointermove rather than mousemove, so a pen and a touch drag name a unit
// too. The listener is on the scroller rather than the drawing because the
// pointer leaving the grid sideways is what hides the tooltip.
el("view-body").addEventListener("pointermove", trackPointer);

el("view-body").addEventListener("pointerleave", () => {
  el("view-tip").hidden = true;
  litHeaders(null, null);
  hoverMark(null);
  view.at = null;
});

el("layout-new").addEventListener("click", openLayoutForm);

for (const id of ["layout-cancel", "layout-cancel-2"]) {
  el(id).addEventListener("click", () => el("layout-form").close());
}

// input covers typing and the number spinners; change covers the radios and a
// paste that arrives as neither.
for (const event of ["input", "change"]) {
  el("layout-fields").addEventListener(event, refreshPreview);
}

el("layout-fields").addEventListener("submit", (event) => {
  // The dialog would close itself on submit — method="dialog" — and take the
  // form with it before the request had been answered. The close happens in
  // submitLayout(), once there is something to close on.
  event.preventDefault();
  submitLayout();
});

boot();
