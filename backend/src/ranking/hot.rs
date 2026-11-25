use time::OffsetDateTime;

use crate::db::items::TopicItemCandidate;

pub fn sort(items: &mut [TopicItemCandidate], gravity: f64, now: OffsetDateTime) {
    items.sort_by(|left, right| {
        let right_score = effective_score(right, gravity, now);
        let left_score = effective_score(left, gravity, now);

        right_score
            .total_cmp(&left_score)
            .then_with(|| right.published_at.cmp(&left.published_at))
            .then_with(|| right.current_score.total_cmp(&left.current_score))
    });
}

fn effective_score(item: &TopicItemCandidate, gravity: f64, now: OffsetDateTime) -> f64 {
    let age = now - item.published_at;
    let age_hours = age.whole_seconds().max(0) as f64 / 3600.0;

    item.current_score / (age_hours + 2.0).powf(gravity)
}
