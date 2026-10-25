//! Background resource processors (machines / cooks / pickers).

use std::time::Duration;

use crate::state::{AppState, Job};

const DEFAULT_WORK_MS: u64 = 5_000;
const MIN_WORK_MS: u64 = 500;
const MAX_WORK_MS: u64 = 60_000;

/// Simulated processing time from `payload.durationMs`, clamped to a sane range.
pub fn work_duration(payload: &Job) -> Duration {
    let ms = payload.get("durationMs").and_then(|v| v.as_u64()).unwrap_or(DEFAULT_WORK_MS);
    Duration::from_millis(ms.clamp(MIN_WORK_MS, MAX_WORK_MS))
}

pub fn spawn_workers(state: &AppState, count: usize) {
    for n in 1..=count {
        tokio::spawn(resource_processor(state.clone(), format!("resource-{n}")));
    }
}

/// Claims are atomic under the lock; the (slow) work happens with no lock held, so a 30-second
/// job never blocks enqueues or other workers.
pub async fn resource_processor(state: AppState, name: String) {
    loop {
        while let Some((tenant, job)) = state.claim_next(&name) {
            // Wake a sibling in case more work is waiting (Notify coalesces permits).
            state.work_ready.notify_one();

            let work = work_duration(&job.payload);
            tracing::info!(worker = %name, %tenant, id = %job.id, label = %job.label, ?work, "processing");
            tokio::time::sleep(work).await;

            if let Err(e) = state.mutate(&tenant, |q| q.complete(job.id)) {
                tracing::warn!(error = %e, "completion failed");
            }
        }
        // `notify_one` stores a permit if nobody is waiting, so a wake-up between the loop above and
        // this await is never lost. The timeout is a belt-and-braces safety poll.
        let _ = tokio::time::timeout(Duration::from_secs(1), state.work_ready.notified()).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn duration_defaults_and_clamps() {
        assert_eq!(work_duration(&json!({})), Duration::from_millis(5_000));
        assert_eq!(work_duration(&json!({"durationMs": 1})), Duration::from_millis(500));
        assert_eq!(work_duration(&json!({"durationMs": 999_999})), Duration::from_millis(60_000));
        assert_eq!(work_duration(&json!({"durationMs": 2_000})), Duration::from_millis(2_000));
        assert_eq!(work_duration(&json!({"durationMs": "x"})), Duration::from_millis(5_000));
    }

    #[tokio::test(start_paused = true)]
    async fn processor_completes_enqueued_job() {
        use crate::domain::{EnqueueRequest, Priority};
        let state = crate::state::Shared::new(Default::default());
        spawn_workers(&state, 1);

        state.mutate("t", |q| {
            q.enqueue(EnqueueRequest { label: "j".into(), payload: json!({"durationMs": 1000}), priority: Priority::Normal })
        });
        state.work_ready.notify_one();

        // Virtual time: advance past the work duration and let the worker run.
        for _ in 0..50 {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let snap: serde_json::Value = serde_json::from_str(&state.snapshot_json("t")).unwrap();
        assert_eq!(snap["completed"].as_array().unwrap().len(), 1);
        assert!(snap["waiting"].as_array().unwrap().is_empty());
        assert!(snap["processing"].as_array().unwrap().is_empty());
    }
}
