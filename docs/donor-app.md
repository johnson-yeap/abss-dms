# The donor app

Written 2026-09-14. The public half: choose a campaign, fill in a form, pay.

`abss-dms.web.app`, over `publicApi` in `asia-southeast1`. Its own Hosting site
and its own origin, deliberately not the admin portal's — this one is opened by
anybody with a phone, and nothing it does should share cookies or storage with
a console over the temple's records.

---

## The shape of it

```
/                            → /zh-Hans/
/zh-Hans/                    the open campaigns
/en/c/vesak-2026             one campaign's form, in English
/zh-Hant/done/VSK-7Q2M9C     after submitting
```

**The locale is in the path, not a cookie or a header.** The temple hands these
links out — a poster with a QR on it, a message to a WhatsApp group — and
`/zh-Hant/c/vesak-2026` has to open in Traditional Chinese for whoever taps it,
on a phone that has never been here and has no preference stored.

A bare `/` is corrected with `replaceState`, so what a donor bookmarks or
forwards says which language it opens in, and Back still leaves the site rather
than bouncing between `/` and `/zh-Hans/`.

The language toggle keeps you where you are: switching on a campaign form
reloads that campaign in the new language rather than returning to the list.
Its entries are real links, so they can be opened in a new tab, and each is
labelled in its own script — somebody who has landed in a language they cannot
read is looking for the writing they recognise, not a translated label.

---

## Three languages

`app/i18n.js` holds all three tables in one file, so a string added in English
and forgotten in the other two is visible on the same screen as the omission.

**Simplified and Traditional are written separately, not converted.** The
vocabulary differs where it matters to this audience — 联络/聯絡, 号码/號碼 —
and running one through a converter produces text that is technically
Traditional and reads as though nobody wrote it.

`check()` reports a key present in one table and missing from another. It needs
to exist because `t()` falls back silently, so the failure is invisible: the app
quietly serves Simplified to an English reader for as long as nobody looks.

Campaign text is per-locale on the document. `localised()` falls back through
the other languages rather than showing nothing — an English reader whose
description has not been translated yet is better served by the Chinese one
than by a blank panel.

---

## What the server will accept

`functions/donation.js` is pure and has no Firestore in it. It is the one place
in this project that takes input from an anonymous stranger and turns it into a
stored record with somebody's phone number in it, which is why it is the module
with the tests.

Three things it does that are easy to get wrong:

**Characters are counted with `[...string]`, not `.length`.** The wishes on this
form are mostly Chinese and, on a phone keyboard, frequently emoji. `.length`
counts UTF-16 code units, so "🙏🙏" is four to it and two to the donor — a limit
that disagrees with the counter under the box looks broken.

**Amounts are a closed set, not a minimum.** The dropdown is closed, so an
amount that is not on it did not come from the form.

**Errors are field/code pairs, never sentences.** The server does not know which
of three phrasings the page is in; the browser owns the wording.

**Blessing recipients are dropped, not refused, when blank.** The form adds a
row when the donor presses Add, and an empty one left behind is a row they
thought better of rather than a mistake to stop a donation for. At most ten,
each under the donor's own 80-character limit. Repeats are kept, unlike the
contact methods — two people really can share a name, and a family offering on
behalf of two relatives called 陈美玲 should not silently lose one of them.

`publicapi.js` adds the rules that need the database: a campaign is re-checked
at submit, because it can close between a page being opened and its form being
sent, and the browser holding a stale page has no way to know.

**A donation is written as `pending-payment`, always.** Whichever way it is
being paid. A PayNow donor who has been shown a QR has not thereby
transferred, and writing anything else here would be this endpoint asserting
something it cannot know. `receiptNo` and `paidAt` are written as `null` in the
same breath, so that every donation has one shape and the admin portal never
has to tell "not paid yet" apart from "written before these fields existed".

**Nothing is echoed back.** A reflected value is how an endpoint like this
becomes somebody else's delivery mechanism.

---

## Why nothing touches Firestore from a browser

`firestore.rules` denies everything. Every read and write goes through a Cloud
Function with the Admin SDK, which bypasses rules entirely.

It matters most for `donations`: those carry a name and a phone number. A public
read rule on that collection — or a public create rule, which is the shape a
browser-writes-directly design needs — would put somebody's contact details one
query away from anyone who opened the site.

`publicCampaign()` is an allowlist rather than a delete-list, for the same
reason: the admin portal will grow fields on these documents, and the safe
default for a field nobody has thought about yet is that the public site does
not serve it.

### The throttle is not a defence

`POST_PER_WINDOW` is a per-instance map keyed on the caller's address. Cloud Run
runs many instances and that map is not shared between them, so a determined
flood gets through in proportion to how many instances it spins up. It stops the
accident and the idle script.

A real one is App Check with reCAPTCHA Enterprise, or a counter in Firestore.
Neither is here yet. If this starts being abused, that is the fix — not a
smaller number in the constant.

---

## PayNow, and why there is a reference code

The QR is static. **It encodes no amount and no reference**, so a transfer
arriving at the bank says only that somebody sent money — not who, not how
much was meant, not which campaign.

The reference is the single thread between a line on a bank statement and a row
in `donations`. It leads with the campaign's prefix so the office can see which
campaign a payment belongs to without looking anything up, and its alphabet has
no `0`/`O` and no `1`/`I`/`L`, because it is read off a screen and typed into a
banking app from memory a moment later.

**Nothing in this system watches a bank account.** Every donation is written
`status: "pending"` and no code moves it past that. Reconciliation is somebody
at the temple comparing a bank statement to the admin portal.

A dynamic QR encoding the amount and reference would remove all of this, and
needs the temple's UEN or registered mobile number plus a correct SGQR/EMVCo
payload. That is the upgrade worth making when someone can supply the UEN.

### The QR file

400KB to 79KB, by palette reduction rather than resizing. **Do not resample a
QR** — blurred module edges are what makes a code fail to scan. Quantising to 16
colours with no dithering maps each pixel to the nearest palette entry and moves
no edges: 26 of ~110,000 sampled pixels changed light/dark state, all of them
anti-aliasing at module boundaries, none of them module centres.

---

## Working on it locally

```
node tools/serve-app.cjs        # http://localhost:5065
```

Serves `app/` and answers `/api` with **the real `publicapi.js`** over an
in-memory stand-in for Firestore. The API under test is the deployed code; only
the database is fake, so a routing mistake or a wrong status code shows up here
rather than after a deploy. The fixtures include a closed campaign, so the
"this has ended" path can be looked at without touching real data.

```
cd functions && npm test        # 70 checks across three suites
```

---

## Campaigns

Seeded by `tools/seed-campaigns.cjs`, which talks to the Firestore REST API with
a token from gcloud rather than using firebase-admin — which would want
application-default credentials, meaning another interactive login and a key
cached on the machine.

Documents are keyed by slug, so running it twice updates rather than duplicates.
It never deletes: a campaign taken down is `active: false`, not a row removed
from under a donor mid-donation.

**This file should be deleted when the admin portal's Campaigns module can write
campaigns.** Two ways to create the same thing is one too many.

```
campaigns/{slug}
  slug              "vesak-2026"
  active            true          the temple's switch, checked before dates
  referencePrefix   "VSK"         leads the donation reference
  photoUrl          null          header image; null draws no header
  name              {zh-Hans, zh-Hant, en}
  description       {zh-Hans, zh-Hant, en}
  campaignStart     "2026-03-01"  when donations open
  campaignEnd       "2026-12-31"  when they close
  eventStart        "2026-05-31"  when the ceremony is
  eventEnd          "2026-05-31"
  amounts           [100, 300]
```

Dates are plain ISO days rather than timestamps: a campaign runs for a day in
Singapore, and a timestamp invites the question of whose midnight it means every
time somebody reads one. A missing end date means it has not closed — the other
reading, a missing date parsing to zero, is a campaign that silently refuses
money.

---

---

## The form's fields

| Field | Required | Limit | Stored as |
| --- | --- | --- | --- |
| Name | yes | 80 characters | `name` |
| Contact number | yes | 8–15 digits | `phone` |
| How may we contact you | no | any of three | `contact[]` |
| Donation amount | yes | the campaign's own set | `amount` |
| Blessing recipient(s) | no | 10 names, 80 characters each | `recipients[]` |
| Your wishes | no | 100 characters | `wishes` |
| Payment method | yes | PayNow or cash | `payBy` |

**Recipients and wishes are both there, and neither replaced the other.** A
wish is a sentence and a recipient is a name. The office searches for the
second by typing a name into a box in the admin portal, and parsing names out
of a free-text sentence is guesswork that would be wrong in three languages at
once. The donor gets a repeatable name field *and* the textarea.

The recipient rows are built by `app.js` from a template rather than written in
the markup, so `[data-i18n]` does not reach them — `applyRecipientStrings()`
re-words them instead, which also covers a donor switching language halfway
through filling the form in. The last row is emptied rather than removed when
its ✕ is pressed: a form that can reach zero rows is a form whose field has
disappeared, and the donor is left pressing Add to find out where it went.

---

## Still to do

- **Campaign photos.** `photoUrl` is read and drawn, and nothing sets it. The
  CSP already allows the two Google Storage hosts an admin upload would serve
  from.
- **Donors.** Donations are stored; nothing yet groups them by phone number into
  the Donors module.
- **Nobody is told.** A submitted donation reaches the database and no further:
  no confirmation to the donor, no notice to the office.
- **Deleting a donation.** Somebody will ask. There is no route for it, on
  purpose, until there is a considered answer about what "delete" means for a
  record the bank statement still refers to.
