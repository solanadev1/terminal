const app = document.getElementById("app");
const SOL = "So11111111111111111111111111111111111111112";
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
let config = { referralAccount: null, referralFeeBps: null };
const configReady = fetch("/api/config").then((r) => r.json()).then((c) => { config = c; }).catch(() => {});

// ---------- formatting ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function usd(n, { price = false } = {}) {
  if (n == null || !Number.isFinite(n)) return "—";
  if (price && n < 0.01) {
    const s = n.toFixed(12).replace(/0+$/, "");
    const m = s.match(/^0\.(0+)(\d{1,4})/);
    if (m && m[1].length >= 3) return `$0.0<sub>${m[1].length}</sub>${m[2]}`;
    return "$" + n.toPrecision(3);
  }
  const a = Math.abs(n);
  if (a >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return "$" + (n / 1e3).toFixed(1) + "K";
  return "$" + n.toFixed(price ? 4 : 0);
}
const pct = (n, d = 1) => (n == null || !Number.isFinite(n) ? "—" : n.toFixed(d) + "%");
const change = (n) => (n == null ? "—" : `<span class="${n >= 0 ? "up" : "down"}">${n >= 0 ? "+" : ""}${n.toFixed(1)}%</span>`);
const short = (a) => (a ? a.slice(0, 4) + "…" + a.slice(-4) : "—");
function ago(t) {
  if (!t) return "—";
  const s = (Date.now() - new Date(t).getTime()) / 1000;
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + "m";
  if (s < 86400) return Math.round(s / 3600) + "h";
  if (s < 86400 * 60) return Math.round(s / 86400) + "d";
  if (s < 86400 * 730) return Math.round(s / (86400 * 30)) + "mo";
  return Math.round(s / (86400 * 365)) + "y";
}
function avatar(img, sym, cls = "") {
  return img
    ? `<img class="avatar ${cls}" src="${esc(img)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`
    : `<div class="avatar ${cls}">${esc((sym || "?").slice(0, 2))}</div>`;
}
const solscan = (a) => `https://solscan.io/account/${a}`;

// ---------- routing ----------
function navigate(path) {
  if (location.pathname !== path) history.pushState({}, "", path);
  route();
}
window.addEventListener("popstate", route);
document.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-link]");
  if (a && !e.metaKey && !e.ctrlKey && a.origin === location.origin) {
    e.preventDefault();
    navigate(a.pathname);
  }
});
function wireSearch(form, errorEl) {
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = form.q.value.trim().replace(/^.*\/(?=[1-9A-HJ-NP-Za-km-z]{32,44}$)/, "");
    if (!MINT_RE.test(q)) {
      if (errorEl) { errorEl.textContent = "That isn't a Solana token address. Paste the full address (32–44 characters)."; errorEl.hidden = false; }
      else form.q.setCustomValidity("Paste a full Solana token address"), form.q.reportValidity(), form.q.setCustomValidity("");
      return;
    }
    form.q.value = "";
    form.q.blur();
    navigate("/t/" + q);
  });
}
wireSearch(document.getElementById("search-top"));

function route() {
  const m = location.pathname.match(/^\/t\/([1-9A-HJ-NP-Za-km-z]{32,44})\/?$/);
  window.scrollTo(0, 0);
  if (m) return renderToken(m[1]);
  renderHome();
}

// ---------- home ----------
async function renderHome() {
  document.body.classList.add("home");
  document.title = "SolanaView: see the dev before you buy";
  app.replaceChildren(document.getElementById("home-tpl").content.cloneNode(true));
  wireSearch(document.getElementById("search-hero"), document.getElementById("hero-error"));
  const grid = document.getElementById("trend-grid");
  try {
    const list = await fetch("/api/trending").then((r) => r.json());
    if (!Array.isArray(list) || !list.length) throw new Error();
    grid.innerHTML = list.map((t) => `
      <a class="trend-card" href="/t/${esc(t.mint)}" data-link>
        ${avatar(t.image, t.symbol)}
        <div class="t-meta">
          <div class="t-sym">${esc(t.symbol)}</div>
          <div class="t-sub">${usd(t.marketCap)} mcap · ${ago(t.pairCreatedAt)} old</div>
        </div>
        <div>${change(t.change24h)}</div>
      </a>`).join("");
  } catch {
    grid.innerHTML = `<p class="empty">Couldn't load trending tokens right now.</p>`;
  }
}

// ---------- token page ----------
let currentMint = null;
async function renderToken(mint) {
  document.body.classList.remove("home");
  currentMint = mint;
  app.innerHTML = `<div class="loading"><div class="spinner"></div>Checking the dev's history…</div>`;
  let r;
  try {
    const res = await fetch("/api/token/" + mint);
    r = await res.json();
    if (!res.ok) throw new Error(r.error || "Something went wrong.");
  } catch (err) {
    if (currentMint !== mint) return;
    app.innerHTML = `<div class="error-box"><h1>Couldn't load this token</h1><p class="muted">${esc(err.message)}</p><p><a href="/" data-link class="pill">Back to home</a></p></div>`;
    return;
  }
  if (currentMint !== mint) return;
  document.title = `${r.token.symbol} · ${verdictLabel(r.verdict)} · SolanaView`;

  app.innerHTML = `
    <div class="token-layout">
      <div class="token-main">
        ${headCard(r)}
        ${verdictCard(r)}
        ${devCard(r)}
        ${chartCard(r)}
        ${securityCard(r)}
        ${holdersCard(r)}
      </div>
      <aside class="side">
        <section class="card trade-card">
          <h2>Trade ${esc(r.token.symbol)}</h2>
          <div id="jupiter-plugin"></div>
          <p class="trade-note" id="trade-note"></p>
        </section>
      </aside>
    </div>`;

  app.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", () => {
    navigator.clipboard?.writeText(b.dataset.copy);
    b.textContent = "Copied";
    setTimeout(() => (b.textContent = "Copy"), 1200);
  }));
  const more = app.querySelector("#more-launches");
  if (more) more.addEventListener("click", () => {
    app.querySelectorAll("tr.extra").forEach((tr) => (tr.hidden = false));
    more.remove();
  });
  mountTrade(r);
}

function verdictLabel(v) {
  return { clean: "Looks clean", caution: "Trade with caution", danger: "High risk" }[v] || v;
}

function headCard(r) {
  const { token: t, market: m } = r;
  const links = [
    ...(m?.websites || []).slice(0, 1).map((u) => `<a class="pill" href="${esc(u)}" target="_blank" rel="noopener">Website</a>`),
    ...(m?.socials || []).slice(0, 3).map((s) => `<a class="pill" href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.type === "twitter" ? "X" : s.type)}</a>`),
    m?.dexUrl ? `<a class="pill" href="${esc(m.dexUrl)}" target="_blank" rel="noopener">DexScreener</a>` : "",
  ].join("");
  return `
    <section class="card head-card">
      <div class="token-head">
        ${avatar(t.image, t.symbol, "lg")}
        <div class="names">
          <h1>${esc(t.name)} <span class="sym">$${esc(t.symbol)}</span></h1>
          <div class="addr-row">
            <span class="mono">${short(t.mint)}</span>
            <button class="copy" data-copy="${esc(t.mint)}">Copy</button>
            ${t.launchpad ? `<span class="pill">${esc(t.launchpad)}</span>` : ""}
            ${links}
          </div>
        </div>
      </div>
      <div class="stats">
        <div class="stat"><div class="k">Price</div><div class="v">${usd(m?.priceUsd, { price: true })}</div></div>
        <div class="stat"><div class="k">Market cap</div><div class="v">${usd(m?.marketCap)}</div></div>
        <div class="stat"><div class="k">Liquidity</div><div class="v">${m?.liquidityUsd == null && m?.dexId === "pumpfun" ? "On curve" : usd(m?.liquidityUsd)}</div></div>
        <div class="stat"><div class="k">24h volume</div><div class="v">${usd(m?.volume24h)}</div></div>
        <div class="stat"><div class="k">24h change</div><div class="v">${change(m?.change24h)}</div></div>
        <div class="stat"><div class="k">Age</div><div class="v">${ago(t.createdAt)}</div></div>
      </div>
    </section>`;
}

function verdictCard(r) {
  const summary = {
    clean: "Nothing major stands out in the dev's history or the holder spread.",
    caution: "Some warning signs. Read the reasons below before you size in.",
    danger: "Serious warning signs. Many tokens like this go to zero.",
  }[r.verdict];
  const factors = r.factors.map((f) => {
    const cls = f.impact < 0 ? "neg" : f.impact > 0 ? "pos" : "neu";
    const imp = f.impact > 0 ? "+" + f.impact : f.impact === 0 ? "info" : f.impact;
    return `<li class="factor ${cls}"><span class="imp">${imp}</span><div><b>${esc(f.label)}</b>${f.detail ? `<span class="d">${esc(f.detail)}</span>` : ""}</div></li>`;
  }).join("");
  return `
    <section class="card verdict-card">
      <div class="verdict">
        <div class="ring ${r.verdict}" style="--p:${r.score}"><div><span>${r.score}</span><small>of 100</small></div></div>
        <div>
          <p class="verdict-title ${r.verdict}">${verdictLabel(r.verdict)}</p>
          <p>${summary}</p>
        </div>
      </div>
      ${factors ? `<ul class="factors">${factors}</ul>` : `<p class="empty" style="margin-top:16px">No red flags found.</p>`}
    </section>`;
}

function devCard(r) {
  const d = r.dev;
  if (!d.wallet) {
    return `<section class="card"><h2>Dev history</h2><p class="empty">We couldn't identify the wallet that launched this token.</p></section>`;
  }
  const s = d.stats;
  const n = d.launches.length;
  const seg = (k, v) => (v ? `<i class="${k}" style="width:${(v / n) * 100}%"></i>` : "");
  const fresh = n - s.dead - s.alive - s.runners;
  const rows = d.launches.map((l, i) => `
    <tr class="${i >= 8 ? "extra" : ""}" ${i >= 8 ? "hidden" : ""}>
      <td>${l.mint
        ? `<a class="tok" href="/t/${esc(l.mint)}" data-link>${avatar(l.image, l.symbol, "sm")}<b>${esc(l.symbol || short(l.mint))}</b></a>`
        : `<a class="tok muted" href="${solscan(l.curve)}" target="_blank" rel="noopener">${avatar(null, "?", "sm")}<span>Unnamed launch</span></a>`}</td>
      <td>${l.createdAt ? ago(l.createdAt) + " ago" : "—"}</td>
      <td>${l.bonded == null ? "—" : l.bonded ? `<span class="up">Yes</span>` : "No"}</td>
      <td>${usd(l.marketCapNow)}</td>
      <td><span class="status ${l.status}">${{ dead: "Dead", alive: "Alive", runner: "Runner", new: "New" }[l.status]}</span></td>
    </tr>`).join("");
  return `
    <section class="card">
      <h2>Dev history <span class="count">${n ? `· ${n} earlier launch${n === 1 ? "" : "es"}` : ""}</span></h2>
      <div class="dev-top">
        <span class="muted">Launched by</span>
        <a class="dev-wallet" href="${solscan(d.wallet)}" target="_blank" rel="noopener">${short(d.wallet)}</a>
        <button class="copy" data-copy="${esc(d.wallet)}">Copy</button>
        <span class="muted">Dev holds ${pct(r.security.devHoldsPct)} of supply</span>
      </div>
      ${n ? `
        <div class="tally">
          <div><div class="n">${n}</div><div class="l">Earlier launches</div></div>
          <div class="dead"><div class="n">${s.dead}</div><div class="l">Dead (under $10K)</div></div>
          <div class="alive"><div class="n">${s.bonded}</div><div class="l">Bonded</div></div>
          <div class="runner"><div class="n">${s.runners}</div><div class="l">Passed $1M</div></div>
        </div>
        <div class="bar" title="${s.dead} dead · ${s.alive} alive · ${s.runners} passed $1M">${seg("dead", s.dead)}${seg("alive", s.alive)}${seg("runner", s.runners)}${seg("new", fresh)}</div>
        <div class="table-wrap"><table>
          <thead><tr><th>Token</th><th>Launched</th><th>Bonded</th><th>Market cap now</th><th>Status</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
        ${n > 8 ? `<button class="more" id="more-launches">Show all ${n}</button>` : ""}
        <p class="trade-note">${d.source === "chain" ? "Read from pump.fun on-chain records, so deleted or delisted launches still count." : "From RugCheck's records."}</p>
      ` : d.historyFailed
        ? `<p class="empty">We couldn't load this dev's launch history right now. Refresh in a moment to try again.</p>`
        : `<p class="empty">No earlier launches from this wallet${d.source === "chain" ? " on pump.fun" : " on record"}. That can mean a first-time dev, or a fresh wallet used to hide a history.</p>`}
    </section>`;
}

function chartCard(r) {
  if (!r.market?.pairAddress) return "";
  const src = `https://dexscreener.com/solana/${encodeURIComponent(r.market.pairAddress)}?embed=1&loadChartSettings=0&trades=0&info=0&tabs=0&chartLeftToolbar=0&chartTheme=dark&theme=dark&chartStyle=1&chartType=usd&interval=15`;
  return `<section class="card chart-card"><iframe src="${src}" title="Price chart" loading="lazy"></iframe></section>`;
}

function securityCard(r) {
  const s = r.security;
  const c = (state, title, sub) => `<div class="check ${state}"><span class="dot"></span><div><b>${esc(title)}</b><span>${esc(sub)}</span></div></div>`;
  const checks = [
    s.mintAuthority ? c("bad", "Mint authority on", "Dev can print more tokens") : c("ok", "Mint authority off", "Supply is fixed"),
    s.freezeAuthority ? c("bad", "Freeze authority on", "Dev can freeze your tokens") : c("ok", "Freeze authority off", "Nobody can freeze holders"),
    s.lpLockedPct == null ? c("warn", "Liquidity lock unknown", "No pool data") : s.lpLockedPct >= 90 ? c("ok", `${s.lpLockedPct.toFixed(0)}% liquidity locked`, "Can't be pulled") : c("bad", `${s.lpLockedPct.toFixed(0)}% liquidity locked`, "Rest can be pulled"),
    s.insiderWallets ? c(s.insiderPct >= 8 ? "bad" : "warn", `${s.insiderWallets} insider wallets`, `Linked wallets hold ${pct(s.insiderPct)}`) : c("ok", "No insider network found", "No linked wallet clusters"),
    c(s.top10Pct >= 50 ? "bad" : s.top10Pct >= 30 ? "warn" : "ok", `Top 10 hold ${pct(s.top10Pct, 0)}`, "Excluding liquidity pools"),
    c(s.devHoldsPct >= 10 ? "bad" : s.devHoldsPct >= 3 ? "warn" : "ok", `Dev holds ${pct(s.devHoldsPct)}`, "Of total supply"),
    s.transferFeePct ? c("bad", `${s.transferFeePct}% transfer tax`, "Charged on every transfer") : c("ok", "No transfer tax", "Token-2022 fee is off"),
    c(s.mutableMetadata ? "warn" : "ok", s.mutableMetadata ? "Metadata editable" : "Metadata locked", s.mutableMetadata ? "Name and image can change" : "Name and image are final"),
  ].join("");
  const holders = s.holderCount != null ? ` <span class="count">· ${s.holderCount.toLocaleString()} holders</span>` : "";
  return `<section class="card"><h2>Token safety${holders}</h2><div class="checks">${checks}</div></section>`;
}

function holdersCard(r) {
  if (!r.holders.length) return "";
  const max = Math.max(...r.holders.map((h) => h.pct || 0), 1);
  const rows = r.holders.map((h, i) => `
    <tr>
      <td class="muted">${i + 1}</td>
      <td><a class="mono" href="${solscan(h.wallet)}" target="_blank" rel="noopener">${short(h.wallet)}</a>${h.isDev ? `<span class="tag dev">DEV</span>` : ""}${h.insider ? `<span class="tag insider">INSIDER</span>` : ""}${h.label ? ` <span class="muted">${esc(h.label)}</span>` : ""}</td>
      <td><span class="holder-bar"><i style="width:${((h.pct || 0) / max) * 100}%"></i></span>${pct(h.pct, 2)}</td>
    </tr>`).join("");
  return `<section class="card"><h2>Top holders <span class="count">· pools excluded</span></h2>
    <div class="table-wrap"><table><thead><tr><th>#</th><th>Wallet</th><th>Share</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

// ---------- trading ----------
async function waitForJupiter(ms = 8000) {
  const start = Date.now();
  while (!window.Jupiter?.init) {
    if (Date.now() - start > ms) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
  return true;
}

async function mountTrade(r) {
  const note = document.getElementById("trade-note");
  await configReady;
  const ok = await waitForJupiter();
  if (currentMint !== r.token.mint) return;
  if (!ok) {
    document.getElementById("jupiter-plugin").outerHTML =
      `<a class="trade-fallback" href="https://jup.ag/swap/SOL-${esc(r.token.mint)}" target="_blank" rel="noopener">Trade on Jupiter</a>`;
    return;
  }
  const formProps = { initialInputMint: SOL, initialOutputMint: r.token.mint, swapMode: "ExactIn" };
  if (config.referralAccount && config.referralFeeBps) {
    formProps.referralAccount = config.referralAccount;
    formProps.referralFee = config.referralFeeBps;
  }
  window.Jupiter.init({
    displayMode: "integrated",
    integratedTargetId: "jupiter-plugin",
    containerStyles: { height: "560px" },
    formProps,
  });
  note.textContent = config.referralFeeBps && config.referralAccount
    ? `Routed through Jupiter for the best price. Includes a ${(config.referralFeeBps / 100).toFixed(2)}% platform fee.`
    : "Routed through Jupiter for the best price.";
  if (r.verdict === "danger") note.textContent += " This token scored high risk. Only trade what you can lose.";
}

route();
