ALTER TABLE crawl_snapshot_items
    ADD COLUMN IF NOT EXISTS comments_count integer NULL CHECK (comments_count IS NULL OR comments_count >= 0);
