CREATE TABLE IF NOT EXISTS letter_case_preferences (
  scope TEXT PRIMARY KEY,
  value TEXT NOT NULL CHECK (value IN ('lower', 'normal'))
);
