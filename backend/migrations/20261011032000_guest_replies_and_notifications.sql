ALTER TABLE guest_comments
    ADD COLUMN reply_to_comment_id uuid NULL REFERENCES guest_comments(id) ON DELETE SET NULL,
    ADD COLUMN reply_notification_recorded boolean NOT NULL DEFAULT false;

CREATE INDEX idx_guest_comments_reply_to ON guest_comments(reply_to_comment_id)
    WHERE reply_to_comment_id IS NOT NULL;

CREATE TABLE guest_reply_events (
    id uuid PRIMARY KEY,
    reply_id uuid NOT NULL UNIQUE REFERENCES guest_comments(id) ON DELETE CASCADE,
    recipient_id uuid NOT NULL REFERENCES guest_authors(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL,
    read_at timestamptz NULL
);
CREATE INDEX idx_guest_reply_events_recipient ON guest_reply_events(recipient_id, created_at DESC, id DESC);

CREATE TABLE guest_push_subscriptions (
    id uuid PRIMARY KEY,
    author_id uuid NOT NULL REFERENCES guest_authors(id) ON DELETE CASCADE,
    endpoint text NOT NULL UNIQUE,
    p256dh text NOT NULL,
    auth text NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
);
CREATE INDEX idx_guest_push_subscriptions_author ON guest_push_subscriptions(author_id);

CREATE TABLE guest_reply_watches (
    subscription_id uuid NOT NULL REFERENCES guest_push_subscriptions(id) ON DELETE CASCADE,
    comment_id uuid NOT NULL REFERENCES guest_comments(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL,
    PRIMARY KEY(subscription_id, comment_id)
);
CREATE INDEX idx_guest_reply_watches_comment ON guest_reply_watches(comment_id);

CREATE TABLE guest_push_deliveries (
    event_id uuid NOT NULL REFERENCES guest_reply_events(id) ON DELETE CASCADE,
    subscription_id uuid NOT NULL REFERENCES guest_push_subscriptions(id) ON DELETE CASCADE,
    attempts integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL,
    finished_at timestamptz NULL,
    outcome text NULL,
    PRIMARY KEY(event_id, subscription_id)
);
CREATE INDEX idx_guest_push_deliveries_due ON guest_push_deliveries(next_attempt_at)
    WHERE finished_at IS NULL;
