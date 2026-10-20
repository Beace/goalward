use serde::Serialize;
use std::{
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};
use tauri::Manager;

const MAX_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BackgroundImageError {
    ImageNotFound,
    ImageReadFailed,
    NotAnImageFile,
    ImageTooLarge,
    ImageCorrupt,
    StoragePathInvalid,
    MissingAbsolutePath,
    InvalidFileName,
    PathContainsTraversal,
    OutsideManagedDirectory,
}

impl std::fmt::Display for BackgroundImageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ImageNotFound => write!(f, "image_not_found"),
            Self::ImageReadFailed => write!(f, "image_read_failed"),
            Self::NotAnImageFile => write!(f, "not_an_image_file"),
            Self::ImageTooLarge => write!(f, "image_too_large"),
            Self::ImageCorrupt => write!(f, "image_corrupt"),
            Self::StoragePathInvalid => write!(f, "storage_path_invalid"),
            Self::MissingAbsolutePath => write!(f, "missing_absolute_path"),
            Self::InvalidFileName => write!(f, "invalid_file_name"),
            Self::PathContainsTraversal => write!(f, "path_contains_traversal"),
            Self::OutsideManagedDirectory => write!(f, "outside_managed_directory"),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct BackgroundImage {
    name: String,
    path: String,
}

fn managed_directory(root: &Path) -> PathBuf {
    root.join("appearance").join("backgrounds")
}

fn bounded_bytes(path: &Path) -> Result<Vec<u8>, BackgroundImageError> {
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
        .map_err(|_| BackgroundImageError::ImageNotFound)?;
    let metadata = file
        .metadata()
        .map_err(|_| BackgroundImageError::ImageReadFailed)?;
    if !metadata.is_file() {
        return Err(BackgroundImageError::NotAnImageFile);
    }
    if metadata.len() > MAX_BYTES {
        return Err(BackgroundImageError::ImageTooLarge);
    }
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| BackgroundImageError::ImageReadFailed)?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(BackgroundImageError::ImageTooLarge);
    }
    Ok(bytes)
}

fn validate_image(path: &Path, bytes: &[u8]) -> Result<(), BackgroundImageError> {
    // Reuse the image preview signature allowlist (which rejects active HTML and SVG).
    crate::attachments::image_data_url(path, bytes.to_vec(), Some(MAX_BYTES))
        .map_err(|_| BackgroundImageError::ImageCorrupt)?;
    #[cfg(target_os = "macos")]
    {
        use objc2::AllocAnyThread;
        use objc2_app_kit::NSBitmapImageRep;
        use objc2_foundation::NSData;
        objc2::rc::autoreleasepool(|_| {
            NSBitmapImageRep::initWithData(NSBitmapImageRep::alloc(), &NSData::with_bytes(bytes))
                .map(|_| ())
                .ok_or(BackgroundImageError::ImageCorrupt)
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

fn prepare_managed_directory(root: &Path) -> Result<PathBuf, BackgroundImageError> {
    private_directory(root, true).map_err(|_| BackgroundImageError::StoragePathInvalid)?;
    let mut directory =
        fs::canonicalize(root).map_err(|_| BackgroundImageError::StoragePathInvalid)?;
    // Do not let a replaced managed directory redirect imports outside app storage.
    for component in ["appearance", "backgrounds"] {
        directory = directory.join(component);
        match fs::symlink_metadata(&directory) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Ok(_) => return Err(BackgroundImageError::StoragePathInvalid),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                private_directory(&directory, false)
                    .map_err(|_| BackgroundImageError::StoragePathInvalid)?;
            }
            Err(_) => return Err(BackgroundImageError::StoragePathInvalid),
        }
    }
    Ok(directory)
}

fn import_image(root: &Path, source: &Path) -> Result<BackgroundImage, BackgroundImageError> {
    if !source.is_absolute() {
        return Err(BackgroundImageError::MissingAbsolutePath);
    }
    let name = source
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|name| !name.is_empty() && !name.chars().any(char::is_control))
        .ok_or(BackgroundImageError::InvalidFileName)?;
    let source = fs::canonicalize(source).map_err(|_| BackgroundImageError::ImageNotFound)?;
    let bytes = bounded_bytes(&source)?;
    // Keep the selected filename's extension when the source was a symlink.
    validate_image(Path::new(name), &bytes)?;
    let managed = prepare_managed_directory(root)?;
    let directory = managed.join(uuid::Uuid::new_v4().to_string());
    private_directory(&directory, false).map_err(|_| BackgroundImageError::StoragePathInvalid)?;
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
            .map_err(|_| BackgroundImageError::StoragePathInvalid)?;
        file.write_all(&bytes)
            .map_err(|_| BackgroundImageError::StoragePathInvalid)?;
        file.sync_all()
            .map_err(|_| BackgroundImageError::StoragePathInvalid)?;
        drop(file);
        fs::rename(&temporary, &destination)
            .map_err(|_| BackgroundImageError::StoragePathInvalid)?;
        #[cfg(unix)]
        fs::File::open(&directory)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| BackgroundImageError::StoragePathInvalid)?;
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

fn validate_managed_path(root: &Path, path: &Path) -> Result<PathBuf, BackgroundImageError> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err(BackgroundImageError::PathContainsTraversal);
    }
    let managed = fs::canonicalize(managed_directory(root))
        .map_err(|_| BackgroundImageError::ImageNotFound)?;
    let canonical_root =
        fs::canonicalize(root).map_err(|_| BackgroundImageError::StoragePathInvalid)?;
    if !managed.starts_with(&canonical_root) {
        return Err(BackgroundImageError::StoragePathInvalid);
    }
    let canonical_path = fs::canonicalize(path).map_err(|_| BackgroundImageError::ImageNotFound)?;
    if !canonical_path.starts_with(&managed) || canonical_path == managed {
        return Err(BackgroundImageError::OutsideManagedDirectory);
    }
    Ok(canonical_path)
}

fn validate_image_file(root: &Path, path: &Path) -> Result<PathBuf, BackgroundImageError> {
    let canonical_path = validate_managed_path(root, path)?;
    let bytes = bounded_bytes(&canonical_path)?;
    // Validate image format; the returned data URL is discarded since we use the asset protocol.
    crate::attachments::image_data_url(&canonical_path, bytes, Some(MAX_BYTES))
        .map_err(|_| BackgroundImageError::ImageCorrupt)?;
    Ok(canonical_path)
}

#[derive(Debug, Serialize)]
pub struct BackgroundImageResult {
    #[serde(flatten)]
    pub image: BackgroundImage,
}

#[derive(Debug, Serialize)]
pub struct BackgroundAssetResult {
    /// Canonical managed path. The webview turns this into a URL with `convertFileSrc`.
    pub path: String,
}

#[derive(Debug, Serialize)]
pub struct BackgroundErrorResult {
    pub error: BackgroundImageError,
}

#[tauri::command]
pub async fn import_background_image(
    window: tauri::WebviewWindow,
    path: String,
) -> Result<BackgroundImageResult, BackgroundErrorResult> {
    if window.label() != "main" {
        return Err(BackgroundErrorResult {
            error: BackgroundImageError::StoragePathInvalid,
        });
    }
    let root = window
        .app_handle()
        .path()
        .app_data_dir()
        .map_err(|_| BackgroundErrorResult {
            error: BackgroundImageError::StoragePathInvalid,
        })?;
    tauri::async_runtime::spawn_blocking(move || import_image(&root, Path::new(&path)))
        .await
        .map_err(|_| BackgroundErrorResult {
            error: BackgroundImageError::StoragePathInvalid,
        })?
        .map(|image| BackgroundImageResult { image })
        .map_err(|error| BackgroundErrorResult { error })
}

#[tauri::command]
pub async fn read_background_image(
    window: tauri::WebviewWindow,
    path: String,
) -> Result<BackgroundAssetResult, BackgroundErrorResult> {
    if window.label() != "main" {
        return Err(BackgroundErrorResult {
            error: BackgroundImageError::StoragePathInvalid,
        });
    }
    let root = window
        .app_handle()
        .path()
        .app_data_dir()
        .map_err(|_| BackgroundErrorResult {
            error: BackgroundImageError::StoragePathInvalid,
        })?;
    let canonical_path =
        tauri::async_runtime::spawn_blocking(move || validate_image_file(&root, Path::new(&path)))
            .await
            .map_err(|_| BackgroundErrorResult {
                error: BackgroundImageError::StoragePathInvalid,
            })?
            .map_err(|error| BackgroundErrorResult { error })?;

    // The asset protocol is scoped to the managed backgrounds directory.
    // The frontend converts this canonical path with convertFileSrc.
    Ok(BackgroundAssetResult {
        path: canonical_path.to_string_lossy().into_owned(),
    })
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
    fn asset_protocol_is_enabled_only_for_managed_backgrounds() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let security = &config["app"]["security"];
        let protocol = &security["assetProtocol"];
        assert_eq!(protocol["enable"], true);
        assert_eq!(
            protocol["scope"],
            serde_json::json!(["$APPDATA/appearance/backgrounds/**"])
        );
        for key in ["csp", "devCsp"] {
            let csp = security[key].as_str().unwrap();
            assert!(
                csp.contains("img-src")
                    && csp.contains("asset:")
                    && csp.contains("http://asset.localhost"),
                "{key} must allow the asset protocol"
            );
        }
        assert!(
            include_str!("../Cargo.toml").contains("features = [\"protocol-asset\"]"),
            "the tauri crate must enable protocol-asset"
        );
    }

    #[test]
    fn error_codes_are_serializable_and_stable() {
        assert_eq!(
            serde_json::to_string(&BackgroundImageError::ImageNotFound).unwrap(),
            r#""image_not_found""#
        );
        assert_eq!(
            serde_json::to_string(&BackgroundImageError::ImageTooLarge).unwrap(),
            r#""image_too_large""#
        );
        assert_eq!(
            serde_json::to_string(&BackgroundImageError::OutsideManagedDirectory).unwrap(),
            r#""outside_managed_directory""#
        );
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
        // validate_image_file returns the canonical path for use with asset protocol
        let canonical =
            validate_image_file(&temp.path().join("app"), Path::new(&image.path)).unwrap();
        assert!(canonical.exists());
        assert!(validate_image_file(&temp.path().join("app"), Path::new(&next.path)).is_ok());
    }

    #[test]
    fn invalid_oversized_missing_and_non_file_sources_are_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("image.png");
        fs::write(&source, b"<svg xmlns='http://www.w3.org/2000/svg'></svg>").unwrap();
        assert_eq!(
            import_image(temp.path(), &source).unwrap_err(),
            BackgroundImageError::ImageCorrupt
        );
        fs::File::create(&source)
            .unwrap()
            .set_len(MAX_BYTES + 1)
            .unwrap();
        assert_eq!(
            import_image(temp.path(), &source).unwrap_err(),
            BackgroundImageError::ImageTooLarge
        );
        assert_eq!(
            import_image(temp.path(), &temp.path().join("missing.png")).unwrap_err(),
            BackgroundImageError::ImageNotFound
        );
        assert_eq!(
            import_image(temp.path(), temp.path()).unwrap_err(),
            BackgroundImageError::NotAnImageFile
        );
        assert_eq!(
            import_image(temp.path(), Path::new("relative.png")).unwrap_err(),
            BackgroundImageError::MissingAbsolutePath
        );
        assert!(!managed_directory(temp.path()).exists());
    }

    #[test]
    fn reads_reject_outside_paths_traversal_missing_and_oversized_files() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("image.png");
        fs::write(&source, png()).unwrap();
        let image = import_image(temp.path(), &source).unwrap();
        assert_eq!(
            validate_image_file(temp.path(), &source).unwrap_err(),
            BackgroundImageError::OutsideManagedDirectory
        );
        assert_eq!(
            validate_image_file(
                temp.path(),
                &managed_directory(temp.path()).join("../outside.png")
            )
            .unwrap_err(),
            BackgroundImageError::PathContainsTraversal
        );
        assert_eq!(
            validate_managed_path(temp.path(), Path::new("relative.png")).unwrap_err(),
            BackgroundImageError::PathContainsTraversal
        );
        fs::File::create(&image.path)
            .unwrap()
            .set_len(MAX_BYTES + 1)
            .unwrap();
        assert_eq!(
            validate_image_file(temp.path(), Path::new(&image.path)).unwrap_err(),
            BackgroundImageError::ImageTooLarge
        );
        fs::remove_file(&image.path).unwrap();
        assert_eq!(
            validate_image_file(temp.path(), Path::new(&image.path)).unwrap_err(),
            BackgroundImageError::ImageNotFound
        );
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
        assert_eq!(
            validate_image_file(temp.path(), &escape).unwrap_err(),
            BackgroundImageError::OutsideManagedDirectory
        );
        let parent_escape = managed_directory(temp.path()).join("escape-folder");
        symlink(temp.path(), &parent_escape).unwrap();
        assert_eq!(
            validate_image_file(temp.path(), &parent_escape.join("source.png")).unwrap_err(),
            BackgroundImageError::OutsideManagedDirectory
        );
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
        assert_eq!(
            import_image(app.path(), &source).unwrap_err(),
            BackgroundImageError::StoragePathInvalid
        );
        assert_eq!(
            validate_image_file(
                app.path(),
                &managed_directory(app.path()).join("source.png")
            )
            .unwrap_err(),
            BackgroundImageError::StoragePathInvalid
        );
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 1);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn corrupt_images_with_valid_signatures_are_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("corrupt.png");
        fs::write(&source, b"\x89PNG\r\n\x1a\ninvalid").unwrap();
        assert_eq!(
            import_image(temp.path(), &source).unwrap_err(),
            BackgroundImageError::ImageCorrupt
        );
    }
}
