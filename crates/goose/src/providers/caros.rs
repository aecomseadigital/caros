use anyhow::Result;
use async_trait::async_trait;

use super::api_client::{ApiClient, AuthMethod, AuthProvider};
use super::base::{ConfigKey, ProviderDef, ProviderMetadata};
use super::openai_compatible::OpenAiCompatibleProvider;
use futures::future::BoxFuture;

const CAROS_PROVIDER_NAME: &str = "caros";
pub const CAROS_DEFAULT_MODEL: &str = "caros-auto";
pub const CAROS_DOC_URL: &str = "https://apim-caros.azure-api.net";
const CAROS_DEFAULT_GATEWAY: &str = "https://apim-caros.azure-api.net/caros/v1";
pub const CAROS_KNOWN_MODELS: &[&str] = &["caros-auto"];

pub struct CarosProvider;

/// Attaches the Entra bearer token (acquired by `caros login` or pushed by the
/// desktop MSAL sign-in) to every gateway request. APIM validates the token and
/// the `hackathon` app role; the gateway classifies the request and routes it.
struct CarosAuthProvider {
    token: String,
}

#[async_trait]
impl AuthProvider for CarosAuthProvider {
    async fn get_auth_header(&self) -> Result<(String, String)> {
        Ok((
            "Authorization".to_string(),
            format!("Bearer {}", self.token),
        ))
    }
}

impl goose_providers::base::ProviderDescriptor for CarosProvider {
    fn metadata() -> ProviderMetadata {
        ProviderMetadata::new(
            CAROS_PROVIDER_NAME,
            "Caros",
            "Azure OpenAI via the Caros APIM gateway: Microsoft Entra sign-in, access gated by the hackathon app role, server-side model routing, and per-user usage logging",
            CAROS_DEFAULT_MODEL,
            CAROS_KNOWN_MODELS.to_vec(),
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

            let auth_provider = CarosAuthProvider { token };
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

    #[tokio::test]
    async fn test_auth_header_is_bearer() {
        let provider = CarosAuthProvider {
            token: "abc123".to_string(),
        };
        let (header, value) = provider.get_auth_header().await.unwrap();
        assert_eq!(header, "Authorization");
        assert_eq!(value, "Bearer abc123");
    }
}
