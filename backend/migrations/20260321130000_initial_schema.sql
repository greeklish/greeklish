-- TimescaleDB 2.x / PostgreSQL 17 baseline migration.
CREATE EXTENSION IF NOT EXISTS timescaledb;

DO $$
BEGIN
    CREATE TYPE ranking_strategy AS ENUM ('hot', 'chronological', 'external');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END
$$;

CREATE TABLE IF NOT EXISTS sources (
    id uuid PRIMARY KEY,
    slug text NOT NULL UNIQUE,
    display_name text NOT NULL,
    base_url text NOT NULL,
    created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS topics (
    id uuid PRIMARY KEY,
    slug text NOT NULL UNIQUE,
    display_name text NOT NULL,
    ranking_strategy ranking_strategy NOT NULL,
    feed_size integer NOT NULL DEFAULT 20 CHECK (feed_size > 0),
    hot_gravity double precision NULL DEFAULT 1.8 CHECK (hot_gravity IS NULL OR hot_gravity > 0),
    created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
    id uuid PRIMARY KEY,
    source_id uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    external_id text NOT NULL,
    title text NOT NULL,
    url text NOT NULL,
    published_at timestamptz NOT NULL,
    crawled_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    UNIQUE (source_id, external_id)
);

CREATE TABLE IF NOT EXISTS topic_items (
    topic_id uuid NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    item_id uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    current_score double precision NOT NULL,
    external_rank integer NULL CHECK (external_rank IS NULL OR external_rank > 0),
    rank_position integer NULL CHECK (rank_position IS NULL OR rank_position > 0),
    added_at timestamptz NOT NULL,
    PRIMARY KEY (topic_id, item_id)
);

CREATE TABLE IF NOT EXISTS score_snapshots (
    item_id uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    topic_id uuid NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    score double precision NOT NULL,
    recorded_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_items_source_id ON items (source_id);
CREATE INDEX IF NOT EXISTS idx_items_published_at ON items (published_at DESC);
CREATE INDEX IF NOT EXISTS idx_topic_items_topic_score ON topic_items (topic_id, current_score DESC);
CREATE INDEX IF NOT EXISTS idx_topic_items_topic_external_rank ON topic_items (topic_id, external_rank ASC);
CREATE INDEX IF NOT EXISTS idx_score_snapshots_topic_item_recorded_at
    ON score_snapshots (topic_id, item_id, recorded_at DESC);

SELECT create_hypertable(
    'score_snapshots',
    'recorded_at',
    if_not_exists => TRUE,
    chunk_time_interval => INTERVAL '1 day'
);

ALTER TABLE score_snapshots
SET (
    timescaledb.compress,
    timescaledb.compress_orderby = 'recorded_at DESC',
    timescaledb.compress_segmentby = 'topic_id,item_id'
);

SELECT add_retention_policy(
    'score_snapshots',
    INTERVAL '30 days',
    if_not_exists => TRUE
);

SELECT add_compression_policy(
    'score_snapshots',
    INTERVAL '7 days',
    if_not_exists => TRUE
);

CREATE MATERIALIZED VIEW IF NOT EXISTS score_snapshots_hourly
WITH (timescaledb.continuous) AS
SELECT
    time_bucket(INTERVAL '1 hour', recorded_at) AS bucket,
    topic_id,
    item_id,
    max(score) AS max_score
FROM score_snapshots
GROUP BY bucket, topic_id, item_id
WITH NO DATA;

SELECT add_continuous_aggregate_policy(
    'score_snapshots_hourly',
    start_offset => INTERVAL '30 days',
    end_offset => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour'
);
