use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

const DETAILS_URL: &str = "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/";
const CACHE_TTL_SECS: u64 = 60 * 60 * 12;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkshopInfo {
    pub title: String,
    pub preview_url: Option<String>,
    pub description: Option<String>,
    pub tags: Vec<String>,
    pub time_updated: u64,
    pub removed: bool,
    pub fetched_at: u64,
}

#[derive(Deserialize)]
struct Resp {
    response: RespInner,
}

#[derive(Deserialize)]
struct RespInner {
    #[serde(default)]
    publishedfiledetails: Vec<Detail>,
}

#[derive(Deserialize)]
struct Detail {
    publishedfileid: String,
    result: i32,
    #[serde(default)]
    title: String,
    preview_url: Option<String>,
    description: Option<String>,
    #[serde(default)]
    time_updated: u64,
    #[serde(default)]
    tags: Vec<Tag>,
}

#[derive(Deserialize)]
struct Tag {
    tag: String,
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn load_cache(path: &Path) -> HashMap<String, WorkshopInfo> {
    std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

pub async fn details(cache_path: &Path, ids: Vec<String>) -> Result<HashMap<String, WorkshopInfo>, String> {
    let mut cache = load_cache(cache_path);
    let stale: Vec<String> = ids
        .iter()
        .filter(|id| cache.get(*id).map_or(true, |c| now().saturating_sub(c.fetched_at) > CACHE_TTL_SECS))
        .cloned()
        .collect();

    let mut fetch_error = None;
    if !stale.is_empty() {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .map_err(|e| e.to_string())?;
        for chunk in stale.chunks(100) {
            let mut form = vec![("itemcount".to_string(), chunk.len().to_string())];
            for (i, id) in chunk.iter().enumerate() {
                form.push((format!("publishedfileids[{i}]"), id.clone()));
            }
            let resp = client.post(DETAILS_URL).form(&form).send().await;
            let parsed = match resp {
                Ok(r) => r.json::<Resp>().await.map_err(|e| e.to_string()),
                Err(e) => Err(e.to_string()),
            };
            match parsed {
                Ok(body) => {
                    for d in body.response.publishedfiledetails {
                        let removed = d.result != 1;
                        let previous = cache.get(&d.publishedfileid).cloned();
                        let info = WorkshopInfo {
                            title: if removed { previous.map(|p| p.title).unwrap_or_default() } else { d.title.trim().to_string() },
                            preview_url: d.preview_url,
                            description: d.description.map(|s| s.chars().take(4000).collect()),
                            tags: d.tags.into_iter().map(|t| t.tag).collect(),
                            time_updated: d.time_updated,
                            removed,
                            fetched_at: now(),
                        };
                        cache.insert(d.publishedfileid, info);
                    }
                }
                Err(e) => fetch_error = Some(e),
            }
        }
        if let Ok(json) = serde_json::to_vec(&cache) {
            if let Some(dir) = cache_path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::fs::write(cache_path, json);
        }
    }

    let out: HashMap<String, WorkshopInfo> = ids.iter().filter_map(|id| cache.get(id).map(|c| (id.clone(), c.clone()))).collect();
    match fetch_error {
        Some(e) if out.is_empty() => Err(e),
        _ => Ok(out),
    }
}

const PAGE_URL: &str = "https://steamcommunity.com/sharedfiles/filedetails/?id=";
const REQUIREMENTS_TTL_SECS: u64 = 60 * 60 * 24 * 7;
const PAGE_DELAY: std::time::Duration = std::time::Duration::from_millis(1500);

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Requirement {
    pub id: String,
    pub title: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CachedRequirements {
    items: Vec<Requirement>,
    fetched_at: u64,
}

fn decode_entities(s: &str) -> String {
    s.replace("&amp;", "&").replace("&quot;", "\"").replace("&#39;", "'").replace("&lt;", "<").replace("&gt;", ">")
}

pub fn parse_required(html: &str) -> Vec<Requirement> {
    let Some(start) = html.find("id=\"RequiredItems\"") else { return Vec::new() };
    let rest = &html[start..];
    let end = rest.find("<div class=\"panel\">").unwrap_or(rest.len().min(20_000));
    let block = &rest[..end];
    block
        .split("filedetails/?id=")
        .skip(1)
        .filter_map(|chunk| {
            let id: String = chunk.chars().take_while(|c| c.is_ascii_digit()).collect();
            if id.is_empty() {
                return None;
            }
            let title = chunk
                .split_once("class=\"requiredItem\">")
                .and_then(|(_, t)| t.split('<').next())
                .map(|t| decode_entities(t.trim()))
                .unwrap_or_default();
            Some(Requirement { id, title })
        })
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequirementBatch {
    pub items: HashMap<String, Vec<Requirement>>,
    pub rate_limited: bool,
}

enum PageError {
    RateLimited,
    Other,
}

async fn fetch_page(client: &reqwest::Client, id: &str) -> Result<String, PageError> {
    let resp = client.get(format!("{PAGE_URL}{id}")).send().await.map_err(|_| PageError::Other)?;
    match resp.status().as_u16() {
        403 | 429 => Err(PageError::RateLimited),
        s if s >= 400 => Err(PageError::Other),
        _ => resp.text().await.map_err(|_| PageError::Other),
    }
}

pub async fn requirements(cache_path: &Path, ids: Vec<String>) -> Result<RequirementBatch, String> {
    let mut cache: HashMap<String, CachedRequirements> = std::fs::read(cache_path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    let stale: Vec<String> = ids
        .iter()
        .filter(|id| cache.get(*id).map_or(true, |c| now().saturating_sub(c.fetched_at) > REQUIREMENTS_TTL_SECS))
        .cloned()
        .collect();

    let mut rate_limited = false;
    if !stale.is_empty() {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .map_err(|e| e.to_string())?;
        for (n, id) in stale.iter().enumerate() {
            if n > 0 {
                tokio::time::sleep(PAGE_DELAY).await;
            }
            match fetch_page(&client, id).await {
                Ok(html) => {
                    cache.insert(id.clone(), CachedRequirements { items: parse_required(&html), fetched_at: now() });
                }
                Err(PageError::RateLimited) => {
                    rate_limited = true;
                    break;
                }
                Err(PageError::Other) => {}
            }
        }
        if let Some(dir) = cache_path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_vec(&cache) {
            let _ = std::fs::write(cache_path, json);
        }
    }

    let items = ids.into_iter().filter_map(|id| cache.get(&id).map(|c| (id, c.items.clone()))).collect();
    Ok(RequirementBatch { items, rate_limited })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_required_items_block() {
        let html = r#"<div class="requiredItemsContainer" id="RequiredItems">
            <a href="https://steamcommunity.com/workshop/filedetails/?id=2634208272" target="_blank" data-subscribed="0">
                <div class="requiredItem">
                    Left 4 Lib &amp; Friends</div></a></div></div><div class="panel"><a href="?id=999">"#;
        let r = parse_required(html);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].id, "2634208272");
        assert_eq!(r[0].title, "Left 4 Lib & Friends");
    }
}
