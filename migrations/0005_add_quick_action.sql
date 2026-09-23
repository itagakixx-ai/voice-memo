ALTER TABLE memos
ADD COLUMN quick_action TEXT NOT NULL DEFAULT 'none'
CHECK (
  quick_action IN (
    'none',
    'order',
    'manufacturer',
    'customer_contact',
    'stock_check',
    'other'
  )
);
