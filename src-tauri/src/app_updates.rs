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
            .map_err(|_| "应用更新正在进行，请等待当前操作完成".to_string())?;
        Ok(Operation(&self.busy))
    }

    fn session(&self) -> Result<std::sync::MutexGuard<'_, UpdateSession>, String> {
        self.session
            .lock()
            .map_err(|_| "应用更新状态不可用，请重启后重试".into())
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
    let url = Url::parse(value).map_err(|_| "GitHub 更新地址无效".to_string())?;
    // Exact canonical spelling excludes credentials, ports, query parameters,
    // fragments, path traversal, escaped separators and another repository.
    if url.as_str() != expected || value != expected {
        return Err("GitHub 更新地址与 Goalward 仓库或版本不匹配".into());
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
        return Err("GitHub 更新产物名称无效".into());
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
            return Err("GitHub Release 存在重复的更新清单，请检查发布产物".into());
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
            "GitHub 更新检查达到请求限制，请稍后重试{}",
            reset
                .map(|v| format!("（额度重置时间 Unix {v}）"))
                .unwrap_or_default()
        );
    }
    if status == StatusCode::NOT_FOUND {
        return "未找到 Goalward 的公开 GitHub Releases，请检查网络或仓库可用性".into();
    }
    format!(
        "GitHub 更新检查失败（HTTP {}），请稍后重试",
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
            .map_err(|e| format!("无法连接 GitHub 检查更新：{e}"))?;
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
            .map_err(|e| format!("无法读取 GitHub 更新信息：{e}"))?
        {
            if body.len() + chunk.len() > MAX_API_PAGE_BYTES {
                return Err("GitHub 更新信息超过安全大小限制，未完成更新检查".into());
            }
            body.extend_from_slice(&chunk);
        }
        let items: Vec<GitHubRelease> = serde_json::from_slice(&body)
            .map_err(|_| "GitHub 返回了无效的 Release 数据，未完成更新检查".to_string())?;
        let complete = items.len() < RELEASES_PER_PAGE;
        releases.extend(items);
        if complete {
            return Ok(releases);
        }
    }
    Err("GitHub Release 数量超过更新检查范围，未确认最新版本".into())
}

fn validate_update(update: &Update, candidate: &ReleaseCandidate) -> Result<(), String> {
    if Version::parse(&update.version).ok().as_ref() != Some(&candidate.version) {
        return Err("更新清单版本与 GitHub Release tag 不一致，未接受此更新".into());
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
        .ok_or("更新清单未指向同一 GitHub Release 的 macOS 更新包")?;
    asset_url(asset, &candidate.release.tag_name)?;
    if update.signature.trim().is_empty() {
        return Err("更新包缺少签名，未接受此更新".into());
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
        return Err("更新已经安装，请重启 Goalward 后再检查更新".into());
    }
    let current_version = app.package_info().version.to_string();
    let current = Version::parse(&current_version)
        .map_err(|_| "当前应用版本无效，无法安全比较更新".to_string())?;
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
        .map_err(|e| format!("无法初始化 GitHub 更新检查：{e}"))?;
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
        .map_err(|e| format!("更新清单地址无效：{e}"))?
        .timeout(Duration::from_secs(30))
        .configure_client(|client| client.redirect(github_redirects()))
        .build()
        .map_err(|e| format!("无法初始化更新组件：{e}"))?
        .check()
        .await
        .map_err(|e| format!("无法读取或验证 GitHub 更新清单：{e}"))?
        .ok_or("GitHub 更新清单未提供匹配的较新版本，未确认最新状态")?;
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
        .ok_or("请先检查并选择可用的更新")?;
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
        .map_err(|e| format!("更新包下载或签名验证失败：{e}"))?;
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
        return Err("开发构建只支持检查和下载更新；请在已安装的 Goalward 应用中安装更新".into());
    }
    if !cfg!(target_os = "macos") {
        return Err("当前版本仅支持 macOS 应用内更新".into());
    }
    let executable = std::env::current_exe().map_err(|_| "无法确认应用安装位置".to_string())?;
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
        return Err("请从已安装的 Goalward.app 中安装更新".into());
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
            return Err("更新已经安装，请重启 Goalward".into());
        }
        (
            session.update.clone().ok_or("请先检查更新")?,
            session.downloaded.clone().ok_or("请先下载并验证更新包")?,
        )
    };
    let runtimes = services.runtimes.clone();
    tauri::async_runtime::spawn_blocking(move || {
        runtimes.while_idle(|| {
            update
                .install(&**bytes)
                .map_err(|e| format!("更新安装失败，已下载的更新包可重试：{e}"))
        })
    })
    .await
    .map_err(|_| "更新安装任务未完成，请重试".to_string())??;
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
        return Err("尚未安装更新，未重启应用".into());
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
        assert!(api_error(StatusCode::FORBIDDEN, Some("0"), Some("123")).contains("请求限制"));
        assert!(api_error(StatusCode::TOO_MANY_REQUESTS, None, None).contains("请求限制"));
        assert!(api_error(StatusCode::NOT_FOUND, None, None).contains("未找到"));
    }
}
