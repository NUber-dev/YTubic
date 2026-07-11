// Diagnostic probe: replicate lastfm.rs::get_token byte-for-byte on the same
// reqwest build the app ships, to chase the "error 10 from the app but not
// from curl" mystery. Run: cargo run --example lastfm_probe [-- <n_runs>]
use std::collections::BTreeMap;

fn json_string_field(json: &str, field: &str) -> Option<String> {
    let needle = format!("\"{field}\"");
    let start = json.find(&needle)? + needle.len();
    let after_colon = json[start..].find(':')? + start + 1;
    let rest = &json[after_colon..];
    let open = rest.find('"')? + 1;
    let close = rest[open..].find('"')? + open;
    Some(rest[open..close].to_string())
}

fn sign(params: &BTreeMap<String, String>, secret: &str) -> String {
    let mut buf = String::new();
    for (k, v) in params {
        buf.push_str(k);
        buf.push_str(v);
    }
    buf.push_str(secret);
    format!("{:x}", md5::compute(buf.as_bytes()))
}

/// Report shape problems in a compiled-in credential without echoing it.
fn diagnose(name: &str, v: &str) {
    let bom = v.starts_with('\u{feff}');
    let hex32 = v.len() == 32 && v.bytes().all(|b| b.is_ascii_hexdigit());
    println!("{name}: len={} bom={bom} hex32={hex32}", v.len());
}

#[tokio::main]
async fn main() {
    // Prefer the consts baked in by build.rs (exactly what a release binary
    // uses); fall back to the local config for ad-hoc runs.
    let mut key = option_env!("YTUBIC_LASTFM_API_KEY").unwrap_or("").to_string();
    let mut secret = option_env!("YTUBIC_LASTFM_API_SECRET").unwrap_or("").to_string();
    if key.is_empty() || secret.is_empty() {
        let raw = std::fs::read_to_string("lastfm_config.json").expect("lastfm_config.json");
        key = json_string_field(&raw, "api_key").expect("api_key");
        secret = json_string_field(&raw, "api_secret").expect("api_secret");
        println!("source: lastfm_config.json (no compiled consts)");
    } else {
        println!("source: compiled consts (build.rs injection)");
    }
    diagnose("api_key", &key);
    diagnose("api_secret", &secret);
    let runs: usize = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(3);

    let client = reqwest::Client::new();
    for i in 1..=runs {
        let mut params = BTreeMap::new();
        params.insert("method".to_string(), "auth.getToken".to_string());
        params.insert("api_key".to_string(), key.clone());
        let sig = sign(&params, &secret);
        params.insert("api_sig".to_string(), sig);
        params.insert("format".to_string(), "json".to_string());

        let resp = client
            .get("https://ws.audioscrobbler.com/2.0/")
            .query(&params)
            .send()
            .await;
        match resp {
            Ok(r) => {
                let status = r.status();
                let version = format!("{:?}", r.version());
                let body = r.text().await.unwrap_or_else(|e| format!("<read error: {e}>"));
                println!("run {i}: {status} {version} {body}");
            }
            Err(e) => println!("run {i}: network error: {e}"),
        }
    }
}
