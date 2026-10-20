//! Observe protocol completion independently of the CLI's process exit code.
use serde_json::Value;

#[derive(Default)]
pub(super) struct Outcome {
    pending: Vec<u8>,
    ended: bool,
    session: Option<String>,
    assistant_stop: Option<String>,
    invalid: bool,
}

impl Outcome {
    pub fn feed(&mut self, bytes: &[u8]) {
        for byte in bytes {
            if *byte == b'\n' {
                let frame = std::mem::take(&mut self.pending);
                self.frame(&frame);
            } else if self.pending.len() < 4 * 1024 * 1024 {
                self.pending.push(*byte);
            } else {
                self.invalid = true;
            }
        }
    }

    fn frame(&mut self, bytes: &[u8]) {
        if bytes.iter().all(u8::is_ascii_whitespace) {
            return;
        }
        let Ok(value) = serde_json::from_slice::<Value>(bytes) else {
            self.invalid = true;
            return;
        };
        match value["type"].as_str() {
            Some("session") => self.session = value["id"].as_str().map(String::from),
            Some("agent_start") => {
                self.ended = false;
                self.assistant_stop = None;
            }
            Some("message_end") if value["message"]["role"] == "assistant" => {
                self.assistant_stop = value["message"]["stopReason"].as_str().map(String::from);
            }
            Some("agent_end") => self.ended = true,
            _ => {}
        }
    }

    pub fn finish(&mut self, expected_session: Option<&str>) -> Result<(), String> {
        let frame = std::mem::take(&mut self.pending);
        self.frame(&frame);
        if self.invalid {
            return Err("The Pi JSON event stream is incomplete or could not be parsed. Check extension output.".into());
        }
        if self.session.as_deref().is_none_or(str::is_empty) {
            return Err("Pi did not return a native session ID.".into());
        }
        if expected_session.is_some_and(|expected| self.session.as_deref() != Some(expected)) {
            return Err(
                "Pi did not continue the requested task session. The session ID does not match."
                    .into(),
            );
        }
        if !self.ended {
            return Err("Pi did not return agent_end. This turn did not complete.".into());
        }
        match self.assistant_stop.as_deref() {
            Some("stop") => Ok(()),
            Some("length") => Err("The Pi answer reached the output length limit. This turn did not complete.".into()),
            Some("error" | "aborted") => {
                Err("The Pi model request failed or was interrupted. Check the error information in Trace.".into())
            }
            _ => Err("Pi did not return a normally completed Agent answer.".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn completion_requires_protocol_success_and_matching_session() {
        for (stop, success) in [
            ("stop", true),
            ("error", false),
            ("aborted", false),
            ("length", false),
            ("toolUse", false),
        ] {
            let input = format!(
                r#"{{"type":"session","id":"exact-id"}}
{{"type":"agent_start"}}
{{"type":"message_end","message":{{"role":"assistant","stopReason":"{stop}"}}}}
{{"type":"agent_end"}}
"#
            );
            let mut outcome = Outcome::default();
            for chunk in input.as_bytes().chunks(7) {
                outcome.feed(chunk);
            }
            assert_eq!(outcome.finish(Some("exact-id")).is_ok(), success);
            assert!(outcome.finish(Some("wrong-id")).is_err());
        }
        let mut missing = Outcome::default();
        missing.feed(b"{\"type\":\"session\",\"id\":\"id\"}\n");
        assert!(missing.finish(None).is_err());
    }
}
