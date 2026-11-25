CREATE TABLE IF NOT EXISTS guest_authors (
    id uuid PRIMARY KEY,
    token_hash bytea NOT NULL UNIQUE,
    approved_count integer NOT NULL DEFAULT 0 CHECK (approved_count >= 0),
    rejected_count integer NOT NULL DEFAULT 0 CHECK (rejected_count >= 0),
    trust_state text NOT NULL DEFAULT 'normal'
        CHECK (trust_state IN ('normal', 'revoked', 'banned')),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    last_seen_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS guest_comments (
    id uuid PRIMARY KEY,
    item_id uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    topic_id uuid NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    author_id uuid NOT NULL REFERENCES guest_authors(id) ON DELETE CASCADE,
    author_display_name text NOT NULL
        CHECK (char_length(author_display_name) BETWEEN 1 AND 24),
    body text NOT NULL CHECK (char_length(body) BETWEEN 2 AND 1000),
    body_hash bytea NOT NULL,
    status text NOT NULL
        CHECK (status IN ('pending', 'approved', 'rejected', 'spam', 'hidden')),
    auto_approved boolean NOT NULL DEFAULT false,
    hold_reason text NULL CHECK (hold_reason IS NULL OR char_length(hold_reason) <= 64),
    author_ip_hash bytea NULL,
    created_at timestamptz NOT NULL,
    decided_at timestamptz NULL,
    updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_guest_comments_item_status_created
    ON guest_comments (item_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_guest_comments_status_created
    ON guest_comments (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_guest_comments_author_created
    ON guest_comments (author_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_guest_comments_ip_created
    ON guest_comments (author_ip_hash, created_at DESC);

CREATE TABLE IF NOT EXISTS guest_comment_moderation_events (
    id uuid PRIMARY KEY,
    comment_id uuid NULL REFERENCES guest_comments(id) ON DELETE CASCADE,
    author_id uuid NULL REFERENCES guest_authors(id) ON DELETE CASCADE,
    action text NOT NULL CHECK (action IN (
        'submitted', 'held', 'auto_approved', 'approved', 'rejected',
        'marked_spam', 'hidden', 'restored',
        'author_trust_revoked', 'author_trust_restored',
        'author_banned', 'author_unbanned', 'ip_blocked', 'ip_unblocked'
    )),
    actor text NOT NULL CHECK (actor IN ('system', 'moderator')),
    reason text NULL CHECK (reason IS NULL OR char_length(reason) <= 200),
    author_approved_count integer NULL
        CHECK (author_approved_count IS NULL OR author_approved_count >= 0),
    recorded_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_guest_comment_moderation_events_recorded_at
    ON guest_comment_moderation_events (recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_guest_comment_moderation_events_comment
    ON guest_comment_moderation_events (comment_id, recorded_at);

CREATE INDEX IF NOT EXISTS idx_guest_comment_moderation_events_action
    ON guest_comment_moderation_events (action, recorded_at DESC);

CREATE TABLE IF NOT EXISTS guest_comment_ip_blocks (
    ip_hash bytea PRIMARY KEY,
    reason text NULL CHECK (reason IS NULL OR char_length(reason) <= 200),
    created_at timestamptz NOT NULL,
    expires_at timestamptz NULL
);
