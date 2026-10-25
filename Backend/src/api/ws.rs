//! WebSocket fan-out of queue snapshots (read-only).

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    response::Response,
};
use serde::Deserialize;
use tokio::sync::broadcast;

use crate::{config::DEFAULT_TENANT, state::AppState};

#[derive(Deserialize)]
pub struct WsParams {
    tenant: Option<String>,
}

/// Public, read-only. Browsers cannot set headers on WebSockets, so the tenant is a query parameter.
pub async fn ws_queue(ws: WebSocketUpgrade, State(state): State<AppState>, Query(p): Query<WsParams>) -> Response {
    let tenant = p.tenant.unwrap_or_else(|| DEFAULT_TENANT.to_owned());
    ws.on_upgrade(move |socket| client_loop(socket, state, tenant))
}

async fn client_loop(mut socket: WebSocket, state: AppState, tenant: String) {
    // Subscribe BEFORE taking the initial snapshot so no update can fall in the gap.
    // The worst case is a duplicate/older snapshot, which clients discard by `version`.
    let mut rx = state.events.subscribe();
    if socket.send(Message::Text(state.snapshot_json(&tenant))).await.is_err() {
        return;
    }

    loop {
        tokio::select! {
            event = rx.recv() => match event {
                Ok(ev) if ev.tenant == tenant => {
                    if socket.send(Message::Text(ev.json.to_string())).await.is_err() { break; }
                }
                Ok(_) => {} // another tenant's update
                // Slow client dropped messages: snapshots are idempotent, so just resync.
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    if socket.send(Message::Text(state.snapshot_json(&tenant))).await.is_err() { break; }
                }
                Err(broadcast::error::RecvError::Closed) => break,
            },
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                Some(Ok(_)) => {} // read-only channel: ignore anything the client sends
            },
        }
    }
}
