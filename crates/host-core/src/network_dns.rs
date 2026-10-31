use serde_json::Value;

const DOH_SERVER_URL_MAX_LENGTH: usize = 2048;

/// Authoritative validation of the device-local Desktop DNS preference.
/// The Host never installs a resolver or changes the environment inherited by Bash.
pub fn validate_network_dns(settings: &Value) -> Result<(), String> {
    let Some(value) = settings.get("networkDns") else {
        return Ok(());
    };
    if value.is_null() {
        return Ok(());
    }
    let object = value.as_object().ok_or("networkDns must be an object")?;
    if let Some(mode) = object.get("mode").filter(|mode| !mode.is_null()) {
        if !matches!(mode.as_str(), Some("system" | "doh")) {
            return Err("networkDns.mode must be system or doh".into());
        }
    }
    if let Some(value) = object.get("serverUrl") {
        let raw = value
            .as_str()
            .ok_or("networkDns.serverUrl must be a string")?
            .trim();
        if raw.is_empty()
            || raw.encode_utf16().count() > DOH_SERVER_URL_MAX_LENGTH
            || raw
                .chars()
                .any(|ch| ch.is_whitespace() || ch.is_control() || matches!(ch, '{' | '}' | '\\'))
        {
            return Err("networkDns.serverUrl must be a bounded HTTPS POST endpoint".into());
        }
        let url = reqwest::Url::parse(raw).map_err(|_| "networkDns.serverUrl is invalid")?;
        if url.scheme() != "https"
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
        {
            return Err(
                "networkDns.serverUrl must use HTTPS without credentials or fragments".into(),
            );
        }
    }
    if let Some(value) = object.get("allowSystemFallback") {
        if !value.is_boolean() {
            return Err("networkDns.allowSystemFallback must be a boolean".into());
        }
    }
    Ok(())
}

/// Optional runtime flag; legacy and independent headless callers remain off.
pub fn desktop_dns_enabled(params: &Value) -> Result<bool, String> {
    match params.get("desktopDnsEnabled") {
        None => Ok(false),
        Some(Value::Bool(enabled)) => Ok(*enabled),
        Some(_) => Err("desktopDnsEnabled must be a boolean".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn runtime_dns_flag_is_optional_and_strictly_boolean() {
        assert!(!desktop_dns_enabled(&json!({})).unwrap());
        assert!(desktop_dns_enabled(&json!({"desktopDnsEnabled": true})).unwrap());
        assert!(!desktop_dns_enabled(&json!({"desktopDnsEnabled": false})).unwrap());
        for value in [json!(null), json!(1), json!("true"), json!({})] {
            assert!(desktop_dns_enabled(&json!({"desktopDnsEnabled": value})).is_err());
        }
    }

    #[test]
    fn disabled_default_and_explicit_private_https_resolver_are_valid() {
        for value in [
            json!({}),
            json!({"networkDns": null}),
            json!({"networkDns": {"mode": "system"}}),
            json!({"networkDns": {"mode": "doh"}}),
            json!({"networkDns": {
                "mode": "system",
                "serverUrl": " https://192.168.1.2/dns-query ",
                "allowSystemFallback": true
            }}),
        ] {
            assert!(validate_network_dns(&value).is_ok());
        }
    }

    #[test]
    fn rejects_insecure_malformed_or_ambiguous_dns_settings() {
        for value in [
            json!(true),
            json!([]),
            json!("doh"),
            json!({"mode": "unknown"}),
            json!({"mode": 1}),
            json!({"serverUrl": 123}),
            json!({"serverUrl": "http://resolver.example/dns-query"}),
            json!({"serverUrl": "https://user:secret@resolver.example/dns-query"}),
            json!({"serverUrl": "https://resolver.example/dns-query#"}),
            json!({"serverUrl": "https://resolver.example/dns query"}),
            json!({"serverUrl": "https://resolver.example/{?dns}"}),
            json!({"serverUrl": "https://resolver.example/\\query"}),
            json!({"serverUrl": format!("https://resolver.example/{}", "a".repeat(2048))}),
            json!({"allowSystemFallback": "yes"}),
        ] {
            assert!(validate_network_dns(&json!({"networkDns": value})).is_err());
        }
    }
}
