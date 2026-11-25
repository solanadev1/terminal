# SolanaView

**See the dev before you buy.** Paste any Solana token and SolanaView shows who launched it, what happened to every token that wallet launched before, who holds the supply, and whether insiders are clustered. Then you trade it on the same page through Jupiter, and the site earns a fee on every swap.

## Why traders use it instead of the big terminals

Most terminals show the chart and the holders. SolanaView puts the **dev's track record** first:

- **Every earlier pump.fun launch by the same wallet**, read straight from the pump.fun program on-chain. Each bonding curve stores its creator, so one query finds all of them, including launches every indexer has forgotten. In testing, one dev behind a promoted token had 254 earlier launches, 250 of them dead. RugCheck listed none of them.
- **Dead / bonded / passed $1M** tallies, plus a launch-by-launch table.
- **A 0–100 score where every point is explained.** No black box: each deduction is listed (serial launcher, insiders hold X%, dev can mint, and so on). Some findings, like a serial rugger or mint/freeze authority, force "High risk" regardless of the rest.
- Token safety checks (mint/freeze authority, liquidity lock weighted by pool size, transfer tax, holder concentration excluding pools, insider networks).

## How you make money

Trades go through the Jupiter swap widget with your **referral account** attached. You set the fee (default 0.75%; Jupiter allows 0.5%–2.55%). Jupiter keeps 20% of your fee and you keep 80%. You never hold user funds or keys: users sign with their own wallet.

## Run it locally

```bash
npm install
npm run dev        # http://localhost:8787
```

## Put it live (free)

You need a free Cloudflare account and a free Helius account.

1. `npx wrangler login`
2. Get a free RPC key at helius.dev, then store it:
   `npx wrangler secret put RPC_URL` and paste `https://mainnet.helius-rpc.com/?api-key=YOUR_KEY`
   (Required. The public Solana endpoint blocks cloud servers, so without this the dev history can't load. The site will say so rather than show a false all-clear.)
3. Create your Jupiter referral account at referral.jup.ag (connect the wallet you want paid to). Put its address in `REFERRAL_ACCOUNT` in `wrangler.jsonc`. Also create referral token accounts for **SOL** and **USDC** in the dashboard, because Jupiter collects most fees in those. Swaps without a matching token account still go through, just without your fee.
4. `npm run deploy`. You get a `solanaview.<you>.workers.dev` URL. Add your own domain in the Cloudflare dashboard whenever you like.
5. Optional but recommended: turn on your own launch database (see the comment in `wrangler.jsonc`). Every report is then saved, so your dev history keeps growing even for tokens the upstream sources drop. Over time, that data is the moat.

Costs at the start: $0. Cloudflare's free tier covers 100k requests/day; Helius free covers about 1M credits/month.

## How it's built

| Piece | What it does |
| --- | --- |
| `src/worker.js` | Cloudflare Worker: serves the site and the `/api` routes |
| `src/report.js` | Builds the report and the explainable score |
| `src/pump.js` | On-chain pump.fun history: creator → bonding curves → tokens → names |
| `src/sources.js` | RugCheck (holders, insiders, authorities) and DexScreener (price, pairs, trending) |
| `src/store.js` | Optional D1 database of every launch seen |
| `public/` | The site: plain HTML/CSS/JS, Jupiter widget, DexScreener chart |

## Known limits

- Dev history covers **pump.fun** launches (most Solana memecoins). Other launchpads only show what RugCheck knows.
- A dev using a brand-new wallet per launch shows "no earlier launches". The page says this can mean a fresh wallet hiding a history. Linking wallets by funding source is the next big feature.
- RugCheck's public API allows about 15 requests a minute. Edge caching absorbs repeat lookups; at real traffic you'll want a RugCheck API plan or to compute holders yourself from the RPC.

## Roadmap

1. **Funding-source linking**: trace who funded the dev wallet, so fresh-wallet serial launchers get caught too.
2. **Dev pages and alerts**: `/dev/<wallet>`, plus a Telegram alert when a known rugger launches again.
3. **Referral program**: give a share of your fee to people who bring traders. This is how terminals grow.
4. **Watchlists and PnL** once wallets are connected.
