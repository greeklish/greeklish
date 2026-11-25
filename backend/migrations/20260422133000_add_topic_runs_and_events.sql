CREATE TABLE IF NOT EXISTS topic_runs (
    id uuid PRIMARY KEY,
    topic_id uuid NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    trigger text NOT NULL CHECK (trigger IN ('manual', 'ticker')),
    item_count integer NOT NULL CHECK (item_count >= 0),
    change_count integer NOT NULL CHECK (change_count >= 0),
    recorded_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_topic_runs_topic_recorded_at
    ON topic_runs (topic_id, recorded_at DESC);

CREATE TABLE IF NOT EXISTS topic_item_events (
    topic_id uuid NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    item_id uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    run_id uuid NOT NULL REFERENCES topic_runs(id) ON DELETE CASCADE,
    event_type text NOT NULL CHECK (event_type IN ('added', 'removed', 'rank_changed')),
    old_rank integer NULL CHECK (old_rank IS NULL OR old_rank > 0),
    new_rank integer NULL CHECK (new_rank IS NULL OR new_rank > 0),
    old_score double precision NULL,
    new_score double precision NULL,
    recorded_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_topic_item_events_topic_recorded_at
    ON topic_item_events (topic_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_topic_item_events_run_id
    ON topic_item_events (run_id);

SELECT create_hypertable(
    'topic_item_events',
    'recorded_at',
    if_not_exists => TRUE,
    chunk_time_interval => INTERVAL '1 day'
);

ALTER TABLE topic_item_events
SET (
    timescaledb.compress,
    timescaledb.compress_orderby = 'recorded_at DESC',
    timescaledb.compress_segmentby = 'topic_id,item_id'
);

SELECT add_compression_policy(
    'topic_item_events',
    INTERVAL '7 days',
    if_not_exists => TRUE
);
