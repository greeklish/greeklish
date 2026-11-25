CREATE TABLE IF NOT EXISTS crawl_snapshots (
    id uuid PRIMARY KEY,
    topic_id uuid NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    source_id uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    crawled_at timestamptz NOT NULL,
    item_count integer NOT NULL CHECK (item_count >= 0),
    created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_crawl_snapshots_topic_crawled_at
    ON crawl_snapshots (topic_id, crawled_at DESC);

CREATE TABLE IF NOT EXISTS crawl_snapshot_items (
    snapshot_id uuid NOT NULL REFERENCES crawl_snapshots(id) ON DELETE CASCADE,
    rank_position integer NOT NULL CHECK (rank_position > 0),
    external_id text NOT NULL,
    title text NOT NULL,
    url text NOT NULL,
    score double precision NOT NULL,
    published_at timestamptz NOT NULL,
    crawled_at timestamptz NOT NULL,
    PRIMARY KEY (snapshot_id, rank_position),
    UNIQUE (snapshot_id, external_id)
);
