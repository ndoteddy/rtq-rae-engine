//! HTTP adapter: builds the router. Handlers hold no business logic; they delegate to `AppState`.

mod docs;
mod handlers;
mod middleware;
mod ws;

use axum::{
    middleware::from_fn_with_state,
    routing::{get, post},
    Router,
};
use tower_http::{cors::{Any, CorsLayer}, trace::TraceLayer};
use utoipa::OpenApi;
use utoipa_swagger_ui::SwaggerUi;

use crate::state::AppState;

pub use docs::ApiDoc;

pub fn router(state: AppState) -> Router {
    let protected = Router::new()
        .route("/api/enqueue", post(handlers::enqueue))
        .route("/api/items/:id/cancel", post(handlers::cancel))
        .route("/api/items/:id/prioritize", post(handlers::prioritize))
        .route_layer(from_fn_with_state(state.clone(), middleware::require_api_key));

    Router::new()
        .merge(protected)
        .route("/ws/queue", get(ws::ws_queue))
        .route("/health", get(handlers::health))
        .merge(SwaggerUi::new("/swagger-ui").url("/api-docs/openapi.json", ApiDoc::openapi()))
        .with_state(state)
        // Outermost so CORS preflight (OPTIONS) is answered before the API-key check.
        // Tighten `allow_origin` to your kiosk/display origins in production.
        .layer(CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any))
        .layer(TraceLayer::new_for_http())
}
