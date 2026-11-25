// SolanaView API worker.
// Serves the static site from ./public and a small JSON API that turns
// public on-chain data into a "who is the dev and what have they done before" report.

import { buildReport } from "./report.js";
import { fetchTrending } from "./sources.js";
import { recordLaunches, devLaunchesFromDb } from "./store.js";

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/api/config") {
        return json({
          referralAccount: env.REFERRAL_ACCOUNT || null,
          referralFeeBps: clampFee(env.REFERRAL_FEE_BPS),
        }, 300);
      }

      if (path === "/api/trending") {
        return json(await fetchTrending(), 60);
      }

      const tokenMatch = path.match(/^\/api\/token\/([^/]+)$/);
      if (tokenMatch) {
        const mint = tokenMatch[1];
        if (!MINT_RE.test(mint)) return json({ error: "That doesn't look like a Solana token address." }, 0, 400);
        const lookupKnown = env.DB ? (creator) => devLaunchesFromDb(env.DB, creator) : null;
        const report = await buildReport(mint, { lookupKnown, rpcUrl: env.RPC_URL || undefined });
        if (env.DB) ctx.waitUntil(recordLaunches(env.DB, report).catch(() => {}));
        return json(report, 30);
      }

      if (path.startsWith("/api/")) return json({ error: "Not found" }, 0, 404);
      return env.ASSETS.fetch(request);
    } catch (err) {
      const status = err.status || 502;
      return json({ error: err.publicMessage || "Couldn't load data right now. Try again in a moment." }, 0, status);
    }
  },
};

function clampFee(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(255, Math.max(50, Math.round(n)));
}

function json(body, maxAge = 0, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": maxAge ? `public, max-age=${maxAge}` : "no-store",
    },
  });
}
