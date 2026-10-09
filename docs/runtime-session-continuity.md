# Runtime 会话连续性

## 修复行为

Run 继续表示一次调用、配置快照与 Trace；原生会话由同一任务的同一成员复用。工作目录、Runtime ID、适配器、可执行文件和高级启动参数保持一致时，后续调用使用已保存的原生会话 ID。模型、思考强度和权限按新调用配置传入。

- Codex：从 `thread.started.thread_id` 记录会话，使用明确 ID 的 `exec resume`。
- Claude：从顶层 `system/init` 或 `result` 的 `session_id` 记录会话，使用 `--resume`。
- Kimi：从 ACP 新建响应保存 `sessionId`，续接时协商 `loadSession` 并调用 `session/load`。加载阶段的旧消息回放不重复追加到新 Run；成功结束后在支持时等待 `session/close` 确认，再退出进程。

会话 ID 在 RunMember 快照及原始 Trace 中保留，已有 Codex/Claude trace 可恢复 ID。新 Run 不改写旧 Run；任务、成员、Runtime、工作目录之间不会通过 `--last` 或 `--continue` 隐式共用会话。恢复失败报错，重试沿用同一 ID，不自动新建空会话。

## 旧记录与通用适配器

原实现每次调用新建会话，交接仅取最后 8 条消息，每条最多 1200 字；用户指令也截断到 12000 字。现在没有原生 ID 的旧记录、切换运行环境及 Generic 适配器均传入已保存的完整公开对话和完整用户指令。原生隐藏状态、从未保存或旧版已截断的数据无法凭空补回。

Codex / Claude 通过 stdin 接收内容，避免长历史触及操作系统 argv 长度上限。原生请求超过 1 MiB 会拒绝启动并显示错误，不静默截断历史。Generic 继续遵循其自定义参数协议，没有统一原生会话恢复保证。

## 验证（2026-09-17）

- `npm run build`：通过。
- `npm test`：36 个文件、418 项测试通过。包含会话 ID 分片解析、持久化/重载、App 第二轮发送、Runtime / 目录 / 成员隔离、旧记录回填、完整交接和恢复失败重试。
- Rust 全量：85 项通过、4 项选择性检查默认忽略；随后新增的完整 stdin 大文本与 Kimi 关闭确认两项定向测试均通过。常规测试合计 87 项。
- Kimi 0.43.1：使用实际 RuntimeManager 和本机 CLI，隔离配置和环境，以回环 HTTP 服务替代远程模型。每种 low / high / max 强度跑两轮，中间关闭进程并重新创建 RuntimeManager；第二轮 provider 请求明确包含第一轮用户消息、第一轮回答和新的用户消息，原生会话 ID 相同，新 Run 只收到一次新的回复。
- 上述 Kimi 三档续接检查重复 3 次全部通过。日志位于 `test-results/runtime-session/installed-kimi-{1,2,3}.log`。
- 验证过程中曾复现收到 `end_turn` 后立即结束进程导致下一轮上下文为空；改为等待关闭确认后重复检查通过，并增加确定性的关闭时序测试。
- Codex resume 参数层级已对照本机 CLI 帮助核验；Codex / Claude 原生参数、权限保留、完整 stdin 内容及前端发送关联均有测试。未调用真实远程模型服务，不能据此声称云端模型 E2E 通过。
- 本次没有修改用户桌面数据库或重新打包安装包。

## 协议来源

- [Kimi ACP：加载、回放与关闭会话](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp)
- [Claude 非交互调用、stdin 与指定会话续接](https://code.claude.com/docs/en/headless)
- Codex：本机 `codex exec --help`、`codex exec resume --help` 和本机官方源码 `codex-rs/exec/src/cli.rs`。
