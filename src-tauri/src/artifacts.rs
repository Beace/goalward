use serde::Serialize;
use std::{
    fs::File,
    io::Read,
    path::{Path, PathBuf},
};
use tauri_plugin_dialog::DialogExt;

const MAX_PREVIEW_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactFile {
    path: String,
    content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    image_data_url: Option<String>,
    bytes: usize,
}

fn resolve(directory: &str, path: &str) -> Result<PathBuf, String> {
    if directory.is_empty() || path.is_empty() {
        return Err("产物缺少执行目录或文件路径。".into());
    }
    let root = Path::new(directory)
        .canonicalize()
        .map_err(|_| "执行目录不存在或无法访问。")?;
    if !root.is_dir() {
        return Err("执行目录不是文件夹。".into());
    }
    let input = Path::new(path);
    let file = if input.is_absolute() {
        input.to_path_buf()
    } else {
        root.join(input)
    };
    let file = file
        .canonicalize()
        .map_err(|_| "文件不存在或无法访问，可能已被移动或删除。")?;
    if !file.starts_with(&root) {
        return Err("此文件位于本次执行目录之外，无法在应用中读取。".into());
    }
    if !file.is_file() {
        return Err("此路径不是普通文件。".into());
    }
    Ok(file)
}
fn read(directory: &str, path: &str) -> Result<ArtifactFile, String> {
    let file = resolve(directory, path)?;
    if matches!(
        file.extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
        "png"
            | "jpg"
            | "jpeg"
            | "gif"
            | "webp"
            | "bmp"
            | "ico"
            | "avif"
            | "tif"
            | "tiff"
            | "heic"
            | "heif"
    ) {
        let image_data_url = crate::attachments::image_preview(&file.to_string_lossy())?;
        return Ok(ArtifactFile {
            bytes: file.metadata().map_err(|_| "无法读取文件信息。")?.len() as usize,
            path: file.to_string_lossy().into_owned(),
            content: String::new(),
            image_data_url: Some(image_data_url),
        });
    }
    let handle = File::open(&file).map_err(|_| "无法读取此文件。")?;
    if handle.metadata().map_err(|_| "无法读取文件信息。")?.len() > MAX_PREVIEW_BYTES {
        return Err("文件超过 2 MB 预览上限，请使用系统打开或在 Finder 中查看。".into());
    }
    let mut bytes = Vec::new();
    handle
        .take(MAX_PREVIEW_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "读取文件失败。")?;
    if bytes.len() as u64 > MAX_PREVIEW_BYTES {
        return Err("文件超过 2 MB 预览上限。".into());
    }
    let size = bytes.len();
    let content = String::from_utf8(bytes)
        .map_err(|_| "此文件不是 UTF-8 文本，请使用系统打开或在 Finder 中查看。")?;
    if content.contains('\0') {
        return Err("此文件为二进制内容，请使用系统打开或在 Finder 中查看。".into());
    }
    Ok(ArtifactFile {
        path: file.to_string_lossy().into_owned(),
        content,
        image_data_url: None,
        bytes: size,
    })
}
fn main_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("此窗口无法访问本地产物。".into())
    }
}
#[tauri::command]
pub async fn read_artifact(
    window: tauri::WebviewWindow,
    directory: String,
    path: String,
) -> Result<ArtifactFile, String> {
    main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || read(&directory, &path))
        .await
        .map_err(|e| e.to_string())?
}
fn can_open(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_lowercase()
            .as_str(),
        "html"
            | "htm"
            | "md"
            | "markdown"
            | "mdown"
            | "txt"
            | "json"
            | "csv"
            | "tsv"
            | "pdf"
            | "png"
            | "jpg"
            | "jpeg"
            | "webp"
            | "gif"
            | "bmp"
            | "ico"
            | "avif"
            | "tif"
            | "tiff"
            | "heic"
            | "heif"
            | "svg"
            | "mp4"
            | "mp3"
            | "wav"
    )
}
#[tauri::command]
pub async fn open_artifact(
    window: tauri::WebviewWindow,
    directory: String,
    path: String,
    reveal: bool,
) -> Result<(), String> {
    main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let file = resolve(&directory, &path)?;
        if !reveal && !can_open(&file) {
            return Err("此类型请使用 Finder 查看。".into());
        }
        #[cfg(target_os = "macos")]
        {
            let mut command = std::process::Command::new("/usr/bin/open");
            if reveal {
                command.arg("-R");
            }
            let result = command
                .arg(&file)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .map_err(|_| "无法打开此文件。")?;
            if result.success() {
                Ok(())
            } else {
                Err("系统未能打开此文件。".into())
            }
        }
        #[cfg(not(target_os = "macos"))]
        Err("此平台尚未接入本地文件打开。".into())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn save_artifact(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    name: String,
    content: String,
) -> Result<Option<String>, String> {
    main_window(&window)?;
    if content.len() as u64 > MAX_PREVIEW_BYTES {
        return Err("文档超过 2 MB 保存上限。".into());
    }
    let name = Path::new(&name)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("document.txt")
        .to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let selected = app
            .dialog()
            .file()
            .set_title("保存产物")
            .set_file_name(&name)
            .blocking_save_file();
        let Some(selected) = selected else {
            return Ok(None);
        };
        let path = selected.into_path().map_err(|_| "保存位置不是本地路径。")?;
        if let Ok(meta) = path.symlink_metadata() {
            if meta.file_type().is_symlink() || !meta.is_file() {
                return Err("请选择普通文件作为保存位置。".into());
            }
        }
        std::fs::write(&path, content.as_bytes()).map_err(|_| "文件保存失败。")?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine};
    #[test]
    fn reads_images_as_data_urls_with_separate_size_limit_and_directory_boundary() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().to_str().unwrap();
        let png = STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=").unwrap();
        let path = root.path().join("图片 with spaces.PNG");
        std::fs::write(&path, &png).unwrap();
        let result = read(directory, path.to_str().unwrap()).unwrap();
        assert_eq!(
            result.image_data_url.unwrap(),
            format!("data:image/png;base64,{}", STANDARD.encode(&png))
        );
        assert!(result.content.is_empty());
        assert_eq!(result.bytes, png.len());
        let mut larger = png.clone();
        larger.resize(MAX_PREVIEW_BYTES as usize + 1, 0);
        std::fs::write(&path, larger).unwrap();
        assert!(read(directory, path.to_str().unwrap()).is_ok());
        File::create(&path)
            .unwrap()
            .set_len(32 * 1024 * 1024 + 1)
            .unwrap();
        assert!(read(directory, path.to_str().unwrap())
            .err()
            .unwrap()
            .contains("32 MB"));
        std::fs::write(&path, b"<html>not an image</html>").unwrap();
        assert!(read(directory, path.to_str().unwrap()).is_err());
        std::fs::write(&path, &png).unwrap();
        let outside = tempfile::tempdir().unwrap();
        let external = outside.path().join("outside.png");
        std::fs::write(&external, &png).unwrap();
        assert!(read(directory, external.to_str().unwrap()).is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&external, root.path().join("escape.png")).unwrap();
            assert!(read(directory, "escape.png").is_err());
        }
    }
    #[test]
    fn reads_unicode_text_and_rejects_missing_binary_large_and_outside_files() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().to_str().unwrap();
        std::fs::write(root.path().join("报告.html"), "<h1>品质</h1>").unwrap();
        assert_eq!(
            read(directory, "报告.html").unwrap().content,
            "<h1>品质</h1>"
        );
        assert!(read(directory, "missing.md").is_err());
        assert!(read(directory, ".").is_err());
        std::fs::write(root.path().join("binary.txt"), [0, 255]).unwrap();
        assert!(read(directory, "binary.txt").is_err());
        File::create(root.path().join("large.md"))
            .unwrap()
            .set_len(MAX_PREVIEW_BYTES + 1)
            .unwrap();
        assert!(read(directory, "large.md").is_err());
        let outside = tempfile::NamedTempFile::new().unwrap();
        assert!(read(directory, outside.path().to_str().unwrap()).is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outside.path(), root.path().join("escape.md")).unwrap();
            assert!(read(directory, "escape.md").is_err());
        }
        assert!(!can_open(Path::new("execute.sh")));
        assert!(can_open(Path::new("REPORT.HTML")));
    }
}
