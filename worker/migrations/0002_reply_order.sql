CREATE INDEX IF NOT EXISTS jobs_reply_order ON jobs(user_id,kind,state,created_at);
