CREATE TABLE IF NOT EXISTS chat_style(chat_id TEXT PRIMARY KEY,tone TEXT,instructions TEXT,previous_state TEXT,updated_at INTEGER,source_message_id TEXT);
CREATE TABLE IF NOT EXISTS chat_changes(id INTEGER PRIMARY KEY AUTOINCREMENT,chat_id TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL,undone INTEGER NOT NULL DEFAULT 0);
