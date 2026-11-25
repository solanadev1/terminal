// Builds the SolanaView token report: market data, the dev's launch history,
// holder concentration, insider networks and a transparent risk score.

import { fetchRugcheck, fetchPairs, fetchPairsByAddress, bestPairByMint } from "./sources.js";
import { fetchCreatorCurves, resolveCurveMints, bondingCurveFor, fetchTokenNames } from "./pump.js";

const DEAD_MCAP = 10_000;      // below this a past launch counts as dead
const DEAD_LIQ = 1_000;        // or when it has almost no liquidity left
const RUNNER_MCAP = 1_000_000; // a launch that reached real size
const NEW_MS = 60 * 60 * 1000; // launches younger than this aren't judged yet
const DAY = 24 * 60 * 60 * 1000;
const DEAD_CURVE_SOL = 0.5;    // an unbonded curve holding less SOL than this has been sold out

export async function buildReport(mint, { lookupKnown = null, rpcUrl } = {}) {
  const rc = await fetchRugcheck(mint);
  const creator = rc.creator || null;

  // 1) Launches we already know about: RugCheck's list and our own records.
  const pastMap = new Map();
  for (const t of rc.creatorTokens || []) {
    if (t?.mint && t.mint !== mint) pastMap.set(t.mint, { mint: t.mint, createdAt: t.createdAt || null, marketCapAtScan: t.marketCap ?? null });
  }
  if (creator && lookupKnown) {
    for (const t of await lookupKnown(creator).catch(() => [])) {
      if (t.mint === mint) continue;
      const cur = pastMap.get(t.mint) || { mint: t.mint };
      pastMap.set(t.mint, {
        ...cur,
        createdAt: cur.createdAt || t.created_at || null,
        marketCapAtScan: cur.marketCapAtScan ?? t.last_mcap ?? null,
        peakMarketCap: t.peak_mcap ?? null,
        symbol: t.symbol || cur.symbol,
        name: t.name || cur.name,
      });
    }
  }

  // 2) Every pump.fun launch by this wallet, read from the chain.
  let curves = [];
  let historySource = "rugcheck";
  let historyFailed = false;
  if (creator) {
    try {
      const own = await bondingCurveFor(mint);
      curves = (await fetchCreatorCurves(creator, rpcUrl)).filter((c) => c.curve !== own);
      historySource = "chain";
    } catch (err) {
      console.warn("creator curves failed:", err.message);
      curves = [];
      historyFailed = true;
    }
  }
  if (curves.length) {
    // Tokens we already know map to their curve by address math, no lookups needed.
    const byCurve = new Map(curves.map((c) => [c.curve, c]));
    for (const m of pastMap.keys()) {
      const c = byCurve.get(await bondingCurveFor(m));
      if (c) c.mint = m;
    }
    // Look up the likeliest-alive curves first; dead ones are rarely still listed.
    const ordered = curves.filter((c) => !c.mint).sort((a, b) => b.bonded - a.bonded || b.realSol - a.realSol);
    const curvePairs = await fetchPairsByAddress(ordered.slice(0, 90).map((c) => c.curve));
    const pairsByCurve = new Map(curvePairs.map((p) => [p.pairAddress, p]));
    await resolveCurveMints(ordered, { rpcUrl, pairsByCurve });
  }
  const curveByMint = new Map(curves.filter((c) => c.mint).map((c) => [c.mint, c]));
  for (const c of curves) {
    if (c.mint && c.mint !== mint && !pastMap.has(c.mint)) pastMap.set(c.mint, { mint: c.mint });
  }

  const pairs = await fetchPairs([mint, ...pastMap.keys()]);
  const best = bestPairByMint(pairs);
  const nameless = [...pastMap.values()].filter((t) => !best.get(t.mint) && !t.symbol).map((t) => t.mint);
  const chainNames = nameless.length ? await fetchTokenNames(nameless, rpcUrl).catch(() => new Map()) : new Map();
  for (const [m, n] of chainNames) Object.assign(pastMap.get(m), { name: n.name, symbol: n.symbol });
  const main = best.get(mint) || null;

  const now = Date.now();
  const named = [...pastMap.values()].map((t) => {
    const p = best.get(t.mint);
    const c = curveByMint.get(t.mint);
    const marketCapNow = p ? (p.marketCap ?? p.fdv ?? null) : null;
    const liquidityNow = p ? (p.liquidity?.usd ?? null) : null;
    const createdAt = t.createdAt || (p?.pairCreatedAt ? new Date(p.pairCreatedAt).toISOString() : null);
    const peak = Math.max(t.peakMarketCap || 0, t.marketCapAtScan || 0, marketCapNow || 0) || null;
    return {
      mint: t.mint,
      curve: c?.curve || null,
      symbol: p?.baseToken?.symbol || t.symbol || null,
      name: p?.baseToken?.name || t.name || null,
      image: p?.info?.imageUrl || null,
      createdAt,
      marketCapNow,
      liquidityNow,
      peakSeen: peak,
      // Graduated if the curve says so, or if it trades in a real pool off the curve.
      bonded: c ? (c.bonded || (!!p && p.dexId !== "pumpfun" && (liquidityNow ?? 0) >= DEAD_LIQ)) : null,
      status: classify({ createdAt, marketCapNow, liquidityNow, fallbackMcap: t.marketCapAtScan, curve: c, now }),
    };
  }).sort((a, b) => (Date.parse(b.createdAt || 0) || 0) - (Date.parse(a.createdAt || 0) || 0));

  // Curves we couldn't name this time still count toward the track record.
  const unnamed = curves.filter((c) => !c.mint).map((c) => ({
    mint: null, curve: c.curve, symbol: null, name: null, image: null, createdAt: null,
    marketCapNow: null, liquidityNow: null, peakSeen: null, bonded: c.bonded,
    status: classify({ curve: c, now }),
  }));
  const launches = [...named, ...unnamed];

  const judged = launches.filter((l) => l.status !== "new");
  const stats = {
    total: launches.length,
    dead: judged.filter((l) => l.status === "dead").length,
    alive: judged.filter((l) => l.status === "alive").length,
    runners: judged.filter((l) => l.status === "runner").length,
    bonded: launches.filter((l) => l.bonded).length,
    last30d: launches.filter((l) => l.createdAt && now - Date.parse(l.createdAt) < 30 * DAY).length,
    bestMarketCap: launches.reduce((m, l) => Math.max(m, l.peakSeen || 0), 0) || null,
  };
  stats.deadRate = judged.length ? stats.dead / judged.length : null;

  const supply = Number(rc.token?.supply) || 0;
  const pct = (raw) => (supply ? (Number(raw) / supply) * 100 : null);

  const poolAccounts = new Set();
  for (const [addr, info] of Object.entries(rc.knownAccounts || {})) {
    if (info?.type === "AMM" || info?.type === "LOCKER") poolAccounts.add(addr);
  }
  for (const m of rc.markets || []) {
    for (const k of ["pubkey", "liquidityA", "liquidityB"]) if (m[k]) poolAccounts.add(m[k]);
  }
  const holders = (rc.topHolders || []).map((h) => ({
    wallet: h.owner || h.address,
    pct: h.pct,
    insider: !!h.insider,
    isDev: !!creator && h.owner === creator,
    isPool: poolAccounts.has(h.owner) || poolAccounts.has(h.address),
    label: rc.knownAccounts?.[h.owner]?.name || rc.knownAccounts?.[h.address]?.name || null,
  }));
  const realHolders = holders.filter((h) => !h.isPool);
  const top10Pct = realHolders.slice(0, 10).reduce((s, h) => s + (h.pct || 0), 0);

  const networks = (rc.insiderNetworks || []).map((n) => ({
    type: n.type,
    wallets: n.size || n.activeAccounts || 0,
    holdingPct: pct(n.currentHolding),
  }));
  const insiderPct = networks.reduce((s, n) => s + (n.holdingPct || 0), 0);
  const insiderWallets = rc.graphInsidersDetected || networks.reduce((s, n) => s + n.wallets, 0);

  // Locked share across all pools, weighted by how much liquidity each pool holds,
  // so a dust pool with nothing locked doesn't drown out a fully locked main pool.
  let lockedUsd = 0, totalUsd = 0;
  for (const m of rc.markets || []) {
    const usd = (m.lp?.quoteUSD || 0) + (m.lp?.baseUSD || 0);
    if (typeof m.lp?.lpLockedPct !== "number" || usd <= 0) continue;
    lockedUsd += usd * (m.lp.lpLockedPct / 100);
    totalUsd += usd;
  }
  const lpLockedPct = totalUsd > 0 ? (lockedUsd / totalUsd) * 100 : null;

  const security = {
    mintAuthority: rc.token?.mintAuthority || null,
    freezeAuthority: rc.token?.freezeAuthority || null,
    mutableMetadata: !!rc.tokenMeta?.mutable,
    transferFeePct: rc.transferFee?.pct || 0,
    lpLockedPct,
    holderCount: rc.totalHolders ?? null,
    top10Pct,
    insiderWallets,
    insiderPct,
    insiderNetworks: networks,
    // RugCheck's creatorBalance can lag; the live holder list is the better signal when the dev is in it.
    devHoldsPct: Math.max(pct(rc.creatorBalance) || 0, holders.filter((h) => h.isDev).reduce((s, h) => s + (h.pct || 0), 0)),
    rugged: !!rc.rugged,
    flags: (rc.risks || []).map((r) => ({ name: r.name, level: r.level, description: r.description, value: r.value })),
  };

  const market = main ? {
    priceUsd: main.priceUsd ? Number(main.priceUsd) : null,
    marketCap: main.marketCap ?? main.fdv ?? null,
    liquidityUsd: main.liquidity?.usd ?? null,
    volume24h: main.volume?.h24 ?? null,
    change24h: main.priceChange?.h24 ?? null,
    change1h: main.priceChange?.h1 ?? null,
    buys24h: main.txns?.h24?.buys ?? null,
    sells24h: main.txns?.h24?.sells ?? null,
    pairAddress: main.pairAddress,
    dexId: main.dexId,
    dexUrl: main.url,
    pairCreatedAt: main.pairCreatedAt || null,
    websites: (main.info?.websites || []).map((w) => w.url),
    socials: (main.info?.socials || []).map((s) => ({ type: s.type, url: s.url })),
  } : null;

  const token = {
    mint,
    name: rc.tokenMeta?.name || rc.fileMeta?.name || main?.baseToken?.name || "Unknown",
    symbol: rc.tokenMeta?.symbol || rc.fileMeta?.symbol || main?.baseToken?.symbol || "???",
    image: main?.info?.imageUrl || rc.fileMeta?.image || null,
    launchpad: rc.launchpad?.name || null,
    createdAt: market?.pairCreatedAt ? new Date(market.pairCreatedAt).toISOString() : null,
  };

  const dev = { wallet: creator, launches, stats, source: historySource, historyFailed };
  const { score, verdict, factors } = scoreReport({ dev, security, market });

  return {
    token, market, dev, security, holders: realHolders.slice(0, 10),
    score, verdict, factors,
    generatedAt: new Date().toISOString(),
  };
}

function classify({ createdAt, marketCapNow, liquidityNow, fallbackMcap, curve, now }) {
  if (createdAt && now - Date.parse(createdAt) < NEW_MS) return "new";
  const trading = marketCapNow != null && (liquidityNow ?? 0) >= DEAD_LIQ;
  // With no live market, the curve is the truth: a sold-out, unbonded curve is dead.
  // (A live pool wins over the curve: some tokens trade in pools their curve never fed.)
  if (!trading && curve && !curve.bonded) return curve.realSol < DEAD_CURVE_SOL ? "dead" : "alive";
  const mcap = marketCapNow ?? fallbackMcap ?? 0;
  if (marketCapNow != null && liquidityNow != null && liquidityNow < DEAD_LIQ) return "dead";
  if (mcap < DEAD_MCAP) return "dead";
  if (mcap >= RUNNER_MCAP) return "runner";
  return "alive";
}

// Every point taken off is listed as a factor, so the score is never a black box.
export function scoreReport({ dev, security: s, market }) {
  const factors = [];
  const add = (impact, label, detail) => factors.push({ impact, label, detail });
  // Some findings are disqualifying on their own, whatever else looks fine.
  let hardFail = false;
  let unverified = false;

  if (s.rugged) { add(-100, "Marked as rugged", "Liquidity was pulled or the token was flagged as a rug."); hardFail = true; }
  if (s.mintAuthority) { add(-30, "Dev can mint more tokens", "Mint authority is still enabled, so supply can be inflated."); hardFail = true; }
  if (s.freezeAuthority) { add(-30, "Dev can freeze wallets", "Freeze authority is enabled, so holders can be blocked from selling."); hardFail = true; }
  if (s.transferFeePct > 0) add(-15, `${s.transferFeePct}% transfer tax`, "Every transfer pays a fee to the token owner.");

  const st = dev.stats;
  const judged = st.dead + st.alive + st.runners;
  if (!dev.wallet) {
    add(-5, "Dev wallet unknown", "We couldn't identify who launched this token.");
  } else if (dev.historyFailed && st.total === 0) {
    // Never hand out an all-clear we couldn't check.
    add(-10, "Couldn't check the dev's history", "The on-chain lookup failed this time. Refresh to try again.");
    unverified = true;
  } else if (st.total === 0) {
    add(0, "No earlier launches on record", "Either a first-time dev or a fresh wallet. Fresh wallets are common for serial launchers too.");
  } else {
    const bondedNote = st.bonded ? ` Only ${st.bonded} ever bonded.` : " None of them ever bonded.";
    if (judged >= 10 && st.deadRate >= 0.9) {
      add(-55, `Serial launcher: ${st.dead} of ${judged} earlier launches died`, `This wallet launches tokens in bulk and almost all go to zero.${bondedNote}`);
      hardFail = true;
    } else if (judged >= 3 && st.deadRate >= 0.8) {
      add(-35, `Serial launcher: ${st.dead} of ${judged} earlier launches died`, `Most of this dev's previous tokens went to near zero.${bondedNote}`);
    } else if (judged >= 2 && st.deadRate >= 0.5) {
      add(-15, `${st.dead} of ${judged} earlier launches died`, st.deadRate >= 0.8 ? "This dev's previous tokens went to near zero." : "Mixed track record.");
    }
    if (st.last30d >= 10) add(-10, `${st.last30d} launches in the last 30 days`, "High launch frequency usually means farming fees, not building.");
    if (st.runners > 0) add(+10, `${st.runners} earlier launch${st.runners > 1 ? "es" : ""} passed $1M`, "This dev has shipped tokens that held real value.");
  }

  if (s.insiderPct >= 20) add(-25, `Insiders hold ${s.insiderPct.toFixed(1)}%`, `${s.insiderWallets} linked wallets funded from the same source.`);
  else if (s.insiderPct >= 8) add(-15, `Insiders hold ${s.insiderPct.toFixed(1)}%`, `${s.insiderWallets} linked wallets funded from the same source.`);
  else if (s.insiderWallets > 0) add(-5, `${s.insiderWallets} linked insider wallets`, `Together they hold ${s.insiderPct.toFixed(1)}%.`);

  if (s.top10Pct >= 50) add(-20, `Top 10 wallets hold ${s.top10Pct.toFixed(0)}%`, "A few wallets can crash the price.");
  else if (s.top10Pct >= 30) add(-10, `Top 10 wallets hold ${s.top10Pct.toFixed(0)}%`, "Supply is fairly concentrated.");

  if (s.devHoldsPct >= 10) add(-15, `Dev still holds ${s.devHoldsPct.toFixed(1)}%`, "The dev can dump a large bag.");
  else if (s.devHoldsPct >= 3) add(-5, `Dev still holds ${s.devHoldsPct.toFixed(1)}%`, "");

  if (s.lpLockedPct != null && s.lpLockedPct < 90) add(-15, `Only ${s.lpLockedPct.toFixed(0)}% of liquidity locked`, "Unlocked liquidity can be pulled.");
  if (market && market.liquidityUsd != null && market.liquidityUsd < 5_000) add(-10, "Very thin liquidity", "Small trades will move the price a lot, and selling may be hard.");
  if (!market) add(-10, "No trading pair found", "This token isn't trading anywhere we can see.");
  if (s.mutableMetadata) add(-3, "Metadata can be changed", "Name, image and links can be edited after launch.");

  const score = Math.max(0, Math.min(100, 100 + factors.reduce((t, f) => t + f.impact, 0)));
  const verdict = hardFail || score < 45 ? "danger" : score < 75 || unverified ? "caution" : "clean";
  factors.sort((a, b) => a.impact - b.impact);
  return { score, verdict, factors };
}
