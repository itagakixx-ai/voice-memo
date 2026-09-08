ALTER TABLE memos ADD COLUMN raw_text TEXT;
ALTER TABLE memos ADD COLUMN category TEXT NOT NULL DEFAULT 'other';
ALTER TABLE memos ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE memos ADD COLUMN due_date TEXT;
ALTER TABLE memos ADD COLUMN due_time TEXT;
ALTER TABLE memos ADD COLUMN due_period TEXT NOT NULL DEFAULT 'none';
ALTER TABLE memos ADD COLUMN due_at TEXT;
ALTER TABLE memos ADD COLUMN parser_version TEXT;

CREATE INDEX IF NOT EXISTS idx_memos_task_order
ON memos (completed, due_at, priority);
