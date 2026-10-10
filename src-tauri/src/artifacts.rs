use serde::Serialize;
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};
use tauri_plugin_dialog::DialogExt;

const MAX_PREVIEW_BYTES: u64 = 500 * 1024 * 1024;
const MAX_SAVE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_PDF_CHUNK_BYTES: usize = 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactFile {
    path: String,
    content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    image_data_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pdf: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    too_large: Option<bool>,
    bytes: u64,
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
fn preview_metadata(file: &Path, bytes: u64, too_large: bool) -> ArtifactFile {
    ArtifactFile {
        path: file.to_string_lossy().into_owned(),
        content: String::new(),
        image_data_url: None,
        pdf: None,
        too_large: too_large.then_some(true),
        bytes,
    }
}

fn validate_pdf(handle: &mut File) -> Result<(), String> {
    let mut signature = [0; 5];
    handle
        .read_exact(&mut signature)
        .map_err(|_| "此文件不是受支持的 PDF，或文件内容已损坏。")?;
    if signature != *b"%PDF-" {
        return Err("此文件不是受支持的 PDF，或文件内容已损坏。".into());
    }
    Ok(())
}

fn read(directory: &str, path: &str, allow_large: bool) -> Result<ArtifactFile, String> {
    read_with_limit(directory, path, allow_large, MAX_PREVIEW_BYTES)
}

fn read_with_limit(
    directory: &str,
    path: &str,
    allow_large: bool,
    max_preview_bytes: u64,
) -> Result<ArtifactFile, String> {
    let file = resolve(directory, path)?;
    let mut handle = File::open(&file).map_err(|_| "无法读取此文件。")?;
    let size = handle.metadata().map_err(|_| "无法读取文件信息。")?.len();
    if !allow_large && size > max_preview_bytes {
        // Metadata alone is enough to ask for an override; do not allocate or read content.
        return Ok(preview_metadata(&file, size, true));
    }
    let extension = file
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if extension == "pdf" {
        validate_pdf(&mut handle)?;
        let mut result = preview_metadata(&file, size, false);
        result.pdf = Some(true);
        return Ok(result);
    }
    let image = matches!(
        extension.as_str(),
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
    );
    let limit = (!allow_large).then_some(max_preview_bytes);
    let mut bytes = Vec::new();
    handle
        .by_ref()
        .take(limit.map_or(u64::MAX, |limit| limit.saturating_add(1)))
        .read_to_end(&mut bytes)
        .map_err(|_| "读取文件失败。")?;
    if limit.is_some_and(|limit| bytes.len() as u64 > limit) {
        // Keep the gate even if a file grew after the metadata check.
        let size = handle.metadata().map_err(|_| "无法读取文件信息。")?.len();
        return Ok(preview_metadata(&file, size, true));
    }
    let mut result = preview_metadata(&file, bytes.len() as u64, false);
    if image {
        result.image_data_url = Some(crate::attachments::image_data_url(&file, bytes, limit)?);
        return Ok(result);
    }
    let content = String::from_utf8(bytes)
        .map_err(|_| "此文件不是 UTF-8 文本，请使用系统打开或在 Finder 中查看。")?;
    if content.contains('\0') {
        return Err("此文件为二进制内容，请使用系统打开或在 Finder 中查看。".into());
    }
    result.content = content;
    Ok(result)
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
    allow_large: Option<bool>,
) -> Result<ArtifactFile, String> {
    main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        read(&directory, &path, allow_large.unwrap_or(false))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn read_pdf_chunk(
    directory: &str,
    path: &str,
    offset: u64,
    length: usize,
    allow_large: bool,
    max_preview_bytes: u64,
) -> Result<Vec<u8>, String> {
    if length == 0 || length > MAX_PDF_CHUNK_BYTES {
        return Err("PDF 单次读取范围必须为 1 字节至 1 MB。".into());
    }
    let file = resolve(directory, path)?;
    let mut handle = File::open(&file).map_err(|_| "无法读取此文件。")?;
    let size = handle.metadata().map_err(|_| "无法读取文件信息。")?.len();
    if !allow_large && size > max_preview_bytes {
        return Err("文件超过 500 MB 预览上限，请点击“仍要打开”后继续加载。".into());
    }
    validate_pdf(&mut handle)?;
    if offset > size {
        return Err("PDF 读取范围超出文件大小。".into());
    }
    handle
        .seek(SeekFrom::Start(offset))
        .map_err(|_| "无法定位 PDF 读取范围。")?;
    let mut bytes = Vec::new();
    handle
        .take(length as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "PDF 读取失败。")?;
    Ok(bytes)
}

#[tauri::command]
pub async fn read_artifact_pdf_chunk(
    window: tauri::WebviewWindow,
    directory: String,
    path: String,
    offset: u64,
    length: usize,
    allow_large: Option<bool>,
) -> Result<tauri::ipc::Response, String> {
    main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        read_pdf_chunk(
            &directory,
            &path,
            offset,
            length,
            allow_large.unwrap_or(false),
            MAX_PREVIEW_BYTES,
        )
        .map(tauri::ipc::Response::new)
    })
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
    if content.len() as u64 > MAX_SAVE_BYTES {
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
    use std::io::Write;

    fn png_bytes() -> Vec<u8> {
        STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=").unwrap()
    }

    #[test]
    fn text_limit_includes_boundary_and_override_loads_content() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().to_str().unwrap();
        let path = root.path().join("报告.html");
        std::fs::write(&path, "<h1>品质</h1>").unwrap();
        let size = std::fs::metadata(&path).unwrap().len();
        let result = read_with_limit(directory, "报告.html", false, size).unwrap();
        assert_eq!(result.content, "<h1>品质</h1>");
        assert_eq!(result.bytes, size);
        assert_eq!(result.too_large, None);

        let blocked = read_with_limit(directory, "报告.html", false, size - 1).unwrap();
        assert_eq!(blocked.too_large, Some(true));
        assert_eq!(blocked.bytes, size);
        assert!(blocked.content.is_empty());
        assert!(blocked.image_data_url.is_none());
        assert!(blocked.pdf.is_none());
        let json = serde_json::to_value(&blocked).unwrap();
        assert_eq!(json["tooLarge"], true);
        assert_eq!(json["path"], path.canonicalize().unwrap().to_str().unwrap());
        assert!(json.get("imageDataUrl").is_none());
        let loaded = read_with_limit(directory, "报告.html", true, size - 1).unwrap();
        assert_eq!(loaded.content, "<h1>品质</h1>");
        assert_eq!(loaded.too_large, None);
        assert_eq!(MAX_PREVIEW_BYTES, 500 * 1024 * 1024);
        assert_eq!(MAX_SAVE_BYTES, 2 * 1024 * 1024);
    }

    #[test]
    fn oversized_files_return_metadata_before_reading_any_type() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().to_str().unwrap();
        for name in ["large.md", "large.png", "large.pdf", "large.zip"] {
            let file = File::create(root.path().join(name)).unwrap();
            file.set_len(MAX_PREVIEW_BYTES + 1).unwrap();
            // These sparse files contain invalid text/image/PDF content. Metadata is still
            // returned because the size gate happens before content is read or validated.
            let result = read(directory, name, false).unwrap();
            assert_eq!(result.too_large, Some(true));
            assert_eq!(result.bytes, MAX_PREVIEW_BYTES + 1);
            assert!(result.content.is_empty());
            assert!(result.image_data_url.is_none());
            assert!(result.pdf.is_none());
        }
    }

    #[test]
    fn images_use_the_artifact_limit_and_override_preserves_signature_validation() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().to_str().unwrap();
        let png = png_bytes();
        let path = root.path().join("图片 with spaces.PNG");
        std::fs::write(&path, &png).unwrap();
        let result = read(directory, path.to_str().unwrap(), false).unwrap();
        assert_eq!(
            result.image_data_url.unwrap(),
            format!("data:image/png;base64,{}", STANDARD.encode(&png))
        );
        assert!(result.content.is_empty());
        assert_eq!(result.bytes, png.len() as u64);
        let blocked = read_with_limit(directory, path.to_str().unwrap(), false, 10).unwrap();
        assert_eq!(blocked.too_large, Some(true));
        assert!(blocked.image_data_url.is_none());
        assert!(read_with_limit(directory, path.to_str().unwrap(), true, 10)
            .unwrap()
            .image_data_url
            .is_some());
        std::fs::write(&path, b"<html>not an image</html>").unwrap();
        assert!(read_with_limit(directory, path.to_str().unwrap(), true, 10).is_err());
    }

    #[test]
    fn pdf_metadata_and_chunks_validate_signature_and_bound_reads() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().to_str().unwrap();
        let pdf = b"%PDF-1.7\npreview page bytes\n%%EOF";
        let path = root.path().join("图纸.PDF");
        std::fs::write(&path, pdf).unwrap();
        let result = read(directory, "图纸.PDF", false).unwrap();
        assert_eq!(result.pdf, Some(true));
        assert_eq!(result.bytes, pdf.len() as u64);
        assert!(result.content.is_empty());
        assert!(result.image_data_url.is_none());
        assert_eq!(
            read_pdf_chunk(directory, "图纸.PDF", 5, 6, false, MAX_PREVIEW_BYTES).unwrap(),
            &pdf[5..11]
        );
        assert_eq!(
            read_pdf_chunk(
                directory,
                "图纸.PDF",
                pdf.len() as u64 - 2,
                10,
                false,
                MAX_PREVIEW_BYTES
            )
            .unwrap(),
            b"OF"
        );
        assert!(read_pdf_chunk(
            directory,
            "图纸.PDF",
            pdf.len() as u64 + 1,
            1,
            false,
            MAX_PREVIEW_BYTES
        )
        .is_err());
        assert!(
            read_pdf_chunk(directory, "图纸.PDF", u64::MAX, 1, false, MAX_PREVIEW_BYTES).is_err()
        );
        assert!(read_pdf_chunk(directory, "图纸.PDF", 0, 0, false, MAX_PREVIEW_BYTES).is_err());
        assert!(read_pdf_chunk(
            directory,
            "图纸.PDF",
            0,
            MAX_PDF_CHUNK_BYTES + 1,
            false,
            MAX_PREVIEW_BYTES
        )
        .is_err());
        assert!(read_pdf_chunk(directory, "图纸.PDF", 0, 5, false, 10).is_err());
        assert_eq!(
            read_pdf_chunk(directory, "图纸.PDF", 0, 5, true, 10).unwrap(),
            b"%PDF-"
        );

        for content in [b"not-a-pdf".as_slice(), b"%PDF".as_slice()] {
            std::fs::write(&path, content).unwrap();
            assert!(read(directory, "图纸.PDF", false).is_err());
            assert!(read_pdf_chunk(directory, "图纸.PDF", 0, 5, true, MAX_PREVIEW_BYTES).is_err());
        }
    }

    #[test]
    fn large_pdf_override_returns_only_metadata_and_requested_range() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().to_str().unwrap();
        let path = root.path().join("large.pdf");
        let mut file = File::create(&path).unwrap();
        file.write_all(b"%PDF-1.7\n").unwrap();
        file.set_len(MAX_PREVIEW_BYTES + 1).unwrap();
        assert_eq!(
            read(directory, "large.pdf", false).unwrap().too_large,
            Some(true)
        );
        let result = read(directory, "large.pdf", true).unwrap();
        assert_eq!(result.pdf, Some(true));
        assert_eq!(result.bytes, MAX_PREVIEW_BYTES + 1);
        assert!(result.content.is_empty());
        assert_eq!(
            read_pdf_chunk(directory, "large.pdf", 0, 8, true, MAX_PREVIEW_BYTES).unwrap(),
            b"%PDF-1.7"
        );
        assert!(read_pdf_chunk(directory, "large.pdf", 0, 8, false, MAX_PREVIEW_BYTES).is_err());
    }

    #[test]
    fn rejects_missing_binary_and_outside_files_including_symlinks() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().to_str().unwrap();
        assert!(read(directory, "missing.md", false).is_err());
        assert!(read(directory, ".", false).is_err());
        assert!(read("", "test.md", false).is_err());
        std::fs::write(root.path().join("binary.txt"), [0, 255]).unwrap();
        assert!(read(directory, "binary.txt", true).is_err());
        std::fs::write(root.path().join("nul.txt"), [0]).unwrap();
        assert!(read(directory, "nul.txt", false).is_err());
        let outside = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(outside.path(), b"%PDF-1.7").unwrap();
        assert!(read(directory, outside.path().to_str().unwrap(), true).is_err());
        assert!(read_pdf_chunk(
            directory,
            outside.path().to_str().unwrap(),
            0,
            5,
            true,
            MAX_PREVIEW_BYTES
        )
        .is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outside.path(), root.path().join("escape.pdf")).unwrap();
            assert!(read(directory, "escape.pdf", true).is_err());
            assert!(
                read_pdf_chunk(directory, "escape.pdf", 0, 5, true, MAX_PREVIEW_BYTES).is_err()
            );
        }
        assert!(!can_open(Path::new("execute.sh")));
        assert!(can_open(Path::new("REPORT.HTML")));
    }
}
