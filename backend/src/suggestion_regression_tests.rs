use crate::{
    api::{self, comments, suggestions},
    captcha,
    comment_regression_tests::{seed, solution, state},
    db::feed_suggestions,
    error::AppError,
    state::AppState,
};
use axum::{
    Json,
    body::Body,
    extract::{ConnectInfo, Path, Query, State},
    http::{HeaderMap, Request, StatusCode},
};
use sqlx::{PgPool, postgres::PgPoolOptions};
use std::net::SocketAddr;
use time::OffsetDateTime;
use tower::ServiceExt;

fn headers(token: Option<&str>) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert("content-type", "application/json".parse().unwrap());
    headers.insert("origin", "https://greeklish.gr".parse().unwrap());
    if let Some(token) = token {
        headers.insert("x-guest-token", token.parse().unwrap());
    }
    headers
}
fn payload(app: &AppState, url: &str) -> suggestions::CreateRequest {
    suggestions::CreateRequest {
        url: url.into(),
        name: Some("Πηγή".into()),
        explanation: Some("Μια ενδιαφέρουσα κοινότητα".into()),
        email: None,
        captcha: solution(app.require_comments_config().unwrap()),
    }
}
async fn post(
    app: &AppState,
    token: Option<&str>,
    body: suggestions::CreateRequest,
) -> Result<suggestions::CreateResponse, AppError> {
    let (status, Json(response)) = suggestions::create(
        State(app.clone()),
        headers(token),
        ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 1234))),
        Json(body),
    )
    .await?;
    assert_eq!(status, StatusCode::CREATED);
    Ok(response)
}
fn comment(app: &AppState, captcha: captcha::CaptchaSolution) -> comments::CreateCommentRequest {
    let _ = app;
    comments::CreateCommentRequest {
        topic: "test".into(),
        external_id: "one".into(),
        body: "Valid comment".into(),
        display_name: None,
        captcha,
        reply_to_comment_id: None,
    }
}

#[test]
fn suggestion_regression_validation() {
    assert_eq!(
        suggestions::normalize_url(" HTTPS://Example.COM:443/#fragment ").unwrap(),
        "https://example.com/"
    );
    for bad in [
        "javascript:alert(1)",
        "file:///tmp/feed",
        "https://user:password@example.com/",
        "not a URL",
        "https://example.com/\nattack",
    ] {
        assert!(suggestions::normalize_url(bad).is_err(), "{bad}");
    }
    assert_eq!(
        suggestions::normalize_email(Some("Test+feed@EXAMPLE.COM"))
            .unwrap()
            .as_deref(),
        Some("Test+feed@example.com")
    );
    assert!(suggestions::normalize_email(Some(" ")).unwrap().is_none());
    for bad in [
        "x@example.com\r\nBcc:spam@example.com",
        "x@example.com,y@example.com",
        ".x@example.com",
        "x@-example.com",
        "x@example..com",
    ] {
        assert!(suggestions::normalize_email(Some(bad)).is_err());
    }
}

#[tokio::test]
async fn suggestion_regression_captcha_reservations_are_atomic_and_refunded() {
    let app = state(
        PgPoolOptions::new()
            .connect_lazy("postgres://localhost/unused")
            .unwrap(),
    );
    {
        let _reservation = app.reserve_captcha("refunded").unwrap();
        assert!(app.reserve_captcha("refunded").is_err());
    }
    app.reserve_captcha("refunded").unwrap().commit();
    assert!(app.reserve_captcha("refunded").is_err());
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(12));
    let workers: Vec<_> = (0..12)
        .map(|_| {
            let app = app.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                match app.reserve_captcha("concurrent") {
                    Ok(permit) => {
                        permit.commit();
                        1
                    }
                    Err(_) => 0,
                }
            })
        })
        .collect();
    assert_eq!(
        workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .sum::<i32>(),
        1
    );
}

#[tokio::test]
async fn suggestion_regression_private_routes_require_current_session() {
    let app = state(
        PgPoolOptions::new()
            .connect_lazy("postgres://localhost/unused")
            .unwrap(),
    );
    let router = api::router(app.clone());
    for (method, path, body) in [
        ("GET", "/api/moderation/feed-suggestions", ""),
        ("GET", "/api/moderation/connection-stats", ""),
        (
            "POST",
            "/api/moderation/feed-suggestions/00000000-0000-0000-0000-000000000001/status",
            "{\"status\":\"added\"}",
        ),
    ] {
        let request = Request::builder()
            .method(method)
            .uri(path)
            .header("content-type", "application/json")
            .body(Body::from(body))
            .unwrap();
        let response = router.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(response.headers()["cache-control"], "private, no-store");
    }
    let token = app.create_moderator_session();
    let request = || {
        Request::builder()
            .uri("/api/moderation/connection-stats")
            .header("cookie", format!("__Host-gl_mod={token}"))
            .body(Body::empty())
            .unwrap()
    };
    let response = router.clone().oneshot(request()).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["cache-control"], "private, no-store");
    app.revoke_moderator_session(&token);
    assert_eq!(
        router.oneshot(request()).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
}

#[sqlx::test(migrations = false)]
#[ignore = "requires isolated local PostgreSQL"]
async fn suggestion_regression_creation_duplicates_and_separate_allowances(pool: PgPool) {
    seed(&pool).await;
    let app = state(pool.clone());
    let Json(health) = api::health::get_health(State(app.clone())).await.unwrap();
    let health = serde_json::to_value(health).unwrap();
    assert_eq!(health["database"]["reachable"], true);
    assert!(health.get("connected_ws_clients").is_none());
    assert!(health.get("connected_ws_unique_client_ips").is_none());
    let mut first = payload(&app, "https://example.com/#first");
    first.email = Some("Guest+news@EXAMPLE.COM".into());
    let response = post(&app, None, first).await.unwrap();
    let token = response.author_token.unwrap();
    let stored: (String, String) =
        sqlx::query_as("SELECT url,email FROM feed_suggestions WHERE id=$1")
            .bind(response.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        stored,
        (
            "https://example.com/".into(),
            "Guest+news@example.com".into()
        )
    );
    let duplicate = payload(&app, "https://EXAMPLE.com:443/#different");
    let reusable = duplicate.captcha.clone();
    assert!(matches!(
        post(&app, Some(&token), duplicate).await,
        Err(AppError::Conflict(_))
    ));
    let mut next = payload(&app, "https://example.com/other");
    next.captcha = reusable;
    post(&app, Some(&token), next).await.unwrap();
    assert!(
        matches!(post(&app, Some(&token), payload(&app, "https://example.com/third")).await, Err(AppError::TooManyRequests { retry_after_secs, .. }) if retry_after_secs > 0)
    );
    let _ = comments::create_comment(
        State(app.clone()),
        headers(Some(&token)),
        ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 1234))),
        Json(comment(
            &app,
            solution(app.require_comments_config().unwrap()),
        )),
    )
    .await
    .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM feed_suggestions")
            .fetch_one(&pool)
            .await
            .unwrap(),
        2
    );
    let guest = comments::resolve_author(&app, &headers(Some(&token)))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(guest.approved_count, 0);
}

#[sqlx::test(migrations = false)]
#[ignore = "requires isolated local PostgreSQL"]
async fn suggestion_regression_cross_endpoint_replay_and_failed_request_refund(pool: PgPool) {
    seed(&pool).await;
    let app = state(pool.clone());
    let first = payload(&app, "https://example.com/");
    let shared = first.captcha.clone();
    let (suggestion, comment) = tokio::join!(
        post(&app, None, first),
        comments::create_comment(
            State(app.clone()),
            headers(None),
            ConnectInfo(SocketAddr::from(([127, 0, 0, 2], 1234))),
            Json(comment(&app, shared))
        )
    );
    assert_ne!(suggestion.is_ok(), comment.is_ok());
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT (SELECT count(*) FROM feed_suggestions)+(SELECT count(*) FROM guest_comments)"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        1
    );
    let second = payload(&app, "https://example.com/second");
    let mut invalid = self::comment(&app, second.captcha.clone());
    invalid.external_id = "missing".into();
    assert!(
        comments::create_comment(
            State(app.clone()),
            headers(None),
            ConnectInfo(SocketAddr::from(([127, 0, 0, 3], 1234))),
            Json(invalid)
        )
        .await
        .is_err()
    );
    post(&app, None, second).await.unwrap();
}

#[sqlx::test(migrations = false)]
#[ignore = "requires isolated local PostgreSQL"]
async fn suggestion_regression_moderation_pagination_retention_and_bans(pool: PgPool) {
    seed(&pool).await;
    let app = state(pool.clone());
    let mut first = payload(&app, "https://example.com/");
    first.email = Some("first@example.com".into());
    let response = post(&app, None, first).await.unwrap();
    let token = response.author_token.unwrap();
    // Independent guests may suggest the same source and keep separate private contact emails.
    let mut second = payload(&app, "https://example.com/");
    second.email = Some("second@example.com".into());
    let other = post(&app, None, second).await.unwrap();
    let Json(page) = suggestions::list(
        State(app.clone()),
        Query(suggestions::ListQuery {
            status: None,
            cursor: None,
            limit: Some(1),
        }),
    )
    .await
    .unwrap();
    assert_eq!(page.pending, 2);
    assert_eq!(page.suggestions.len(), 1);
    let Json(next) = suggestions::list(
        State(app.clone()),
        Query(suggestions::ListQuery {
            status: None,
            cursor: page.next_cursor,
            limit: Some(1),
        }),
    )
    .await
    .unwrap();
    assert_eq!(next.suggestions[0].id, response.id);
    suggestions::decide(
        State(app.clone()),
        headers(None),
        Path(response.id),
        Json(suggestions::Decision {
            status: "added".into(),
        }),
    )
    .await
    .unwrap();
    assert_eq!(feed_suggestions::pending_count(&pool).await.unwrap(), 1);
    sqlx::query("UPDATE feed_suggestions SET resolved_at=now()-interval '91 days',created_at=now()-interval '100 days' WHERE id=$1").bind(response.id).execute(&pool).await.unwrap();
    let list = feed_suggestions::list(&pool, Some("added"), None, 10)
        .await
        .unwrap();
    assert!(list[0].email.is_none());
    feed_suggestions::prune(
        &pool,
        OffsetDateTime::now_utc(),
        OffsetDateTime::now_utc() - time::Duration::days(90),
    )
    .await
    .unwrap();
    let erased: (Option<String>, Option<Vec<u8>>) =
        sqlx::query_as("SELECT email,author_ip_hash FROM feed_suggestions WHERE id=$1")
            .bind(response.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(erased, (None, None));
    assert_eq!(
        sqlx::query_scalar::<_, Option<String>>("SELECT email FROM feed_suggestions WHERE id=$1")
            .bind(other.id)
            .fetch_one(&pool)
            .await
            .unwrap()
            .as_deref(),
        Some("second@example.com")
    );
    let fresh = state(pool.clone());
    sqlx::query("UPDATE guest_authors SET trust_state='banned' WHERE token_hash=$1")
        .bind(crate::crypto::hash_token(&token).as_slice())
        .execute(&pool)
        .await
        .unwrap();
    assert!(matches!(
        post(
            &fresh,
            Some(&token),
            payload(&fresh, "https://example.com/banned")
        )
        .await,
        Err(AppError::Forbidden(_))
    ));
    let hash = crate::crypto::hash_ip(
        &fresh.require_comments_config().unwrap().ip_pepper,
        "127.0.0.1",
    );
    sqlx::query("INSERT INTO guest_comment_ip_blocks(ip_hash,created_at) VALUES($1,now())")
        .bind(hash.as_slice())
        .execute(&pool)
        .await
        .unwrap();
    assert!(matches!(
        post(&fresh, None, payload(&fresh, "https://example.com/blocked")).await,
        Err(AppError::Forbidden(_))
    ));
}

#[sqlx::test(migrations = false)]
#[ignore = "requires isolated local PostgreSQL"]
async fn suggestion_regression_invalid_captcha_and_pending_cap(pool: PgPool) {
    seed(&pool).await;
    let base = state(pool.clone());
    let mut config = base.config().clone();
    let settings = config.comments.as_mut().unwrap();
    settings.per_ip_hourly_limit = 100;
    settings.per_author_hourly_limit = 100;
    settings.max_pending_per_author = 1;
    let app = AppState::new(config, pool.clone());
    let mut invalid = payload(&app, "https://example.com/");
    invalid.captcha.signature = "invalid".into();
    assert!(post(&app, None, invalid).await.is_err());
    let response = post(&app, None, payload(&app, "https://example.com/"))
        .await
        .unwrap();
    assert!(matches!(
        post(
            &app,
            response.author_token.as_deref(),
            payload(&app, "https://example.com/next")
        )
        .await,
        Err(AppError::Conflict(_))
    ));
    let token = app.create_moderator_session();
    let mut wrong_origin = headers(None);
    wrong_origin.insert("origin", "https://other.example".parse().unwrap());
    wrong_origin.insert("cookie", format!("__Host-gl_mod={token}").parse().unwrap());
    assert!(matches!(
        suggestions::decide(
            State(app),
            wrong_origin,
            Path(response.id),
            Json(suggestions::Decision {
                status: "added".into()
            })
        )
        .await,
        Err(AppError::Forbidden(_))
    ));
}
