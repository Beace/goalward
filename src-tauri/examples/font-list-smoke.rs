#[path = "../src/fonts.rs"]
#[allow(dead_code)]
mod fonts;
#[cfg(target_os = "macos")]
fn main() {
    let families = fonts::available_font_families().expect("read native macOS font families");
    assert!(families.len() > 10);
    assert!(families.iter().any(|name| name == "Menlo"));
    assert!(families.iter().any(|name| name == "PingFang SC"));
    println!("{}", serde_json::to_string_pretty(&families).unwrap());
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("Font discovery smoke requires macOS");
}
