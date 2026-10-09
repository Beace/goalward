//! Read-only startup I/O profile. Pass an existing application data directory.
//! No state/trace contents are printed and no save operation is performed.
#[allow(dead_code)]
#[path = "../src/storage.rs"]
mod storage;
#[allow(dead_code)]
#[path = "../src/types.rs"]
mod types;

use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    time::Instant,
};
use types::TraceRef;

fn main() -> Result<(), String> {
    let root = PathBuf::from(
        std::env::args()
            .nth(1)
            .ok_or("Pass an existing application data directory")?,
    );
    if !root.join("state.json").is_file() {
        return Err("state.json does not exist; nothing changed".into());
    }
    let storage = storage::Storage::new(root)?;
    let start = Instant::now();
    let state = storage.load_legacy()?.ok_or("Missing state")?;
    let read_ms = start.elapsed().as_secs_f64() * 1000.0;
    let tasks = state["tasks"].as_array().ok_or("Missing tasks")?;
    let mut refs = Vec::new();
    let mut known = HashMap::<String, HashSet<String>>::new();
    for task in tasks
        .iter()
        .filter(|task| task["demo"].as_bool() != Some(true))
    {
        let task_id = task["id"].as_str().ok_or("Invalid task ID")?;
        known.insert(
            task_id.into(),
            task["events"]
                .as_array()
                .ok_or("Missing events")?
                .iter()
                .filter_map(|event| event["id"].as_str().map(String::from))
                .collect(),
        );
        for run in task["runs"].as_array().ok_or("Missing runs")? {
            for member in run["members"].as_array().ok_or("Missing members")? {
                refs.push(TraceRef {
                    task_id: task_id.into(),
                    run_id: run["id"].as_str().ok_or("Invalid run ID")?.into(),
                    member_id: member["id"].as_str().ok_or("Invalid member ID")?.into(),
                });
            }
        }
    }
    let start = Instant::now();
    let full = storage.load_trace_events_except(&refs, &HashMap::new())?;
    let full_read_ms = start.elapsed().as_secs_f64() * 1000.0;
    let start = Instant::now();
    let full_json = serde_json::to_vec(&full).map_err(|e| e.to_string())?;
    let full_serialize_ms = start.elapsed().as_secs_f64() * 1000.0;
    let start = Instant::now();
    let missing = storage.load_trace_events_except(&refs, &known)?;
    let missing_read_ms = start.elapsed().as_secs_f64() * 1000.0;
    let missing_json = serde_json::to_vec(&missing).map_err(|e| e.to_string())?;
    println!(
        "{}",
        serde_json::json!({
            "stateReadMs": read_ms, "fullTraceReadMs": full_read_ms,
            "fullTraceSerializeMs": full_serialize_ms, "missingTraceReadMs": missing_read_ms,
            "fullEvents": full.len(), "missingEvents": missing.len(),
            "fullResponseBytes": full_json.len(), "missingResponseBytes": missing_json.len()
        })
    );
    Ok(())
}
