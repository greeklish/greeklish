use crate::db::items::TopicItemCandidate;

pub fn sort(items: &mut [TopicItemCandidate]) {
    items.sort_by(|left, right| {
        right
            .published_at
            .cmp(&left.published_at)
            .then_with(|| right.crawled_at.cmp(&left.crawled_at))
            .then_with(|| right.current_score.total_cmp(&left.current_score))
    });
}
