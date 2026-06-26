use anyhow::{anyhow, Result};
use goose::config::Config;
use serde_json::Value;
use std::time::{Duration, Instant};

const TENANT: &str = "16ed5ab4-2b59-4e40-806d-8a30bdc9cf26";
const CLIENT_ID: &str = "5284f3e5-40c4-43e3-92b2-512af17f64cc";
const SCOPE: &str = "api://ea4c58eb-9223-46bd-89cc-06bf4652f43c/.default offline_access";

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

        if resp.status().is_success() {
            break resp.json::<Value>().await?;
        }

        let err: Value = resp.json().await.unwrap_or(Value::Null);
        match err["error"].as_str().unwrap_or_default() {
            "authorization_pending" | "slow_down" => continue,
            other => {
                let desc = err["error_description"].as_str().unwrap_or(other);
                return Err(anyhow!("sign-in failed: {desc}"));
            }
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
    config.set_param("GOOSE_PROVIDER", "caros")?;
    config.set_param("GOOSE_MODEL", "caros-auto")?;

    println!("Signed in to Caros. Provider set to 'caros' (model 'caros-auto').");
    Ok(())
}
