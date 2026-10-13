# Claude 与 Pi 原生会话

Goalward 将连接进程、原生会话和每轮 Run 分开管理。Claude 与 Pi 的同一任务成员可在配置和工作目录不变时复用连接；每轮输出仍保存到该轮独立 Trace。连接断开不会自动重放输入，下一次显式请求才续接已保存的精确会话 ID。

## Claude Code

Rust 适配器直接接入 Claude Code 的双向 JSONL transport，使用 `--input-format stream-json --output-format stream-json --include-partial-messages --permission-prompt-tool stdio`。这是官方 Agent SDK 使用的原生子进程协议；应用没有引入 SDK npm 包、Node sidecar 或自己的模型/工具循环。原 CLI 继续管理账号认证、上下文和工具执行。[官方 SDK transport 源码](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/transport/subprocess_cli.py)

初始化通过 `control_request/initialize` 完成，输入使用 `user` record，公开响应和工具活动持续从 stdout 返回。`can_use_tool` 回询由用户允许一次或拒绝，原始工具参数随允许回应返回；不支持的客户端 control 请求直接报错。停止使用原生 `interrupt`。审批 token 只能在当前 Run 内回答一次，过期和非当前请求不接受。[官方控制协议实现](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/query.py)

运行中追加消息属于 **follow-up 排队**，不声明 Codex/Pi 式的 steering。应用会等待所有已提交用户消息的原生结果，才结束这个 Run。stdio 写入成功只记录“已提交追加消息”；本机实测 `--replay-user-messages` 的 UUID echo 在该消息开始处理时才返回，不能当作立即接纳队列的 acknowledgement。后续失败和断连保留到 Trace。[官方持续输入说明](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)

Claude 的原生 `interrupt` 没有 clear-queue 接口，并可能立即推进后续队列。因此已有排队输入时，停止会直接回收该连接，不先发送 interrupt，也不等待正常关闭的宽限期，防止 UI 停止后 CLI 继续处理队列；已知原生 session ID 保留，下轮通过 `--resume=<exact-id>` 恢复。单个未排队 Turn 正常中断后可保留连接。排队输入中某个结果失败，也会回收仍有未处理输入的连接，避免旧结果进入下一 Run。

目标助手的 plan 配置额外限定 `Read,Grep,Glob`，使用 `--restricted`、空的 strict MCP 配置，并拒绝需要客户端批准的工具请求。目标工作目录通过 cwd 和 `--add-dir` 传入。应用内 `manual` 权限模式映射为 CLI 的 `default`；已有其他原生权限模式继续生效。

## Pi

执行改为 `pi --mode rpc`，不带 `--print`。先通过 `get_state` 获取并校验原生 session ID，再发送 `prompt`；消息、工具开始/进度/结束事件与原生 JSON 事件保持一致。启动参数不能覆盖应用管理的协议、模型或 session 选择。[官方 RPC 模式](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)

`prompt` 的成功 response 只表示接受输入。低层 `agent_end` 后仍可能发生重试、压缩恢复或排队处理；完成以 `agent_settled` 为准，兼容无 settled 的事件序列时会查询原生 idle 状态，要求未 streaming、未 compacting、无 pending message，并验证最终 assistant 正常停止。[官方事件生命周期](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/json.md)

运行中追加使用原生 `steer`，按 request ID 等待成功 acknowledgement 后才确认接受；明确拒绝、断连和取消会返回错误，输入保留。五秒无法确认接纳时回收连接，不自动重放未知结果的输入。停止先发送 `clear_queue`，再发送 `abort`，避免仅 abort 后排队消息继续运行；正常停止可保留同一个 idle session。Pi 的实际 thinking level 从 `get_state` 展示，显式档位覆盖仍保持关闭，直到模型目录能验证支持范围。[官方 RPC commands](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc-commands.md)

兼容没有 `agent_settled` 的事件流时，`agent_end` 后如果 get-state 仍 busy，以 250 ms 间隔继续查询 idle，不能依赖另一条 notification 才收口。每次结束后的 idle 确认窗口最多 120 秒；无法确认则失败并保留部分输出与原生历史，不自动重放输入。

Pi 不提供统一的逐次工具权限机制，因此不会把它声明为 approvals 能力。原生扩展的 `confirm` dialog 可在 Goalward 确认或取消；尚未接入的 `input/select/editor` 会显式取消并记录 Trace，不让扩展悬挂。[官方扩展 UI 协议](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc-extension-ui.md)

目标助手只开放内建 `read,grep,find,ls` 工具以读取引用文件，关闭 extensions 和 MCP；`--tools` 白名单单独使用仍会保留 MCP 工具，因此只读工具配置会自动补 `--no-mcp`。不开放 bash/edit/write/powershell。Pi 没有 Claude 式 `--add-dir` 访问授权；额外目标工作目录作为请求上下文传入，保持 Pi 原生工具的路径语义。[官方 CLI 工具选择](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli.md)

## 兼容与验证

本次真实协议检查使用 **Claude Code 2.1.295、Pi 1.1.0**。以已安装版本的协议和 flags 为准；旧版不支持 SDK control、`--restricted`、`--no-mcp` 等 flags 时会保留失败与 stderr，不能静默回退到原来的单次调用模式。升级由用户管理，应用不修改 CLI、账号凭据或用户配置。

Rust fixtures 覆盖同连接两轮、公开 delta、显式 session 不一致时发送前拒绝、审批一次性回应、追加排队、停止、Claude queued-stop 回收后恢复、约 500 KiB 用户消息，以及 Pi 低层结束后重试、busy→idle 没有后续 notification 的兼容流程、steer acknowledgement 接受/拒绝/断连/超时和 exit 0 未完成。可重复运行实际 CLI 的本地 provider 检查：

```bash
python3 scripts/native-session-protocol-smoke.py
```

这个脚本使用临时配置/会话目录和 localhost 的受控 Anthropic-compatible provider，不使用原账号凭据。实际通过了 Claude 两轮上下文、流式输出、拒绝 Bash 写入、排队两次结果、queued-stop 回收后精确恢复，以及 Pi 两轮上下文、四个内建只读工具白名单、read 工具活动/结果、steer、clear-queue/abort 和停止后保留同 session。它与 Rust fixtures 合起来验证 CLI 协议和应用路由；**未验证真实供应商认证、远端网络或打包后的桌面 UI 端到端行为**。
