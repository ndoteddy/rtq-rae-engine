//! In-process HTTP tests: the real router, no sockets, no workers (deterministic).

use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use http_body_util::BodyExt;
use queue_engine::{api, config::parse_api_keys, state::{AppState, Shared}};
use serde_json::{json, Value};
use tower::ServiceExt;

fn app(keys: &str) -> (Router, AppState) {
    let state = Shared::new(parse_api_keys(keys));
    (api::router(state.clone()), state)
}

async fn send(app: &Router, method: &str, uri: &str, headers: &[(&str, &str)], body: Option<Value>) -> (StatusCode, Value) {
    let mut b = Request::builder().method(method).uri(uri);
    for (k, v) in headers {
        b = b.header(*k, *v);
    }
    let req = match body {
        Some(v) => b.header("content-type", "application/json").body(Body::from(v.to_string())).unwrap(),
        None => b.body(Body::empty()).unwrap(),
    };
    let res = app.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    let json = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, json)
}

#[tokio::test]
async fn health_is_ok() {
    let (app, _) = app("");
    let res = app.oneshot(Request::get("/health").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
}

#[tokio::test]
async fn enqueue_returns_201_with_id_and_position() {
    let (app, _) = app("");
    let (s, v) = send(&app, "POST", "/api/enqueue", &[], Some(json!({"label": "A", "payload": {}}))).await;
    assert_eq!(s, StatusCode::CREATED);
    assert_eq!(v["position"], 0);
    assert!(v["id"].is_string());
}

#[tokio::test]
async fn enqueue_rejects_blank_label_and_bad_tenant() {
    let (app, _) = app("");
    let (s, v) = send(&app, "POST", "/api/enqueue", &[], Some(json!({"label": "  ", "payload": {}}))).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert!(v["error"].is_string());

    let (s, _) = send(&app, "POST", "/api/enqueue", &[("x-tenant-id", "bad tenant!")], Some(json!({"label": "A", "payload": {}}))).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn api_key_is_enforced_when_configured() {
    let (app, _) = app("secret");
    let body = json!({"label": "A", "payload": {}});
    let (s, _) = send(&app, "POST", "/api/enqueue", &[], Some(body.clone())).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    let (s, _) = send(&app, "POST", "/api/enqueue", &[("x-api-key", "wrong")], Some(body.clone())).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    let (s, _) = send(&app, "POST", "/api/enqueue", &[("x-api-key", "secret")], Some(body)).await;
    assert_eq!(s, StatusCode::CREATED);
}

#[tokio::test]
async fn cancel_flow_204_then_404() {
    let (app, _) = app("");
    let (_, v) = send(&app, "POST", "/api/enqueue", &[], Some(json!({"label": "A", "payload": {}}))).await;
    let uri = format!("/api/items/{}/cancel", v["id"].as_str().unwrap());
    assert_eq!(send(&app, "POST", &uri, &[], None).await.0, StatusCode::NO_CONTENT);
    assert_eq!(send(&app, "POST", &uri, &[], None).await.0, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn cancel_processing_item_is_409() {
    let (app, state) = app("");
    let (_, v) = send(&app, "POST", "/api/enqueue", &[], Some(json!({"label": "A", "payload": {}}))).await;
    state.claim_next("test-worker").expect("claim");
    let uri = format!("/api/items/{}/cancel", v["id"].as_str().unwrap());
    assert_eq!(send(&app, "POST", &uri, &[], None).await.0, StatusCode::CONFLICT);
}

#[tokio::test]
async fn prioritize_moves_item_to_front() {
    let (app, _) = app("");
    send(&app, "POST", "/api/enqueue", &[], Some(json!({"label": "A", "payload": {}}))).await;
    let (_, b) = send(&app, "POST", "/api/enqueue", &[], Some(json!({"label": "B", "payload": {}}))).await;
    let uri = format!("/api/items/{}/prioritize", b["id"].as_str().unwrap());
    let (s, v) = send(&app, "POST", &uri, &[], None).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["position"], 0);
}

#[tokio::test]
async fn tenants_do_not_see_each_other() {
    let (app, state) = app("");
    send(&app, "POST", "/api/enqueue", &[("x-tenant-id", "shop-a")], Some(json!({"label": "A", "payload": {}}))).await;
    assert!(state.snapshot_json("shop-a").contains("\"label\":\"A\""));
    assert!(!state.snapshot_json("shop-b").contains("\"label\":\"A\""));
}

#[tokio::test]
async fn openapi_spec_and_swagger_ui_are_served() {
    let (app, _) = app("");
    let (s, spec) = send(&app, "GET", "/api-docs/openapi.json", &[], None).await;
    assert_eq!(s, StatusCode::OK);
    for path in ["/api/enqueue", "/api/items/{id}/cancel", "/api/items/{id}/prioritize", "/health"] {
        assert!(spec["paths"].get(path).is_some(), "spec is missing {path}");
    }
    assert!(spec["components"]["securitySchemes"]["api_key"].is_object());

    let res = app.oneshot(Request::get("/swagger-ui/").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
}
