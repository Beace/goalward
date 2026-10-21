//! Stable codes for user-facing native diagnostics.
//! The frontend maps each code to the selected UI language. Variable data
//! follows a unit separator and is never translated.

const SEPARATOR: char = '\u{1f}';

pub fn diagnostic(id: &'static str) -> String {
    id.to_string()
}

pub fn diagnostic_with(id: &'static str, value: impl std::fmt::Display) -> String {
    let value = value.to_string().replace(SEPARATOR, " ");
    format!("{id}{SEPARATOR}{value}")
}

pub fn trying_local_cache(cause: &str) -> String {
    diagnostic_with("trying_local_cache", cause)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::Path};

    #[test]
    fn codes_keep_variable_data_and_strip_the_separator() {
        assert_eq!(diagnostic("local_scan_failed"), "local_scan_failed");
        assert_eq!(
            diagnostic_with("config_invalid_utf8", "/tmp/café\u{1f}.toml"),
            "config_invalid_utf8\u{1f}/tmp/café .toml"
        );
        assert_eq!(
            trying_local_cache("traex_query_timeout"),
            "trying_local_cache\u{1f}traex_query_timeout"
        );
    }

    #[test]
    fn native_user_facing_modules_do_not_embed_chinese() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        for relative in [
            "diagnostics.rs",
            "lib.rs",
            "pi_query.rs",
            "traex_query.rs",
            "local_discovery.rs",
            "local_discovery/pi.rs",
            "local_discovery/traex.rs",
        ] {
            let text = fs::read_to_string(root.join(relative)).unwrap();
            assert!(
                !text
                    .chars()
                    .any(|character| ('\u{4e00}'..='\u{9fff}').contains(&character)),
                "{relative} still embeds Chinese user-facing text"
            );
        }
    }
}
