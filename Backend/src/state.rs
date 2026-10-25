//! Shared application state: the multi-tenant queue map plus the broadcast channel.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard};

use tokio::sync::{broadcast, Notify};

use crate::domain::{ItemMeta, QueueState};

/// The concrete payload for this deployment. The engine is generic; swap this alias for a
/// strongly typed struct per product without touching `domain.rs`.
pub type Job = serde_json::Value;

/// A pre-serialized snapshot for one tenant. Serializing once and sharing an `Arc<str>`
/// means N connected displays cost one serialization, not N.
#[derive(Clone)]
pub struct Event {
    pub tenant: String,
    pub json: Arc<str>,
}

pub struct Shared {
    /// A `std::sync::Mutex` is deliberate: every critical section is short, CPU-only and never `.await`s.
    tenants: Mutex<HashMap<String, QueueState<Job>>>,
    pub events: broadcast::Sender<Event>,
    /// Wakes idle resource processors when work arrives.
    pub work_ready: Notify,
    /// Accepted `x-api-key` values. Empty = open dev mode.
    pub api_keys: HashSet<String>,
}

pub type AppState = Arc<Shared>;

impl Shared {
    pub fn new(api_keys: HashSet<String>) -> AppState {
        let (events, _) = broadcast::channel(1024);
        Arc::new(Self { tenants: Mutex::new(HashMap::new()), events, work_ready: Notify::new(), api_keys })
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, QueueState<Job>>> {
        // A panic in one request must not brick the queue; mutators only bump `version` after finishing.
        self.tenants.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Runs `f` against a tenant's queue and, if it changed anything, broadcasts the new snapshot
    /// *while still holding the lock*. That guarantees snapshots are published in version order.
    pub fn mutate<R>(&self, tenant: &str, f: impl FnOnce(&mut QueueState<Job>) -> R) -> R {
        let mut tenants = self.lock();
        let queue = tenants.entry(tenant.to_owned()).or_default();
        let before = queue.version();
        let out = f(queue);
        if queue.version() != before {
            self.publish(tenant, queue);
        }
        out
    }

    fn publish(&self, tenant: &str, queue: &QueueState<Job>) {
        let json = serde_json::to_string(&queue.snapshot(tenant)).expect("snapshot is serializable");
        // Err only means "no subscribers right now", which is fine.
        let _ = self.events.send(Event { tenant: tenant.to_owned(), json: json.into() });
    }

    pub fn snapshot_json(&self, tenant: &str) -> String {
        let mut tenants = self.lock();
        let queue = tenants.entry(tenant.to_owned()).or_default();
        serde_json::to_string(&queue.snapshot(tenant)).expect("snapshot is serializable")
    }

    /// Claims the next waiting job across all tenants.
    pub fn claim_next(&self, worker: &str) -> Option<(String, ItemMeta<Job>)> {
        let mut tenants = self.lock();
        for (tenant, queue) in tenants.iter_mut() {
            if let Some(job) = queue.claim_next(worker) {
                self.publish(tenant, queue);
                return Some((tenant.clone(), job));
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{EnqueueRequest, Priority};
    use serde_json::json;

    fn req(label: &str) -> EnqueueRequest<Job> {
        EnqueueRequest { label: label.into(), payload: json!({}), priority: Priority::Normal }
    }

    #[test]
    fn mutate_broadcasts_only_on_change() {
        let state = Shared::new(HashSet::new());
        let mut rx = state.events.subscribe();

        state.mutate("t", |q| q.enqueue(req("a")));
        let ev = rx.try_recv().expect("enqueue publishes");
        assert_eq!(ev.tenant, "t");
        assert!(ev.json.contains("\"version\":1"));

        // A failing cancel changes nothing, so nothing is published.
        let _ = state.mutate("t", |q| q.cancel(uuid::Uuid::new_v4()));
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn tenants_are_isolated() {
        let state = Shared::new(HashSet::new());
        state.mutate("a", |q| q.enqueue(req("only-a")));
        assert!(state.snapshot_json("a").contains("only-a"));
        assert!(!state.snapshot_json("b").contains("only-a"));
    }

    #[test]
    fn claim_next_returns_tenant_and_empties_queue() {
        let state = Shared::new(HashSet::new());
        assert!(state.claim_next("w").is_none());
        state.mutate("a", |q| q.enqueue(req("job")));
        let (tenant, job) = state.claim_next("w").expect("job available");
        assert_eq!((tenant.as_str(), job.label.as_str()), ("a", "job"));
        assert!(state.claim_next("w").is_none());
    }
}
