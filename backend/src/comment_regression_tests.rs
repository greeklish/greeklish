//! Isolated database regressions: run with DATABASE_URL and `cargo test comment_regression -- --ignored`.
use crate::{
    api::comments,
    captcha,
    config::{Config, RuntimeEnvironment},
    db::guest_comments::{self, ModerationFilters},
    ratelimit::{RateKey, RateRule, RateScope},
    state::AppState,
};
use axum::{
    Json,
    extract::{ConnectInfo, Query, State},
    http::HeaderMap,
};
use sqlx::PgPool;
use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr},
    time::Duration,
};
use time::OffsetDateTime;
use uuid::Uuid;

pub(crate) fn state(pool: PgPool) -> AppState {
    let mut comments = captcha::tests_support::sample_config();
    comments.per_ip_burst_interval = Duration::ZERO;
    comments.per_author_burst_interval = Duration::ZERO;
    comments.per_ip_hourly_limit = 2;
    comments.per_author_hourly_limit = 2;
    AppState::new(
        Config {
            database_url: String::new(),
            internal_api_token: String::new(),
            bind_address: IpAddr::V4(Ipv4Addr::LOCALHOST),
            ws_ping_interval: Duration::from_secs(30),
            ws_timeout: Duration::from_secs(60),
            ticker_interval: Duration::from_secs(30),
            default_feed_size: 20,
            hot_gravity: 1.8,
            environment: RuntimeEnvironment::Development,
            port: 0,
            required_client_version: None,
            sweeper_interval: Duration::from_secs(60),
            comments: Some(comments),
            push: None,
        },
        pool,
    )
}

#[tokio::test]
async fn comment_regression_refunds_reservations_on_failure() {
    let state = state(
        sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://localhost/unused")
            .unwrap(),
    );
    let ip = RateKey::new(RateScope::CommentIp, "test");
    let author = RateKey::new(RateScope::CommentAuthor, "test");
    let rules = [RateRule::new(1, Duration::from_secs(60))];
    state
        .reserve_comment_rate(author.clone(), &rules, "wait")
        .unwrap()
        .commit();
    {
        let _ip_permit = state
            .reserve_comment_rate(ip.clone(), &rules, "wait")
            .unwrap();
        assert!(state.reserve_comment_rate(author, &rules, "wait").is_err());
    }
    state
        .reserve_comment_rate(ip.clone(), &rules, "wait")
        .unwrap()
        .commit();
    assert!(state.reserve_comment_rate(ip, &rules, "wait").is_err());
}

pub(crate) async fn seed(pool: &PgPool) -> (Uuid, Uuid) {
    let initial = include_str!("../migrations/20260321130000_initial_schema.sql");
    let start = initial.find("DO $$").unwrap();
    let end = initial
        .find("CREATE TABLE IF NOT EXISTS score_snapshots")
        .unwrap();
    sqlx::raw_sql(&initial[start..end])
        .execute(pool)
        .await
        .unwrap();
    sqlx::raw_sql(include_str!(
        "../migrations/20261009120000_add_guest_comments.sql"
    ))
    .execute(pool)
    .await
    .unwrap();
    sqlx::raw_sql(include_str!(
        "../migrations/20261011032000_guest_replies_and_notifications.sql"
    ))
    .execute(pool)
    .await
    .unwrap();
    let source = Uuid::now_v7();
    sqlx::raw_sql(include_str!(
        "../migrations/20261011160000_feed_suggestions.sql"
    ))
    .execute(pool)
    .await
    .unwrap();
    let topic = Uuid::now_v7();
    let item = Uuid::now_v7();
    sqlx::query("INSERT INTO sources VALUES ($1, 'test', 'Test', 'https://example.test', now())")
        .bind(source)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO topics(id, slug, display_name, ranking_strategy, created_at) VALUES ($1, 'test', 'Test', 'hot', now())").bind(topic).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO items VALUES ($1, $2, 'one', 'Fixture title', 'https://example.test/one', now(), now(), now())").bind(item).bind(source).execute(pool).await.unwrap();
    sqlx::query(
        "INSERT INTO topic_items(topic_id,item_id,current_score,added_at) VALUES ($1,$2,1,now())",
    )
    .bind(topic)
    .bind(item)
    .execute(pool)
    .await
    .unwrap();
    (topic, item)
}

pub(crate) fn solution(config: &crate::config::CommentsConfig) -> captcha::CaptchaSolution {
    use sha2::{Digest, Sha256};
    let challenge = captcha::issue(config, OffsetDateTime::now_utc());
    let number = (0..=challenge.maxnumber)
        .find(|n| {
            format!("{:x}", Sha256::digest(format!("{}{n}", challenge.salt))) == challenge.challenge
        })
        .unwrap();
    captcha::CaptchaSolution {
        algorithm: challenge.algorithm,
        challenge: challenge.challenge,
        salt: challenge.salt,
        number,
        signature: challenge.signature,
    }
}

#[sqlx::test(migrations = false)]
#[ignore = "requires local PostgreSQL with permission to create isolated test databases"]
async fn comment_regression_public_discussions(pool: PgPool) {
    use guest_comments::CommentStatus;
    let (topic, first_item) = seed(&pool).await;
    let now = OffsetDateTime::now_utc();
    let mut tx = pool.begin().await.unwrap();
    let author = guest_comments::insert_author(&mut tx, &[7; 32], now)
        .await
        .unwrap();
    // The second public discussion and a private-only one are absent from topic_items/feed snapshots.
    let second_item = Uuid::now_v7();
    let private_item = Uuid::now_v7();
    for (id, external_id) in [(second_item, "two"), (private_item, "private")] {
        sqlx::query("INSERT INTO items SELECT $1, source_id, $2, $2, 'https://example.test/' || $2, now(), now(), now() FROM items WHERE id = $3")
            .bind(id).bind(external_id).bind(first_item).execute(&mut *tx).await.unwrap();
    }
    for (item_id, status, created_at) in [
        (first_item, CommentStatus::Approved, now),
        (first_item, CommentStatus::Approved, now),
        (second_item, CommentStatus::Approved, now),
        (
            first_item,
            CommentStatus::Pending,
            now + time::Duration::hours(1),
        ),
        (private_item, CommentStatus::Pending, now),
        (private_item, CommentStatus::Rejected, now),
        (private_item, CommentStatus::Hidden, now),
        (private_item, CommentStatus::Spam, now),
    ] {
        guest_comments::insert_comment(
            &mut tx,
            guest_comments::InsertCommentParams {
                reply_to_comment_id: None,
                item_id,
                topic_id: topic,
                author_id: author.id,
                author_display_name: "Fixture",
                body: "Fixture comment",
                body_hash: &[3; 32],
                status,
                auto_approved: false,
                hold_reason: None,
                author_ip_hash: None,
                created_at,
            },
        )
        .await
        .unwrap();
    }
    tx.commit().await.unwrap();
    let state = state(pool);
    let Json(first) = comments::list_discussions(
        State(state.clone()),
        Query(comments::DiscussionsQuery {
            cursor: None,
            limit: Some(1),
        }),
    )
    .await
    .unwrap();
    assert_eq!(first.discussions.len(), 1);
    assert_eq!(first.discussions[0].external_id, "two");
    let Json(second) = comments::list_discussions(
        State(state.clone()),
        Query(comments::DiscussionsQuery {
            cursor: first.next_cursor,
            limit: Some(1),
        }),
    )
    .await
    .unwrap();
    assert_eq!(second.discussions.len(), 1);
    assert_eq!(second.discussions[0].external_id, "one");
    assert_eq!(second.discussions[0].guest_comment_count, 2);
    assert_eq!(second.discussions[0].item_title, "Fixture title");
    assert!(second.next_cursor.is_none());
    assert!(
        comments::list_discussions(
            State(state),
            Query(comments::DiscussionsQuery {
                cursor: Some("bad|cursor".into()),
                limit: None,
            })
        )
        .await
        .is_err()
    );
}

#[sqlx::test(migrations = false)]
#[ignore = "requires local PostgreSQL with permission to create isolated test databases"]
async fn comment_regression_failed_posts_do_not_consume_quota(pool: PgPool) {
    seed(&pool).await;
    let state = state(pool);
    let mut headers = HeaderMap::new();
    headers.insert("content-type", "application/json".parse().unwrap());
    headers.insert("origin", "https://greeklish.gr".parse().unwrap());
    let peer = SocketAddr::from(([127, 0, 0, 1], 1234));
    let post = |body: &str| {
        Json(comments::CreateCommentRequest {
            reply_to_comment_id: None,
            topic: "test".into(),
            external_id: "one".into(),
            body: body.into(),
            display_name: Some("Tester".into()),
            captcha: solution(state.require_comments_config().unwrap()),
        })
    };
    let (_, Json(first)) = comments::create_comment(
        State(state.clone()),
        headers.clone(),
        ConnectInfo(peer),
        post("First comment"),
    )
    .await
    .unwrap();
    headers.insert(
        "x-guest-token",
        first.author_token.unwrap().parse().unwrap(),
    );
    for _ in 0..4 {
        assert!(matches!(
            comments::create_comment(
                State(state.clone()),
                headers.clone(),
                ConnectInfo(peer),
                post("First comment")
            )
            .await,
            Err(crate::error::AppError::Conflict(_))
        ));
    }
    let _ = comments::create_comment(
        State(state.clone()),
        headers.clone(),
        ConnectInfo(peer),
        post("Second unique comment"),
    )
    .await
    .unwrap();
    assert!(matches!(
        comments::create_comment(
            State(state.clone()),
            headers.clone(),
            ConnectInfo(peer),
            post("Third unique comment")
        )
        .await,
        Err(crate::error::AppError::TooManyRequests { .. })
    ));

    // Only a valid server-side session bypasses guest quotas and the pending cap.
    let mut config = state.config().clone();
    let limits = config.comments.as_mut().unwrap();
    limits.per_ip_hourly_limit = 0;
    limits.per_author_hourly_limit = 0;
    limits.max_pending_per_author = 0;
    limits.per_author_item_daily_limit = 1;
    let moderator_state = AppState::new(config, state.db_pool().clone());
    headers.insert("cookie", "__Host-gl_mod=fake".parse().unwrap());
    assert!(matches!(
        comments::create_comment(
            State(moderator_state.clone()),
            headers.clone(),
            ConnectInfo(peer),
            post("Moderator test")
        )
        .await,
        Err(crate::error::AppError::TooManyRequests { .. })
    ));
    let token = moderator_state.create_moderator_session();
    headers.insert("cookie", format!("__Host-gl_mod={token}").parse().unwrap());
    let (_, Json(response)) = comments::create_comment(
        State(moderator_state),
        headers,
        ConnectInfo(peer),
        post("Moderator test"),
    )
    .await
    .unwrap();
    assert_eq!(response.next_comment_in_secs, 2);
    assert_eq!(response.comment.status, "pending");
}

#[sqlx::test(migrations = false)]
#[ignore = "requires local PostgreSQL with permission to create isolated test databases"]
async fn comment_regression_filters_and_tied_pagination(pool: PgPool) {
    let (topic, item) = seed(&pool).await;
    let mut tx = pool.begin().await.unwrap();
    let now = OffsetDateTime::now_utc();
    let a = guest_comments::insert_author(&mut tx, &[1; 32], now)
        .await
        .unwrap();
    let b = guest_comments::insert_author(&mut tx, &[2; 32], now)
        .await
        .unwrap();
    for (author, body, status) in [
        (a.id, "needle one", guest_comments::CommentStatus::Pending),
        (a.id, "needle two", guest_comments::CommentStatus::Pending),
        (b.id, "other body", guest_comments::CommentStatus::Approved),
    ] {
        let comment = guest_comments::insert_comment(
            &mut tx,
            guest_comments::InsertCommentParams {
                reply_to_comment_id: None,
                item_id: item,
                topic_id: topic,
                author_id: author,
                author_display_name: "Same name",
                body,
                body_hash: &[1; 32],
                status,
                auto_approved: false,
                hold_reason: None,
                author_ip_hash: None,
                created_at: now,
            },
        )
        .await
        .unwrap();
        guest_comments::insert_moderation_event(
            &mut tx,
            guest_comments::InsertEventParams {
                comment_id: Some(comment.id),
                author_id: Some(author),
                action: guest_comments::ModerationAction::Held,
                actor: guest_comments::ModerationActor::System,
                reason: None,
                author_approved_count: Some(0),
                recorded_at: now,
            },
        )
        .await
        .unwrap();
    }
    tx.commit().await.unwrap();
    let filters = ModerationFilters {
        topic: Some("test".into()),
        author_id: Some(a.id),
        author: Some("same".into()),
        q: Some("NEEDLE".into()),
    };
    let first = guest_comments::list_queue(&pool, &["pending", "approved"], None, &filters, 1)
        .await
        .unwrap();
    assert_eq!(first.len(), 1);
    let second = guest_comments::list_queue(
        &pool,
        &["pending", "approved"],
        Some((first[0].created_at, first[0].id)),
        &filters,
        1,
    )
    .await
    .unwrap();
    assert_eq!(second.len(), 1);
    assert_ne!(first[0].id, second[0].id);
    let log = guest_comments::list_log(&pool, None, None, None, &filters, 10)
        .await
        .unwrap();
    assert_eq!(log.len(), 2);
    let other = ModerationFilters {
        author_id: Some(b.id),
        ..Default::default()
    };
    assert_eq!(
        guest_comments::list_queue(&pool, &["approved"], None, &other, 10)
            .await
            .unwrap()
            .len(),
        1
    );
    assert!(
        guest_comments::list_queue(&pool, &["pending"], None, &other, 10)
            .await
            .unwrap()
            .is_empty()
    );
    let absent = ModerationFilters {
        topic: Some("absent".into()),
        ..Default::default()
    };
    assert!(
        guest_comments::list_log(&pool, None, None, None, &absent, 10)
            .await
            .unwrap()
            .is_empty()
    );
    let literal = ModerationFilters {
        q: Some("%".into()),
        ..Default::default()
    };
    assert!(
        guest_comments::list_queue(&pool, &["pending"], None, &literal, 10)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        guest_comments::author_item_quota_release(
            &pool,
            a.id,
            item,
            now - Duration::from_secs(86400),
            2
        )
        .await
        .unwrap(),
        Some(
            now.replace_nanosecond(now.nanosecond() / 1000 * 1000)
                .unwrap()
        )
    );
}
