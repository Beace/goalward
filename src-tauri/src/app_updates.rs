//! Public GitHub Releases are discovery metadata; Tauri verifies the signed
//! archive (including its version) before these bytes can be installed.
use crate::AppServices;
use reqwest::{redirect, Client, StatusCode};
use semver::Version;
use serde::{Deserialize, Serialize};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{ipc::Channel, AppHandle, State, Url};
use tauri_plugin_updater::{Update, UpdaterExt};

const REPOSITORY: &str = "Beace/goalward";
const MAX_RELEASE_PAGES: usize = 10;
const RELEASES_PER_PAGE: usize = 100;
const MAX_API_PAGE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Default)]
pub struct AppUpdates {
    busy: AtomicBool,
    session: Mutex<UpdateSession>,
}

#[derive(Default)]
struct UpdateSession {
    update: Option<Update>,
    downloaded: Option<Arc<Vec<u8>>>,
    installed: bool,
}

struct Operation<'a>(&'a AtomicBool);

impl Drop for Operation<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

impl AppUpdates {
    fn begin(&self) -> Result<Operation<'_>, String> {
        self.busy
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .map_err(|_| "An app update is in progress. Wait for the current operation to finish.".to_string())?;
        Ok(Operation(&self.busy))
    }

    fn session(&self) -> Result<std::sync::MutexGuard<'_, UpdateSession>, String> {
        self.session
            .lock()
            .map_err(|_| "The app update state is unavailable. Restart and try again.".into())
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateInfo {
    current_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    notes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    release_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    date: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data")]
pub enum DownloadEvent {
    Started {
        #[serde(rename = "contentLength", skip_serializing_if = "Option::is_none")]
        content_length: Option<u64>,
    },
    Progress {
        #[serde(rename = "chunkLength")]
        chunk_length: usize,
    },
    Finished,
}

#[derive(Clone, Debug, Deserialize)]
struct ReleaseAsset {
    name: String,
    browser_download_url: String,
    state: String,
}

#[derive(Clone, Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    draft: bool,
    html_url: String,
    body: Option<String>,
    published_at: Option<String>,
    assets: Vec<ReleaseAsset>,
}

struct ReleaseCandidate {
    release: GitHubRelease,
    version: Version,
    manifest_url: Url,
}

fn exact_github_url(value: &str, path: &str) -> Result<Url, String> {
    let expected = format!("https://github.com/{REPOSITORY}/{path}");
    let url = Url::parse(value).map_err(|_| "The GitHub update URL is invalid.".to_string())?;
    // Exact canonical spelling excludes credentials, ports, query parameters,
    // fragments, path traversal, escaped separators and another repository.
    if url.as_str() != expected || value != expected {
        return Err("The GitHub update URL does not match the Goalward repository or version.".into());
    }
    Ok(url)
}

fn asset_url(asset: &ReleaseAsset, tag: &str) -> Result<Url, String> {
    if asset.name.is_empty()
        || !asset
            .name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
    {
        return Err("The GitHub update asset name is invalid.".into());
    }
    exact_github_url(
        &asset.browser_download_url,
        &format!("releases/download/{tag}/{}", asset.name),
    )
}

fn select_release(
    releases: Vec<GitHubRelease>,
    current: &Version,
) -> Result<Option<ReleaseCandidate>, String> {
    let mut candidates = Vec::new();
    for release in releases {
        if release.draft || release.published_at.is_none() {
            continue;
        }
        let Some(version) = release
            .tag_name
            .strip_prefix('v')
            .and_then(|v| Version::parse(v).ok())
        else {
            continue;
        };
        if !version.build.is_empty()
            || version <= *current
            || release.tag_name != format!("v{version}")
        {
            continue;
        }
        // Pre-updater releases have no manifest and cannot be installed here.
        let manifests: Vec<_> = release
            .assets
            .iter()
            .filter(|a| a.name == "latest.json" && a.state == "uploaded")
            .collect();
        if manifests.is_empty() {
            continue;
        }
        if manifests.len() != 1 {
            return Err("The GitHub Release contains duplicate update manifests. Check the release assets.".into());
        }
        exact_github_url(
            &release.html_url,
            &format!("releases/tag/{}", release.tag_name),
        )?;
        let manifest_url = asset_url(manifests[0], &release.tag_name)?;
        candidates.push(ReleaseCandidate {
            release,
            version,
            manifest_url,
        });
    }
    // GitHub's published prereleases are deliberately included. Publication
    // order does not decide version precedence, and we never downgrade.
    candidates.sort_by(|a, b| b.version.cmp(&a.version));
    Ok(candidates.into_iter().next())
}

fn github_redirects() -> redirect::Policy {
    redirect::Policy::custom(|attempt| {
        let url = attempt.url();
        let allowed = url.scheme() == "https"
            && url.username().is_empty()
            && url.password().is_none()
            && url.port_or_known_default() == Some(443)
            && matches!(
                url.host_str(),
                Some(
                    "github.com"
                        | "release-assets.githubusercontent.com"
                        | "objects.githubusercontent.com"
                )
            );
        if attempt.previous().len() >= 5 || !allowed {
            attempt.error("GitHub update redirect reached an unexpected endpoint")
        } else {
            attempt.follow()
        }
    })
}

fn api_error(status: StatusCode, remaining: Option<&str>, reset: Option<&str>) -> String {
    if status == StatusCode::TOO_MANY_REQUESTS
        || status == StatusCode::FORBIDDEN && remaining == Some("0")
    {
        return format!(
            "GitHub update checks reached the rate limit. Try again later{}",
            reset
                .map(|v| format!(" (rate limit resets at Unix {v})"))
                .unwrap_or_default()
        );
    }
    if status == StatusCode::NOT_FOUND {
        return "No public Goalward GitHub Releases were found. Check the network and repository availability.".into();
    }
    format!(
        "The GitHub update check failed (HTTP {}). Try again later.",
        status.as_u16()
    )
}

async fn public_releases(client: &Client) -> Result<Vec<GitHubRelease>, String> {
    let mut releases = Vec::new();
    for page in 1..=MAX_RELEASE_PAGES {
        let mut response = client
            .get(format!(
                "https://api.github.com/repos/{REPOSITORY}/releases?per_page={RELEASES_PER_PAGE}&page={page}"
            ))
            .send()
            .await
            .map_err(|e| format!("Could not connect to GitHub to check for updates: {e}"))?;
        if !response.status().is_success() {
            return Err(api_error(
                response.status(),
                response
                    .headers()
                    .get("x-ratelimit-remaining")
                    .and_then(|h| h.to_str().ok()),
                response
                    .headers()
                    .get("x-ratelimit-reset")
                    .and_then(|h| h.to_str().ok()),
            ));
        }
        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|e| format!("Could not read GitHub update information: {e}"))?
        {
            if body.len() + chunk.len() > MAX_API_PAGE_BYTES {
                return Err("GitHub update information exceeds the safe size limit. The update check did not complete.".into());
            }
            body.extend_from_slice(&chunk);
        }
        let items: Vec<GitHubRelease> = serde_json::from_slice(&body)
            .map_err(|_| "GitHub returned invalid Release data. The update check did not complete.".to_string())?;
        let complete = items.len() < RELEASES_PER_PAGE;
        releases.extend(items);
        if complete {
            return Ok(releases);
        }
    }
    Err("The GitHub Release count exceeds the update check range. The latest version could not be confirmed.".into())
}

fn validate_update(update: &Update, candidate: &ReleaseCandidate) -> Result<(), String> {
    if Version::parse(&update.version).ok().as_ref() != Some(&candidate.version) {
        return Err("The update manifest version does not match the GitHub Release tag. The update was rejected.".into());
    }
    let asset = candidate
        .release
        .assets
        .iter()
        .find(|asset| {
            asset.state == "uploaded"
                && asset.browser_download_url == update.download_url.as_str()
                && asset.name.ends_with(".app.tar.gz")
        })
        .ok_or("The update manifest does not reference the macOS update package from the same GitHub Release.")?;
    asset_url(asset, &candidate.release.tag_name)?;
    if update.signature.trim().is_empty() {
        return Err("The update package has no signature. The update was rejected.".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn check_app_update(
    app: AppHandle,
    updates: State<'_, AppUpdates>,
) -> Result<AppUpdateInfo, String> {
    let _operation = updates.begin()?;
    if updates.session()?.installed {
        return Err("The update is already installed. Restart Goalward before checking for updates again.".into());
    }
    let current_version = app.package_info().version.to_string();
    let current = Version::parse(&current_version)
        .map_err(|_| "The current app version is invalid. Updates cannot be compared safely.".to_string())?;
    let client = Client::builder()
        .user_agent(format!("Goalward/{current_version}"))
        .timeout(Duration::from_secs(30))
        .redirect(redirect::Policy::none())
        .default_headers(
            [
                (
                    reqwest::header::ACCEPT,
                    reqwest::header::HeaderValue::from_static("application/vnd.github+json"),
                ),
                (
                    reqwest::header::HeaderName::from_static("x-github-api-version"),
                    reqwest::header::HeaderValue::from_static("2022-11-28"),
                ),
            ]
            .into_iter()
            .collect(),
        )
        .build()
        .map_err(|e| format!("Could not initialize the GitHub update check: {e}"))?;
    let candidate = select_release(public_releases(&client).await?, &current)?;
    let Some(candidate) = candidate else {
        let mut session = updates.session()?;
        session.update = None;
        session.downloaded = None;
        return Ok(AppUpdateInfo {
            current_version,
            version: None,
            notes: None,
            release_url: None,
            date: None,
        });
    };
    let mut update = app
        .updater_builder()
        .endpoints(vec![candidate.manifest_url.clone()])
        .map_err(|e| format!("The update manifest URL is invalid: {e}"))?
        .timeout(Duration::from_secs(30))
        .configure_client(|client| client.redirect(github_redirects()))
        .build()
        .map_err(|e| format!("Could not initialize the updater: {e}"))?
        .check()
        .await
        .map_err(|e| format!("Could not read or verify the GitHub update manifest: {e}"))?
        .ok_or("The GitHub update manifest does not provide a matching newer version. Update status could not be confirmed.")?;
    validate_update(&update, &candidate)?;
    // Checking a small manifest and downloading a full app need different
    // time budgets; neither request has an unlimited network timeout.
    update.timeout = Some(Duration::from_secs(300));
    let info = AppUpdateInfo {
        current_version,
        version: Some(candidate.version.to_string()),
        notes: candidate.release.body,
        release_url: Some(candidate.release.html_url),
        date: candidate.release.published_at,
    };
    let mut session = updates.session()?;
    session.update = Some(update);
    session.downloaded = None;
    Ok(info)
}

#[tauri::command]
pub async fn download_app_update(
    updates: State<'_, AppUpdates>,
    on_event: Channel<DownloadEvent>,
) -> Result<(), String> {
    let _operation = updates.begin()?;
    let update = updates
        .session()?
        .update
        .clone()
        .ok_or("Check for updates and select an available update first.")?;
    let mut started = false;
    let bytes = update
        .download(
            |chunk_length, content_length| {
                if !started {
                    started = true;
                    let _ = on_event.send(DownloadEvent::Started { content_length });
                }
                let _ = on_event.send(DownloadEvent::Progress { chunk_length });
            },
            || {},
        )
        .await
        .map_err(|e| format!("The update package download or signature verification failed: {e}"))?;
    if !started {
        let _ = on_event.send(DownloadEvent::Started {
            content_length: Some(bytes.len() as u64),
        });
    }
    updates.session()?.downloaded = Some(Arc::new(bytes));
    // The plugin's finish callback fires before verification. Notify the UI
    // only after download() has verified the signature and signed version.
    let _ = on_event.send(DownloadEvent::Finished);
    Ok(())
}

fn installation_supported() -> Result<(), String> {
    if cfg!(debug_assertions) {
        return Err("Development builds only support checking for and downloading updates. Install updates from the installed Goalward app.".into());
    }
    if !cfg!(target_os = "macos") {
        return Err("This version only supports in-app updates on macOS.".into());
    }
    let executable = std::env::current_exe().map_err(|_| "Could not determine the app installation location.".to_string())?;
    if executable
        .parent()
        .is_none_or(|p| p.file_name().is_none_or(|n| n != "MacOS"))
        || executable
            .parent()
            .and_then(|p| p.parent())
            .is_none_or(|p| p.file_name().is_none_or(|n| n != "Contents"))
        || executable
            .parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.parent())
            .is_none_or(|p| p.extension().is_none_or(|e| e != "app"))
    {
        return Err("Install updates from the installed Goalward.app.".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn install_app_update(
    updates: State<'_, AppUpdates>,
    services: State<'_, AppServices>,
) -> Result<(), String> {
    let _operation = updates.begin()?;
    installation_supported()?;
    let (update, bytes) = {
        let session = updates.session()?;
        if session.installed {
            return Err("The update is already installed. Restart Goalward.".into());
        }
        (
            session.update.clone().ok_or("Check for updates first.")?,
            session.downloaded.clone().ok_or("Download and verify the update package first.")?,
        )
    };
    let runtimes = services.runtimes.clone();
    tauri::async_runtime::spawn_blocking(move || {
        runtimes.while_idle(|| {
            update
                .install(&**bytes)
                .map_err(|e| format!("Update installation failed. The downloaded update package can be retried: {e}"))
        })
    })
    .await
    .map_err(|_| "The update installation task did not complete. Try again.".to_string())??;
    let mut session = updates.session()?;
    session.installed = true;
    session.update = None;
    session.downloaded = None;
    Ok(())
}

#[tauri::command]
pub fn restart_app_after_update(
    app: AppHandle,
    updates: State<'_, AppUpdates>,
    services: State<'_, AppServices>,
) -> Result<(), String> {
    let _operation = updates.begin()?;
    if !updates.session()?.installed {
        return Err("No update is installed. The app was not restarted.".into());
    }
    // restart() never returns; holding the lifecycle gate excludes a new
    // Runtime start until exit. shutdown() uses the separate process mutex.
    services.runtimes.while_idle(|| app.restart())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release(tag: &str, with_manifest: bool) -> GitHubRelease {
        GitHubRelease {
            tag_name: tag.into(),
            draft: false,
            html_url: format!("https://github.com/{REPOSITORY}/releases/tag/{tag}"),
            body: Some("release notes".into()),
            published_at: Some("2026-10-10T00:00:00Z".into()),
            assets: if with_manifest {
                vec![ReleaseAsset {
                    name: "latest.json".into(),
                    state: "uploaded".into(),
                    browser_download_url: format!(
                        "https://github.com/{REPOSITORY}/releases/download/{tag}/latest.json"
                    ),
                }]
            } else {
                vec![]
            },
        }
    }

    #[test]
    fn selects_highest_newer_published_version_including_prereleases() {
        let mut draft = release("v9.0.0", true);
        draft.draft = true;
        let selected = select_release(
            vec![
                release("v0.2.0", true),
                draft,
                release("v0.4.0-beta.1", true),
                release("v0.3.0", true),
                release("v1.0.0", false),
            ],
            &Version::parse("0.1.1").unwrap(),
        )
        .unwrap()
        .unwrap();
        assert_eq!(selected.version.to_string(), "0.4.0-beta.1");
        assert!(selected
            .manifest_url
            .as_str()
            .contains("/v0.4.0-beta.1/latest.json"));
    }

    #[test]
    fn ignores_old_legacy_unpublished_and_noncanonical_tags_without_downgrading() {
        let mut unpublished = release("v0.6.0", true);
        unpublished.published_at = None;
        assert!(select_release(
            vec![
                release("v0.1.0", true),
                release("v0.2.0", true),
                release("v0.5.0", false),
                release("v0.7.0+build.1", true),
                release("nightly", true),
                release("0.7.0", true),
                unpublished
            ],
            &Version::parse("0.2.0").unwrap()
        )
        .unwrap()
        .is_none());
        assert!(select_release(
            vec![release("v1.0.0-beta.1", true)],
            &Version::parse("1.0.0").unwrap()
        )
        .unwrap()
        .is_none());
    }

    #[test]
    fn rejects_manifest_urls_outside_the_exact_repository_release() {
        for url in [
            "http://github.com/Beace/goalward/releases/download/v0.2.0/latest.json",
            "https://github.com/other/goalward/releases/download/v0.2.0/latest.json",
            "https://github.com/Beace/goalward/releases/download/v0.1.0/latest.json",
            "https://github.com/Beace/goalward/releases/download/v0.2.0/latest.json?x=1",
            "https://user@github.com/Beace/goalward/releases/download/v0.2.0/latest.json",
            "https://github.com/Beace/goalward/releases/download/v0.2.0/%6catest.json",
        ] {
            let mut item = release("v0.2.0", true);
            item.assets[0].browser_download_url = url.into();
            assert!(
                select_release(vec![item], &Version::parse("0.1.1").unwrap()).is_err(),
                "accepted {url}"
            );
        }
    }

    #[test]
    fn fails_closed_for_duplicate_manifests_and_unsafe_asset_names() {
        let mut item = release("v0.2.0", true);
        item.assets.push(item.assets[0].clone());
        assert!(select_release(vec![item], &Version::parse("0.1.1").unwrap()).is_err());
        let mut asset = release("v0.2.0", true).assets.remove(0);
        asset.name = "../Goalward.app.tar.gz".into();
        assert!(asset_url(&asset, "v0.2.0").is_err());
    }

    #[test]
    fn concurrent_operations_reject_and_retry_after_error_release() {
        let state = AppUpdates::default();
        let operation = state.begin().unwrap();
        assert!(state.begin().is_err());
        drop(operation);
        assert!(state.begin().is_ok());
    }

    #[test]
    fn rate_limit_errors_differ_from_no_update() {
        assert!(api_error(StatusCode::FORBIDDEN, Some("0"), Some("123")).contains("rate limit"));
        assert!(api_error(StatusCode::TOO_MANY_REQUESTS, None, None).contains("rate limit"));
        assert!(api_error(StatusCode::NOT_FOUND, None, None).contains("No public"));
    }
}
