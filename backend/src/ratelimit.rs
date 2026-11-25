use std::time::{Duration, Instant};

/// Identifies which counter a request is charged against.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RateScope {
    CaptchaIp,
    CommentIp,
    CommentAttemptIp,
    CommentAuthor,
    SuggestionIp,
    SuggestionAttemptIp,
    SuggestionAuthor,
    ModeratorLoginIp,
    ReplyInboxAuthor,
    PushSettingsAuthor,
}

/// A single counter: a scope plus the subject being counted within it.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct RateKey {
    pub scope: RateScope,
    pub subject: String,
}

impl RateKey {
    pub fn new(scope: RateScope, subject: impl Into<String>) -> Self {
        Self {
            scope,
            subject: subject.into(),
        }
    }
}

/// One sliding-window constraint. Several of these can apply to the same key.
#[derive(Debug, Clone, Copy)]
pub struct RateRule {
    pub limit: usize,
    pub window: Duration,
}

impl RateRule {
    pub const fn new(limit: usize, window: Duration) -> Self {
        Self { limit, window }
    }
}

/// Outcome of a limiter check. `Limited` carries how long the caller should wait, which becomes
/// the `Retry-After` header.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RateDecision {
    Allowed,
    Limited { retry_after: Duration },
}

/// Evaluates every rule against a window of recorded hits.
///
/// Hits older than the longest window are dropped in place, so a key's vector stays bounded by the
/// largest limit regardless of how long the process has been running.
pub fn evaluate(hits: &mut Vec<Instant>, rules: &[RateRule], now: Instant) -> RateDecision {
    let Some(longest) = rules.iter().map(|rule| rule.window).max() else {
        return RateDecision::Allowed;
    };

    hits.retain(|hit| now.duration_since(*hit) < longest);

    let mut retry_after = Duration::ZERO;

    for rule in rules {
        if rule.limit == 0 {
            return RateDecision::Limited {
                retry_after: rule.window.max(Duration::from_secs(1)),
            };
        }
        let count = hits
            .iter()
            .filter(|hit| now.duration_since(**hit) < rule.window)
            .count();

        if count < rule.limit {
            continue;
        }

        // Enough hits must age out to fall below the limit, including after a rule change.
        let oldest_in_window = hits
            .iter()
            .filter(|hit| now.duration_since(**hit) < rule.window)
            .rev()
            .nth(rule.limit.saturating_sub(1))
            .copied();

        let wait = oldest_in_window
            .map(|oldest| rule.window.saturating_sub(now.duration_since(oldest)))
            .unwrap_or(rule.window);

        retry_after = retry_after.max(wait);
    }

    if retry_after.is_zero() {
        hits.push(now);
        return RateDecision::Allowed;
    }

    RateDecision::Limited { retry_after }
}

/// Tracks repeated moderator login failures for one address.
#[derive(Debug, Clone, Copy)]
pub struct LockoutState {
    pub failures: usize,
    pub last_failure: Instant,
    pub locked_until: Option<Instant>,
}

impl LockoutState {
    pub fn first_failure(now: Instant) -> Self {
        Self {
            failures: 1,
            last_failure: now,
            locked_until: None,
        }
    }

    /// Doubles the lockout for every failure past the allowance, capped at one hour.
    pub fn record_failure(&mut self, now: Instant, allowance: usize, window: Duration) {
        if now.duration_since(self.last_failure) > window && self.locked_until.is_none() {
            self.failures = 0;
        }

        self.failures = self.failures.saturating_add(1);
        self.last_failure = now;

        if self.failures <= allowance {
            self.locked_until = None;
            return;
        }

        let excess = (self.failures - allowance).min(MAX_LOCKOUT_DOUBLINGS) as u32;
        let penalty = BASE_LOCKOUT
            .saturating_mul(2u32.saturating_pow(excess.saturating_sub(1)))
            .min(MAX_LOCKOUT);

        self.locked_until = Some(now + penalty);
    }

    pub fn remaining_lockout(&self, now: Instant) -> Option<Duration> {
        let locked_until = self.locked_until?;

        (locked_until > now).then(|| locked_until.duration_since(now))
    }

    /// True once the entry carries no useful information and the sweeper can drop it.
    pub fn is_stale(&self, now: Instant, window: Duration) -> bool {
        self.remaining_lockout(now).is_none() && now.duration_since(self.last_failure) > window
    }
}

const BASE_LOCKOUT: Duration = Duration::from_secs(60);
const MAX_LOCKOUT: Duration = Duration::from_secs(3600);
const MAX_LOCKOUT_DOUBLINGS: usize = 7;

#[cfg(test)]
mod tests {
    use super::*;

    const MINUTE: Duration = Duration::from_secs(60);

    #[test]
    fn allows_up_to_the_limit_then_rejects() {
        let rules = [RateRule::new(2, MINUTE)];
        let mut hits = Vec::new();
        let now = Instant::now();

        assert_eq!(evaluate(&mut hits, &rules, now), RateDecision::Allowed);
        assert_eq!(evaluate(&mut hits, &rules, now), RateDecision::Allowed);

        match evaluate(&mut hits, &rules, now) {
            RateDecision::Limited { retry_after } => assert!(retry_after <= MINUTE),
            RateDecision::Allowed => panic!("third hit should be limited"),
        }
    }

    #[test]
    fn a_rejected_hit_is_not_recorded() {
        let rules = [RateRule::new(1, MINUTE)];
        let mut hits = Vec::new();
        let now = Instant::now();

        assert_eq!(evaluate(&mut hits, &rules, now), RateDecision::Allowed);
        let _ = evaluate(&mut hits, &rules, now);
        let _ = evaluate(&mut hits, &rules, now);

        assert_eq!(hits.len(), 1, "rejections must not extend the window");
    }

    #[test]
    fn window_slides_and_prunes() {
        let rules = [RateRule::new(1, MINUTE)];
        let mut hits = Vec::new();
        let start = Instant::now();

        assert_eq!(evaluate(&mut hits, &rules, start), RateDecision::Allowed);
        assert_eq!(
            evaluate(&mut hits, &rules, start + MINUTE + Duration::from_secs(1)),
            RateDecision::Allowed
        );
        assert_eq!(hits.len(), 1, "the aged-out hit should be dropped");
    }

    #[test]
    fn the_strictest_rule_wins() {
        let rules = [
            RateRule::new(10, Duration::from_secs(3600)),
            RateRule::new(1, Duration::from_secs(30)),
        ];
        let mut hits = Vec::new();
        let now = Instant::now();

        assert_eq!(evaluate(&mut hits, &rules, now), RateDecision::Allowed);

        match evaluate(&mut hits, &rules, now) {
            RateDecision::Limited { retry_after } => {
                assert!(retry_after <= Duration::from_secs(30));
            }
            RateDecision::Allowed => panic!("burst rule should bite before the hourly rule"),
        }
    }

    #[test]
    fn lockout_starts_only_after_the_allowance() {
        let now = Instant::now();
        let mut state = LockoutState::first_failure(now);

        for _ in 1..5 {
            state.record_failure(now, 5, MINUTE * 15);
        }

        assert!(state.remaining_lockout(now).is_none());

        state.record_failure(now, 5, MINUTE * 15);
        assert!(state.remaining_lockout(now).is_some());
    }

    #[test]
    fn lockout_is_capped_at_one_hour() {
        let now = Instant::now();
        let mut state = LockoutState::first_failure(now);

        for _ in 0..50 {
            state.record_failure(now, 5, MINUTE * 15);
        }

        let remaining = state.remaining_lockout(now).expect("should be locked out");
        assert!(remaining <= MAX_LOCKOUT);
    }
}

#[cfg(test)]
mod regression_tests {
    use super::*;
    #[test]
    fn retry_waits_until_enough_hits_expire() {
        let start = Instant::now();
        let mut hits = vec![
            start,
            start + Duration::from_secs(10),
            start + Duration::from_secs(20),
        ];
        assert_eq!(
            evaluate(
                &mut hits,
                &[RateRule::new(2, Duration::from_secs(60))],
                start + Duration::from_secs(30)
            ),
            RateDecision::Limited {
                retry_after: Duration::from_secs(40)
            }
        );
    }
    #[test]
    fn zero_limit_is_never_allowed() {
        assert!(matches!(
            evaluate(
                &mut vec![],
                &[RateRule::new(0, Duration::ZERO)],
                Instant::now()
            ),
            RateDecision::Limited { .. }
        ));
    }
}
