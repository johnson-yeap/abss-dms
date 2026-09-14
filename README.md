# ABSS Donation Management System (DMS)

Two halves, on two origins.

```
app/            the donor app — abss-dms.web.app, open to anybody
admin/          the staff portal — abss-dms-admin.web.app, behind an allowlist
functions/      adminApi (the portal) and publicApi (the donation form)
tools/          the two local harnesses, and the campaign seed
docs/           donor-app.md, admin-portal.md
```

Run either locally, no Firebase project needed:

```
node tools/serve-app.cjs      # the donor app, http://localhost:5065
node tools/serve.cjs          # the admin portal, http://localhost:5055
cd functions && npm test      # 111 checks
```

The donor app's harness runs the real API over an in-memory database, so the
code under test is the deployed code.

- [docs/donor-app.md](docs/donor-app.md) — the form, the three languages, and
  why there is a reference code on the PayNow page.
- [docs/admin-portal.md](docs/admin-portal.md) — project setup, the allowlist
  secret, and why the gate is shaped the way it is.
