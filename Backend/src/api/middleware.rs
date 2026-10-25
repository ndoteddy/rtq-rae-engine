//! Cross-cutting request guards: API key and tenant resolution.

use axum::{
    extract::{Request, State},
    http::HeaderMap,
    middleware::Next,
    response::Response,
};

use crate::{config::DEFAULT_TENANT, error::ApiError, state::AppState};

/// Shared guard for kiosks and headless callers (Shopify webhooks, ERPs, POS): same endpoint, same key check.
pub async fn require_api_key(State(state): State<AppState>, req: Request, next: Next) -> Result<Response, ApiError> {
    if state.api_keys.is_empty() {
        return Ok(next.run(req).await);
    }
    let authorized = req
        .headers()
        .get("x-api-key")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|key| state.api_keys.contains(key));
    if authorized { Ok(next.run(req).await) } else { Err(ApiError::Unauthorized) }
}

/// Tenant comes from the `x-tenant-id` header; restricted charset keeps it safe for logs and map keys.
pub fn tenant_from(headers: &HeaderMap) -> Result<String, ApiError> {
    let tenant = headers.get("x-tenant-id").and_then(|v| v.to_str().ok()).unwrap_or(DEFAULT_TENANT);
    let valid = !tenant.is_empty()
        && tenant.len() <= 64
        && tenant.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if valid { Ok(tenant.to_owned()) } else { Err(ApiError::Invalid("invalid x-tenant-id")) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers(tenant: Option<&str>) -> HeaderMap {
        let mut h = HeaderMap::new();
        if let Some(t) = tenant {
            h.insert("x-tenant-id", HeaderValue::from_str(t).unwrap());
        }
        h
    }

    #[test]
    fn defaults_when_header_missing() {
        assert_eq!(tenant_from(&headers(None)).unwrap(), "default");
    }

    #[test]
    fn accepts_valid_tenant() {
        assert_eq!(tenant_from(&headers(Some("shop_1-A"))).unwrap(), "shop_1-A");
    }

    #[test]
    fn rejects_bad_tenants() {
        for bad in ["", "has space", "a/b", "../x", &"x".repeat(65)] {
            assert!(tenant_from(&headers(Some(bad))).is_err(), "{bad:?} should be rejected");
        }
    }
}
