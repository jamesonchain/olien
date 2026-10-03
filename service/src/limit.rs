// How often one caller may ask.
//
// A public API that takes bearer keys and has no limit is a place to guess keys, and a
// service that anyone can make busy is one a member cannot reach when it matters. The
// limits are generous to a person at a console, which polls a dozen views every ten
// seconds, and not to a loop.
//
// One process, one map, no store: the service runs as a single instance and a limit
// that resets when it restarts is still a limit. Each caller has a bucket that refills
// at a steady rate up to a burst.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

#[derive(Debug, Clone, Copy)]
pub struct Rate {
    pub burst: f64,
    pub per_second: f64,
}

/// A console session: several tabs polling at once fit comfortably.
pub const SESSION: Rate = Rate { burst: 300.0, per_second: 20.0 };
/// An API key: a payroll or accounting job, two requests a second sustained.
pub const KEY: Rate = Rate { burst: 60.0, per_second: 2.0 };
/// Signing in, per address it comes from.
pub const SIGN_IN: Rate = Rate { burst: 20.0, per_second: 0.5 };
/// Keys that turned out not to exist, per address they came from. Ten guesses, then
/// one every ten seconds: a 256-bit key is not found this way in any number of lifetimes.
pub const WRONG_KEY: Rate = Rate { burst: 10.0, per_second: 0.1 };

struct Bucket {
    tokens: f64,
    at: Instant,
}

#[derive(Default)]
pub struct Limiter {
    buckets: Mutex<HashMap<String, Bucket>>,
}

/// Enough callers that the map is worth sweeping; full buckets carry no information.
const SWEEP_AT: usize = 20_000;

impl Limiter {
    fn level(bucket: &Bucket, rate: Rate, now: Instant) -> f64 {
        (bucket.tokens + now.saturating_duration_since(bucket.at).as_secs_f64() * rate.per_second).min(rate.burst)
    }

    /// Takes one request from the caller's bucket, or says how many seconds until it
    /// has one.
    pub fn take(&self, caller: &str, rate: Rate, now: Instant) -> Result<(), u64> {
        let mut buckets = self.buckets.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if buckets.len() > SWEEP_AT {
            buckets.retain(|_, bucket| Self::level(bucket, rate, now) < rate.burst);
        }
        let bucket = buckets.entry(caller.to_string()).or_insert(Bucket { tokens: rate.burst, at: now });
        let level = Self::level(bucket, rate, now);
        if level < 1.0 {
            bucket.tokens = level;
            bucket.at = now;
            return Err(((1.0 - level) / rate.per_second).ceil().max(1.0) as u64);
        }
        bucket.tokens = level - 1.0;
        bucket.at = now;
        Ok(())
    }

    /// Whether the caller's bucket is empty, without taking from it. For a bucket that
    /// is charged only when something goes wrong, checked before trying.
    pub fn exhausted(&self, caller: &str, rate: Rate, now: Instant) -> bool {
        let buckets = self.buckets.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        buckets.get(caller).is_some_and(|bucket| Self::level(bucket, rate, now) < 1.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    const TWO_THEN_ONE_A_SECOND: Rate = Rate { burst: 2.0, per_second: 1.0 };

    #[test]
    fn a_burst_is_allowed_and_then_the_steady_rate() {
        let limiter = Limiter::default();
        let start = Instant::now();
        assert!(limiter.take("a", TWO_THEN_ONE_A_SECOND, start).is_ok());
        assert!(limiter.take("a", TWO_THEN_ONE_A_SECOND, start).is_ok());
        assert_eq!(limiter.take("a", TWO_THEN_ONE_A_SECOND, start), Err(1), "and it says how long to wait");
        assert!(limiter.take("a", TWO_THEN_ONE_A_SECOND, start + Duration::from_secs(1)).is_ok());
        assert!(limiter.take("a", TWO_THEN_ONE_A_SECOND, start + Duration::from_secs(1)).is_err());
    }

    #[test]
    fn one_caller_does_not_spend_anothers_allowance() {
        let limiter = Limiter::default();
        let now = Instant::now();
        for _ in 0..2 {
            limiter.take("a", TWO_THEN_ONE_A_SECOND, now).unwrap();
        }
        assert!(limiter.take("a", TWO_THEN_ONE_A_SECOND, now).is_err());
        assert!(limiter.take("b", TWO_THEN_ONE_A_SECOND, now).is_ok());
    }

    #[test]
    fn a_bucket_never_holds_more_than_its_burst() {
        let limiter = Limiter::default();
        let start = Instant::now();
        limiter.take("a", TWO_THEN_ONE_A_SECOND, start).unwrap();
        let much_later = start + Duration::from_secs(3_600);
        assert!(limiter.take("a", TWO_THEN_ONE_A_SECOND, much_later).is_ok());
        assert!(limiter.take("a", TWO_THEN_ONE_A_SECOND, much_later).is_ok());
        assert!(limiter.take("a", TWO_THEN_ONE_A_SECOND, much_later).is_err());
    }

    #[test]
    fn an_empty_bucket_can_be_seen_without_taking_from_it() {
        let limiter = Limiter::default();
        let now = Instant::now();
        assert!(!limiter.exhausted("guesser", WRONG_KEY, now), "someone never seen has not run out");
        for _ in 0..10 {
            limiter.take("guesser", WRONG_KEY, now).unwrap();
        }
        assert!(limiter.exhausted("guesser", WRONG_KEY, now));
        assert!(limiter.exhausted("guesser", WRONG_KEY, now), "looking did not change it");
        assert!(!limiter.exhausted("guesser", WRONG_KEY, now + Duration::from_secs(10)));
    }
}
