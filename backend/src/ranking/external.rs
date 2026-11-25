use crate::db::items::TopicItemCandidate;

pub fn sort(items: &mut [TopicItemCandidate]) {
    items.sort_by(
        |left, right| match (left.external_rank, right.external_rank) {
            (Some(left_rank), Some(right_rank)) => left_rank
                .cmp(&right_rank)
                .then_with(|| right.current_score.total_cmp(&left.current_score))
                .then_with(|| right.published_at.cmp(&left.published_at)),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => right
                .current_score
                .total_cmp(&left.current_score)
                .then_with(|| right.published_at.cmp(&left.published_at)),
        },
    );
}
