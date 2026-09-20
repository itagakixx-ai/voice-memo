ALTER TABLE memos
ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'
CHECK (status IN ('pending', 'in_progress', 'completed'));

UPDATE memos
SET status = CASE
  WHEN completed = 1 THEN 'completed'
  ELSE 'pending'
END;
