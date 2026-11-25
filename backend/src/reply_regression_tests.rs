//! Real PostgreSQL tests in isolated databases; no provider requests or production writes.
use axum::{
    extract::{Path, Query, State},
    http::HeaderMap,
};
use sqlx::PgPool;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::{
    api::notifications,
    comment_regression_tests::{seed, state},
    crypto,
    db::{
        guest_comments::{
            self as comments, CommentStatus as Status, InsertCommentParams,
            ModerationAction as Action,
        },
        reply_notifications as replies,
    },
    error::AppError,
};

struct Fixture {
    topic: Uuid,
    item: Uuid,
    alice: Uuid,
    bob: Uuid,
}

async fn fixture(pool: &PgPool) -> Fixture {
    let (topic, item) = seed(pool).await;
    let mut tx = pool.begin().await.unwrap();
    let alice = comments::insert_author(
        &mut tx,
        &crypto::hash_token("alice-token"),
        OffsetDateTime::now_utc(),
    )
    .await
    .unwrap()
    .id;
    let bob = comments::insert_author(
        &mut tx,
        &crypto::hash_token("bob-token"),
        OffsetDateTime::now_utc(),
    )
    .await
    .unwrap()
    .id;
    tx.commit().await.unwrap();
    Fixture {
        topic,
        item,
        alice,
        bob,
    }
}

async fn comment(
    pool: &PgPool,
    fixture: &Fixture,
    author_id: Uuid,
    status: Status,
    parent: Option<Uuid>,
) -> Result<Uuid, AppError> {
    let mut tx = pool.begin().await?;
    let body = format!("Comment {}", Uuid::now_v7());
    let comment = comments::insert_comment(
        &mut tx,
        InsertCommentParams {
            item_id: fixture.item,
            topic_id: fixture.topic,
            author_id,
            author_display_name: "Fixture",
            body: &body,
            body_hash: &crypto::hash_body(&body),
            status,
            auto_approved: status.is_public(),
            hold_reason: None,
            author_ip_hash: None,
            created_at: OffsetDateTime::now_utc(),
            reply_to_comment_id: parent,
        },
    )
    .await?;
    tx.commit().await?;
    Ok(comment.id)
}

fn headers(token: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert("x-guest-token", token.parse().unwrap());
    headers.insert("content-type", "application/json".parse().unwrap());
    headers.insert("origin", "https://greeklish.gr".parse().unwrap());
    headers
}

#[sqlx::test(migrations = false)]
#[ignore = "requires local PostgreSQL with permission to create isolated test databases"]
async fn reply_regression_approval_opt_in_and_deduplication(pool: PgPool) {
    let f = fixture(&pool).await;
    let now = OffsetDateTime::now_utc();
    let parent = comment(&pool, &f, f.alice, Status::Approved, None)
        .await
        .unwrap();
    let pending = comment(&pool, &f, f.bob, Status::Pending, Some(parent))
        .await
        .unwrap();
    comment(&pool, &f, f.alice, Status::Approved, Some(parent))
        .await
        .unwrap();
    comment(&pool, &f, f.bob, Status::Approved, None)
        .await
        .unwrap();
    let sub = replies::register_subscription(
        &pool,
        f.alice,
        "https://fcm.googleapis.com/test-a",
        "key",
        "auth",
        now,
    )
    .await
    .unwrap();
    replies::set_watch(&pool, f.alice, sub, parent, true, now)
        .await
        .unwrap();
    assert_eq!(
        replies::unread_count(&pool, f.alice).await.unwrap(),
        0,
        "pending, self replies and unrelated comments do not notify"
    );
    assert!(
        replies::claim_delivery(&pool, now + time::Duration::seconds(1))
            .await
            .unwrap()
            .is_none()
    );

    for _ in 0..2 {
        comments::apply_decision(
            &pool,
            pending,
            Status::Approved,
            Action::Approved,
            None,
            now,
        )
        .await
        .unwrap();
    }
    let events = replies::list_replies(&pool, f.alice, None, 20)
        .await
        .unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].reply_id, pending);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM guest_push_deliveries")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 1, "moderation retries must not enqueue twice");
    let approved: i32 =
        sqlx::query_scalar("SELECT approved_count FROM guest_authors WHERE id = $1")
            .bind(f.bob)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(approved, 1, "repeated approval must not inflate trust");

    let delivery = replies::claim_delivery(&pool, now).await.unwrap().unwrap();
    assert!(
        replies::delivery_content(&pool, &delivery, now)
            .await
            .unwrap()
            .is_some()
    );
    comments::apply_decision(&pool, pending, Status::Hidden, Action::Hidden, None, now)
        .await
        .unwrap();
    assert!(
        replies::delivery_content(&pool, &delivery, now)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(replies::unread_count(&pool, f.alice).await.unwrap(), 0);
    replies::finish_delivery(&pool, &delivery, "suppressed", now, None)
        .await
        .unwrap();
    comments::apply_decision(
        &pool,
        pending,
        Status::Approved,
        Action::Restored,
        None,
        now,
    )
    .await
    .unwrap();
    assert!(
        replies::claim_delivery(&pool, now).await.unwrap().is_none(),
        "restoration cannot re-send an old reply notification"
    );

    let next = comment(&pool, &f, f.bob, Status::Approved, Some(parent))
        .await
        .unwrap();
    let delivery = replies::claim_delivery(&pool, OffsetDateTime::now_utc())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        replies::delivery_content(&pool, &delivery, now)
            .await
            .unwrap()
            .unwrap()
            .reply_id,
        next
    );
    replies::set_watch(&pool, f.alice, sub, parent, false, now)
        .await
        .unwrap();
    replies::set_watch(&pool, f.alice, sub, parent, true, now)
        .await
        .unwrap();
    assert!(
        replies::delivery_content(&pool, &delivery, now)
            .await
            .unwrap()
            .is_none(),
        "unsubscribe cancels queued replies even after re-enabling"
    );

    let other_parent = comment(&pool, &f, f.alice, Status::Approved, None)
        .await
        .unwrap();
    comment(&pool, &f, f.bob, Status::Approved, Some(other_parent))
        .await
        .unwrap();
    assert_eq!(
        replies::unread_count(&pool, f.alice).await.unwrap(),
        3,
        "inbox also works without a push watch"
    );
    assert!(
        replies::claim_delivery(&pool, OffsetDateTime::now_utc())
            .await
            .unwrap()
            .is_none(),
        "opt-in is per comment"
    );
    replies::set_watch(&pool, f.alice, sub, other_parent, true, now)
        .await
        .unwrap();
    assert!(
        replies::claim_delivery(&pool, OffsetDateTime::now_utc())
            .await
            .unwrap()
            .is_none(),
        "late opt-in must not send historical replies"
    );
}

#[sqlx::test(migrations = false)]
#[ignore = "requires local PostgreSQL with permission to create isolated test databases"]
async fn reply_regression_identity_and_inbox_read_state(pool: PgPool) {
    let f = fixture(&pool).await;
    let now = OffsetDateTime::now_utc();
    let parent = comment(&pool, &f, f.alice, Status::Approved, None)
        .await
        .unwrap();
    let reply = comment(&pool, &f, f.bob, Status::Approved, Some(parent))
        .await
        .unwrap();
    let sub = replies::register_subscription(
        &pool,
        f.alice,
        "https://fcm.googleapis.com/owned",
        "key",
        "auth",
        now,
    )
    .await
    .unwrap();
    assert!(
        replies::register_subscription(
            &pool,
            f.bob,
            "https://fcm.googleapis.com/owned",
            "new-key",
            "new-auth",
            now
        )
        .await
        .is_err()
    );
    assert!(replies::watched_comments(&pool, f.bob, sub).await.is_err());
    assert!(
        replies::set_watch(&pool, f.bob, sub, parent, true, now)
            .await
            .is_err()
    );
    assert!(
        replies::set_watch(&pool, f.alice, sub, reply, true, now)
            .await
            .is_err(),
        "can only watch own comments"
    );
    replies::delete_subscription(&pool, f.bob, sub)
        .await
        .unwrap();
    assert!(replies::watched_comments(&pool, f.alice, sub).await.is_ok());

    let app = state(pool.clone());
    assert!(
        notifications::inbox(
            State(app.clone()),
            HeaderMap::new(),
            Query(notifications::InboxQuery {
                cursor: None,
                limit: None
            })
        )
        .await
        .is_err()
    );
    let alice = notifications::inbox(
        State(app.clone()),
        headers("alice-token"),
        Query(notifications::InboxQuery {
            cursor: None,
            limit: None,
        }),
    )
    .await
    .unwrap()
    .0;
    let bob = notifications::inbox(
        State(app.clone()),
        headers("bob-token"),
        Query(notifications::InboxQuery {
            cursor: None,
            limit: None,
        }),
    )
    .await
    .unwrap()
    .0;
    assert_eq!(alice.replies.len(), 1);
    assert!(bob.replies.is_empty());
    let event_id = alice.replies[0].id;
    notifications::read_reply(State(app.clone()), headers("bob-token"), Path(event_id))
        .await
        .unwrap();
    assert_eq!(replies::unread_count(&pool, f.alice).await.unwrap(), 1);
    notifications::read_reply(State(app), headers("alice-token"), Path(event_id))
        .await
        .unwrap();
    assert_eq!(replies::unread_count(&pool, f.alice).await.unwrap(), 0);
    assert_eq!(
        replies::list_replies(&pool, f.alice, None, 10)
            .await
            .unwrap()
            .len(),
        1,
        "read replies remain accessible"
    );
}

#[sqlx::test(migrations = false)]
#[ignore = "requires local PostgreSQL with permission to create isolated test databases"]
async fn reply_regression_parent_validation_and_archived_articles(pool: PgPool) {
    let f = fixture(&pool).await;
    for status in [
        Status::Pending,
        Status::Hidden,
        Status::Rejected,
        Status::Spam,
    ] {
        let parent = comment(&pool, &f, f.alice, status, None).await.unwrap();
        assert!(
            comment(&pool, &f, f.bob, Status::Approved, Some(parent))
                .await
                .is_err()
        );
    }
    let parent = comment(&pool, &f, f.alice, Status::Approved, None)
        .await
        .unwrap();
    let different_item = Uuid::now_v7();
    sqlx::query("INSERT INTO items SELECT $1, source_id, 'two', 'Second item', url, now(), now(), now() FROM items WHERE id = $2")
        .bind(different_item).bind(f.item).execute(&pool).await.unwrap();
    let other = Fixture {
        item: different_item,
        ..f
    };
    assert!(
        comment(&pool, &other, f.bob, Status::Approved, Some(parent))
            .await
            .is_err()
    );
    let different_topic = Uuid::now_v7();
    sqlx::query("INSERT INTO topics(id,slug,display_name,ranking_strategy,created_at) VALUES ($1,'second','Second','hot',now())").bind(different_topic).execute(&pool).await.unwrap();
    let other = Fixture {
        topic: different_topic,
        ..f
    };
    assert!(
        comment(&pool, &other, f.bob, Status::Approved, Some(parent))
            .await
            .is_err()
    );
    assert!(
        comment(&pool, &f, f.bob, Status::Approved, Some(Uuid::now_v7()))
            .await
            .is_err()
    );
    sqlx::query("DELETE FROM topic_items WHERE item_id = $1")
        .bind(f.item)
        .execute(&pool)
        .await
        .unwrap();
    let archived = comments::resolve_item(&pool, "test", "one")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(archived.item_title, "Fixture title");
    assert_eq!(archived.item_id, f.item);
    assert!(
        comment(&pool, &f, f.bob, Status::Approved, Some(parent))
            .await
            .is_ok()
    );
}

#[sqlx::test(migrations = false)]
#[ignore = "requires local PostgreSQL with permission to create isolated test databases"]
async fn reply_regression_delivery_leases_and_expiry(pool: PgPool) {
    let f = fixture(&pool).await;
    let parent = comment(&pool, &f, f.alice, Status::Approved, None)
        .await
        .unwrap();
    let now = OffsetDateTime::now_utc();
    let sub = replies::register_subscription(
        &pool,
        f.alice,
        "https://fcm.googleapis.com/lease",
        "key",
        "auth",
        now,
    )
    .await
    .unwrap();
    replies::set_watch(&pool, f.alice, sub, parent, true, now)
        .await
        .unwrap();
    comment(&pool, &f, f.bob, Status::Approved, Some(parent))
        .await
        .unwrap();
    let now = OffsetDateTime::now_utc();
    let first = replies::claim_delivery(&pool, now).await.unwrap().unwrap();
    assert_eq!(first.attempts, 1);
    assert!(replies::claim_delivery(&pool, now).await.unwrap().is_none());
    let recovered = replies::claim_delivery(&pool, first.lease_until)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(recovered.attempts, 2, "expired process leases are retried");
    replies::finish_delivery(&pool, &first, "stale-worker", now, None)
        .await
        .unwrap();
    assert!(
        replies::delivery_content(&pool, &recovered, now)
            .await
            .unwrap()
            .is_some(),
        "an old lease cannot complete the new worker's claim"
    );
    let retry_at = recovered.lease_until + time::Duration::minutes(1);
    replies::finish_delivery(&pool, &recovered, "retry", now, Some(retry_at))
        .await
        .unwrap();
    assert!(
        replies::claim_delivery(&pool, recovered.lease_until)
            .await
            .unwrap()
            .is_none()
    );
    let retry = replies::claim_delivery(&pool, retry_at)
        .await
        .unwrap()
        .unwrap();
    let event = replies::list_replies(&pool, f.alice, None, 10)
        .await
        .unwrap()
        .remove(0);
    replies::mark_read(&pool, f.alice, Some(event.id), now)
        .await
        .unwrap();
    assert!(
        replies::delivery_content(&pool, &retry, retry_at)
            .await
            .unwrap()
            .is_none(),
        "reading an inbox entry suppresses queued delivery"
    );
    replies::expire_subscription(&pool, sub).await.unwrap();
    let remaining: i64 = sqlx::query_scalar("SELECT count(*) FROM guest_push_deliveries")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        remaining, 0,
        "expired device cleanup cascades to watches and delivery jobs"
    );
    assert_eq!(
        replies::list_replies(&pool, f.alice, None, 10)
            .await
            .unwrap()
            .len(),
        1
    );
}

#[sqlx::test(migrations = false)]
#[ignore = "requires local PostgreSQL with permission to create isolated test databases"]
async fn reply_regression_pruning_preserves_deduplication(pool: PgPool) {
    let f = fixture(&pool).await;
    let now = OffsetDateTime::now_utc();
    let parent = comment(&pool, &f, f.alice, Status::Approved, None)
        .await
        .unwrap();
    let sub = replies::register_subscription(
        &pool,
        f.alice,
        "https://fcm.googleapis.com/retention",
        "key",
        "auth",
        now,
    )
    .await
    .unwrap();
    replies::set_watch(&pool, f.alice, sub, parent, true, now)
        .await
        .unwrap();
    let reply = comment(&pool, &f, f.bob, Status::Approved, Some(parent))
        .await
        .unwrap();
    replies::prune(&pool, now + time::Duration::days(91))
        .await
        .unwrap();
    assert!(
        replies::watched_comments(&pool, f.alice, sub)
            .await
            .is_err()
    );
    assert!(
        replies::list_replies(&pool, f.alice, None, 10)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        comments::list_comments_for_item(&pool, f.item, None)
            .await
            .unwrap()
            .len(),
        2,
        "retention never erases public discussion text"
    );
    comments::apply_decision(&pool, reply, Status::Hidden, Action::Hidden, None, now)
        .await
        .unwrap();
    comments::apply_decision(&pool, reply, Status::Approved, Action::Restored, None, now)
        .await
        .unwrap();
    assert!(
        replies::list_replies(&pool, f.alice, None, 10)
            .await
            .unwrap()
            .is_empty(),
        "old notifications cannot be recreated after retention cleanup"
    );
}

#[sqlx::test(migrations = false)]
#[ignore = "requires local PostgreSQL with permission to create isolated test databases"]
async fn reply_regression_submission_and_moderation_with_one_connection(pool: PgPool) {
    use axum::{Json, extract::ConnectInfo};
    use std::{net::SocketAddr, time::Duration};
    let f = fixture(&pool).await;
    let parent = comment(&pool, &f, f.alice, Status::Approved, None)
        .await
        .unwrap();
    sqlx::query("UPDATE guest_authors SET approved_count = 10 WHERE id = $1")
        .bind(f.bob)
        .execute(&pool)
        .await
        .unwrap();
    let single = sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .connect_with((*pool.connect_options()).clone())
        .await
        .unwrap();
    let app = state(single.clone());
    let captcha = crate::comment_regression_tests::solution(app.require_comments_config().unwrap());
    let response = tokio::time::timeout(
        Duration::from_secs(5),
        crate::api::comments::create_comment(
            State(app),
            headers("bob-token"),
            ConnectInfo("127.0.0.1:1234".parse::<SocketAddr>().unwrap()),
            Json(crate::api::comments::CreateCommentRequest {
                topic: "test".into(),
                external_id: "one".into(),
                body: "Μία άμεση απάντηση χωρίς αδιέξοδο συνδέσεων.".into(),
                display_name: None,
                captcha,
                reply_to_comment_id: Some(parent),
            }),
        ),
    )
    .await
    .expect("submission must not acquire a second connection while holding its transaction")
    .unwrap()
    .1
    .0;
    assert_eq!(
        response.comment.reply_to_comment_id,
        Some(parent.to_string())
    );
    assert_eq!(response.comment.status, "approved");
    let reply_id = response.comment.id.parse().unwrap();
    tokio::time::timeout(
        Duration::from_secs(5),
        comments::apply_decision(
            &single,
            reply_id,
            Status::Hidden,
            Action::Hidden,
            None,
            OffsetDateTime::now_utc(),
        ),
    )
    .await
    .expect("moderation must not acquire a second connection while holding its transaction")
    .unwrap();
    single.close().await;
}
