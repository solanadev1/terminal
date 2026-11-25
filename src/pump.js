// Dev launch history read straight from the pump.fun program on-chain.
//
// Every pump.fun bonding curve account stores the wallet that created it
// (bytes 49..81), so one filtered getProgramAccounts call returns every
// pump.fun launch a wallet has made, whether or not any indexer still lists it.
// The curve data alone tells us whether each launch bonded or died. To show a
// launch's name we map curve -> token (cached forever, a curve never changes token).

import { ed25519 } from "@noble/curves/ed25519";

export const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const DEFAULT_RPC = "https://api.mainnet-beta.solana.com";
const LAMPORTS = 1e9;
const MAX_RESOLVE = 20; // curve->token lookups per report on top of the cache

// ---------- base58 ----------
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function b58encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = "";
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = "1" + s; }
  return s;
}
export function b58decode(str) {
  let n = 0n;
  for (const c of str) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error("bad base58");
    n = n * 58n + BigInt(i);
  }
  const out = [];
  while (n > 0n) { out.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const c of str) { if (c !== "1") break; out.unshift(0); }
  return new Uint8Array(out);
}

// ---------- PDA ----------
function onCurve(bytes) {
  try { ed25519.ExtendedPoint.fromHex(bytes); return true; } catch { return false; }
}
export async function findProgramAddress(seeds, programId) {
  const program = b58decode(programId);
  const marker = new TextEncoder().encode("ProgramDerivedAddress");
  for (let bump = 255; bump >= 0; bump--) {
    const parts = [...seeds, Uint8Array.of(bump), program, marker];
    const buf = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of parts) { buf.set(p, o); o += p.length; }
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
    if (!onCurve(hash)) return b58encode(hash);
  }
  throw new Error("no PDA");
}
export const bondingCurveFor = (mint) =>
  findProgramAddress([new TextEncoder().encode("bonding-curve"), b58decode(mint)], PUMP_PROGRAM);

// ---------- RPC ----------
async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw new Error(`${method}: ${body.error?.message || res.status}`);
  return body.result;
}

const readU64 = (d, o) => Number(new DataView(d.buffer, d.byteOffset + o, 8).getBigUint64(0, true));

// Every pump.fun curve created by `creator`.
export async function fetchCreatorCurves(creator, rpcUrl = DEFAULT_RPC) {
  const params = [PUMP_PROGRAM, {
    encoding: "base64",
    dataSlice: { offset: 0, length: 49 },
    filters: [{ memcmp: { offset: 49, bytes: creator } }],
  }];
  let result;
  for (let attempt = 0; ; attempt++) {
    try { result = await rpc(rpcUrl, "getProgramAccounts", params); break; }
    catch (err) {
      if (attempt >= 2 || !/429|Too many/i.test(err.message)) throw err;
      await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
    }
  }
  return result.map(({ pubkey, account }) => {
    const d = Uint8Array.from(atob(account.data[0]), (c) => c.charCodeAt(0));
    return {
      curve: pubkey,
      space: account.space,
      realSol: d.length >= 40 ? readU64(d, 32) / LAMPORTS : 0,
      bonded: d[48] === 1,
    };
  });
}

// ---------- token names straight from the chain ----------
// Dead launches drop out of every indexer, but their names live on-chain forever:
// Token-2022 mints carry them in a metadata extension, classic SPL mints in a
// Metaplex metadata account. Two getMultipleAccounts calls per 100 tokens.
const METAPLEX = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
const clean = (s) => (s || "").replace(/\0/g, "").trim() || null;

function parseMetaplex(bytes) {
  let o = 1 + 32 + 32;
  const str = () => {
    const len = new DataView(bytes.buffer, bytes.byteOffset + o, 4).getUint32(0, true);
    o += 4;
    const s = new TextDecoder().decode(bytes.subarray(o, o + len));
    o += len;
    return clean(s);
  };
  const name = str();
  const symbol = str();
  return { name, symbol };
}

export async function fetchTokenNames(mints, rpcUrl = DEFAULT_RPC) {
  const out = new Map();
  for (let i = 0; i < mints.length; i += 100) {
    const chunk = mints.slice(i, i + 100);
    let accounts;
    try { accounts = (await rpc(rpcUrl, "getMultipleAccounts", [chunk, { encoding: "jsonParsed" }])).value; }
    catch { continue; }
    const legacy = [];
    accounts.forEach((a, j) => {
      const ext = (a?.data?.parsed?.info?.extensions || []).find((e) => e.extension === "tokenMetadata");
      if (ext) out.set(chunk[j], { name: clean(ext.state.name), symbol: clean(ext.state.symbol) });
      else if (a) legacy.push(chunk[j]);
    });
    if (!legacy.length) continue;
    try {
      const enc = new TextEncoder();
      const pdas = await Promise.all(legacy.map((m) => findProgramAddress([enc.encode("metadata"), b58decode(METAPLEX), b58decode(m)], METAPLEX)));
      const metas = (await rpc(rpcUrl, "getMultipleAccounts", [pdas, { encoding: "base64" }])).value;
      metas.forEach((a, j) => {
        if (!a) return;
        try { out.set(legacy[j], parseMetaplex(Uint8Array.from(atob(a.data[0]), (c) => c.charCodeAt(0)))); } catch {}
      });
    } catch {}
  }
  return out;
}

// ---------- curve -> token cache ----------
const memory = new Map();
const cacheKey = (curve) => new Request(`https://cache.solanaview.internal/curve/${curve}`);
async function cachedMint(curve) {
  if (memory.has(curve)) return memory.get(curve);
  if (typeof caches === "undefined" || !caches.default) return null;
  const hit = await caches.default.match(cacheKey(curve)).catch(() => null);
  if (!hit) return null;
  const mint = await hit.text();
  memory.set(curve, mint);
  return mint;
}
async function rememberMint(curve, mint) {
  memory.set(curve, mint);
  if (typeof caches === "undefined" || !caches.default) return;
  await caches.default.put(cacheKey(curve), new Response(mint, {
    headers: { "cache-control": "public, max-age=31536000, immutable" },
  })).catch(() => {});
}

async function mintFromRpc(curve, space, rpcUrl) {
  // Newer curves (larger accounts) mostly hold Token-2022 mints; try that program first.
  const order = space > 150 ? [TOKEN_2022, TOKEN] : [TOKEN, TOKEN_2022];
  for (const programId of order) {
    const r = await rpc(rpcUrl, "getTokenAccountsByOwner", [curve, { programId }, { encoding: "jsonParsed" }]);
    const mint = r?.value?.[0]?.account?.data?.parsed?.info?.mint;
    if (mint) return mint;
  }
  return null;
}

// Fill `mint` on as many curves as we can: cache first, then DexScreener (which
// lists live pump.fun curves by curve address), then RPC one at a time.
export async function resolveCurveMints(curves, { rpcUrl = DEFAULT_RPC, pairsByCurve = new Map() } = {}) {
  for (const c of curves) {
    c.mint = await cachedMint(c.curve);
    const pair = pairsByCurve.get(c.curve);
    if (!c.mint && pair) { c.mint = pair.baseToken.address; await rememberMint(c.curve, c.mint); }
  }
  let budget = MAX_RESOLVE;
  // Resolve in parallel pairs; the public RPC rejects bursts and batches.
  const todo = curves.filter((c) => !c.mint);
  for (let i = 0; i < todo.length && budget > 0; i += 2) {
    const slice = todo.slice(i, i + 2);
    budget -= slice.length;
    const results = await Promise.allSettled(slice.map((c) => mintFromRpc(c.curve, c.space, rpcUrl)));
    let limited = false;
    results.forEach((r, j) => {
      if (r.status === "fulfilled" && r.value) { slice[j].mint = r.value; rememberMint(slice[j].curve, r.value); }
      if (r.status === "rejected" && /429|Too many/i.test(r.reason?.message)) limited = true;
    });
    if (limited) break;
  }
  return curves;
}
