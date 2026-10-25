//! Domain model for the queue engine.
//!
//! Everything here is generic over the business payload `T`, so the same core serves
//! boutique check-ins, distributor orders or factory jobs. `QueueState<T>` is plain,
//! synchronous data: it knows nothing about locks, sockets or HTTP. The server wraps it
//! in a single `Mutex`, which keeps every invariant in one auditable place.

use std::collections::{HashMap, VecDeque};
use std::fmt;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

/// How many finished items are kept for the "recently completed" strip.
const COMPLETED_HISTORY: usize = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum Priority {
    #[default]
    Normal,
    High,
}

/// Fields shared by every lifecycle state of an item.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemMeta<T> {
    pub id: Uuid,
    /// Short human-readable text shown on the display ("Order #1042", "Ms. Alvarez").
    pub label: String,
    pub priority: Priority,
    /// Tenant-specific business data; opaque to the engine.
    pub payload: T,
    pub enqueued_at: DateTime<Utc>,
}

/// Lifecycle state of an item. Internally tagged, so the JSON is flat:
/// `{ "status": "processing", "id": "...", "label": "...", "startedAt": "...", "worker": "..." }`
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum QueueItem<T> {
    Waiting {
        #[serde(flatten)]
        meta: ItemMeta<T>,
    },
    Processing {
        #[serde(flatten)]
        meta: ItemMeta<T>,
        started_at: DateTime<Utc>,
        worker: String,
    },
    Completed {
        #[serde(flatten)]
        meta: ItemMeta<T>,
        started_at: DateTime<Utc>,
        completed_at: DateTime<Utc>,
        worker: String,
    },
}

/// Body accepted by `POST /api/enqueue`.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[schema(bound = "")]
pub struct EnqueueRequest<T> {
    /// Short text shown on the display, e.g. "Order #1042".
    pub label: String,
    /// Arbitrary tenant-specific JSON. `durationMs` (500-60000) sets simulated processing time.
    #[schema(value_type = Object, example = json!({"durationMs": 5000}))]
    pub payload: T,
    #[serde(default)]
    pub priority: Priority,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct EnqueueResponse {
    pub id: Uuid,
    /// Zero-based position in the waiting list at insertion time.
    pub position: usize,
}

/// Full picture of one tenant's queue. Sent to every WebSocket client on each change.
/// Snapshots (rather than deltas) are idempotent, so a dropped message is repaired by the next one.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueSnapshot<T> {
    pub tenant: String,
    /// Monotonic per tenant; lets clients discard stale or out-of-order snapshots.
    pub version: u64,
    pub waiting: Vec<QueueItem<T>>,
    pub processing: Vec<QueueItem<T>>,
    pub completed: Vec<QueueItem<T>>,
}

#[derive(Debug)]
pub enum QueueError {
    NotFound(Uuid),
    /// Work already in flight on a resource cannot be cancelled from the queue.
    NotCancellable(Uuid),
}

impl fmt::Display for QueueError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            QueueError::NotFound(id) => write!(f, "item {id} not found in the waiting list"),
            QueueError::NotCancellable(id) => write!(f, "item {id} is already processing"),
        }
    }
}

impl std::error::Error for QueueError {}

struct ProcessingEntry<T> {
    meta: ItemMeta<T>,
    started_at: DateTime<Utc>,
    worker: String,
}

/// One tenant's queue. Every mutator bumps `version` exactly once, which is how the
/// server decides whether a broadcast is needed.
pub struct QueueState<T> {
    waiting: VecDeque<ItemMeta<T>>,
    processing: HashMap<Uuid, ProcessingEntry<T>>,
    completed: VecDeque<QueueItem<T>>,
    version: u64,
}

impl<T> Default for QueueState<T> {
    fn default() -> Self {
        Self {
            waiting: VecDeque::new(),
            processing: HashMap::new(),
            completed: VecDeque::new(),
            version: 0,
        }
    }
}

impl<T: Clone> QueueState<T> {
    pub fn version(&self) -> u64 {
        self.version
    }

    pub fn enqueue(&mut self, req: EnqueueRequest<T>) -> (Uuid, usize) {
        let meta = ItemMeta {
            id: Uuid::new_v4(),
            label: req.label,
            priority: req.priority,
            payload: req.payload,
            enqueued_at: Utc::now(),
        };
        let id = meta.id;
        let position = self.insert_by_priority(meta);
        self.version += 1;
        (id, position)
    }

    /// Atomically moves the head of the waiting list to `Processing`.
    /// Because this runs under the tenant lock, two workers can never claim the same item.
    pub fn claim_next(&mut self, worker: &str) -> Option<ItemMeta<T>> {
        let meta = self.waiting.pop_front()?;
        self.processing.insert(
            meta.id,
            ProcessingEntry { meta: meta.clone(), started_at: Utc::now(), worker: worker.to_owned() },
        );
        self.version += 1;
        Some(meta)
    }

    pub fn complete(&mut self, id: Uuid) -> Result<(), QueueError> {
        let entry = self.processing.remove(&id).ok_or(QueueError::NotFound(id))?;
        self.completed.push_front(QueueItem::Completed {
            meta: entry.meta,
            started_at: entry.started_at,
            completed_at: Utc::now(),
            worker: entry.worker,
        });
        self.completed.truncate(COMPLETED_HISTORY);
        self.version += 1;
        Ok(())
    }

    pub fn cancel(&mut self, id: Uuid) -> Result<(), QueueError> {
        match self.waiting.iter().position(|i| i.id == id) {
            Some(pos) => {
                self.waiting.remove(pos);
                self.version += 1;
                Ok(())
            }
            None if self.processing.contains_key(&id) => Err(QueueError::NotCancellable(id)),
            None => Err(QueueError::NotFound(id)),
        }
    }

    /// Promotes a waiting item to the front of the normal-priority line (behind other high-priority items).
    pub fn prioritize(&mut self, id: Uuid) -> Result<usize, QueueError> {
        let pos = self.waiting.iter().position(|i| i.id == id).ok_or(QueueError::NotFound(id))?;
        let mut meta = self.waiting.remove(pos).expect("position was just found");
        meta.priority = Priority::High;
        let new_pos = self.insert_by_priority(meta);
        self.version += 1;
        Ok(new_pos)
    }

    pub fn snapshot(&self, tenant: &str) -> QueueSnapshot<T> {
        let mut processing: Vec<_> = self.processing.values().collect();
        processing.sort_by_key(|e| e.started_at);

        QueueSnapshot {
            tenant: tenant.to_owned(),
            version: self.version,
            waiting: self.waiting.iter().map(|m| QueueItem::Waiting { meta: m.clone() }).collect(),
            processing: processing
                .into_iter()
                .map(|e| QueueItem::Processing {
                    meta: e.meta.clone(),
                    started_at: e.started_at,
                    worker: e.worker.clone(),
                })
                .collect(),
            completed: self.completed.iter().cloned().collect(),
        }
    }

    /// High priority goes behind existing high-priority items but ahead of all normal ones; normal goes last.
    fn insert_by_priority(&mut self, meta: ItemMeta<T>) -> usize {
        let idx = match meta.priority {
            Priority::Normal => self.waiting.len(),
            Priority::High => self
                .waiting
                .iter()
                .position(|i| i.priority == Priority::Normal)
                .unwrap_or(self.waiting.len()),
        };
        self.waiting.insert(idx, meta);
        idx
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    type Q = QueueState<Value>;

    fn req(label: &str, priority: Priority) -> EnqueueRequest<Value> {
        EnqueueRequest { label: label.into(), payload: json!({}), priority }
    }

    fn labels(q: &Q) -> Vec<String> {
        q.snapshot("t")
            .waiting
            .into_iter()
            .map(|i| match i {
                QueueItem::Waiting { meta } => meta.label,
                _ => unreachable!(),
            })
            .collect()
    }

    #[test]
    fn enqueue_is_fifo_for_normal_priority() {
        let mut q = Q::default();
        assert_eq!(q.enqueue(req("a", Priority::Normal)).1, 0);
        assert_eq!(q.enqueue(req("b", Priority::Normal)).1, 1);
        assert_eq!(labels(&q), ["a", "b"]);
    }

    #[test]
    fn high_priority_jumps_normal_but_not_other_high() {
        let mut q = Q::default();
        q.enqueue(req("n1", Priority::Normal));
        q.enqueue(req("h1", Priority::High));
        q.enqueue(req("h2", Priority::High));
        q.enqueue(req("n2", Priority::Normal));
        assert_eq!(labels(&q), ["h1", "h2", "n1", "n2"]);
    }

    #[test]
    fn every_mutation_bumps_version_once() {
        let mut q = Q::default();
        let (id, _) = q.enqueue(req("a", Priority::Normal));
        assert_eq!(q.version(), 1);
        q.claim_next("w").unwrap();
        assert_eq!(q.version(), 2);
        q.complete(id).unwrap();
        assert_eq!(q.version(), 3);
    }

    #[test]
    fn claim_next_pops_head_and_moves_to_processing() {
        let mut q = Q::default();
        assert!(q.claim_next("w").is_none());
        q.enqueue(req("a", Priority::Normal));
        let claimed = q.claim_next("w1").unwrap();
        assert_eq!(claimed.label, "a");
        let snap = q.snapshot("t");
        assert!(snap.waiting.is_empty());
        assert_eq!(snap.processing.len(), 1);
    }

    #[test]
    fn complete_moves_to_history_and_unknown_id_fails() {
        let mut q = Q::default();
        let (id, _) = q.enqueue(req("a", Priority::Normal));
        q.claim_next("w").unwrap();
        q.complete(id).unwrap();
        assert_eq!(q.snapshot("t").completed.len(), 1);
        assert!(matches!(q.complete(id), Err(QueueError::NotFound(_))));
    }

    #[test]
    fn completed_history_is_capped_newest_first() {
        let mut q = Q::default();
        for n in 0..(COMPLETED_HISTORY + 5) {
            let (id, _) = q.enqueue(req(&format!("j{n}"), Priority::Normal));
            q.claim_next("w").unwrap();
            q.complete(id).unwrap();
        }
        let done = q.snapshot("t").completed;
        assert_eq!(done.len(), COMPLETED_HISTORY);
        match &done[0] {
            QueueItem::Completed { meta, .. } => assert_eq!(meta.label, format!("j{}", COMPLETED_HISTORY + 4)),
            _ => panic!("expected completed"),
        }
    }

    #[test]
    fn cancel_waiting_ok_processing_conflict_unknown_not_found() {
        let mut q = Q::default();
        let (a, _) = q.enqueue(req("a", Priority::Normal));
        let (b, _) = q.enqueue(req("b", Priority::Normal));
        q.cancel(b).unwrap();
        assert_eq!(labels(&q), ["a"]);
        q.claim_next("w").unwrap();
        assert!(matches!(q.cancel(a), Err(QueueError::NotCancellable(_))));
        assert!(matches!(q.cancel(Uuid::new_v4()), Err(QueueError::NotFound(_))));
    }

    #[test]
    fn failed_operations_do_not_bump_version() {
        let mut q = Q::default();
        let _ = q.cancel(Uuid::new_v4());
        let _ = q.prioritize(Uuid::new_v4());
        assert_eq!(q.version(), 0);
    }

    #[test]
    fn prioritize_promotes_behind_existing_high() {
        let mut q = Q::default();
        q.enqueue(req("h1", Priority::High));
        q.enqueue(req("n1", Priority::Normal));
        let (n2, _) = q.enqueue(req("n2", Priority::Normal));
        assert_eq!(q.prioritize(n2).unwrap(), 1);
        assert_eq!(labels(&q), ["h1", "n2", "n1"]);
    }

    #[test]
    fn snapshot_json_shape_is_flat_and_camel_case() {
        let mut q = Q::default();
        q.enqueue(req("a", Priority::Normal));
        q.claim_next("w").unwrap();
        let v = serde_json::to_value(q.snapshot("t")).unwrap();
        let item = &v["processing"][0];
        assert_eq!(item["status"], "processing");
        assert_eq!(item["label"], "a");
        assert_eq!(item["worker"], "w");
        assert!(item.get("startedAt").is_some() && item.get("enqueuedAt").is_some());
    }

    #[test]
    fn enqueue_request_defaults_priority_to_normal() {
        let r: EnqueueRequest<Value> = serde_json::from_value(json!({"label": "x", "payload": {}})).unwrap();
        assert_eq!(r.priority, Priority::Normal);
    }
}
