fn main() {
    inject_lastfm_credentials();
    tauri_build::build()
}

/// Make the Last.fm API key + shared secret available to `option_env!` in
/// src/lastfm.rs WITHOUT committing them to source. Precedence: existing env
/// vars (set as GitHub Actions secrets for release builds), then a gitignored
/// `lastfm_config.json` next to this file (for local dev). If neither provides a
/// value the env var is left unset and the feature simply stays unconfigured.
fn inject_lastfm_credentials() {
    println!("cargo:rerun-if-env-changed=YTUBIC_LASTFM_API_KEY");
    println!("cargo:rerun-if-env-changed=YTUBIC_LASTFM_API_SECRET");
    println!("cargo:rerun-if-changed=lastfm_config.json");

    let mut key = clean_credential(std::env::var("YTUBIC_LASTFM_API_KEY").unwrap_or_default());
    let mut secret = clean_credential(std::env::var("YTUBIC_LASTFM_API_SECRET").unwrap_or_default());

    if key.is_empty() || secret.is_empty() {
        if let Ok(raw) = std::fs::read_to_string("lastfm_config.json") {
            if key.is_empty() {
                if let Some(v) = json_string_field(&raw, "api_key") {
                    key = clean_credential(v);
                }
            }
            if secret.is_empty() {
                if let Some(v) = json_string_field(&raw, "api_secret") {
                    secret = clean_credential(v);
                }
            }
        }
    }

    assert_credential_shape("YTUBIC_LASTFM_API_KEY", &key);
    assert_credential_shape("YTUBIC_LASTFM_API_SECRET", &secret);

    if !key.is_empty() {
        println!("cargo:rustc-env=YTUBIC_LASTFM_API_KEY={key}");
    }
    if !secret.is_empty() {
        println!("cargo:rustc-env=YTUBIC_LASTFM_API_SECRET={secret}");
    }
}

/// Strip a UTF-8 BOM plus surrounding whitespace from a credential value.
/// Piping a value into `gh secret set` from Windows PowerShell 5.1 prepends a
/// BOM to the stored secret; v0.3.1 shipped with a "\u{FEFF}<key>" const that
/// Last.fm rejected as error 10 (Invalid API key). Cargo's directive parsing
/// already drops trailing CR/LF, but a leading BOM sails through untouched.
fn clean_credential(v: String) -> String {
    v.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
        .to_string()
}

/// Fail the build loudly when a credential is present but malformed, instead
/// of silently shipping a release whose Last.fm integration can never work.
/// Both the Last.fm API key and shared secret are exactly 32 hex chars; empty
/// stays allowed (the feature just reports itself unconfigured).
fn assert_credential_shape(name: &str, v: &str) {
    if v.is_empty() {
        return;
    }
    let hex32 = v.len() == 32 && v.bytes().all(|b| b.is_ascii_hexdigit());
    assert!(
        hex32,
        "{name} looks corrupted ({} bytes, expected 32 hex chars). \
         Re-set the GitHub secret with `gh secret set {name} --body <value>`; \
         never pipe the value in (PowerShell prepends a UTF-8 BOM).",
        v.len()
    );
}

/// Pull a top-level string field out of a flat JSON object. Deliberately tiny
/// (the config is two string fields) to avoid a serde_json build-dependency.
fn json_string_field(json: &str, field: &str) -> Option<String> {
    let needle = format!("\"{field}\"");
    let start = json.find(&needle)? + needle.len();
    let after_colon = json[start..].find(':')? + start + 1;
    let rest = &json[after_colon..];
    let open = rest.find('"')? + 1;
    let close = rest[open..].find('"')? + open;
    Some(rest[open..close].to_string())
}
