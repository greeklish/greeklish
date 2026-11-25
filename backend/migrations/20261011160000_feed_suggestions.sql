CREATE TABLE feed_suggestions (
    id uuid PRIMARY KEY,
    author_id uuid NOT NULL REFERENCES guest_authors(id) ON DELETE CASCADE,
    url text NOT NULL CHECK (char_length(url) BETWEEN 1 AND 2048),
    name text CHECK (char_length(name) BETWEEN 1 AND 100),
    explanation text CHECK (char_length(explanation) BETWEEN 1 AND 1000),
    email text CHECK (char_length(email) BETWEEN 3 AND 254),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'added', 'rejected', 'spam')),
    author_ip_hash bytea,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    resolved_at timestamptz,
    CHECK ((status = 'pending') = (resolved_at IS NULL))
);
CREATE UNIQUE INDEX feed_suggestions_pending_url ON feed_suggestions(author_id, url) WHERE status = 'pending';
CREATE INDEX feed_suggestions_queue ON feed_suggestions(status, created_at DESC, id DESC);
CREATE INDEX feed_suggestions_author_url ON feed_suggestions(author_id, url, created_at DESC);
