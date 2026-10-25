//! OpenAPI document served at `/api-docs/openapi.json` and rendered at `/swagger-ui`.

use utoipa::{
    openapi::security::{ApiKey, ApiKeyValue, SecurityScheme},
    Modify, OpenApi,
};

use super::handlers::{self, PrioritizeResponse};
use crate::{
    domain::{EnqueueRequest, EnqueueResponse, Priority},
    error::ErrorBody,
    state::Job,
};

#[derive(OpenApi)]
#[openapi(
    info(
        title = "Queue Engine API",
        description = "Real-time queue & resource allocation engine.\n\nLive updates are pushed as full queue snapshots over WebSocket at `/ws/queue?tenant=<id>` (not representable in OpenAPI)."
    ),
    paths(handlers::enqueue, handlers::cancel, handlers::prioritize, handlers::health),
    components(schemas(EnqueueRequest<Job>, EnqueueResponse, Priority, ErrorBody, PrioritizeResponse)),
    modifiers(&ApiKeyAuth)
)]
pub struct ApiDoc;

struct ApiKeyAuth;

impl Modify for ApiKeyAuth {
    fn modify(&self, openapi: &mut utoipa::openapi::OpenApi) {
        openapi.components.get_or_insert_with(Default::default).add_security_scheme(
            "api_key",
            SecurityScheme::ApiKey(ApiKey::Header(ApiKeyValue::new("x-api-key"))),
        );
    }
}
