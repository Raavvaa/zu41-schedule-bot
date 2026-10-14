CREATE TABLE IF NOT EXISTS refresh_requests(
 group_id INTEGER NOT NULL,week TEXT NOT NULL,date TEXT NOT NULL,requested_at INTEGER NOT NULL,
 PRIMARY KEY(group_id,week)
);
CREATE INDEX IF NOT EXISTS refresh_requests_due ON refresh_requests(requested_at);
