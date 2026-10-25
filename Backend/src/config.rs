//! Runtime configuration, read once at startup.

use std::collections::HashSet;

pub const DEFAULT_TENANT: &str = "default";
pub const RESOURCE_WORKERS: usize = 2;

#[derive(Debug, Clone)]
pub struct Config {
    /// Accepted `x-api-key` values. Empty = open development mode.
    pub api_keys: HashSet<String>,
    pub bind_addr: String,
    pub workers: usize,
}

impl Config {
    /// `API_KEYS` (comma separated), `BIND_ADDR` (default `0.0.0.0:3000`).
    pub fn from_env() -> Self {
        Self {
            api_keys: parse_api_keys(&std::env::var("API_KEYS").unwrap_or_default()),
            bind_addr: std::env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:3000".to_owned()),
            workers: RESOURCE_WORKERS,
        }
    }
}

pub fn parse_api_keys(raw: &str) -> HashSet<String> {
    raw.split(',').map(str::trim).filter(|k| !k.is_empty()).map(str::to_owned).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_trims_and_skips_empty_keys() {
        let keys = parse_api_keys(" a, b ,,c ");
        assert_eq!(keys.len(), 3);
        assert!(keys.contains("a") && keys.contains("b") && keys.contains("c"));
    }

    #[test]
    fn empty_input_means_open_mode() {
        assert!(parse_api_keys("").is_empty());
    }
}
