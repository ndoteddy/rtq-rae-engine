//! API error type and its HTTP mapping.

use axum::{http::StatusCode, response::{IntoResponse, Response}, Json};
use serde::Serialize;
use utoipa::ToSchema;

use crate::domain::QueueError;

/// JSON error envelope returned by every failing endpoint.
#[derive(Serialize, ToSchema)]
pub struct ErrorBody {
    pub error: String,
}

#[derive(Debug)]
pub enum ApiError {
    Unauthorized,
    Invalid(&'static str),
    Queue(QueueError),
}

impl From<QueueError> for ApiError {
    fn from(e: QueueError) -> Self {
        ApiError::Queue(e)
    }
}

impl ApiError {
    pub fn status(&self) -> StatusCode {
        match self {
            ApiError::Unauthorized => StatusCode::UNAUTHORIZED,
            ApiError::Invalid(_) => StatusCode::BAD_REQUEST,
            ApiError::Queue(QueueError::NotFound(_)) => StatusCode::NOT_FOUND,
            ApiError::Queue(QueueError::NotCancellable(_)) => StatusCode::CONFLICT,
        }
    }

    fn message(&self) -> String {
        match self {
            ApiError::Unauthorized => "missing or invalid x-api-key".to_owned(),
            ApiError::Invalid(m) => (*m).to_owned(),
            ApiError::Queue(e) => e.to_string(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status(), Json(ErrorBody { error: self.message() })).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn maps_errors_to_status_codes() {
        let id = Uuid::new_v4();
        assert_eq!(ApiError::Unauthorized.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(ApiError::Invalid("x").status(), StatusCode::BAD_REQUEST);
        assert_eq!(ApiError::from(QueueError::NotFound(id)).status(), StatusCode::NOT_FOUND);
        assert_eq!(ApiError::from(QueueError::NotCancellable(id)).status(), StatusCode::CONFLICT);
    }
}
