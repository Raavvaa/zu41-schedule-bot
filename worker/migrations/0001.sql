PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
 user_id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL UNIQUE, group_id INTEGER NOT NULL,
 group_name TEXT NOT NULL, subgroup TEXT NOT NULL DEFAULT 'both' CHECK(subgroup IN ('both','1','2')),
 morning_time TEXT NOT NULL DEFAULT '06:00', morning_enabled INTEGER NOT NULL DEFAULT 1,
 reminders_enabled INTEGER NOT NULL DEFAULT 1, reminder_minutes INTEGER NOT NULL DEFAULT 10 CHECK(reminder_minutes IN (5,10,15,30)),
 send_empty INTEGER NOT NULL DEFAULT 0, paused_until INTEGER NOT NULL DEFAULT 0,
 blocked INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1,
 changed_at INTEGER NOT NULL, next_plan INTEGER NOT NULL DEFAULT 0, lane INTEGER NOT NULL,
 timezone TEXT NOT NULL DEFAULT 'Europe/Moscow' CHECK(timezone='Europe/Moscow')
);
CREATE INDEX IF NOT EXISTS users_plan ON users(lane,blocked,next_plan);
CREATE INDEX IF NOT EXISTS users_group ON users(group_id,blocked);
CREATE TABLE IF NOT EXISTS dialogs(user_id INTEGER PRIMARY KEY, state TEXT NOT NULL, draft TEXT NOT NULL, nonce TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS groups(group_id INTEGER PRIMARY KEY, name TEXT NOT NULL, checked_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS schedules(group_id INTEGER NOT NULL, date TEXT NOT NULL, status TEXT NOT NULL, data TEXT, fingerprint TEXT,
 checked_at INTEGER NOT NULL DEFAULT 0, attempt_at INTEGER NOT NULL DEFAULT 0, error TEXT, next_refresh INTEGER NOT NULL,
 PRIMARY KEY(group_id,date));
CREATE INDEX IF NOT EXISTS schedules_refresh ON schedules(next_refresh);
CREATE TABLE IF NOT EXISTS jobs (
 job_key TEXT PRIMARY KEY,user_id INTEGER NOT NULL,chat_id INTEGER NOT NULL,lane INTEGER NOT NULL,
 date TEXT NOT NULL,group_id INTEGER,lesson_number INTEGER,kind TEXT NOT NULL,
 due_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,start_at INTEGER,revision INTEGER NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,lease_until INTEGER,
 payload TEXT,created_at INTEGER NOT NULL,sent_at INTEGER,message_id INTEGER,last_error TEXT
);
CREATE INDEX IF NOT EXISTS jobs_due ON jobs(lane,state,due_at);
CREATE INDEX IF NOT EXISTS jobs_user ON jobs(user_id,state,date);
CREATE TABLE IF NOT EXISTS attempts(id INTEGER PRIMARY KEY AUTOINCREMENT,job_key TEXT NOT NULL,attempt INTEGER NOT NULL,at INTEGER NOT NULL,outcome TEXT NOT NULL,message_id INTEGER);
CREATE INDEX IF NOT EXISTS attempts_job ON attempts(job_key);
CREATE TABLE IF NOT EXISTS updates(update_id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS updates_pending ON updates(state,created_at);
CREATE TABLE IF NOT EXISTS locks(name TEXT PRIMARY KEY,owner TEXT NOT NULL,expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS meta(name TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rate_slots(bucket INTEGER PRIMARY KEY,used INTEGER NOT NULL);

CREATE INDEX IF NOT EXISTS updates_pending_lane ON updates(state,(user_id%8),created_at);
CREATE INDEX IF NOT EXISTS jobs_global_due ON jobs(state,due_at,lane);
CREATE INDEX IF NOT EXISTS users_global_plan ON users(blocked,next_plan,lane);
CREATE TABLE IF NOT EXISTS queue_budgets(date TEXT PRIMARY KEY,used INTEGER NOT NULL);
