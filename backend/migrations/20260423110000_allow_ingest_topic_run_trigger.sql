ALTER TABLE topic_runs
DROP CONSTRAINT IF EXISTS topic_runs_trigger_check;

ALTER TABLE topic_runs
ADD CONSTRAINT topic_runs_trigger_check
CHECK (trigger IN ('manual', 'ticker', 'ingest'));
