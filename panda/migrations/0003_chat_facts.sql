CREATE TABLE IF NOT EXISTS chat_facts(id INTEGER PRIMARY KEY AUTOINCREMENT,chat_id TEXT NOT NULL,fact TEXT NOT NULL,source TEXT NOT NULL,source_message_id TEXT NOT NULL,confidence TEXT NOT NULL,embedding_json TEXT,created_at INTEGER NOT NULL,UNIQUE(chat_id,source_message_id,fact));
CREATE INDEX IF NOT EXISTS chat_facts_chat ON chat_facts(chat_id);
CREATE TABLE IF NOT EXISTS background_jobs(chat_id TEXT NOT NULL,kind TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,state TEXT NOT NULL DEFAULT 'pending',not_before INTEGER NOT NULL DEFAULT 0,lease_until INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(chat_id,kind));
CREATE TABLE IF NOT EXISTS fact_extraction(chat_id TEXT PRIMARY KEY,new_messages INTEGER NOT NULL DEFAULT 0,last_attempt INTEGER NOT NULL DEFAULT 0);
