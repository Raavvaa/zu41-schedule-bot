CREATE TABLE IF NOT EXISTS facts(key TEXT PRIMARY KEY,value TEXT NOT NULL CHECK(length(value)<=200),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS digest(id INTEGER PRIMARY KEY CHECK(id=1),content TEXT NOT NULL DEFAULT '',last_rowid INTEGER NOT NULL DEFAULT 0,attempt_day TEXT,updated_at INTEGER NOT NULL DEFAULT 0);
INSERT OR IGNORE INTO digest(id) VALUES(1);
WITH RECURSIVE chunks(n,part,rest) AS (SELECT 1,substr(context,1,200),substr(context,201) FROM settings WHERE id=1 AND length(context)>0 UNION ALL SELECT n+1,substr(rest,1,200),substr(rest,201) FROM chunks WHERE length(rest)>0) INSERT OR IGNORE INTO facts(key,value,created_at,updated_at) SELECT 'legacy:'||n,part,0,0 FROM chunks;
