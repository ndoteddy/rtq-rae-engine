//! REST handlers, annotated for OpenAPI.

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::Serialize;
use utoipa::ToSchema;
use uuid::Uuid;

use super::middleware::tenant_from;
use crate::{
    domain::{EnqueueRequest, EnqueueResponse},
    error::{ApiError, ErrorBody},
    state::{AppState, Job},
};

#[derive(Serialize, ToSchema)]
pub struct PrioritizeResponse {
    pub id: Uuid,
    pub position: usize,
}

/// Add an item to the tenant's queue. High-priority items go ahead of normal ones.
#[utoipa::path(
    post,
    path = "/api/enqueue",
    tag = "queue",
    params(("x-tenant-id" = Option<String>, Header, description = "Tenant (default: `default`)")),
    request_body = EnqueueRequest<Job>,
    responses(
        (status = 201, description = "Item queued", body = EnqueueResponse),
        (status = 400, description = "Invalid label or tenant", body = ErrorBody),
        (status = 401, description = "Missing or invalid API key", body = ErrorBody),
    ),
    security(("api_key" = []))
)]
pub async fn enqueue(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<EnqueueRequest<Job>>,
) -> Result<(StatusCode, Json<EnqueueResponse>), ApiError> {
    let tenant = tenant_from(&headers)?;
    if req.label.trim().is_empty() {
        return Err(ApiError::Invalid("label must not be empty"));
    }
    let (id, position) = state.mutate(&tenant, |q| q.enqueue(req));
    state.work_ready.notify_one();
    Ok((StatusCode::CREATED, Json(EnqueueResponse { id, position })))
}

/// Remove a waiting item. Items already processing cannot be cancelled.
#[utoipa::path(
    post,
    path = "/api/items/{id}/cancel",
    tag = "queue",
    params(
        ("id" = Uuid, Path, description = "Item id"),
        ("x-tenant-id" = Option<String>, Header, description = "Tenant (default: `default`)"),
    ),
    responses(
        (status = 204, description = "Cancelled"),
        (status = 401, description = "Missing or invalid API key", body = ErrorBody),
        (status = 404, description = "Not in the waiting list", body = ErrorBody),
        (status = 409, description = "Already processing", body = ErrorBody),
    ),
    security(("api_key" = []))
)]
pub async fn cancel(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, ApiError> {
    let tenant = tenant_from(&headers)?;
    state.mutate(&tenant, |q| q.cancel(id))?;
    Ok(StatusCode::NO_CONTENT)
}

/// Promote a waiting item to high priority.
#[utoipa::path(
    post,
    path = "/api/items/{id}/prioritize",
    tag = "queue",
    params(
        ("id" = Uuid, Path, description = "Item id"),
        ("x-tenant-id" = Option<String>, Header, description = "Tenant (default: `default`)"),
    ),
    responses(
        (status = 200, description = "New position", body = PrioritizeResponse),
        (status = 401, description = "Missing or invalid API key", body = ErrorBody),
        (status = 404, description = "Not in the waiting list", body = ErrorBody),
    ),
    security(("api_key" = []))
)]
pub async fn prioritize(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<PrioritizeResponse>, ApiError> {
    let tenant = tenant_from(&headers)?;
    let position = state.mutate(&tenant, |q| q.prioritize(id))?;
    Ok(Json(PrioritizeResponse { id, position }))
}

/// Liveness probe.
#[utoipa::path(get, path = "/health", tag = "ops", responses((status = 200, description = "Alive", body = String)))]
pub async fn health() -> &'static str {
    "ok"
}
