//! Compare legacy snapshot writes with split storage using an isolated temporary
//! copy. The supplied application directory is read-only; no contents are printed.
#[allow(dead_code)]
#[path = "../src/storage.rs"]
mod storage;
#[allow(dead_code)]
#[path = "../src/types.rs"]
mod types;

use serde_json::{json, Value};
use std::{fs, io::Write, path::PathBuf, time::Instant};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let source = PathBuf::from(
        std::env::args()
            .nth(1)
            .ok_or("Pass an application data directory")?,
    );
    let original = fs::read(source.join("state.json"))?;
    let start = Instant::now();
    let state: Value = serde_json::from_slice(&original)?;
    let legacy_parse_ms = start.elapsed().as_secs_f64() * 1000.;
    let directory = tempfile::tempdir()?;
    let root = directory.path();
    storage::private_file(&root.join("state.json"), false)?.write_all(&original)?;
    let store = storage::Storage::new(root.into())?;
    let start = Instant::now();
    let loaded = store.load()?.ok_or("Missing migrated state")?;
    let migration_ms = start.elapsed().as_secs_f64() * 1000.;
    assert_eq!(state, loaded, "Migration changed data");
    assert_eq!(fs::read(root.join("state.json"))?, original);
    drop(loaded);
    drop(store);
    let store = storage::Storage::new(root.into())?;
    let start = Instant::now();
    let summary = store.summary()?.ok_or("Missing summary")?;
    let summary_read_ms = start.elapsed().as_secs_f64() * 1000.;
    let start = Instant::now();
    let summary_bytes = serde_json::to_vec(&summary)?.len();
    let summary_serialize_ms = start.elapsed().as_secs_f64() * 1000.;
    let mut page_count = 0;
    let mut max_page_bytes = 0;
    let start = Instant::now();
    for task in state["tasks"].as_array().ok_or("Missing tasks")? {
        let id = task["id"].as_str().ok_or("Missing task ID")?;
        let mut after = -1;
        let mut through = None;
        let mut restored = Vec::new();
        loop {
            let page = store.event_page(id, after, through)?;
            page_count += 1;
            max_page_bytes = max_page_bytes.max(serde_json::to_vec(&page)?.len());
            restored.extend(
                page["events"]
                    .as_array()
                    .ok_or("Missing events")?
                    .iter()
                    .cloned(),
            );
            let Some(next) = page["next"].as_i64() else {
                break;
            };
            after = next;
            through = page["through"].as_i64();
        }
        assert_eq!(
            Value::Array(restored),
            task["events"],
            "Paged history changed data"
        );
    }
    let paged_read_serialize_compare_ms = start.elapsed().as_secs_f64() * 1000.;
    let start = Instant::now();
    assert_eq!(store.load()?.as_ref(), Some(&state));
    let reopen_ms = start.elapsed().as_secs_f64() * 1000.;
    let mut delta = state.clone();
    for task in delta["tasks"].as_array_mut().ok_or("Missing tasks")? {
        task["events"] = json!([]);
    }
    delta["activeTaskId"] = json!("profile-selection");
    let start = Instant::now();
    let payload = serde_json::to_vec(&delta)?;
    let delta_serialize_ms = start.elapsed().as_secs_f64() * 1000.;
    let mut full = state.clone();
    full["activeTaskId"] = delta["activeTaskId"].clone();
    let start = Instant::now();
    let bytes = serde_json::to_vec(&full)?;
    let mut file = storage::private_file(&root.join("legacy-benchmark.tmp"), false)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    fs::rename(
        root.join("legacy-benchmark.tmp"),
        root.join("legacy-benchmark.json"),
    )?;
    fs::File::open(root)?.sync_all()?;
    let legacy_save_ms = start.elapsed().as_secs_f64() * 1000.;
    let before = fs::read(root.join("workspace.sqlite3"))?;
    let start = Instant::now();
    store.save_delta(&delta)?;
    let delta_save_ms = start.elapsed().as_secs_f64() * 1000.;
    let after = fs::read(root.join("workspace.sqlite3"))?;
    let changed_pages = before
        .chunks(4096)
        .zip(after.chunks(4096))
        .filter(|(a, b)| a != b)
        .count();
    assert_eq!(store.load()?.as_ref(), Some(&full));
    let tasks = full["tasks"].as_array().ok_or("Missing tasks")?;
    for task in tasks {
        let exported: Value = serde_json::from_slice(&fs::read(store.export(task)?)?)?;
        assert_eq!(&exported, task);
    }
    assert_eq!(
        fs::read(source.join("state.json"))?,
        original,
        "Source changed during profile"
    );
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "legacyBytes":original.len(), "metadataPayloadBytes":payload.len(),
            "summaryReadMs":summary_read_ms, "summaryBytes":summary_bytes,"summarySerializeMs":summary_serialize_ms,
            "historyPageCount":page_count,"maxHistoryPageBytes":max_page_bytes,"pagedReadSerializeCompareMs":paged_read_serialize_compare_ms,"pagedHistoryExactEquality":true,
            "databaseBytes":after.len(), "changed4096BytePages":changed_pages,
            "legacyParseMs":legacy_parse_ms,"migrationIncludingLoadMs":migration_ms,"databaseReopenIncludingComparisonMs":reopen_ms,
            "legacySerializeAndSaveMs":legacy_save_ms,"deltaSerializeMs":delta_serialize_ms,"deltaSaveMs":delta_save_ms,
        "migrationExactEquality":true,"reopenExactEquality":true,"metadataSavePreservesEvents":true,"exportExactEquality":true,"exportedTasks":tasks.len(),"sourceUnchanged":true
        }))?
    );
    Ok(())
}
