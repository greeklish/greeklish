pub mod comments;
pub mod guards;
pub mod health;
pub mod internal;
pub mod moderation;
pub mod notifications;
pub mod suggestions;

use axum::Router;
use axum::extract::DefaultBodyLimit;
use axum::middleware;
use axum::routing::{delete, get, post, put};

use crate::state::AppState;
use crate::ws::handler::ws_handler;

pub fn router(state: AppState) -> Router {
    let internal_routes = Router::new()
        .route("/sources/{source_slug}", put(internal::upsert_source))
        .route("/topics/{topic_slug}", put(internal::upsert_topic))
        .route(
            "/topics/{topic_slug}/items/{source_slug}/{external_id}",
            put(internal::upsert_topic_item),
        )
        .route(
            "/topics/{topic_slug}/crawl-snapshots",
            post(internal::create_crawl_snapshot),
        )
        .route(
            "/topics/{topic_slug}/crawl-passes",
            post(internal::ingest_crawl_pass),
        )
        .route("/maintenance/prune-history", post(internal::prune_history))
        .route("/topics/{topic_slug}/rerank", post(internal::rerank_topic))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            internal::require_internal_token,
        ))
        .with_state(state.clone());

    // Public, unauthenticated write surface. Deliberately outside `require_internal_token`.
    let public_comment_routes = Router::new()
        .route("/captcha/challenge", get(comments::get_captcha_challenge))
        .route("/comments", post(comments::create_comment))
        .route("/comments/discussions", get(comments::list_discussions))
        .route(
            "/comments/{topic_slug}/{external_id}",
            get(comments::list_item_comments),
        )
        .route(
            "/comments/counts/{topic_slug}",
            get(comments::list_topic_comment_counts),
        )
        .with_state(state.clone());

    let notification_routes = Router::new()
        .route("/replies", get(notifications::inbox))
        .route("/replies/read", post(notifications::read_all))
        .route("/replies/{id}/read", post(notifications::read_reply))
        .route("/push/config", get(notifications::push_config))
        .route("/push/subscriptions", post(notifications::register))
        .route(
            "/push/subscriptions/{id}",
            get(notifications::subscription).delete(notifications::unsubscribe),
        )
        .route(
            "/push/subscriptions/{id}/watches/{comment_id}",
            put(notifications::watch).delete(notifications::unwatch),
        )
        .layer(middleware::map_response(
            |mut response: axum::response::Response| async move {
                response.headers_mut().insert(
                    axum::http::header::CACHE_CONTROL,
                    axum::http::HeaderValue::from_static("private, no-store"),
                );
                response
            },
        ))
        .with_state(state.clone());

    let moderation_routes = Router::new()
        .route(
            "/moderation/connection-stats",
            get(moderation::connection_stats),
        )
        .route("/moderation/feed-suggestions", get(suggestions::list))
        .route(
            "/moderation/feed-suggestions/{id}/status",
            post(suggestions::decide),
        )
        .route("/moderation/stats", get(moderation::get_stats))
        .route("/moderation/feeds", get(moderation::list_feeds))
        .route("/moderation/queue", get(moderation::list_queue))
        .route("/moderation/log", get(moderation::list_log))
        .route(
            "/moderation/comments/{comment_id}/decision",
            post(moderation::decide_comment),
        )
        .route(
            "/moderation/authors/{author_id}/trust",
            post(moderation::set_author_trust),
        )
        .layer(middleware::from_fn_with_state(
            state.clone(),
            moderation::require_moderator,
        ))
        .layer(middleware::map_response(no_store))
        .with_state(state.clone());

    // Login and logout sit outside the moderator guard: the login call is what creates a session,
    // and logout has to work even once a session has expired.
    let session_routes = Router::new()
        .route("/moderation/session", post(moderation::create_session))
        .route("/moderation/session", delete(moderation::delete_session))
        .with_state(state.clone());

    let api_routes = Router::new()
        .merge(
            Router::new()
                .route("/feed-suggestions", post(suggestions::create))
                .layer(middleware::map_response(no_store))
                .with_state(state.clone()),
        )
        .merge(public_comment_routes)
        .merge(notification_routes)
        .merge(session_routes)
        .merge(moderation_routes)
        // A 1000-character comment needs nothing like Axum's implicit 2 MiB `Json` default.
        .layer(DefaultBodyLimit::max(MAX_API_BODY_BYTES));

    Router::new()
        .route("/health", get(health::get_health))
        .route("/ws", get(ws_handler))
        .nest("/api", api_routes)
        .nest("/internal", internal_routes)
        .with_state(state)
}

async fn no_store(mut response: axum::response::Response) -> axum::response::Response {
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("private, no-store"),
    );
    response
}

const MAX_API_BODY_BYTES: usize = 8 * 1024;
