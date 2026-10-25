//! Queue engine library. `main.rs` is only a thin bootstrap; everything testable lives here.
//!
//! Layers (dependencies point downwards only):
//! - `api`    : HTTP/WebSocket adapters + OpenAPI docs
//! - `worker` : background resource processors
//! - `state`  : shared, thread-safe application state (locks + broadcast)
//! - `domain` : pure queue logic, no I/O
//! - `config` / `error`: cross-cutting

pub mod api;
pub mod config;
pub mod domain;
pub mod error;
pub mod state;
pub mod worker;
