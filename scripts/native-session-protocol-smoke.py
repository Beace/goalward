#!/usr/bin/env python3
"""Verify installed Claude/Pi session protocols against a local test provider.

No real provider credentials are used. Agent state lives in temporary folders.
This verifies actual CLI framing/lifecycle; Rust routing is covered by unit
fixtures, and this is not a packaged desktop or vendor-authentication test.
"""
import argparse
import json
import os
import pathlib
import queue
import shutil
import signal
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Provider:
    def __init__(self):
        self.mode = "text"
        self.requests = []
        provider = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                payload = json.loads(self.rfile.read(int(self.headers.get("content-length", "0"))))
                if self.path.endswith("count_tokens"):
                    self.send_response(200)
                    self.send_header("content-type", "application/json")
                    self.end_headers()
                    self.wfile.write(b'{"input_tokens":10}')
                    return
                provider.requests.append(payload)
                mode = provider.mode
                self.send_response(200)
                self.send_header("content-type", "text/event-stream")
                self.end_headers()

                def event(name, value):
                    self.wfile.write(("event: " + name + "\ndata: " + json.dumps(value) + "\n\n").encode())
                    self.wfile.flush()

                tool = mode in ("tool", "read") and not any(
                    isinstance(message.get("content"), list)
                    and any(block.get("type") == "tool_result" for block in message["content"])
                    for message in payload.get("messages", [])
                )
                try:
                    event("message_start", {"type": "message_start", "message": {
                        "id": "local-" + str(len(provider.requests)), "type": "message", "role": "assistant",
                        "model": payload.get("model"), "content": [], "stop_reason": None,
                        "stop_sequence": None, "usage": {"input_tokens": 10, "output_tokens": 0}}})
                    block = {"type": "tool_use", "id": "local-tool", "name": "read" if mode == "read" else "Bash", "input": {}} if tool else {"type": "text", "text": ""}
                    event("content_block_start", {"type": "content_block_start", "index": 0, "content_block": block})
                    tool_input = {"path": "reference.txt"} if mode == "read" else {
                        "command": "printf 'never' > unauthorized.txt", "description": "Write a marker"}
                    delta = {"type": "input_json_delta", "partial_json": json.dumps(tool_input)} if tool else {"type": "text_delta", "text": "LOCAL_ACK"}
                    event("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": delta})
                    if mode == "slow":
                        time.sleep(0.6)
                    event("content_block_stop", {"type": "content_block_stop", "index": 0})
                    event("message_delta", {"type": "message_delta", "delta": {
                        "stop_reason": "tool_use" if tool else "end_turn", "stop_sequence": None}, "usage": {"output_tokens": 2}})
                    event("message_stop", {"type": "message_stop"})
                except (BrokenPipeError, ConnectionResetError):
                    pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = "http://127.0.0.1:" + str(self.server.server_port)

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class Client:
    def __init__(self, command, directory, env):
        self.records = []
        self.queue = queue.Queue()
        self.process = subprocess.Popen(command, cwd=directory, env=env, stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                        text=True, start_new_session=True)

        def read():
            for line in self.process.stdout:
                if line.startswith("{"):
                    self.queue.put(json.loads(line))
            self.queue.put({"type": "fixture-disconnected"})

        threading.Thread(target=read, daemon=True).start()
        # Drain diagnostics without printing inherited configuration/accounts.
        threading.Thread(target=lambda: list(self.process.stderr), daemon=True).start()

    def send(self, value):
        self.process.stdin.write(json.dumps(value) + "\n")
        self.process.stdin.flush()

    def until(self, predicate):
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            value = self.queue.get(timeout=max(0.1, deadline - time.monotonic()))
            assert value["type"] != "fixture-disconnected", "Native CLI disconnected"
            self.records.append(value)
            if predicate(value):
                return value
        raise TimeoutError("Native CLI did not reach the expected protocol state")

    def close(self, force=False):
        if self.process.poll() is None:
            os.killpg(self.process.pid, signal.SIGKILL if force else signal.SIGTERM)
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(self.process.pid, signal.SIGKILL)
                self.process.wait(timeout=3)


def claude_smoke(executable):
    provider = Provider()
    client = None
    try:
        with tempfile.TemporaryDirectory(prefix="goalward-claude-local-") as directory:
            env = {key: value for key, value in os.environ.items()
                   if not key.startswith("ANTHROPIC") and key not in ("CLAUDECODE", "CLAUDE_CODE_OAUTH_TOKEN")}
            env.update({"ANTHROPIC_BASE_URL": provider.url, "ANTHROPIC_API_KEY": "goalward-local-fixture",
                        "CLAUDE_CONFIG_DIR": directory, "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"})
            arguments = [executable, "--print", "--input-format", "stream-json", "--output-format", "stream-json",
                         "--verbose", "--include-partial-messages", "--permission-prompt-tool", "stdio",
                         "--permission-mode", "default", "--tools", "Bash", "--strict-mcp-config",
                         "--mcp-config", '{"mcpServers":{}}']

            def connect(extra=None):
                connection = Client(arguments + (extra or []), directory, env)
                connection.send({"type": "control_request", "request_id": "initialize",
                                 "request": {"subtype": "initialize", "hooks": None}})
                reply = connection.until(lambda value: value["type"] == "control_response")
                assert reply["response"]["subtype"] == "success"
                return connection

            def user(prompt, session=""):
                client.send({"type": "user", "session_id": session, "parent_tool_use_id": None,
                             "message": {"role": "user", "content": prompt}})

            def result():
                reply = client.until(lambda value: value["type"] == "result")
                assert reply["subtype"] == "success" and not reply["is_error"]
                return reply

            client = connect()
            user("Remember LOCAL_CONTEXT_TOKEN")
            first = result()
            user("Recall the earlier token", first["session_id"])
            second = result()
            assert first["session_id"] == second["session_id"]
            assert "LOCAL_CONTEXT_TOKEN" in json.dumps(provider.requests[1]["messages"])
            assert any(value["type"] == "stream_event" for value in client.records)

            provider.mode = "tool"
            user("Request a tool, then finish", first["session_id"])
            permission = client.until(lambda value: value["type"] == "control_request")
            assert permission["request"]["subtype"] == "can_use_tool"
            assert permission["request"]["tool_name"] == "Bash"
            client.send({"type": "control_response", "response": {"subtype": "success",
                         "request_id": permission["request_id"], "response": {"behavior": "deny", "message": "Local test denied"}}})
            result()
            assert not pathlib.Path(directory, "unauthorized.txt").exists()

            provider.mode = "slow"
            user("Start the queue test", first["session_id"])
            client.until(lambda value: value["type"] == "stream_event" and value.get("event", {}).get("type") == "content_block_delta")
            user("Queued follow-up", first["session_id"])
            result()
            result()

            user("Start queued-stop test", first["session_id"])
            client.until(lambda value: value["type"] == "stream_event" and value.get("event", {}).get("type") == "content_block_delta")
            user("Must not run after Stop", first["session_id"])
            # Native SDK transport exposes no clear-queue command. The Rust
            # adapter immediately recycles a queued connection without sending
            # interrupt, which could release pending native input first.
            client.close(force=True)
            time.sleep(0.8)
            provider.mode = "text"
            before_resume = len(provider.requests)
            client = connect(["--resume=" + first["session_id"]])
            user("Explicit request after queued Stop", first["session_id"])
            resumed = result()
            assert resumed["session_id"] == first["session_id"]
            assert len(provider.requests) == before_resume + 1
            client.close()
            return {"native_multi_turn": True, "streaming": True, "context_retained": True,
                    "permission_denial_prevents_write": True, "queued_input_has_two_results": True,
                    "queued_stop_recycles_connection": True, "exact_session_resume": True}
    finally:
        if client:
            client.close()
        provider.close()


def pi_smoke(executable):
    provider = Provider()
    client = None
    try:
        with tempfile.TemporaryDirectory(prefix="goalward-pi-local-") as directory:
            config = pathlib.Path(directory, "config")
            config.mkdir()
            (config / "models.json").write_text(json.dumps({"providers": {"goalward-local": {
                "baseUrl": provider.url, "api": "anthropic-messages", "apiKey": "goalward-local-fixture",
                "models": [{"id": "fixture-model", "name": "Local Fixture", "reasoning": False,
                            "input": ["text"], "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
                            "contextWindow": 200000, "maxTokens": 4096}]}}}))
            env = {key: value for key, value in os.environ.items() if not key.startswith(("ANTHROPIC", "OPENAI", "PI_"))}
            env.update({"PI_CODING_AGENT_DIR": str(config), "PI_TELEMETRY": "0"})
            client = Client([executable, "--mode", "rpc", "--offline", "--tools", "read,grep,find,ls", "--no-extensions", "--no-mcp",
                             "--no-skills", "--no-prompt-templates", "--no-context-files", "--provider", "goalward-local",
                             "--model", "fixture-model"], directory, env)
            client.send({"type": "get_state", "id": "initialize"})
            state = client.until(lambda value: value["type"] == "response")
            session = state["data"]["sessionId"]
            for index, prompt in enumerate(["Remember LOCAL_CONTEXT_TOKEN", "Recall the earlier token"]):
                client.send({"type": "prompt", "id": "prompt-" + str(index), "message": prompt})
                client.until(lambda value: value["type"] == "agent_settled")
            assert "LOCAL_CONTEXT_TOKEN" in json.dumps(provider.requests[1]["messages"])
            assert {tool["name"] for tool in provider.requests[0].get("tools", [])} == {"read", "grep", "find", "ls"}
            pathlib.Path(directory, "reference.txt").write_text("LOCAL_REFERENCE_TEXT")
            provider.mode = "read"
            client.send({"type": "prompt", "id": "read-prompt", "message": "Read the reference file"})
            client.until(lambda value: value["type"] == "agent_settled")
            assert any(value["type"] == "tool_execution_start" and value.get("toolName") == "read" for value in client.records)
            assert any(value["type"] == "tool_execution_end" and value.get("toolName") == "read" for value in client.records)
            assert "LOCAL_REFERENCE_TEXT" in json.dumps(provider.requests[-1]["messages"])
            provider.mode = "slow"
            client.send({"type": "prompt", "id": "steer-prompt", "message": "Start steering test"})
            client.until(lambda value: value["type"] == "message_update" and value.get("assistantMessageEvent", {}).get("type") == "text_delta")
            client.send({"type": "steer", "id": "steer", "message": "New direction"})
            client.until(lambda value: value["type"] == "response" and value.get("id") == "steer")
            client.until(lambda value: value["type"] == "agent_settled")
            client.send({"type": "prompt", "id": "abort-prompt", "message": "Start abort test"})
            client.until(lambda value: value["type"] == "message_update" and value.get("assistantMessageEvent", {}).get("type") == "text_delta")
            client.send({"type": "clear_queue", "id": "clear"})
            client.send({"type": "abort", "id": "abort"})
            aborted = client.until(lambda value: value["type"] == "agent_settled")
            assert aborted["aborted"]
            client.send({"type": "get_state", "id": "after-stop"})
            state = client.until(lambda value: value["type"] == "response" and value.get("id") == "after-stop")
            assert state["data"]["sessionId"] == session and not state["data"]["isStreaming"]
            assert state["data"]["pendingMessageCount"] == 0
            client.close()
            return {"native_multi_turn": True, "streaming": True, "context_retained": True,
                    "read_only_tool_allowlist": True, "native_read_tool_progress": True,
                    "native_steer": True, "clear_queue_then_abort": True, "same_idle_session_after_stop": True}
    finally:
        if client:
            client.close()
        provider.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--claude", default=shutil.which("claude"))
    parser.add_argument("--pi", default=shutil.which("pi"))
    parser.add_argument("--output")
    args = parser.parse_args()
    report = {"boundary": "Actual installed CLI protocols with a temporary local fixture provider; no vendor authentication or packaged desktop UI verification"}
    if args.claude:
        report["claude"] = claude_smoke(args.claude)
    if args.pi:
        report["pi"] = pi_smoke(args.pi)
    encoded = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        pathlib.Path(args.output).write_text(encoded)
    print(encoded, end="")
