use serde::Serialize;
use std::{
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};
use tauri::Manager;

const MAX_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Debug, Serialize)]
pub struct BackgroundImage {
    name: String,
    path: String,
}

fn managed_directory(root: &Path) -> PathBuf {
    root.join("appearance").join("backgrounds")
}

fn bounded_bytes(path: &Path) -> Result<Vec<u8>, String> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    // The caller resolves the selected source first; reads cannot follow a substituted symlink.
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options
        .open(path)
        .map_err(|_| "背景图片不存在或无法访问，请重新选择图片。")?;
    let metadata = file.metadata().map_err(|_| "无法读取背景图片信息。")?;
    if !metadata.is_file() {
        return Err("此路径不是图片文件。".into());
    }
    if metadata.len() > MAX_BYTES {
        return Err("背景图片超过 32 MB，请选择较小的图片。".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "背景图片读取失败。")?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("背景图片超过 32 MB，请选择较小的图片。".into());
    }
    Ok(bytes)
}

fn validate_image(path: &Path, bytes: &[u8]) -> Result<(), String> {
    // Reuse the image preview signature allowlist (which rejects active HTML and SVG).
    crate::attachments::image_data_url(path, bytes.to_vec(), Some(MAX_BYTES))?;
    #[cfg(target_os = "macos")]
    {
        use objc2::AllocAnyThread;
        use objc2_app_kit::NSBitmapImageRep;
        use objc2_foundation::NSData;
        objc2::rc::autoreleasepool(|_| {
            NSBitmapImageRep::initWithData(NSBitmapImageRep::alloc(), &NSData::with_bytes(bytes))
                .map(|_| ())
                .ok_or_else(|| "背景图片内容已损坏，无法显示。".to_string())
        })?;
    }
    Ok(())
}

fn private_directory(path: &Path, recursive: bool) -> Result<(), String> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(recursive);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path).map_err(|error| error.to_string())
}

fn prepare_managed_directory(root: &Path) -> Result<PathBuf, String> {
    private_directory(root, true)?;
    let mut directory = fs::canonicalize(root).map_err(|error| error.to_string())?;
    // Do not let a replaced managed directory redirect imports outside app storage.
    for component in ["appearance", "backgrounds"] {
        directory = directory.join(component);
        match fs::symlink_metadata(&directory) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Ok(_) => return Err("背景图片存储路径无效。".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                private_directory(&directory, false)?;
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(directory)
}

fn import_image(root: &Path, source: &Path) -> Result<BackgroundImage, String> {
    if !source.is_absolute() {
        return Err("背景图片缺少本地绝对路径。".into());
    }
    let name = source
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|name| !name.is_empty() && !name.chars().any(char::is_control))
        .ok_or("背景图片文件名无效。")?;
    let source =
        fs::canonicalize(source).map_err(|_| "背景图片不存在或无法访问，请重新选择图片。")?;
    let bytes = bounded_bytes(&source)?;
    // Keep the selected filename's extension when the source was a symlink.
    validate_image(Path::new(name), &bytes)?;
    let managed = prepare_managed_directory(root)?;
    let directory = managed.join(uuid::Uuid::new_v4().to_string());
    private_directory(&directory, false)?;
    let temporary = directory.join(".importing");
    let destination = directory.join(name);
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        file.write_all(&bytes).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        drop(file);
        fs::rename(&temporary, &destination).map_err(|error| error.to_string())?;
        #[cfg(unix)]
        fs::File::open(&directory)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| error.to_string())?;
        Ok(BackgroundImage {
            name: name.into(),
            path: destination.to_string_lossy().into_owned(),
        })
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(directory);
    }
    // Prior images remain available for persisted settings and save rollback.
    result
}

fn read_image(root: &Path, path: &Path) -> Result<String, String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err("背景图片路径无效，请重新选择图片。".into());
    }
    let managed = fs::canonicalize(managed_directory(root))
        .map_err(|_| "背景图片不存在，请重新选择图片。")?;
    let canonical_root = fs::canonicalize(root).map_err(|_| "背景图片存储路径无效。")?;
    if !managed.starts_with(&canonical_root) {
        return Err("背景图片存储路径无效。".into());
    }
    let path = fs::canonicalize(path).map_err(|_| "背景图片不存在或已被删除，请重新选择图片。")?;
    if !path.starts_with(&managed) || path == managed {
        return Err("只能读取 App 管理的背景图片。".into());
    }
    let bytes = bounded_bytes(&path)?;
    crate::attachments::image_data_url(&path, bytes, Some(MAX_BYTES))
}

#[tauri::command]
pub async fn import_background_image(
    window: tauri::WebviewWindow,
    path: String,
) -> Result<BackgroundImage, String> {
    if window.label() != "main" {
        return Err("此窗口无法设置背景图片。".into());
    }
    let root = window
        .app_handle()
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || import_image(&root, Path::new(&path)))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn read_background_image(
    window: tauri::WebviewWindow,
    path: String,
) -> Result<String, String> {
    if window.label() != "main" {
        return Err("此窗口无法读取背景图片。".into());
    }
    let root = window
        .app_handle()
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || read_image(&root, Path::new(&path)))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine};

    // A complete one-pixel PNG exercises native decoding as well as signature validation.
    fn png() -> Vec<u8> {
        STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=").unwrap()
    }

    #[test]
    fn imported_bytes_survive_source_deletion_and_remain_available_after_replacement() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("wallpaper.png");
        fs::write(&source, png()).unwrap();
        let image = import_image(&temp.path().join("app"), &source).unwrap();
        let next = import_image(&temp.path().join("app"), &source).unwrap();
        assert_eq!(image.name, "wallpaper.png");
        assert_ne!(image.path, next.path);
        assert_eq!(fs::read(&image.path).unwrap(), png());
        fs::remove_file(source).unwrap();
        assert!(read_image(&temp.path().join("app"), Path::new(&image.path))
            .unwrap()
            .starts_with("data:image/png;base64,"));
        assert!(read_image(&temp.path().join("app"), Path::new(&next.path)).is_ok());
    }

    #[test]
    fn invalid_oversized_missing_and_non_file_sources_are_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("image.png");
        fs::write(&source, b"<svg xmlns='http://www.w3.org/2000/svg'></svg>").unwrap();
        assert!(import_image(temp.path(), &source)
            .unwrap_err()
            .contains("not a supported image"));
        fs::File::create(&source)
            .unwrap()
            .set_len(MAX_BYTES + 1)
            .unwrap();
        assert!(import_image(temp.path(), &source)
            .unwrap_err()
            .contains("32 MB"));
        assert!(import_image(temp.path(), &temp.path().join("missing.png")).is_err());
        assert!(import_image(temp.path(), temp.path())
            .unwrap_err()
            .contains("不是图片文件"));
        assert!(import_image(temp.path(), Path::new("relative.png")).is_err());
        assert!(!managed_directory(temp.path()).exists());
    }

    #[test]
    fn reads_reject_outside_paths_traversal_missing_and_oversized_files() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("image.png");
        fs::write(&source, png()).unwrap();
        let image = import_image(temp.path(), &source).unwrap();
        assert!(read_image(temp.path(), &source)
            .unwrap_err()
            .contains("App 管理"));
        assert!(read_image(
            temp.path(),
            &managed_directory(temp.path()).join("../outside.png")
        )
        .unwrap_err()
        .contains("路径无效"));
        assert!(read_image(temp.path(), Path::new("relative.png")).is_err());
        fs::File::create(&image.path)
            .unwrap()
            .set_len(MAX_BYTES + 1)
            .unwrap();
        assert!(read_image(temp.path(), Path::new(&image.path))
            .unwrap_err()
            .contains("32 MB"));
        fs::remove_file(&image.path).unwrap();
        assert!(read_image(temp.path(), Path::new(&image.path))
            .unwrap_err()
            .contains("不存在"));
    }

    #[cfg(unix)]
    #[test]
    fn assets_are_private_and_reads_reject_symlink_escapes() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source.png");
        fs::write(&source, png()).unwrap();
        let image = import_image(temp.path(), &source).unwrap();
        assert_eq!(
            fs::metadata(&image.path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let directory = Path::new(&image.path).parent().unwrap();
        assert_eq!(
            fs::metadata(directory).unwrap().permissions().mode() & 0o777,
            0o700
        );
        let escape = directory.join("escape.png");
        symlink(&source, &escape).unwrap();
        assert!(read_image(temp.path(), &escape)
            .unwrap_err()
            .contains("App 管理"));
        let parent_escape = managed_directory(temp.path()).join("escape-folder");
        symlink(temp.path(), &parent_escape).unwrap();
        assert!(read_image(temp.path(), &parent_escape.join("source.png"))
            .unwrap_err()
            .contains("App 管理"));
    }

    #[cfg(unix)]
    #[test]
    fn replaced_managed_directory_cannot_redirect_imports_or_reads_outside_app_storage() {
        use std::os::unix::fs::symlink;
        let app = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let source = outside.path().join("source.png");
        fs::write(&source, png()).unwrap();
        private_directory(&app.path().join("appearance"), false).unwrap();
        symlink(outside.path(), managed_directory(app.path())).unwrap();
        assert!(import_image(app.path(), &source)
            .unwrap_err()
            .contains("存储路径无效"));
        assert!(read_image(
            app.path(),
            &managed_directory(app.path()).join("source.png")
        )
        .unwrap_err()
        .contains("存储路径无效"));
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 1);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn corrupt_images_with_valid_signatures_are_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("corrupt.png");
        fs::write(&source, b"\x89PNG\r\n\x1a\ninvalid").unwrap();
        assert!(import_image(temp.path(), &source).is_err());
    }
}
