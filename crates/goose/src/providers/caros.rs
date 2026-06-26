use anyhow::Result;
use async_trait::async_trait;
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;

use super::api_client::{ApiClient, AuthMethod, AuthProvider};
use super::base::{ConfigKey, ProviderDef, ProviderMetadata};
use super::openai_compatible::OpenAiCompatibleProvider;
use goose_providers::base::ModelInfo;
use futures::future::BoxFuture;

const CAROS_PROVIDER_NAME: &str = "caros";
pub const CAROS_DEFAULT_MODEL: &str = "gpt-5.4-auto";
pub const CAROS_DOC_URL: &str = "https://apim-caros.azure-api.net";
const CAROS_DEFAULT_GATEWAY: &str = "https://apim-caros.azure-api.net/caros/v1";
pub const CAROS_KNOWN_MODELS: &[&str] = &["gpt-5.4-auto"];

const ENTRA_TENANT: &str = "16ed5ab4-2b59-4e40-806d-8a30bdc9cf26";
const ENTRA_CLIENT_ID: &str = "5284f3e5-40c4-43e3-92b2-512af17f64cc";
const ENTRA_SCOPE: &str = "api://ea4c58eb-9223-46bd-89cc-06bf4652f43c/.default offline_access";
/// Refresh this many seconds before the access token actually expires.
const REFRESH_SKEW_SECS: u64 = 300;

pub struct CarosProvider;

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn entra_token_url() -> String {
    format!("https://login.microsoftonline.com/{ENTRA_TENANT}/oauth2/v2.0/token")
}

/// True when the access token is expired or within the refresh skew window.
/// Unknown expiry (`None`, e.g. an older login) means "don't proactively refresh".
fn should_refresh(expiry: Option<u64>, now: u64, skew: u64) -> bool {
    matches!(expiry, Some(exp) if now + skew >= exp)
}

#[derive(Debug)]
struct RefreshedToken {
    access: String,
    expiry: Option<u64>,
    refresh: Option<String>,
}

/// Exchange a refresh token for a fresh access token at the Entra token endpoint.
/// Pure HTTP — no persistence, so it can be unit-tested against a mock server.
async fn exchange_refresh_token(
    token_url: &str,
    client_id: &str,
    scope: &str,
    refresh_token: &str,
) -> Result<RefreshedToken> {
    let resp = reqwest::Client::new()
        .post(token_url)
        .form(&[
            ("grant_type", "refresh_token"),
            ("client_id", client_id),
            ("scope", scope),
            ("refresh_token", refresh_token),
        ])
        .send()
        .await?;

    if !resp.status().is_success() {
        let body: Value = resp.json().await.unwrap_or(Value::Null);
        let desc = body["error_description"]
            .as_str()
            .or_else(|| body["error"].as_str())
            .unwrap_or("unknown error")
            .to_string();
        return Err(anyhow::anyhow!("token refresh failed: {desc}"));
    }

    let body: Value = resp.json().await?;
    let access = body["access_token"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("refresh response missing access_token"))?
        .to_string();
    Ok(RefreshedToken {
        access,
        expiry: body["expires_in"].as_u64().map(|s| now_unix() + s),
        refresh: body["refresh_token"].as_str().map(str::to_string),
    })
}

fn persist_refreshed(token: &RefreshedToken) {
    let config = crate::config::Config::global();
    let _ = config.set_secret("CAROS_TOKEN", &token.access);
    if let Some(exp) = token.expiry {
        let _ = config.set_param("CAROS_TOKEN_EXPIRY", exp);
    }
    if let Some(refresh) = &token.refresh {
        let _ = config.set_secret("CAROS_REFRESH_TOKEN", refresh);
    }
}

struct TokenState {
    access: String,
    expiry: Option<u64>,
    refresh: Option<String>,
}

/// Attaches the Entra bearer token (acquired by `caros login` or pushed by the
/// desktop MSAL sign-in) to every gateway request, refreshing it ahead of the
/// ~1h expiry when a refresh token is available. APIM validates the token and the
/// `hackathon` app role; the gateway classifies the request and routes it.
struct CarosAuthProvider {
    state: Mutex<TokenState>,
}

#[async_trait]
impl AuthProvider for CarosAuthProvider {
    async fn get_auth_header(&self) -> Result<(String, String)> {
        let mut state = self.state.lock().await;
        if should_refresh(state.expiry, now_unix(), REFRESH_SKEW_SECS) {
            if let Some(refresh) = state.refresh.clone() {
                match exchange_refresh_token(
                    &entra_token_url(),
                    ENTRA_CLIENT_ID,
                    ENTRA_SCOPE,
                    &refresh,
                )
                .await
                {
                    Ok(refreshed) => {
                        persist_refreshed(&refreshed);
                        state.access = refreshed.access;
                        state.expiry = refreshed.expiry;
                        if refreshed.refresh.is_some() {
                            state.refresh = refreshed.refresh; // Entra rotates refresh tokens
                        }
                    }
                    Err(e) => {
                        tracing::warn!("Caros token refresh failed, using existing token: {e}");
                    }
                }
            }
        }
        Ok((
            "Authorization".to_string(),
            format!("Bearer {}", state.access),
        ))
    }
}

impl goose_providers::base::ProviderDescriptor for CarosProvider {
    fn metadata() -> ProviderMetadata {
        ProviderMetadata::with_models(
            CAROS_PROVIDER_NAME,
            // Internal id stays `caros`; this is the user-facing display label only.
            "aecom-asia-digital-dev",
            "Azure OpenAI via the Caros APIM gateway: Microsoft Entra sign-in, access gated by the hackathon app role, server-side model routing, and per-user usage logging",
            CAROS_DEFAULT_MODEL,
            // The gateway routes to gpt-5.4-mini/nano, both 400k input context, so
            // advertise 400k (the desktop reads context from provider metadata).
            CAROS_KNOWN_MODELS
                .iter()
                .map(|&m| ModelInfo::new(m, 400_000))
                .collect(),
            CAROS_DOC_URL,
            vec![
                ConfigKey::new(
                    "CAROS_GATEWAY_URL",
                    false,
                    false,
                    Some(CAROS_DEFAULT_GATEWAY),
                    false,
                ),
                ConfigKey::new("CAROS_TOKEN", true, true, None, true),
            ],
        )
    }
}

impl ProviderDef for CarosProvider {
    type Provider = OpenAiCompatibleProvider;

    fn from_env(
        _extensions: Vec<crate::config::ExtensionConfig>,
        tls_config: Option<crate::providers::api_client::TlsConfig>,
    ) -> BoxFuture<'static, Result<Self::Provider>> {
        Box::pin(async move {
            let config = crate::config::Config::global();
            let gateway: String = config
                .get_param("CAROS_GATEWAY_URL")
                .unwrap_or_else(|_| CAROS_DEFAULT_GATEWAY.to_string());
            let token: String = config
                .get_secret("CAROS_TOKEN")
                .ok()
                .filter(|t: &String| !t.is_empty())
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "Not signed in to Caros — run `caros login` (or sign in from the desktop app)"
                    )
                })?;

            let refresh: Option<String> = config
                .get_secret("CAROS_REFRESH_TOKEN")
                .ok()
                .filter(|t: &String| !t.is_empty());
            let expiry: Option<u64> = config.get_param("CAROS_TOKEN_EXPIRY").ok();

            let auth_provider = CarosAuthProvider {
                state: Mutex::new(TokenState {
                    access: token,
                    expiry,
                    refresh,
                }),
            };
            let host = gateway.trim_end_matches('/').to_string();
            let api_client = ApiClient::new_with_tls(
                host,
                AuthMethod::Custom(Box::new(auth_provider)),
                tls_config,
            )?;

            Ok(OpenAiCompatibleProvider::new(
                CAROS_PROVIDER_NAME.to_string(),
                api_client,
                String::new(),
            ))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use goose_providers::base::ProviderDescriptor as _;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn test_auth_header_is_bearer() {
        let provider = CarosAuthProvider {
            state: Mutex::new(TokenState {
                access: "abc123".to_string(),
                expiry: None, // unknown expiry -> never proactively refreshes (no network)
                refresh: None,
            }),
        };
        let (header, value) = provider.get_auth_header().await.unwrap();
        assert_eq!(header, "Authorization");
        assert_eq!(value, "Bearer abc123");
    }

    #[test]
    fn test_should_refresh_window() {
        let now = 1_000_000;
        assert!(!should_refresh(None, now, REFRESH_SKEW_SECS)); // unknown -> no refresh
        assert!(!should_refresh(Some(now + 1000), now, REFRESH_SKEW_SECS)); // far from expiry
        assert!(should_refresh(Some(now + 100), now, REFRESH_SKEW_SECS)); // within skew
        assert!(should_refresh(Some(now), now, REFRESH_SKEW_SECS)); // already expired
    }

    #[tokio::test]
    async fn test_exchange_refresh_token_success() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "new-access",
                "expires_in": 3600,
                "refresh_token": "rotated-refresh"
            })))
            .mount(&server)
            .await;

        let url = format!("{}/token", server.uri());
        let r = exchange_refresh_token(&url, "client", "scope", "old-refresh")
            .await
            .unwrap();
        assert_eq!(r.access, "new-access");
        assert_eq!(r.refresh.as_deref(), Some("rotated-refresh"));
        assert!(r.expiry.unwrap() > now_unix());
    }

    #[tokio::test]
    async fn test_exchange_refresh_token_error_surfaces_description() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(ResponseTemplate::new(400).set_body_json(serde_json::json!({
                "error": "invalid_grant",
                "error_description": "refresh token expired"
            })))
            .mount(&server)
            .await;

        let url = format!("{}/token", server.uri());
        let err = exchange_refresh_token(&url, "c", "s", "r")
            .await
            .unwrap_err();
        assert!(err.to_string().contains("refresh token expired"));
    }

    #[test]
    fn test_metadata_contract() {
        let meta = CarosProvider::metadata();
        assert_eq!(meta.name, CAROS_PROVIDER_NAME);
        assert_eq!(meta.default_model, CAROS_DEFAULT_MODEL);

        // The token must be marked secret + required so it is keyring-backed and
        // never written to plaintext config (CAROS_SECURITY_REVIEW S3.1).
        let token_key = meta
            .config_keys
            .iter()
            .find(|k| k.name == "CAROS_TOKEN")
            .expect("CAROS_TOKEN config key must exist");
        assert!(token_key.secret, "CAROS_TOKEN must be a secret");
        assert!(token_key.required, "CAROS_TOKEN must be required");

        // The gateway URL is defaulted to the APIM https endpoint (S4.1).
        let gateway_key = meta
            .config_keys
            .iter()
            .find(|k| k.name == "CAROS_GATEWAY_URL")
            .expect("CAROS_GATEWAY_URL config key must exist");
        assert_eq!(gateway_key.default.as_deref(), Some(CAROS_DEFAULT_GATEWAY));
        assert!(
            CAROS_DEFAULT_GATEWAY.starts_with("https://"),
            "default gateway must be https to avoid leaking the bearer token"
        );
    }
}
