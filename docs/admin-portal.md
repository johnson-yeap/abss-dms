# The admin portal

Written 2026-09-14. The first module with anything behind it is **Layouts**;
the other six are still empty.

It is a Hosting site (`abss-dms-admin`) over one Cloud Function (`adminApi`,
`asia-southeast1`). The function exists to answer one question — may the person
holding this token be here — and that question is the whole security boundary
today.

The shape is taken from the SpendLens admin portal: no framework, no bundler,
three files in `admin/`, and the allowlist enforced on the server rather than in
the page.

---

## Why the allowlist is where it is

Anybody with a Google account can obtain a valid ID token for this Firebase
project. `verifyIdToken()` therefore says only that the caller is who the token
claims — it does not say they may be here. The allowlist is the second check,
and it runs in `authorizeAdmin()` in `functions/index.js`:

1. A `Bearer` token, or `401 no-token`.
2. `verifyIdToken()`, or `401 bad-token`.
3. `email_verified === true`, or `401 unverified-email`. This matters because
   the allowlist is keyed on an email, and a provider handing over an unverified
   address would let an attacker pick the string it is compared against.
4. The lowercased email is in `ADMIN_EMAILS`, or `403 not-allowed`.

**The list lives in Secret Manager, not in this repository and not in the
database.** In the repository it would be a published list of the people worth
phishing. In Firestore it would be an authorisation rule stored inside the thing
it authorises.

`401` and `403` are answered differently on purpose. The person behind a `403`
is a colleague who just signed in with the wrong Google account, and a flat
"unauthorised" would send them looking for a bug instead of at the allowlist.
The email handed back to them is their own; it is not a disclosure.

Nothing in the browser enforces any of this. `admin/app.js` hides the portal
until `/api/admin/session` answers `200`, but that is presentation — the gate is
the function.

---

## First-time setup

Steps 1–2 are the CLI. Steps 3–5 are the Firebase console and cannot be done
from the CLI.

### 0. If this project belongs to a different Google account

The Firebase CLI holds several accounts and picks one per project directory.

```
firebase login:add                 # authorise the account that owns abss-dms
firebase login:list
firebase login:use <email>         # run this INSIDE this repository
```

`login:use` sets the default "for this project directory **or the global default
account if not in a Firebase project directory**". `firebase.json` is committed
here, so this directory qualifies and the setting stays local to it — another
project on this machine keeps its own account. Per-command instead:
`--account <email>`.

### 1. Create the project and the site

```
firebase projects:create abss-dms --display-name "ABSS DMS"
firebase apps:create WEB "ABSS DMS Admin"
firebase hosting:sites:create abss-dms-admin
```

Project ids are globally unique across Google Cloud, so `abss-dms` may be taken.
If you use a different one, change `.firebaserc` and the two `frame-src` origins
in `firebase.json`'s CSP to match.

The display names above are short on purpose and do not match the name the
portal shows. A Google Cloud project name is capped at 30 characters and "ABSS
Donation Management System (DMS)" is 37, so the full name cannot go there at
all. None of this is load-bearing: the id is what everything resolves by, the
display name is console decoration, and the name users read is the wordmark in
`admin/index.html`.

**The web app is not optional.** `app.js` reads the project's config from
`/__/firebase/init.json`, which Hosting serves from the web app — that is the
reason no API key is written into this repository. With one web app in the
project it resolves without being bound to a site; with several, bind the
intended one at creation time with `hosting:sites:create --app <appId>`, since
there is no `hosting:sites:update` to do it afterwards.

### 2–4. Blaze, Google sign-in, authorised domains — verify, do not assume

These were written up as manual console steps and then all three turned out to
be **already true** on this project. Creating it with `projects:create`, adding
a web app with `apps:create WEB`, and creating the site with
`hosting:sites:create` between them provisioned the lot. So check first; only
reach for the console if a check comes back wrong.

Billing — Blaze is exactly "a billing account is linked":

```
gcloud billing projects describe abss-dms
# want: billingEnabled: true
```

The nominal flag is not proof the link works. Enabling a billing-gated API is:

```
gcloud services enable secretmanager.googleapis.com --project=abss-dms
```

Google sign-in, and the authorised domains, both come from the Identity Toolkit
admin API. It needs `x-goog-user-project` — without it the call fails 403
`SERVICE_DISABLED` against gcloud's own project number, which reads like a
permissions problem and is not one:

```
TOKEN=$(gcloud auth print-access-token)
curl -s -H "Authorization: Bearer $TOKEN" -H "x-goog-user-project: abss-dms" \
  https://identitytoolkit.googleapis.com/admin/v2/projects/abss-dms/defaultSupportedIdpConfigs
# want: google.com with enabled: true and a clientId

curl -s -H "Authorization: Bearer $TOKEN" -H "x-goog-user-project: abss-dms" \
  https://identitytoolkit.googleapis.com/admin/v2/projects/abss-dms/config
# want: authorizedDomains contains abss-dms-admin.web.app
```

A Hosting site's domain is added to `authorizedDomains` when the site is
created, so a site made later than this document was written is covered too.

The single best check is the one the portal itself makes — no credentials
needed, just the web API key from `firebase apps:sdkconfig WEB <appId>`:

```
curl -s "https://identitytoolkit.googleapis.com/v1/projects?key=<apiKey>"
```

`200` is what `authAvailable()` in `app.js` wants. Anything else and the portal
disables its own sign-in button and says so on the gate, which is the behaviour
that check exists to produce.

If a check does come back wrong, the console paths are: Usage and billing →
Details & settings → Modify plan; Authentication → Get started → Google; and
Authentication → Settings → Authorized domains.

### 5. The allowlist

```
firebase functions:secrets:set ADMIN_EMAILS
```

That prompts. To set it without a terminal — from a script, or an agent with no
TTY — `--data-file -` reads the value from stdin instead:

```
printf 'ops@example.com' | firebase functions:secrets:set ADMIN_EMAILS --data-file -
```

Either form of the value works — a JSON array or a separated list:

```
["ops@example.com", "someone@example.com"]
ops@example.com, someone@example.com
```

`parseAllowlist()` takes both, because this is a value pasted at some remove
from anything that would say which was expected. It lowercases, and an unset or
malformed secret parses to an empty set — an allowlist nobody is on refuses
everybody, which is the safe way for that particular parse to fail.

**Changing the list needs a redeploy of the function**, not just a new secret
version: the parse is cached per instance.

### 6. Deploy

```
cd functions && npm install && cd ..
firebase deploy --only functions:adminApi
firebase deploy --only hosting:abss-dms-admin
```

Functions first. The Hosting rewrite points at a function in
`asia-southeast1`, and a rewrite to a function that is not there yet is a 404
rather than a deploy-time error — which is also why the `region` in
`firebase.json` and `REGION` in `functions/index.js` must not drift apart.

---

## Working on it locally

```
node tools/serve.cjs            # http://localhost:5055
GATE=1 node tools/serve.cjs     # the sign-in screen instead of the portal
```

The harness serves `admin/` and answers `/api/admin` with **the real
`functions/admin.js`**, over an in-memory stand-in for Firestore and an
`authorize()` that always says yes. Only the database and the allowlist are
fake, so a routing mistake, a validation gap or a wrong status code shows up
here rather than after a deploy — the same arrangement `serve-app.cjs` uses for
the donor app.

It used to answer the two routes itself, in ten lines, on the grounds that the
point of the harness was to run without the `authorize()` `admin.js` is built
around. That stopped paying the moment there was a module behind the gate: a
second implementation of `/layouts` would be a second thing to keep correct,
and the copy in the harness is the one nobody would notice had drifted.

Which mode applies is decided by `/api/admin/config`, not by the page: the
alternative — the page deciding it is in development because of where it was
served from — puts a bypass in the deployed bundle, one condition away from
being true in production. The portal draws "local harness — authentication off"
where the email goes, so a screenshot from it is never mistaken for the deployed
console.

The fixtures are the two halves of the Mid-Autumn lantern table and one
inactive hall, so both statuses and both allotments are on screen without
anybody having to make one.

`GATE=1` serves a stub `init.json` whose API key is not real, so the probe
reports the sign-in as unavailable and the button stays disabled. The gate's
layout is reviewable; its sign-in is not pretendable.

```
cd functions && npm test        # the gate, the allowlist parser, and layouts
```

---

## The side menu

Collapsed and expanded are the same markup. The labels stay in the DOM and are
hidden by width, so the state is one class (`.is-collapsed`) on the rail and
nothing is rebuilt to change it — which is also what lets a screen reader read a
label the eye cannot see, with `title` covering the pointer.

The chevron is **one** path in the markup, drawn pointing left and rotated 180°
by CSS off that same class. Two icons swapped in script would be two things to
keep in step with a state that already lives in a class. What script does set is
`aria-expanded` and the label, because neither a screen reader nor a tooltip can
see a rotation.

The choice is remembered in `localStorage` under `abss-dms.rail`, per browser
rather than per account: it is about the screen somebody is sitting at, not
about who they are. Every read and write is inside a `try` — `localStorage`
throws rather than returning null in a browser with site data blocked, and a
portal that will not load because it could not remember a menu width is a bad
trade. Without a stored choice the rail starts collapsed below 720px, where it
overlays the page rather than sitting beside it, and expanded above.

---

## The modules

Seven. One of them, Layouts, has something in it:

**Access Control**, **Broadcasts**, **Campaigns**, **Donations**, **Donors**,
**Layouts**, **Reports**.

Alphabetical by the label a reader sees — the only order that needs no
explaining to somebody looking for one of seven things. The generator that
writes the markup sorts on the label rather than the `data-module` key, because
those agree today and stop agreeing the first time a key abbreviates its label.

With no fragment in the address, the portal opens on the first item, Access
Control. That is "the top of the menu" rather than a considered landing page;
when one of these earns being the place people start, it is one line in
`showModule()`.

## The router

`#/donors` in the address bar, which means a module survives a reload, can be
linked to, and answers Back and Forward.

Three things about it worth knowing before changing it:

**The label is the only place a module's name is written.** The heading is
copied out of the active item, so the menu and the heading cannot disagree.

**`history.replaceState`, not `location.hash =`.** The menu is not a history
stack: someone who clicked through four modules should not press Back four
times to leave the portal.

**An unknown key falls back to the first module and rewrites the address bar
to match.** A stale bookmark is the ordinary way to arrive with one, and the
alternatives are both worse — a blank frame, or an address that names a page
other than the one on screen.

`aria-current` is removed from the inactive items rather than set to `"false"`.
The attribute has no falsy value; every string it accepts, that one included,
means "this is the current page".

## Adding the eighth module

1. An `<li>` in the `.modules` list in `index.html`, in alphabetical position,
   with a `data-module` key and an inline SVG icon. The icon must be inline:
   the CSP allows `img-src 'self' data:` and nothing external, and nothing in
   `app.js` builds markup from a string.
2. A `<section class="page" data-page="...">` whose `data-page` matches the
   key. Add it `hidden`; the router clears that on the one it opens.
3. Nothing in `app.js` for the routing. The router reads the DOM, and the click
   handler is one listener on the list rather than one per item, so an eighth
   button is not a second place to remember.

A module that has to *do* something adds one line to `showModule()`, where
Layouts has one: the router tells every module it has been opened, and only the
ones that have asked to hear it do anything. That is deliberately not a table
of pages the router knows are special.

Icons are drawn on a 24×24 viewBox at `stroke-width` 1.7 to match the rest.
Check a new one at 20px rather than on the artboard — the first Donations glyph
was a heart over an arc that read perfectly at 200px and looked like an
underline in the rail.

Anything that reads or writes real data also needs a route in
`functions/admin.js`, behind the same `authorize()` the gate uses.

---

## Layouts

A layout is a grid over a physical space that campaigns allot to donors — the
lanterns along a wall, the seats in a hall, the niches on a floor. One layout is
a specification several campaigns can each draw on, so it names the space and
not the giving: no campaign, no donor and no price is on it.

The shape is taken from the temple's own Mid-Autumn lantern plan, which is
lettered down the side, numbered across the top, and hangs its lanterns where
the rails cross. That is why rows are letters and columns are numbers here: a
donor is told their lantern is at `D5`, and a portal that addressed the same
wall differently would be a second naming of it.

### Three files

`functions/layout.js` is what a layout *is* — the counts, the addresses and what
will be accepted as one. Pure: no Firestore, no clock it is not handed, and
`layout.test.cjs` drives all of it without a project.

`functions/admin.js` is routing, status codes and the database, and decides
nothing about whether a grid is acceptable. `GET /layouts`, `POST /layouts`,
`PATCH /layouts/:id`, all behind the same `authorize()` as the gate.

`admin/app.js` draws it. Everything visible is built from the template in
`index.html` and filled through `textContent`; the only thing inserted as
elements is the grid, which is built node by node with `createElementNS`. A
layout's name is typed by a person, and this is the file that must never hand
one to a parser.

### Nothing derived is stored

A layout document holds its name, where it is, its rows, its columns, its
allotment and whether it is active. That is all. The number of cells, the number
of intersection nodes, the address of any one of them and the picture on the
card are **derived every time they are wanted**.

This is the reason there is no snapshot image anywhere: the "minimised snapshot"
on a card is an `<svg>` drawn from the three numbers each time it is drawn. A
stored PNG would be a copy of something already known, it would go stale the
first time a layout was edited, and it would cost a Storage bucket and a hole in
the `img-src` of the CSP to keep. The same routine draws the card and the
preview in the form, so a card cannot disagree with the form that made it.

### The counts, and the one thing to check before this ships

For a grid of `r` rows and `c` columns:

```
cells = r × c                    the spaces the lines enclose
nodes = (r + 1) × (c + 1)        the crossings of the lines
```

The nodes count is `(r + 1)` because `r` rows are drawn with `r + 1` horizontal
lines — one above each row and one below the last — and the four corners are
crossings like any other. Both counts are shown in the form whichever allotment
is chosen, because the point of showing them is the comparison: 8 × 5 is 40 of
one and 54 of the other, and that difference is the whole reason the choice
exists.

**Rows are the spaces, not the lines — decided, and worth knowing.** On the
lantern plan rows A–C are *rails*, and 3 rails × 18 verticals is 54 hanging
points with no `+ 1` anywhere. This form reads the other way: 4 rows means 4
bands, drawn with 5 rails, and that wall is entered here as 2 × 17.

It was decided that way so the two allotments give different numbers, which is
what makes the comparison in the form worth showing at all. The cost is that
somebody looking at a wall of 4 rails can reasonably type 4, so two things say
otherwise before they submit: the preview letters the rails it will actually
draw (A–E for 4 rows), and a line under the boxes names the addresses outright
— "Addresses run A1 to E19 — rows A to E, columns 1 to 19." If a layout still
turns up in the database one rail too tall, that line is the thing to make
louder.

### What this module deliberately cannot do

**Change a grid.** `PATCH` takes `active` and nothing else. A layout that has
been allotted from cannot lose a row without somebody deciding what happens to
whoever was in it, and that decision belongs with the module that does the
allotting.

**Describe a real plan in full.** The lantern table has nodes that are
deliberately empty, obstructions drawn on it (`PILLAR`, `TV`, `AIRCON`), a
part-row its planner called `CA`, and four kinds of lantern at different sizes
and prices. None of that is here. What is here is sized so that it can be:
nothing stores a count that assumes every node is usable, so blocked nodes
subtract from a capacity rather than contradicting a stored number, and the
labels are generated rather than fixed, so a layout carrying its own can
override them.

**Two grids in one layout.** The lantern plan is one sheet with two blocks on
it, 600×600 above and 300×300 below. Those are two layouts here, sharing a
building, a floor and a location. If they turn out to need to be one thing —
printed together, allotted together — that is a layout holding a list of grids
rather than one grid, and it is a change to `layout.js` before it is a change
to anything else.
