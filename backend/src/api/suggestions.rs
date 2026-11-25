use crate::{
    api::{
        comments,
        guards::{enforce_rate_limit, require_allowed_origin, require_json_content_type},
        moderation,
    },
    captcha::{self, CaptchaSolution},
    crypto,
    db::{
        feed_suggestions,
        guest_comments::{self, TrustState},
    },
    error::AppError,
    net,
    ratelimit::{RateKey, RateRule, RateScope},
    state::AppState,
};
use axum::{
    Json,
    extract::{ConnectInfo, Path, Query, State},
    http::{HeaderMap, StatusCode},
};
use serde::{Deserialize, Serialize};
use std::{net::SocketAddr, time::Duration};
use time::OffsetDateTime;
use uuid::Uuid;

const HOUR: Duration = Duration::from_secs(3600);
const DAY: Duration = Duration::from_secs(86400);

#[derive(Debug, Deserialize)]
pub struct CreateRequest {
    pub url: String,
    pub name: Option<String>,
    pub explanation: Option<String>,
    pub email: Option<String>,
    pub captcha: CaptchaSolution,
}

#[derive(Debug, Serialize)]
pub struct CreateResponse {
    pub id: Uuid,
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author_token: Option<String>,
    pub next_submission_in_secs: u64,
}

pub(crate) fn normalize_url(value: &str) -> Result<String, AppError> {
    let value = value.trim();
    let invalid = || {
        AppError::bad_request("Συμπλήρωσε έναν έγκυρο σύνδεσμο http ή https (έως 2048 χαρακτήρες).")
    };
    if value.len() > 2048 || value.chars().any(char::is_control) {
        return Err(invalid());
    }
    let mut url = reqwest::Url::parse(value).map_err(|_| invalid())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(invalid());
    }
    url.set_fragment(None);
    let value = url.to_string();
    if value.len() > 2048 {
        return Err(invalid());
    }
    Ok(value)
}

fn optional_text(value: Option<&str>, max: usize) -> Result<Option<String>, AppError> {
    let value = value.unwrap_or_default().trim();
    if value.chars().count() > max
        || value
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\t')
    {
        return Err(AppError::bad_request(format!(
            "Το πεδίο πρέπει να έχει έως {max} χαρακτήρες."
        )));
    }
    Ok((!value.is_empty()).then(|| value.to_owned()))
}

pub(crate) fn normalize_email(value: Option<&str>) -> Result<Option<String>, AppError> {
    let value = value.unwrap_or_default().trim();
    if value.is_empty() {
        return Ok(None);
    }
    let invalid = || AppError::bad_request("Συμπλήρωσε ένα έγκυρο email ή άφησε το πεδίο κενό.");
    let (local, domain) = value.split_once('@').ok_or_else(invalid)?;
    if value.len() > 254
        || local.is_empty()
        || local.len() > 64
        || local.starts_with('.')
        || local.ends_with('.')
        || local.contains("..")
        || !local
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b".!#$%&'*+-/=?^_`{|}~".contains(&c))
        || !domain.contains('.')
        || domain.split('.').any(|part| {
            part.is_empty()
                || part.len() > 63
                || part.starts_with('-')
                || part.ends_with('-')
                || !part.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
        })
    {
        return Err(invalid());
    }
    Ok(Some(format!("{local}@{}", domain.to_ascii_lowercase())))
}

pub async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(payload): Json<CreateRequest>,
) -> Result<(StatusCode, Json<CreateResponse>), AppError> {
    let config = state.require_comments_config()?;
    require_json_content_type(&headers)?;
    require_allowed_origin(config, &headers)?;
    let url = normalize_url(&payload.url)?;
    let name = optional_text(payload.name.as_deref(), 100)?;
    let explanation = optional_text(payload.explanation.as_deref(), config.max_length.min(1000))?;
    let email = normalize_email(payload.email.as_deref())?;
    let ip = net::rate_limit_subject(net::resolve_client_ip(&headers).unwrap_or(peer.ip()));
    let ip_hash = crypto::hash_ip(&config.ip_pepper, &ip);
    let now = OffsetDateTime::now_utc();
    if guest_comments::is_ip_blocked(state.db_pool(), &ip_hash, now).await? {
        return Err(AppError::forbidden(
            "Δεν είναι δυνατή η υποβολή προτάσεων από αυτή τη σύνδεση.",
        ));
    }
    enforce_rate_limit(
        &state,
        RateKey::new(RateScope::SuggestionAttemptIp, ip.clone()),
        &[RateRule::new(30, Duration::from_secs(60))],
        "Έγιναν πολλές προσπάθειες. Η πρότασή σου διατηρείται.",
    )?;
    let is_moderator = net::cookie_value(&headers, moderation::SESSION_COOKIE)
        .is_some_and(|token| state.touch_moderator_session(&token));
    let cooldown = if is_moderator {
        Duration::from_secs(2)
    } else {
        config
            .per_author_burst_interval
            .max(config.per_ip_burst_interval)
    };
    let ip_permit = if is_moderator {
        None
    } else {
        Some(state.reserve_comment_rate(RateKey::new(RateScope::SuggestionIp, ip), &[
        RateRule::new(1, config.per_ip_burst_interval), RateRule::new(config.per_ip_hourly_limit, HOUR), RateRule::new(config.per_ip_daily_limit, DAY)
    ], "Συμπληρώθηκε προσωρινά το όριο προτάσεων αυτής της σύνδεσης. Η πρότασή σου διατηρείται.")?)
    };
    captcha::verify(config, &payload.captcha, now)?;
    let captcha_permit = state.reserve_captcha(&payload.captcha.challenge)?;
    let existing = comments::resolve_author(&state, &headers).await?;
    let mut tx = state.db_pool().begin().await?;
    let (author, author_token) = match existing {
        Some(author) => (
            guest_comments::touch_author(&mut tx, author.id, now).await?,
            None,
        ),
        None => {
            let token = crypto::generate_token();
            (
                guest_comments::insert_author(&mut tx, &crypto::hash_token(&token), now).await?,
                Some(token),
            )
        }
    };
    if author.trust()? == TrustState::Banned {
        return Err(AppError::forbidden("Δεν είναι δυνατή η υποβολή προτάσεων."));
    }
    let author_rules = if is_moderator {
        vec![RateRule::new(1, cooldown)]
    } else {
        vec![
            RateRule::new(1, config.per_author_burst_interval),
            RateRule::new(config.per_author_hourly_limit, HOUR),
        ]
    };
    let author_permit = state.reserve_comment_rate(
        RateKey::new(RateScope::SuggestionAuthor, author.id.to_string()),
        &author_rules,
        "Χρειάζεται μια παύση πριν από την επόμενη πρόταση. Η πρότασή σου διατηρείται.",
    )?;
    if sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM feed_suggestions WHERE author_id=$1 AND url=$2 AND status='pending')").bind(author.id).bind(&url).fetch_one(&mut *tx).await? {
        return Err(AppError::conflict("Έχεις ήδη προτείνει αυτή την πηγή. Η πρόταση περιμένει έλεγχο."));
    }
    if !is_moderator {
        let pending: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM feed_suggestions WHERE author_id=$1 AND status='pending'",
        )
        .bind(author.id)
        .fetch_one(&mut *tx)
        .await?;
        if pending >= config.max_pending_per_author {
            return Err(AppError::conflict(
                "Έχεις ήδη προτάσεις σε αναμονή. Περίμενε να ελεγχθούν.",
            ));
        }
        let release_at: Option<OffsetDateTime> = sqlx::query_scalar("SELECT created_at FROM feed_suggestions WHERE author_id=$1 AND url=$2 AND created_at > $3 ORDER BY created_at DESC OFFSET $4 LIMIT 1")
            .bind(author.id).bind(&url).bind(now - DAY).bind(config.per_author_item_daily_limit.max(1) as i64 - 1).fetch_optional(&mut *tx).await?;
        if let Some(at) = release_at {
            return Err(AppError::too_many_requests(
                "Συμπληρώθηκε το ημερήσιο όριο προτάσεων για αυτή την πηγή.",
                (at + DAY - now)
                    .try_into()
                    .unwrap_or(Duration::from_secs(1)),
            ));
        }
    }
    let id = Uuid::now_v7();
    let result = sqlx::query("INSERT INTO feed_suggestions(id,author_id,url,name,explanation,email,author_ip_hash,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8)")
        .bind(id).bind(author.id).bind(url).bind(name).bind(explanation).bind(email).bind(ip_hash.as_slice()).bind(now).execute(&mut *tx).await;
    if let Err(error) = result {
        if error
            .as_database_error()
            .is_some_and(|e| e.is_unique_violation())
        {
            return Err(AppError::conflict("Έχεις ήδη προτείνει αυτή την πηγή."));
        }
        return Err(error.into());
    }
    tx.commit().await?;
    if let Some(permit) = ip_permit {
        permit.commit();
    }
    author_permit.commit();
    captcha_permit.commit();
    Ok((
        StatusCode::CREATED,
        Json(CreateResponse {
            id,
            status: "pending",
            author_token,
            next_submission_in_secs: cooldown.as_secs(),
        }),
    ))
}

#[derive(Deserialize)]
pub struct ListQuery {
    pub status: Option<String>,
    pub cursor: Option<String>,
    pub limit: Option<i64>,
}
#[derive(Serialize)]
pub struct ListResponse {
    pub suggestions: Vec<feed_suggestions::Suggestion>,
    pub next_cursor: Option<String>,
    pub pending: i64,
}
fn validate_status(status: &str) -> Result<(), AppError> {
    if matches!(status, "pending" | "added" | "rejected" | "spam") {
        Ok(())
    } else {
        Err(AppError::bad_request("Μη έγκυρη κατάσταση πρότασης."))
    }
}
pub async fn list(
    State(state): State<AppState>,
    Query(query): Query<ListQuery>,
) -> Result<Json<ListResponse>, AppError> {
    let status = query.status.as_deref().unwrap_or("pending");
    if status != "all" {
        validate_status(status)?;
    }
    let limit = query.limit.unwrap_or(30).clamp(1, 100);
    let mut suggestions = feed_suggestions::list(
        state.db_pool(),
        (status != "all").then_some(status),
        moderation::parse_cursor(query.cursor.as_deref())?,
        limit + 1,
    )
    .await?;
    let next_cursor =
        moderation::next_cursor(&mut suggestions, limit, |item| (item.created_at, item.id))?;
    Ok(Json(ListResponse {
        suggestions,
        next_cursor,
        pending: feed_suggestions::pending_count(state.db_pool()).await?,
    }))
}

#[derive(Deserialize)]
pub struct Decision {
    pub status: String,
}
pub async fn decide(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(payload): Json<Decision>,
) -> Result<StatusCode, AppError> {
    require_json_content_type(&headers)?;
    require_allowed_origin(state.require_comments_config()?, &headers)?;
    validate_status(&payload.status)?;
    let result = sqlx::query("UPDATE feed_suggestions SET status=$2, email=CASE WHEN resolved_at < now() - interval '90 days' THEN NULL ELSE email END, resolved_at=CASE WHEN $2='pending' THEN NULL WHEN status='pending' THEN now() ELSE resolved_at END, updated_at=now() WHERE id=$1")
        .bind(id).bind(payload.status).execute(state.db_pool()).await;
    match result {
        Ok(row) if row.rows_affected() == 0 => Err(AppError::not_found("Η πρόταση δεν βρέθηκε.")),
        Ok(_) => Ok(StatusCode::NO_CONTENT),
        Err(error)
            if error
                .as_database_error()
                .is_some_and(|e| e.is_unique_violation()) =>
        {
            Err(AppError::conflict("Υπάρχει ήδη ίδια πρόταση σε αναμονή."))
        }
        Err(error) => Err(error.into()),
    }
}
