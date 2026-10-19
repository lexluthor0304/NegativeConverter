//! Coalesce duplicate iOS WebContent termination callbacks and leave time for
//! WebKit to release memory before another page is created (#298 P0).
use std::sync::Mutex;

const QUIET_RESET_MS: u64 = 60_000;
const DELAYS_MS: [u64; 6] = [500, 1_000, 2_000, 4_000, 10_000, 30_000];

#[derive(Default)]
struct RecoveryState {
    pending: bool,
    last_at: Option<u64>,
    attempts: usize,
}

#[derive(Default)]
pub struct ReloadBackoff(Mutex<RecoveryState>);

impl ReloadBackoff {
    /// None means the already scheduled reload owns recovery. The clock is
    /// supplied by the host so tests cover bursts without waiting in real time.
    pub fn schedule(&self, now_ms: u64) -> Option<u64> {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if state.pending {
            return None;
        }
        if state.last_at.is_none_or(|at| now_ms.saturating_sub(at) >= QUIET_RESET_MS) {
            state.attempts = 0;
        }
        let delay = DELAYS_MS[state.attempts.min(DELAYS_MS.len() - 1)];
        state.attempts = state.attempts.saturating_add(1);
        state.last_at = Some(now_ms);
        state.pending = true;
        Some(delay)
    }

    pub fn ready(&self) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).pending = false;
    }
}

#[cfg(test)]
mod tests {
    use super::ReloadBackoff;

    #[test]
    fn termination_burst_queues_one_reload() {
        let policy = ReloadBackoff::default();
        assert_eq!(policy.schedule(100), Some(500));
        assert_eq!(policy.schedule(150), None);
        assert_eq!(policy.schedule(250), None);
        policy.ready();
        assert_eq!(policy.schedule(700), Some(1_000));
    }

    #[test]
    fn repeated_terminations_back_off_with_a_bound() {
        let policy = ReloadBackoff::default();
        let mut now = 0;
        for expected in [500, 1_000, 2_000, 4_000, 10_000, 30_000, 30_000] {
            assert_eq!(policy.schedule(now), Some(expected));
            now += expected;
            policy.ready();
        }
    }

    #[test]
    fn healthy_interval_resets_backoff() {
        let policy = ReloadBackoff::default();
        assert_eq!(policy.schedule(0), Some(500));
        policy.ready();
        assert_eq!(policy.schedule(800), Some(1_000));
        policy.ready();
        assert_eq!(policy.schedule(60_800), Some(500));
    }
}
