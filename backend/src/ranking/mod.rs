pub mod chronological;
pub mod external;
pub mod hot;

use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use uuid::Uuid;

use crate::db::items::TopicItemCandidate;
use crate::db::topics::TopicRecord;
use crate::error::AppError;
use crate::ws::messages::{RankedItem, RankingStrategy};

#[derive(Debug, Clone)]
pub struct RankedTopicItem {
    pub item_id: Uuid,
    pub payload: RankedItem,
}

pub fn rank_topic(
    topic: &TopicRecord,
    mut candidates: Vec<TopicItemCandidate>,
    now: OffsetDateTime,
) -> Result<Vec<RankedTopicItem>, AppError> {
    match topic.ranking_strategy {
        RankingStrategy::Chronological => chronological::sort(&mut candidates),
        RankingStrategy::Hot => hot::sort(&mut candidates, topic.hot_gravity.unwrap_or(1.8), now),
        RankingStrategy::External => external::sort(&mut candidates),
    }

    let limit = usize::try_from(topic.feed_size)
        .map_err(|_| AppError::bad_request("feed_size must fit into usize"))?;

    candidates
        .into_iter()
        .take(limit)
        .enumerate()
        .map(|(index, candidate)| {
            Ok(RankedTopicItem {
                item_id: candidate.item_id,
                payload: RankedItem {
                    id: candidate.item_id.to_string(),
                    title: candidate.title,
                    url: candidate.url,
                    source_slug: candidate.source_slug,
                    external_id: candidate.external_id,
                    score: candidate.current_score,
                    comments_count: extract_comments_count(candidate.metadata.as_ref()),
                    nsfw: extract_nsfw(candidate.metadata.as_ref()),
                    rank_position: i32::try_from(index + 1)
                        .map_err(|_| AppError::bad_request("rank position overflow"))?,
                    published_at: format_timestamp(candidate.published_at)?,
                    crawled_at: format_timestamp(candidate.crawled_at)?,
                },
            })
        })
        .collect()
}

fn extract_comments_count(metadata: Option<&serde_json::Value>) -> Option<i32> {
    let value = metadata?.get("comments_count")?;
    if let Some(count) = value.as_i64() {
        return i32::try_from(count).ok().filter(|count| *count >= 0);
    }

    value
        .as_str()
        .and_then(|count| count.parse::<i32>().ok())
        .filter(|count| *count >= 0)
}

fn extract_nsfw(metadata: Option<&serde_json::Value>) -> Option<bool> {
    metadata?.get("nsfw")?.as_bool()
}

pub fn format_timestamp(value: OffsetDateTime) -> Result<String, AppError> {
    value
        .format(&Rfc3339)
        .map_err(|error| AppError::bad_request(format!("failed to format timestamp: {error}")))
}
