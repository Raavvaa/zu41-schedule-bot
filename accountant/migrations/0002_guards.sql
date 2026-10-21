CREATE TABLE IF NOT EXISTS guard_events(type TEXT NOT NULL,tool TEXT,at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS guard_events_at ON guard_events(at);
