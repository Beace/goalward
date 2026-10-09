use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::{
    fs,
    io::{Read, Write},
    path::Path,
};
use tauri::Manager;

const MAX_BYTES: usize = 32 * 1024 * 1024;

pub(crate) fn image_preview(path: &str) -> Result<String, String> {
    if !Path::new(path).is_absolute() {
        return Err("图片缺少本地绝对路径。".into());
    }
    let file = fs::File::open(path).map_err(|_| "图片不存在或无法访问，可能已被移动或删除。")?;
    let metadata = file.metadata().map_err(|_| "无法读取图片信息。")?;
    if !metadata.is_file() {
        return Err("此路径不是图片文件。".into());
    }
    if metadata.len() > MAX_BYTES as u64 {
        return Err("图片超过 32 MB 预览上限。".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "图片读取失败。")?;
    if bytes.len() > MAX_BYTES {
        return Err("图片超过 32 MB 预览上限。".into());
    }
    // Inspect bytes rather than trusting extensions; never expose HTML/SVG as active content.
    let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        "image/jpeg"
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        "image/gif"
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        "image/webp"
    } else if bytes.starts_with(b"BM") {
        "image/bmp"
    } else if bytes.starts_with(&[0, 0, 1, 0]) {
        "image/x-icon"
    } else if bytes.get(4..8) == Some(b"ftyp")
        && matches!(bytes.get(8..12), Some(b"avif" | b"avis"))
    {
        "image/avif"
    } else {
        #[cfg(target_os = "macos")]
        {
            let extension = Path::new(path)
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("")
                .to_lowercase();
            if matches!(extension.as_str(), "tif" | "tiff" | "heic" | "heif") {
                return native_image_png(&bytes)
                    .map(|png| format!("data:image/png;base64,{}", STANDARD.encode(png)));
            }
        }
        return Err("此文件不是受支持的图片，或图片内容已损坏。".into());
    };
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

#[cfg(target_os = "macos")]
fn native_image_png(bytes: &[u8]) -> Result<Vec<u8>, String> {
    use objc2::AllocAnyThread;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep};
    use objc2_foundation::{NSData, NSDictionary};
    objc2::rc::autoreleasepool(|_| {
        let image =
            NSBitmapImageRep::initWithData(NSBitmapImageRep::alloc(), &NSData::with_bytes(bytes))
                .ok_or("图片解码失败。")?;
        let data = unsafe {
            image.representationUsingType_properties(
                NSBitmapImageFileType::PNG,
                &NSDictionary::new(),
            )
        }
        .ok_or("图片转换失败。")?;
        if data.length() > MAX_BYTES {
            return Err("转换后的图片超过 32 MB 预览上限。".into());
        }
        Ok(data.to_vec())
    })
}

#[tauri::command]
pub async fn read_attachment_image(
    window: tauri::WebviewWindow,
    path: String,
) -> Result<String, String> {
    if window.label() != "main" {
        return Err("此窗口无法预览本地图片。".into());
    }
    tauri::async_runtime::spawn_blocking(move || image_preview(&path))
        .await
        .map_err(|e| e.to_string())?
}

#[derive(Debug, Serialize)]
pub struct Attachment {
    name: String,
    path: String,
}

fn existing_file(path: &Path) -> Result<Attachment, String> {
    if !path.is_absolute() || !path.is_file() {
        return Err(format!(
            "无法添加文件（不存在或不是文件）：{}",
            path.display()
        ));
    }
    // Keep the source filename, including when a symlink resolves to another name.
    let name = path
        .file_name()
        .ok_or("文件名无效")?
        .to_string_lossy()
        .into_owned();
    let path = fs::canonicalize(path).map_err(|e| format!("无法读取 {name}：{e}"))?;
    fs::File::open(&path).map_err(|e| format!("无法读取 {name}：{e}"))?;
    Ok(Attachment {
        name,
        path: path.to_string_lossy().into_owned(),
    })
}

fn persist(root: &Path, name: &str, bytes: &[u8]) -> Result<Attachment, String> {
    if bytes.len() > MAX_BYTES {
        return Err("剪贴板内容超过 32 MB，请先保存成文件，再从 Finder 复制。".into());
    }
    let name = name
        .rsplit(['/', '\\'])
        .next()
        .filter(|name| !name.is_empty() && *name != "." && *name != "..")
        .unwrap_or("clipboard-file");
    if name.chars().any(char::is_control) {
        return Err("附件文件名包含无效字符".into());
    }
    let directory = root
        .join("attachments")
        .join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let path = directory.join(name);
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&path).map_err(|e| e.to_string())?;
        file.write_all(bytes).map_err(|e| e.to_string())?;
        Ok(Attachment {
            name: name.into(),
            path: path.to_string_lossy().into_owned(),
        })
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(directory);
    }
    result
}

#[tauri::command]
pub async fn save_clipboard_file(
    window: tauri::WebviewWindow,
    name: String,
    data: String,
) -> Result<Attachment, String> {
    if window.label() != "main" {
        return Err("此窗口无法添加附件".into());
    }
    if data.len() > MAX_BYTES.div_ceil(3) * 4 {
        return Err("剪贴板内容超过 32 MB".into());
    }
    let root = window
        .app_handle()
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = STANDARD.decode(data).map_err(|_| "剪贴板文件内容无效")?;
        persist(&root, &name, &bytes)
    })
    .await
    .map_err(|e| e.to_string())?
}

// A synchronous command reads the pasteboard on the UI thread, and only in
// response to a paste gesture. Prefer original file URLs over image representations.
#[tauri::command]
pub fn read_clipboard_attachments(window: tauri::WebviewWindow) -> Result<Vec<Attachment>, String> {
    if window.label() != "main" {
        return Err("此窗口无法读取剪贴板附件".into());
    }
    let root = window
        .app_handle()
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    read_native(&root)
}

#[cfg(target_os = "macos")]
fn read_native(root: &Path) -> Result<Vec<Attachment>, String> {
    read_board(root, &objc2_app_kit::NSPasteboard::generalPasteboard())
}

#[cfg(target_os = "macos")]
fn read_board(root: &Path, board: &objc2_app_kit::NSPasteboard) -> Result<Vec<Attachment>, String> {
    use objc2::AllocAnyThread;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep};
    use objc2_foundation::{NSDictionary, NSString, NSURL};

    objc2::rc::autoreleasepool(|_| {
        let mut files = Vec::new();
        if let Some(items) = board.pasteboardItems() {
            for item in items.iter() {
                if let Some(value) = item.stringForType(&NSString::from_str("public.file-url")) {
                    let url = NSURL::URLWithString(&value).ok_or("剪贴板文件地址无效")?;
                    if !url.isFileURL() {
                        return Err("剪贴板不是本地文件地址".into());
                    }
                    // Finder can publish file:///.file/id=… reference URLs.
                    // Foundation resolves these against the filesystem before Rust opens them.
                    let path = url
                        .filePathURL()
                        .and_then(|url| url.path())
                        .ok_or("剪贴板文件已被移动或无法访问")?;
                    let file = existing_file(Path::new(&path.to_string()))?;
                    if !files
                        .iter()
                        .any(|previous: &Attachment| previous.path == file.path)
                    {
                        files.push(file);
                    }
                }
            }
        }
        if !files.is_empty() {
            return Ok(files);
        }
        let name = format!("截图-{}.png", chrono::Local::now().format("%Y%m%d-%H%M%S"));
        if let Some(data) = board.dataForType(&NSString::from_str("public.png")) {
            if data.length() > MAX_BYTES {
                return Err("剪贴板图片超过 32 MB".into());
            }
            return Ok(vec![persist(root, &name, &data.to_vec())?]);
        }
        if let Some(data) = board.dataForType(&NSString::from_str("public.tiff")) {
            if data.length() > MAX_BYTES {
                return Err("剪贴板图片超过 32 MB".into());
            }
            let image = NSBitmapImageRep::initWithData(NSBitmapImageRep::alloc(), &data)
                .ok_or("无法解码剪贴板图片")?;
            // The empty dictionary contains no incorrectly typed property values.
            let png = unsafe {
                image.representationUsingType_properties(
                    NSBitmapImageFileType::PNG,
                    &NSDictionary::new(),
                )
            }
            .ok_or("无法保存剪贴板图片")?;
            return Ok(vec![persist(root, &name, &png.to_vec())?]);
        }
        Ok(Vec::new())
    })
}

#[cfg(not(target_os = "macos"))]
fn read_native(_root: &Path) -> Result<Vec<Attachment>, String> {
    Ok(Vec::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn previews_image_bytes_and_rejects_text_missing_relative_and_oversized_files() {
        let root = tempfile::tempdir().unwrap();
        let png = STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=").unwrap();
        let path = root.path().join("图片 with spaces.png");
        fs::write(&path, &png).unwrap();
        assert_eq!(
            image_preview(path.to_str().unwrap()).unwrap(),
            format!("data:image/png;base64,{}", STANDARD.encode(&png))
        );
        fs::write(&path, b"<svg onload='doNotExecute()'/>").unwrap();
        assert!(image_preview(path.to_str().unwrap()).is_err());
        fs::File::create(&path)
            .unwrap()
            .set_len(MAX_BYTES as u64 + 1)
            .unwrap();
        assert!(image_preview(path.to_str().unwrap()).is_err());
        assert!(image_preview("relative.png").is_err());
        assert!(image_preview(root.path().to_str().unwrap()).is_err());
        assert!(image_preview(root.path().join("missing.png").to_str().unwrap()).is_err());
    }

    #[test]
    fn persists_exact_bytes_with_safe_unique_paths_and_original_names() {
        let root = tempfile::tempdir().unwrap();
        let first = persist(root.path(), "../../中文 screenshot.png", b"image bytes").unwrap();
        let second = persist(root.path(), "中文 screenshot.png", b"next image").unwrap();
        assert_eq!(first.name, "中文 screenshot.png");
        assert_ne!(first.path, second.path);
        assert!(Path::new(&first.path).starts_with(root.path().join("attachments")));
        assert_eq!(fs::read(first.path).unwrap(), b"image bytes");
        assert!(persist(root.path(), "bad\nname", b"x").is_err());
    }

    #[test]
    fn original_files_are_referenced_without_copying_or_modifying() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("报告 with spaces.pdf");
        fs::write(&path, b"original").unwrap();
        let attachment = existing_file(&path).unwrap();
        assert_eq!(attachment.name, "报告 with spaces.pdf");
        assert_eq!(
            Path::new(&attachment.path),
            fs::canonicalize(&path).unwrap()
        );
        assert_eq!(fs::read(&path).unwrap(), b"original");
        assert!(existing_file(root.path()).is_err());
        assert!(existing_file(&root.path().join("missing")).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn native_pasteboard_reads_multiple_file_urls_and_png_tiff_images() {
        use objc2::{runtime::ProtocolObject, AllocAnyThread};
        use objc2_app_kit::{
            NSBitmapImageFileType, NSBitmapImageRep, NSPasteboard, NSPasteboardItem,
        };
        use objc2_foundation::{NSArray, NSData, NSDictionary, NSString, NSURL};
        let root = tempfile::tempdir().unwrap();
        // Isolated named pasteboard: never replace the user's general clipboard.
        let board = NSPasteboard::pasteboardWithName(&NSString::from_str(&format!(
            "goalward-test-{}",
            uuid::Uuid::new_v4()
        )));
        let paths = [
            root.path().join("中文 #报告.pdf"),
            root.path().join("image with spaces.png"),
        ];
        let items: Vec<_> = paths
            .iter()
            .map(|path| {
                fs::write(path, b"source content").unwrap();
                let item = NSPasteboardItem::new();
                let url = NSString::from_str(tauri::Url::from_file_path(path).unwrap().as_str());
                let value = if path.extension().is_some_and(|value| value == "png") {
                    let reference = NSURL::URLWithString(&url)
                        .unwrap()
                        .fileReferenceURL()
                        .unwrap()
                        .absoluteString()
                        .unwrap();
                    assert!(reference.to_string().contains("/.file/id="));
                    reference
                } else {
                    url
                };
                assert!(item.setString_forType(&value, &NSString::from_str("public.file-url")));
                item
            })
            .collect();
        assert!(board.writeObjects(&NSArray::from_slice(
            &items
                .iter()
                .map(|item| ProtocolObject::from_ref(&**item))
                .collect::<Vec<_>>()
        )));
        let files = read_board(root.path(), &board).unwrap();
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].name, "中文 #报告.pdf");
        assert_eq!(files[1].name, "image with spaces.png");
        assert_eq!(fs::read(&files[1].path).unwrap(), b"source content");

        let png = STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=").unwrap();
        let data = NSData::with_bytes(&png);
        board.clearContents();
        assert!(board.setData_forType(Some(&data), &NSString::from_str("public.png")));
        let saved = read_board(root.path(), &board).unwrap();
        assert_eq!(fs::read(&saved[0].path).unwrap(), png);

        let image = NSBitmapImageRep::initWithData(NSBitmapImageRep::alloc(), &data).unwrap();
        let tiff = unsafe {
            image.representationUsingType_properties(
                NSBitmapImageFileType::TIFF,
                &NSDictionary::new(),
            )
        }
        .unwrap();
        let tiff_path = root.path().join("预览.tiff");
        fs::write(&tiff_path, tiff.to_vec()).unwrap();
        assert!(image_preview(tiff_path.to_str().unwrap())
            .unwrap()
            .starts_with("data:image/png;base64,"));
        board.clearContents();
        assert!(board.setData_forType(Some(&tiff), &NSString::from_str("public.tiff")));
        let saved = read_board(root.path(), &board).unwrap();
        let encoded = fs::read(&saved[0].path).unwrap();
        assert!(encoded.starts_with(b"\x89PNG\r\n\x1a\n"));
        assert!(NSBitmapImageRep::initWithData(
            NSBitmapImageRep::alloc(),
            &NSData::with_bytes(&encoded)
        )
        .is_some());

        board.clearContents();
        assert!(board.setString_forType(
            &NSString::from_str("ordinary text"),
            &NSString::from_str("public.utf8-plain-text")
        ));
        assert!(read_board(root.path(), &board).unwrap().is_empty());
        board.clearContents();
    }
}
