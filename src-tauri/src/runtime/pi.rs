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
            return Err("Pi 返回的 JSON 事件流不完整或无法解析；请检查扩展输出".into());
        }
        if self.session.as_deref().is_none_or(str::is_empty) {
            return Err("Pi 未返回原生会话 ID".into());
        }
        if expected_session.is_some_and(|expected| self.session.as_deref() != Some(expected)) {
            return Err("Pi 未续接请求的任务会话；会话 ID 不匹配".into());
        }
        if !self.ended {
            return Err("Pi 未返回 agent_end，本轮执行未完成".into());
        }
        match self.assistant_stop.as_deref() {
            Some("stop") => Ok(()),
            Some("length") => Err("Pi 回答达到输出长度限制，本轮执行未完成".into()),
            Some("error" | "aborted") => {
                Err("Pi 模型请求失败或被中止，请查看 Trace 中的错误信息".into())
            }
            _ => Err("Pi 未返回正常结束的 Agent 回答".into()),
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
