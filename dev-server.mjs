// Local preview without Cloudflare: `node dev-server.mjs` then open http://localhost:8787
// Runs the same worker code, serving ./public for everything outside /api.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import worker from "./src/worker.js";

const PORT = Number(process.env.PORT) || 8787;
const root = new URL("./public/", import.meta.url).pathname;
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

const ASSETS = {
  async fetch(req) {
    const { pathname } = new URL(req.url);
    const file = normalize(join(root, pathname === "/" ? "index.html" : pathname));
    for (const f of [file, join(root, "index.html")]) {
      if (!f.startsWith(root)) continue;
      try {
        return new Response(await readFile(f), { headers: { "content-type": types[extname(f)] || "application/octet-stream" } });
      } catch {}
    }
    return new Response("Not found", { status: 404 });
  },
};

const env = {
  ASSETS,
  REFERRAL_ACCOUNT: process.env.REFERRAL_ACCOUNT || "",
  REFERRAL_FEE_BPS: process.env.REFERRAL_FEE_BPS || "75",
};
const ctx = { waitUntil() {} };

createServer(async (req, res) => {
  const request = new Request(`http://localhost:${PORT}${req.url}`, { method: req.method, headers: req.headers });
  const response = await worker.fetch(request, env, ctx);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(PORT, () => console.log(`SolanaView on http://localhost:${PORT}`));
