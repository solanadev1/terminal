// Optional D1 storage. Every report we build records the token and the dev's
// other launches, so SolanaView's dev history grows with every lookup, including
// launches the upstream providers have forgotten. This is the long-term moat.

export async function devLaunchesFromDb(db, creator) {
  const { results } = await db
    .prepare("SELECT mint, symbol, name, created_at, last_mcap, peak_mcap FROM launches WHERE creator = ? ORDER BY created_at DESC LIMIT 200")
    .bind(creator)
    .all();
  return results || [];
}

export async function recordLaunches(db, report) {
  const creator = report.dev.wallet;
  if (!creator) return;
  const now = new Date().toISOString();
  const rows = [
    {
      mint: report.token.mint,
      symbol: report.token.symbol,
      name: report.token.name,
      createdAt: report.token.createdAt,
      mcap: report.market?.marketCap ?? null,
    },
    ...report.dev.launches.map((l) => ({
      mint: l.mint, symbol: l.symbol, name: l.name, createdAt: l.createdAt, mcap: l.marketCapNow,
    })),
  ];
  const stmt = db.prepare(`
    INSERT INTO launches (mint, creator, symbol, name, created_at, first_seen, last_seen, last_mcap, peak_mcap)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?7)
    ON CONFLICT(mint) DO UPDATE SET
      symbol = COALESCE(excluded.symbol, launches.symbol),
      name = COALESCE(excluded.name, launches.name),
      created_at = COALESCE(launches.created_at, excluded.created_at),
      last_seen = excluded.last_seen,
      last_mcap = COALESCE(excluded.last_mcap, launches.last_mcap),
      peak_mcap = MAX(COALESCE(launches.peak_mcap, 0), COALESCE(excluded.last_mcap, 0))
  `);
  await db.batch(rows.map((r) => stmt.bind(r.mint, creator, r.symbol, r.name, r.createdAt, now, r.mcap)));
}
