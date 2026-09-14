# ABSS DMS

```
admin/          the portal — index.html, app.css, app.js, favicon.svg
functions/      adminApi, and the allowlist that guards it
tools/          serve.cjs, the local harness
docs/           admin-portal.md — setup, and why the gate is shaped this way
```

Run it locally, no Firebase project needed:

```
node tools/serve.cjs          # http://localhost:5055
cd functions && npm test
```

Setting up the Firebase project, the allowlist secret, and the first deploy:
[docs/admin-portal.md](docs/admin-portal.md).
