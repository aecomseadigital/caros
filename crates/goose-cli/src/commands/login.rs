use anyhow::{anyhow, Result};
use goose::config::Config;
use serde_json::Value;
use std::time::{Duration, Instant};

const TENANT: &str = "16ed5ab4-2b59-4e40-806d-8a30bdc9cf26";
const CLIENT_ID: &str = "5284f3e5-40c4-43e3-92b2-512af17f64cc";
const SCOPE: &str = "api://ea4c58eb-9223-46bd-89cc-06bf4652f43c/.default offline_access";

/// Outcome of polling the Entra token endpoint during the device-code flow.
#[derive(Debug, PartialEq)]
enum PollResult {
    /// Keep polling — the user hasn't completed sign-in yet (RFC 8628).
    Pending,
    /// Sign-in succeeded; carries the token response JSON.
    Done(Value),
    /// Terminal failure; carries a human-readable description.
    Failed(String),
}

/// Classify one response from the device-code token endpoint.
fn classify_poll(is_success: bool, body: &Value) -> PollResult {
    if is_success {
        return PollResult::Done(body.clone());
    }
    match body["error"].as_str().unwrap_or_default() {
        "authorization_pending" | "slow_down" => PollResult::Pending,
        other => {
            let desc = body["error_description"].as_str().unwrap_or(other);
            PollResult::Failed(desc.to_string())
        }
    }
}

/// Sign in to Caros via the Microsoft Entra device-code flow and store the
/// resulting token so the `caros` provider can call the gateway.
pub async fn handle_login() -> Result<()> {
    let client = reqwest::Client::new();

    let device: Value = client
        .post(format!(
            "https://login.microsoftonline.com/{TENANT}/oauth2/v2.0/devicecode"
        ))
        .form(&[("client_id", CLIENT_ID), ("scope", SCOPE)])
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;

    let device_code = device["device_code"]
        .as_str()
        .ok_or_else(|| anyhow!("device authorization response missing device_code"))?
        .to_string();
    let interval = device["interval"].as_u64().unwrap_or(5);
    let expires_in = device["expires_in"].as_u64().unwrap_or(900);

    if let Some(message) = device["message"].as_str() {
        println!("\n{message}\n");
    }

    let token_url = format!("https://login.microsoftonline.com/{TENANT}/oauth2/v2.0/token");
    let deadline = Instant::now() + Duration::from_secs(expires_in);

    let token = loop {
        if Instant::now() >= deadline {
            return Err(anyhow!("device code expired before sign-in completed"));
        }
        tokio::time::sleep(Duration::from_secs(interval + 1)).await;

        let resp = client
            .post(&token_url)
            .form(&[
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                ("client_id", CLIENT_ID),
                ("device_code", device_code.as_str()),
            ])
            .send()
            .await?;

        let is_success = resp.status().is_success();
        let body: Value = resp.json().await.unwrap_or(Value::Null);
        match classify_poll(is_success, &body) {
            PollResult::Pending => continue,
            PollResult::Done(token) => break token,
            PollResult::Failed(desc) => return Err(anyhow!("sign-in failed: {desc}")),
        }
    };

    let access_token = token["access_token"]
        .as_str()
        .ok_or_else(|| anyhow!("token response missing access_token"))?;

    let config = Config::global();
    config.set_secret("CAROS_TOKEN", &access_token.to_string())?;
    if let Some(refresh) = token["refresh_token"].as_str() {
        config.set_secret("CAROS_REFRESH_TOKEN", &refresh.to_string())?;
    }
    // Absolute expiry (unix secs) so the provider can refresh ahead of the ~1h TTL.
    if let Some(expires_in) = token["expires_in"].as_u64() {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        config.set_param("CAROS_TOKEN_EXPIRY", now + expires_in)?;
    }
    config.set_param("GOOSE_PROVIDER", "caros")?;
    config.set_param("GOOSE_MODEL", "caros-auto")?;

    println!("Signed in to Caros. Provider set to 'caros' (model 'caros-auto').");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn poll_success_returns_token() {
        let body = json!({"access_token": "tok", "refresh_token": "ref"});
        assert_eq!(classify_poll(true, &body), PollResult::Done(body));
    }

    #[test]
    fn poll_authorization_pending_keeps_polling() {
        let body = json!({"error": "authorization_pending"});
        assert_eq!(classify_poll(false, &body), PollResult::Pending);
    }

    #[test]
    fn poll_slow_down_keeps_polling() {
        let body = json!({"error": "slow_down"});
        assert_eq!(classify_poll(false, &body), PollResult::Pending);
    }

    #[test]
    fn poll_terminal_error_uses_description() {
        let body = json!({"error": "expired_token", "error_description": "device code expired"});
        assert_eq!(
            classify_poll(false, &body),
            PollResult::Failed("device code expired".to_string())
        );
    }

    #[test]
    fn poll_terminal_error_without_description_falls_back_to_code() {
        let body = json!({"error": "access_denied"});
        assert_eq!(
            classify_poll(false, &body),
            PollResult::Failed("access_denied".to_string())
        );
    }

    #[test]
    fn scope_requests_offline_access_for_refresh_token() {
        assert!(
            SCOPE.contains("offline_access"),
            "offline_access is required for Entra to return a refresh token"
        );
    }
}
