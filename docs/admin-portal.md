# The admin portal

Written 2026-09-14, with the first module: **Layouts**, which is deliberately
empty.

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

The harness serves `admin/` and answers the two API routes with authentication
off. `/api/admin/config` is what decides this, not the page: the alternative —
the page deciding it is in development because of where it was served from —
puts a bypass in the deployed bundle, one condition away from being true in
production. The portal draws "local harness — authentication off" where the
email goes, so a screenshot from it is never mistaken for the deployed console.

`GATE=1` serves a stub `init.json` whose API key is not real, so the probe
reports the sign-in as unavailable and the button stays disabled. The gate's
layout is reviewable; its sign-in is not pretendable.

```
cd functions && npm test        # the gate's statuses and the allowlist parser
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

## Adding the second module

1. An `<li>` in the `.modules` list in `index.html`, with an inline SVG icon and
   a label. The icon must be inline: the CSP allows `img-src 'self' data:` and
   nothing external.
2. A `<section class="page">` for it.
3. Routing. There is none today — one module needs no router, and writing one
   for a single page would be guessing at what the second needs.

Anything that reads or writes real data also needs a route in `functions/admin.js`,
behind the same `authorize()` the gate uses.
