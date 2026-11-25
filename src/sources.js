// Thin wrappers around the public data sources SolanaView reads.
//  - RugCheck: creator wallet, creator's earlier launches, holders, insider networks, authorities.
//  - DexScreener: price, market cap, liquidity, volume, pair age, socials.

const RUGCHECK = "https://api.rugcheck.xyz/v1";
const DEXSCREENER = "https://api.dexscreener.com";

export class SourceError extends Error {
  constructor(publicMessage, status = 502) {
    super(publicMessage);
    this.publicMessage = publicMessage;
    this.status = status;
  }
}

async function getJSON(url, cacheTtl = 30) {
  const res = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "SolanaView/0.1" },
    // On Cloudflare this caches upstream responses at the edge, which keeps us
    // well under the public APIs' rate limits. Ignored when run elsewhere.
    cf: { cacheTtl, cacheEverything: true },
  });
  if (!res.ok) {
    const err = new Error(`${url} -> ${res.status}`);
    err.upstreamStatus = res.status;
    err.upstreamBody = (await res.text().catch(() => "")).slice(0, 300);
    throw err;
  }
  return res.json();
}

const warn = (fallback) => (err) => { console.warn("dexscreener failed:", err.message); return fallback; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchRugcheck(mint) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await getJSON(`${RUGCHECK}/tokens/${mint}/report`, 60);
    } catch (err) {
      lastErr = err;
      const notFound = err.upstreamStatus === 404 ||
        (err.upstreamStatus === 400 && /not ?found|invalid|unable to find/i.test(err.upstreamBody || ""));
      if (notFound) throw new SourceError("No token found at that address.", 404);
      if (attempt < 2) await sleep(attempt === 0 ? 800 : 2000);
    }
  }
  {
    const err = lastErr;
    if (err.upstreamStatus === 429) {
      throw new SourceError("Data provider is rate limiting us. Try again in a few seconds.", 429);
    }
    throw new SourceError("Couldn't reach the token data provider. Try again in a moment.");
  }
}

// DexScreener accepts up to 30 addresses per call.
export async function fetchPairs(mints) {
  const unique = [...new Set(mints)].filter(Boolean);
  const chunks = [];
  for (let i = 0; i < unique.length; i += 30) chunks.push(unique.slice(i, i + 30));
  const results = await Promise.all(
    chunks.map((c) => getJSON(`${DEXSCREENER}/tokens/v1/solana/${c.join(",")}`, 30).catch(warn([]))),
  );
  return results.flat();
}

// Look pairs up by pair address. Live pump.fun tokens are listed under their bonding curve address.
export async function fetchPairsByAddress(addresses) {
  const chunks = [];
  for (let i = 0; i < addresses.length; i += 30) chunks.push(addresses.slice(i, i + 30));
  const results = await Promise.all(
    chunks.map((c) => getJSON(`${DEXSCREENER}/latest/dex/pairs/solana/${c.join(",")}`, 60).then((r) => r.pairs || []).catch(warn([]))),
  );
  return results.flat();
}

// Best (most liquid) pair for each base token.
export function bestPairByMint(pairs) {
  const best = new Map();
  for (const p of pairs) {
    const mint = p?.baseToken?.address;
    if (!mint) continue;
    const cur = best.get(mint);
    if (!cur || (p.liquidity?.usd || 0) > (cur.liquidity?.usd || 0)) best.set(mint, p);
  }
  return best;
}

export async function fetchTrending() {
  const [boosts, profiles] = await Promise.all([
    getJSON(`${DEXSCREENER}/token-boosts/top/v1`, 60).catch(() => []),
    getJSON(`${DEXSCREENER}/token-profiles/latest/v1`, 60).catch(() => []),
  ]);
  const mints = [];
  for (const t of [...(boosts || []), ...(profiles || [])]) {
    if (t.chainId === "solana" && !mints.includes(t.tokenAddress)) mints.push(t.tokenAddress);
  }
  const best = bestPairByMint(await fetchPairs(mints.slice(0, 30)));
  return mints
    .map((m) => best.get(m))
    .filter((p) => p && (p.liquidity?.usd || 0) > 0)
    .slice(0, 20)
    .map((p) => ({
      mint: p.baseToken.address,
      symbol: p.baseToken.symbol,
      name: p.baseToken.name,
      image: p.info?.imageUrl || null,
      marketCap: p.marketCap ?? p.fdv ?? null,
      change24h: p.priceChange?.h24 ?? null,
      volume24h: p.volume?.h24 ?? null,
      pairCreatedAt: p.pairCreatedAt || null,
    }));
}
