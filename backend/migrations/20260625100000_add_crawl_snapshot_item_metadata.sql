ALTER TABLE crawl_snapshot_items
ADD COLUMN IF NOT EXISTS metadata jsonb;
