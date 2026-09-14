/*
 * The local harness.
 *
 * Serves admin/ and answers /api/admin with the real admin.js over an
 * in-memory stand-in for Firestore, with the gate wired open. The portal can
 * be worked on without a Firebase project, a deploy or a Google account, and
 * the code under test is the deployed code — only the database and the
 * allowlist are fake, so a routing mistake, a validation gap or a wrong status
 * code shows up here rather than after a deploy.
 *
 * It used to answer the two routes itself, in ten lines, on the grounds that
 * the point of the harness was to run without the authorize() admin.js is
 * built around. That stopped paying the moment there was a module behind the
 * gate: a second implementation of /layouts would be a second thing to keep
 * correct, and the copy in here is the one nobody would notice had drifted.
 * authorize() is injected, so it can simply be one that always says yes.
 *
 * The portal says "local harness — authentication off" in the rail when it is
 * running against this, so a screenshot from here is never mistaken for the
 * deployed console.
 *
 *   node tools/serve.cjs          then open http://localhost:5055
 *   GATE=1 node tools/serve.cjs   the sign-in screen instead of the portal
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const { createAdminApi } = require("../functions/admin");

const ROOT = path.join(__dirname, "..", "admin");
const PORT = Number(process.env.PORT) || 5055;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

// Fixtures taken from the Mid-Autumn lantern table, which is the plan this
// module was built from: two grids over the same hall, allotted by the nodes
// where the rails cross, lettered down the side and numbered across the top.
// The third is inactive and allotted by cell, so that both statuses and both
// allotments are on screen without anybody having to make one.
const LAYOUTS = {
  l1: {
    name: "Lantern Table — 600×600",
    building: "Main Building",
    floor: "1",
    location: "Main Hall, upper rails",
    rows: 4,
    columns: 18,
    allottedBy: "node",
    active: true,
    createdAt: "2026-09-10T02:00:00.000Z",
    updatedAt: "2026-09-10T02:00:00.000Z",
  },
  l2: {
    name: "Lantern Table — 300×300",
    building: "Main Building",
    floor: "1",
    location: "Main Hall, lower rails",
    rows: 16,
    columns: 19,
    allottedBy: "node",
    active: true,
    createdAt: "2026-09-10T02:05:00.000Z",
    updatedAt: "2026-09-10T02:05:00.000Z",
  },
  l3: {
    name: "Main Hall Seating",
    building: "Main Building",
    floor: "2",
    location: "Dharma Hall",
    rows: 12,
    columns: 10,
    allottedBy: "cell",
    active: false,
    createdAt: "2026-08-02T09:30:00.000Z",
    updatedAt: "2026-09-01T04:00:00.000Z",
  },
};

let written = 0;

// Enough of Firestore for the routes admin.js has: a limited list, an add, and
// a get/update by id. Deliberately not more — a fake that grows features the
// real one is not being asked for is a fake that can pass a test the database
// would fail.
const db = {
  collection() {
    const api = {
      limit: () => api,
      get: async () => ({
        docs: Object.entries(LAYOUTS).map(([id, doc]) => ({
          id,
          data: () => doc,
        })),
      }),
      add: async (record) => {
        written += 1;
        const id = `new${written}`;
        LAYOUTS[id] = record;
        console.log(`  layout  ${id}  ${record.name}  ` +
          `${record.rows}×${record.columns}  by ${record.allottedBy}`);
        return { id };
      },
      doc: (id) => ({
        get: async () => ({
          exists: Boolean(LAYOUTS[id]),
          id,
          data: () => LAYOUTS[id],
        }),
        update: async (patch) => {
          Object.assign(LAYOUTS[id], patch);
          console.log(`  layout  ${id}  ${LAYOUTS[id].name}  ` +
            `${patch.active === false ? "deactivated" : "activated"}`);
        },
      }),
    };
    return api;
  },
};

const handle = createAdminApi({
  // GATE=1 puts the harness in front of the sign-in screen instead of past it,
  // which is the only way to work on the gate without deploying. The stub
  // init.json below has no real API key in it, so the probe in app.js reports
  // the sign-in as unavailable and the button stays disabled — the layout is
  // reviewable, the sign-in is not pretendable.
  authMode: process.env.GATE ? "firebase" : "none",
  // The one thing the harness fakes that matters. Everything downstream of it
  // is the real file.
  authorize: async () => ({
    ok: true,
    email: "local harness — authentication off",
  }),
  getDb: () => db,
  getTimestamp: () => ({ now: () => new Date().toISOString() }),
});

/**
 * Turns a Node request/response pair into what the handler expects.
 *
 * @param {Object} req - The Node request.
 * @param {Object} res - The Node response.
 * @param {Object} body - The parsed JSON body, if any.
 * @returns {Promise<void>} When answered.
 */
async function callApi(req, res, body) {
  const shim = {
    method: req.method,
    path: new URL(req.url, "http://localhost").pathname,
    body,
    get: (key) => req.headers[key.toLowerCase()] || "",
  };
  const out = {
    headers: {},
    set(k, v) { out.headers[k] = v; return out; },
    status(c) { out.code = c; return out; },
    json(payload) {
      res.writeHead(out.code || 200, {
        ...out.headers,
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify(payload));
      return out;
    },
  };
  await handle(shim, out);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/__/firebase/init.json") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      apiKey: "harness-not-a-real-key",
      projectId: "harness",
    }));
    return;
  }

  if (url.pathname.startsWith("/api/admin")) {
    if (req.method === "POST" || req.method === "PATCH") {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        let body;
        try {
          body = JSON.parse(raw);
        } catch (error) {
          body = {};
        }
        callApi(req, res, body).catch(() => {
          res.writeHead(500).end('{"error":"harness"}');
        });
      });
      return;
    }
    callApi(req, res).catch(() => {
      res.writeHead(500).end('{"error":"harness"}');
    });
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
  console.log(`  ${Object.keys(LAYOUTS).length} layouts, held in memory`);
});
