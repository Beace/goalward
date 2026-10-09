//! One-time, non-destructive migration after changing the macOS bundle identifier.
//! The old directory remains available to the previous app and for recovery.
use super::{private_directory, private_file};
use std::{
    ffi::OsStr,
    fs::{self, File},
    io::{self, Read},
    path::Path,
};

const LEGACY_DIRECTORY: &str = "dev.superagents.desktop";
const CURRENT_DIRECTORY: &str = "dev.goalward.desktop";

pub(crate) fn migrate_legacy_data(new_root: &Path) -> Result<(), String> {
    if new_root.file_name() != Some(OsStr::new(CURRENT_DIRECTORY)) {
        return Err("Unexpected Goalward data directory; migration was not attempted".into());
    }
    let parent = new_root
        .parent()
        .ok_or("Goalward data directory has no parent")?;
    let old_root = parent.join(LEGACY_DIRECTORY);
    match fs::symlink_metadata(new_root) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => return Ok(()),
        Ok(_) => return Err("Goalward data path is not a regular directory; preserved".into()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("Cannot inspect Goalward data directory: {error}")),
    }
    let old_metadata = match fs::symlink_metadata(&old_root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("Cannot inspect previous app data: {error}")),
    };
    if !old_metadata.is_dir() || old_metadata.file_type().is_symlink() {
        return Err("Previous app data is not a regular directory; preserved".into());
    }

    let stage = parent.join(format!(
        ".{CURRENT_DIRECTORY}.migration-{}",
        uuid::Uuid::new_v4()
    ));
    private_directory(&stage)?;
    let result = (|| {
        copy_tree(&old_root, &stage)?;
        // Detect changes to the old workspace during the copy, including new files.
        compare_tree(&old_root, &stage)?;
        validate_workspace(&stage)?;
        publish_without_replacing(&stage, new_root)?;
        Ok::<(), String>(())
    })();
    if result.is_err() {
        // Only the uniquely named staging directory created above is removed.
        let _ = fs::remove_dir_all(&stage);
    }
    result
}

fn copy_tree(source: &Path, destination: &Path) -> Result<(), String> {
    for entry in fs::read_dir(source).map_err(|e| format!("Cannot read previous app data: {e}"))? {
        let entry = entry.map_err(|e| format!("Cannot read previous app data entry: {e}"))?;
        let from = entry.path();
        let to = destination.join(entry.file_name());
        let kind = entry
            .file_type()
            .map_err(|e| format!("Cannot inspect previous app data: {e}"))?;
        if kind.is_dir() {
            private_directory(&to)?;
            copy_tree(&from, &to)?;
        } else if kind.is_file() {
            let mut input =
                File::open(&from).map_err(|e| format!("Cannot read previous app data: {e}"))?;
            let mut output = private_file(&to, false)?;
            io::copy(&mut input, &mut output)
                .map_err(|e| format!("Cannot copy previous app data: {e}"))?;
            output
                .sync_all()
                .map_err(|e| format!("Cannot flush migrated app data: {e}"))?;
        } else {
            // Following symlinks or special files could copy data outside the app directory.
            return Err("Previous app data contains a symlink or special file; preserved".into());
        }
    }
    Ok(())
}

fn compare_tree(source: &Path, destination: &Path) -> Result<(), String> {
    let source_entries = fs::read_dir(source)
        .map_err(|e| format!("Cannot verify previous app data: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Cannot verify previous app data: {e}"))?;
    let destination_count = fs::read_dir(destination)
        .map_err(|e| format!("Cannot verify migrated app data: {e}"))?
        .count();
    if source_entries.len() != destination_count {
        return Err("Previous app data changed during migration; original preserved".into());
    }
    for entry in source_entries {
        let from = entry.path();
        let to = destination.join(entry.file_name());
        let kind = entry
            .file_type()
            .map_err(|e| format!("Cannot verify previous app data: {e}"))?;
        let copied = fs::symlink_metadata(&to)
            .map_err(|e| format!("Cannot verify migrated app data: {e}"))?;
        if kind.is_dir() && copied.is_dir() {
            compare_tree(&from, &to)?;
        } else if kind.is_file() && copied.is_file() {
            if !files_equal(&from, &to)
                .map_err(|e| format!("Cannot verify migrated app data: {e}"))?
            {
                return Err(
                    "Previous app data changed during migration; original preserved".into(),
                );
            }
        } else {
            return Err("Previous app data changed during migration; original preserved".into());
        }
    }
    Ok(())
}

fn files_equal(source: &Path, destination: &Path) -> io::Result<bool> {
    let mut source = File::open(source)?;
    let mut destination = File::open(destination)?;
    if source.metadata()?.len() != destination.metadata()?.len() {
        return Ok(false);
    }
    let mut left = [0_u8; 64 * 1024];
    let mut right = [0_u8; 64 * 1024];
    loop {
        let count = source.read(&mut left)?;
        if count == 0 {
            return Ok(true);
        }
        destination.read_exact(&mut right[..count])?;
        if left[..count] != right[..count] {
            return Ok(false);
        }
    }
}

fn validate_workspace(root: &Path) -> Result<(), String> {
    let database = root.join("workspace.sqlite3");
    if !database.exists() {
        return Ok(());
    }
    let connection = rusqlite::Connection::open(&database)
        .map_err(|e| format!("Cannot open migrated workspace database: {e}"))?;
    let result: String = connection
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(|e| format!("Cannot verify migrated workspace database: {e}"))?;
    if result != "ok" {
        return Err(
            "Migrated workspace database failed integrity check; original preserved".into(),
        );
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn publish_without_replacing(stage: &Path, destination: &Path) -> Result<(), String> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let from = CString::new(stage.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
    let to = CString::new(destination.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
    // RENAME_EXCL prevents replacing a directory another process created meanwhile.
    let status = unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) };
    if status == 0 {
        Ok(())
    } else {
        Err(format!(
            "Cannot publish migrated app data without replacing existing data: {}",
            io::Error::last_os_error()
        ))
    }
}

#[cfg(not(target_os = "macos"))]
fn publish_without_replacing(_stage: &Path, _destination: &Path) -> Result<(), String> {
    Err("Automatic app data migration is only supported on macOS; original preserved".into())
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn migrates_without_changing_legacy_data_or_replacing_goalward_data() {
        let directory = tempfile::tempdir().unwrap();
        let old = directory.path().join(LEGACY_DIRECTORY);
        let new = directory.path().join(CURRENT_DIRECTORY);
        private_directory(&old).unwrap();
        private_directory(&old.join("attachments")).unwrap();
        fs::write(old.join("attachments/example.txt"), "original attachment").unwrap();
        fs::write(old.join("state.json"), "{\"version\":2}").unwrap();
        let db = rusqlite::Connection::open(old.join("workspace.sqlite3")).unwrap();
        db.execute_batch(
            "CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES ('old');",
        )
        .unwrap();
        drop(db);

        migrate_legacy_data(&new).unwrap();
        assert_eq!(
            fs::read_to_string(old.join("attachments/example.txt")).unwrap(),
            "original attachment"
        );
        assert_eq!(
            fs::read_to_string(new.join("attachments/example.txt")).unwrap(),
            "original attachment"
        );
        assert_eq!(
            fs::read_to_string(old.join("state.json")).unwrap(),
            "{\"version\":2}"
        );
        assert_eq!(
            fs::read_to_string(new.join("state.json")).unwrap(),
            "{\"version\":2}"
        );

        fs::write(new.join("state.json"), "new workspace").unwrap();
        migrate_legacy_data(&new).unwrap();
        assert_eq!(
            fs::read_to_string(new.join("state.json")).unwrap(),
            "new workspace"
        );
        assert_eq!(
            fs::read_to_string(old.join("state.json")).unwrap(),
            "{\"version\":2}"
        );
    }

    #[test]
    fn refuses_symlinks_without_creating_the_goalward_directory() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let old = directory.path().join(LEGACY_DIRECTORY);
        let new = directory.path().join(CURRENT_DIRECTORY);
        private_directory(&old).unwrap();
        symlink(directory.path(), old.join("outside")).unwrap();
        assert!(migrate_legacy_data(&new).unwrap_err().contains("symlink"));
        assert!(!new.exists());
        assert!(old.join("outside").is_symlink());
    }
}
