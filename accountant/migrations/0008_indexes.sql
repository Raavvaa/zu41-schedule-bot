CREATE INDEX IF NOT EXISTS operation_meta_effective ON operation_meta(effective_at,tx_id);
CREATE INDEX IF NOT EXISTS drafts_state_created ON drafts(state,created_at);
