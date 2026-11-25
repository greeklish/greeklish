ALTER TABLE items
ADD COLUMN IF NOT EXISTS metadata jsonb NULL;

CREATE TABLE IF NOT EXISTS item_observations (
    item_id uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    title text NOT NULL,
    url text NOT NULL,
    metadata jsonb NULL,
    recorded_at timestamptz NOT NULL,
    PRIMARY KEY (item_id, recorded_at)
);

CREATE INDEX IF NOT EXISTS idx_item_observations_item_recorded_at
    ON item_observations (item_id, recorded_at DESC);

SELECT create_hypertable(
    'item_observations',
    'recorded_at',
    if_not_exists => TRUE,
    chunk_time_interval => INTERVAL '1 day'
);

ALTER TABLE item_observations
SET (
    timescaledb.compress,
    timescaledb.compress_orderby = 'recorded_at DESC',
    timescaledb.compress_segmentby = 'item_id'
);

SELECT add_compression_policy(
    'item_observations',
    INTERVAL '7 days',
    if_not_exists => TRUE
);

INSERT INTO item_observations (item_id, title, url, metadata, recorded_at)
SELECT
    items.id,
    items.title,
    items.url,
    items.metadata,
    items.updated_at
FROM items
ON CONFLICT (item_id, recorded_at) DO NOTHING;
