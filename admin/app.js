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
 * One GET against the admin API, with the caller's identity attached.
 *
 * The token is fetched per request rather than held, because the SDK refreshes
 * it in the background and a copy kept here would be the stale one an hour into
 * a session.
 *
 * @param {string} path - Below /api/admin.
 * @returns {Promise<Object>} The parsed payload.
 */
async function api(path) {
  const headers = {};
  const token = await state.token();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`/api/admin${path}`, { headers });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(payload.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.email = payload.email || null;
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
  showModule(moduleFromHash() || "");
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
 * @param {boolean} [remember] - Whether to put it in the address bar.
 */
function showModule(key, remember = true) {
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
  // Short form here, unlike the document's own <title>: this is a browser tab,
  // and the module is the part worth reading when six of them are open.
  document.title = `${el("page-title").textContent} — ABSS DMS`;

  // Corrected even when the caller said not to remember, if the key asked for
  // was not a module: that is the stale-bookmark case, and leaving the address
  // bar naming a page that is not the one on screen is worse than rewriting it.
  if ((remember || !matched) && moduleFromHash() !== open) {
    // replaceState rather than assigning location.hash: the menu is not a
    // history stack, and a reader who clicked through four modules should not
    // have to press Back four times to leave the portal.
    history.replaceState(null, "", `#/${open}`);
  }
}

/**
 * @returns {string|null} The module named in the address bar, if any.
 */
function moduleFromHash() {
  const match = /^#\/([a-z-]+)$/.exec(location.hash);
  return match ? match[1] : null;
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
window.addEventListener("hashchange", () => {
  showModule(moduleFromHash() || "", false);
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

boot();
