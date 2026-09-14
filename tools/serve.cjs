/*
 * The local harness.
 *
 * Serves admin/ and answers the two API routes with authentication turned off,
 * so the portal can be worked on without a Firebase project, a deploy, or a
 * Google account. The portal says "local harness — authentication off" in the
 * rail when it is running against this, so a screenshot from here is never
 * mistaken for the deployed console.
 *
 * Node's own http and fs, no dependencies: this is forty lines of routing and
 * it should not be a reason to run npm install at the root.
 *
 *   node tools/serve.cjs          then open http://localhost:5055
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "admin");
const PORT = Number(process.env.PORT) || 5055;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // The same two routes admin.js answers, with the gate wired open. Kept in
  // this file rather than by requiring admin.js, because the point of the
  // harness is to run without the authorize() that module is built around.
  if (url.pathname === "/api/admin/config") {
    res.writeHead(200, { "Content-Type": "application/json" });
    // GATE=1 puts the harness in front of the sign-in screen instead of past
    // it, which is the only way to work on the gate without deploying. The
    // stub config below has no real API key in it, so the probe in app.js
    // reports the sign-in as unavailable and the button stays disabled —
    // the layout is reviewable, the sign-in is not pretendable.
    res.end(JSON.stringify({ auth: process.env.GATE ? "firebase" : "none" }));
    return;
  }

  if (url.pathname === "/__/firebase/init.json") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ apiKey: "harness-not-a-real-key", projectId: "harness" }));
    return;
  }

  if (url.pathname === "/api/admin/session") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ viewer: "local harness — authentication off" }));
    return;
  }

  // Everything else is the single page, matching the Hosting rewrite.
  const name = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = path.join(ROOT, path.normalize(name).replace(/^(\.\.[/\\])+/, ""));

  fs.readFile(file, (error, body) => {
    if (error) {
      fs.readFile(path.join(ROOT, "index.html"), (fallbackError, page) => {
        res.writeHead(fallbackError ? 404 : 200, {
          "Content-Type": TYPES[".html"],
        });
        res.end(fallbackError ? "not found" : page);
      });
      return;
    }
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(body);
  });
});

server.listen(PORT, () => {
  console.log(`ABSS DMS admin harness on http://localhost:${PORT}`);
});
