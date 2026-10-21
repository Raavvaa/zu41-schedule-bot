CREATE TABLE IF NOT EXISTS dialog_state(id INTEGER PRIMARY KEY CHECK(id=1),mode TEXT NOT NULL DEFAULT 'idle',pending_draft_id TEXT,question TEXT,last_applied_tx TEXT,last_cancelled_draft TEXT,last_topic TEXT,last_turn TEXT,updated_at INTEGER NOT NULL DEFAULT 0);
INSERT OR IGNORE INTO dialog_state(id) VALUES(1);
CREATE TABLE IF NOT EXISTS operation_meta(tx_id TEXT PRIMARY KEY,actions TEXT,effective_at INTEGER NOT NULL);
