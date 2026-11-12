CREATE TABLE IF NOT EXISTS deletion_watch (scope TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS deletion_snapshots (
 scope TEXT NOT NULL, message_id INTEGER NOT NULL, at INTEGER NOT NULL,
 body TEXT NOT NULL, method TEXT, field TEXT, file_id TEXT,
 PRIMARY KEY(scope,message_id)
);
CREATE INDEX IF NOT EXISTS deletion_snapshots_at ON deletion_snapshots(at);
