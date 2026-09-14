/*
 * The donor app's local harness.
 *
 * Serves app/ and answers /api with the real publicapi.js over an in-memory
 * stand-in for Firestore. The API code under test is the deployed code — only
 * the database is fake — so a routing mistake, a validation gap or a wrong
 * status code shows up here rather than after a deploy.
 *
 * The campaigns below are fixtures with all three languages filled in, one of
 * them closed, so the empty case and the "this has ended" case can both be
 * looked at without touching the real database.
 *
 *   node tools/serve-app.cjs        then open http://localhost:5065
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const { createPublicApi } = require("../functions/publicapi");

const ROOT = path.join(__dirname, "..", "app");
const PORT = Number(process.env.PORT) || 5065;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
};

const CAMPAIGNS = {
  c1: {
    slug: "vesak-2026",
    active: true,
    referencePrefix: "VSK",
    photoUrl: null,
    name: {
      "zh-Hans": "卫塞节供僧大典",
      "zh-Hant": "衛塞節供僧大典",
      "en": "Vesak Day Offering",
    },
    description: {
      "zh-Hans": "谨订于卫塞节举行供僧大典，恭请十方善信随喜护持，共沾法喜。所得善款将用于道场日常运作及弘法活动。",
      "zh-Hant": "謹訂於衛塞節舉行供僧大典，恭請十方善信隨喜護持，共沾法喜。所得善款將用於道場日常運作及弘法活動。",
      "en": "An offering ceremony held on Vesak Day. All are warmly invited to take part. Gifts received support the temple's daily running and its teaching work.",
    },
    campaignStart: "2026-03-01",
    campaignEnd: "2026-12-31",
    eventStart: "2026-05-31",
    eventEnd: "2026-05-31",
    amounts: [100, 300],
    internalNote: "this must never reach the browser",
  },
  c2: {
    slug: "kathina-2026",
    active: true,
    referencePrefix: "KTH",
    photoUrl: null,
    name: {
      "zh-Hans": "卡提那功德衣法会",
      "zh-Hant": "卡提那功德衣法會",
      "en": "Kathina Robe Offering",
    },
    description: {
      "zh-Hans": "雨安居圆满，谨设卡提那功德衣法会，广邀善信共襄盛举。",
      "zh-Hant": "雨安居圓滿，謹設卡提那功德衣法會，廣邀善信共襄盛舉。",
      "en": "Marking the end of the rains retreat with the traditional offering of robes.",
    },
    campaignStart: "2026-08-01",
    campaignEnd: "2026-11-30",
    eventStart: "2026-10-25",
    eventEnd: "2026-10-25",
    amounts: [100, 300],
  },
  c3: {
    slug: "newyear-2025",
    active: true,
    referencePrefix: "NY",
    name: { "zh-Hans": "去年的活动", "zh-Hant": "去年的活動", "en": "Last year" },
    description: { "zh-Hans": "已结束", "zh-Hant": "已結束", "en": "Already over" },
    campaignStart: "2025-01-01",
    campaignEnd: "2025-02-28",
    amounts: [100],
  },
};

const donations = [];

const db = {
  collection(name) {
    if (name === "donations") {
      return {
        add: async (record) => {
          donations.push(record);
          console.log(`  donation #${donations.length}  ${record.reference}  ` +
            `S$${record.amount}  ${record.payBy}  ${record.name}`);
          return { id: `d${donations.length}` };
        },
      };
    }
    let predicate = () => true;
    const api = {
      where(field, _op, value) {
        const previous = predicate;
        predicate = (doc) => previous(doc) && doc[field] === value;
        return api;
      },
      limit: () => api,
      get: async () => {
        const docs = Object.entries(CAMPAIGNS)
          .filter(([, doc]) => predicate(doc))
          .map(([id, doc]) => ({ id, data: () => doc }));
        return { empty: docs.length === 0, docs };
      },
      doc: (id) => ({
        get: async () => ({
          exists: Boolean(CAMPAIGNS[id]),
          id,
          data: () => CAMPAIGNS[id],
        }),
      }),
    };
    return api;
  },
};

const handle = createPublicApi({
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
    ip: "127.0.0.1",
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

  if (url.pathname.startsWith("/api")) {
    if (req.method === "POST") {
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

  // Everything else is the single page, matching the Hosting rewrite. A file
  // is only served when one exists at that exact path.
  const name = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = path.join(ROOT, path.normalize(name).replace(/^(\.\.[/\\])+/, ""));

  fs.readFile(file, (error, content) => {
    if (error) {
      fs.readFile(path.join(ROOT, "index.html"), (fallbackError, page) => {
        res.writeHead(fallbackError ? 404 : 200, { "Content-Type": TYPES[".html"] });
        res.end(fallbackError ? "not found" : page);
      });
      return;
    }
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(content);
  });
});

server.listen(PORT, () => {
  console.log(`ABSS donation app harness on http://localhost:${PORT}`);
  console.log(`  open   /            → redirects to /zh-Hans/`);
  console.log(`  open   /en/         → the list in English`);
  console.log(`  open   /zh-Hant/c/vesak-2026`);
});
