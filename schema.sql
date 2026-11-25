CREATE TABLE IF NOT EXISTS launches (
  mint        TEXT PRIMARY KEY,
  creator     TEXT NOT NULL,
  symbol      TEXT,
  name        TEXT,
  created_at  TEXT,
  first_seen  TEXT NOT NULL,
  last_seen   TEXT NOT NULL,
  last_mcap   REAL,
  peak_mcap   REAL
);

CREATE INDEX IF NOT EXISTS launches_by_creator ON launches (creator, created_at);
