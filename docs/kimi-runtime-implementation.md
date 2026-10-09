# Kimi CLI 原生接入

2026-09-17。第五种 Runtime 已由参考原型落实为 React / Tauri 适配器。采用 Kimi Code CLI 的 `kimi acp` 子进程，通过标准输入 / 输出交换 ACP JSON-RPC，避免将非交互 `-p` 的自动权限策略误称为手动审批。

## 行为

- 检测可执行文件时包含 `~/.kimi-code/bin`，沿用既有有界 `--version` 检测。自动检测读取 `KIMI_CODE_HOME/config.toml` 或 `~/.kimi-code/config.toml` 的模型别名、显示名称、默认模型；不导入 Provider 密钥，也不执行配置中的 hooks。模型标识是模型别名，不替换成底层 Provider 的 wire ID。
- 执行先协商 ACP v1，确认 `agentInfo.name = Kimi Code CLI`，创建目标工作目录的会话，默认设置 Runtime 实际公开的 `yolo` 自动批准模式；不提供 `yolo` 的版本使用 `default` 模式，并由应用自动选择请求中的 `allow_always` / `allow_once`。手动模式可在设置中显式选择。选择显式模型时，通过 `session/set_config_option` 设置模型别名。模式设置或模型选择失败时，在发送 prompt 前停止。
- 模型留空时继承 Runtime 默认模型。自动检测按每个模型的 `support_efforts` 导入思考档位，`overrides.support_efforts` 优先（包括空数组）；缺失或没有可识别档位时只提供继承。重新导入更新已有模型能力，保留用户设置的默认强度、显示名和启用状态。Kimi 的 `default_effort` 与全局 `thinking` 不复制成应用显式默认值。
- 模型设置、Agent 档案和任务成员共用思考强度选择器。显式强度在模型选择后按当前 ACP `configOptions` 校验，再调用 `session/set_config_option` 设置 `thinking`，核对返回的 `currentValue` 后才发送 prompt；能力消失、拒绝设置或返回不同值时停止，不静默降档。继承不发送思考覆盖。ACP 适配器不接受任意额外命令行参数。
- 公开 `agent_message_chunk` 实时更新聊天，工具开始 / 更新 / 结束通过调用 ID 汇总到 Trace。隐藏 thought chunk 不向前端转发或写入原始 Trace；握手中的 authMethods 元数据不写入 Trace。
- 手动模式的 Runtime 权限请求通过工作台控件响应。原生层将请求映射为不透明一次性 ID，并验证 Run、成员和当前请求允许的选项；自动模式只选择协议中的允许选项，未知或仅拒绝的选项仍交给用户。手动选择 `allow_always` 后，应用保存会话授权并自动处理已排队及后续允许请求；同一原生会话跨进程恢复仍有效，不跨任务、成员、Runtime 配置或工作目录复用。Runtime 自身的静态允许 / 拒绝规则仍然有效，已允许的工具可能不再发出请求。
- 停止先发送 `session/cancel`，再按有界宽限期清理整个子进程组。应用退出同样取消并回收。不将进程启动或单独 exit 0 视为成功；只有收到 `session/prompt` 的 `end_turn` 结果才标记完成。中断、缺失终态、协议错误、上下文上限等保留明确失败 / 停止状态。
- 浏览器仅管理界面与本地预览数据，不执行 Runtime。

此适配器要求 **Kimi Code CLI** 的 ACP 协议，旧 Python **kimi-cli** 在身份协商时被明确拒绝。没有改写用户的 Kimi 配置、迁移其旧 CLI 数据或自动登录。

## 验证

- Rust fixture 测试覆盖：协议握手、手动模式、模型选择、权限等待与选项校验、重复响应拒绝、公开文本、隐藏 thought 排除、完成判定、等待权限时取消、错误与 exit 0 的区分、旧 CLI 拒绝，以及额外参数拒绝。
- 前端测试覆盖：分片 JSON 恢复、流式文本、工具调用与输入输出合并、权限提示及异步失败重试、历史 / 已中断 Run 不出现可操作审批、思考继承与分模型档位、能力刷新保留用户选择、设置保存、成员覆盖与原生请求参数、历史 Run 快照隔离和首次检测回归。
- 实际安装的 **Kimi Code CLI 0.39.1** 通过隔离临时配置和本机回环 HTTP 模型夹具执行了 initialize → session/new → set_mode → set_config_option → prompt → 文本流 → end_turn。只向 `127.0.0.1` 发送一次 fixture 请求，没有使用用户凭据或付费模型服务。[验证记录](../test-results/kimi-implementation/installed-acp-smoke.json)
- 思考强度补充验证使用当前已安装的 **Kimi Code CLI 0.43.1**：应用原生 `RuntimeManager` 经 ACP 依次测试 `low / high / max`，回环模型服务实际收到 `thinking.effort` 与请求档位逐项一致，每次均收到公开回复和 `completed` 终态。测试使用清空继承环境的临时配置，没有用户凭据、hooks 或真实远端推理。[原生链路记录](../test-results/kimi-reasoning/native-runtime-smoke.json) · [ACP 回包记录](../test-results/kimi-reasoning/installed-acp-smoke.json)
- 本次回归通过前端 332 项、Rust 71 项，以及 Clippy、格式检查与 macOS App 构建 / 签名校验。原生界面使用同源码、独立数据目录的验收应用，在 1536 × 960 和 1280 × 720 窗口检查 K3 的 `low / high / max`；验证选择持久化、键盘选择与菜单焦点恢复、切到 Highspeed 后清除显式档位，以及紧凑窗口的设置弹层。沿用共享选择器与即时状态反馈；没有新增动效，本次未切换系统减少动态效果偏好或做慢放动效审计。[完整验收记录](../test-results/kimi-reasoning/verification.json)
- 真实账号登录、远端模型服务可调用性仍由用户本机 Kimi 配置决定；本次没有发起真实远端模型推理。

权限提示使用统一 shadcn/ui Alert / Button，沿用项目主题和共享按压 / 禁用 / 焦点反馈。审批请求及流式状态即时更新，不新增布局移动或延迟真实响应；实现前读取了项目指定的 apple-design 与 animate SKILL.md。

## 官方依据

- [Kimi Code CLI ACP](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp.html)
- [命令与非交互权限行为](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command)
- [模型别名与配置](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/config-files)

已发布的 `.superdesign` 原型仅作参考；本说明描述的是 `src` 和 `src-tauri` 的正式实现。

## 2026-09-17 权限默认值与会话批准修复

- 根因：每轮 `session/load` 后强制切回 `default`，且客户端仅透传批准选项，没有记录会话级授权。
- 默认自动批准；手动模式的会话授权存于应用私有 `permissions/<task>/<member>/<session>.json`，不改写 Runtime 全局配置。
- 本机 Kimi Code CLI 0.43.1 原生回归：low / high / max 各执行两轮，模型响应来自隔离回环服务，两个进程恢复同一会话；每轮 Bash 实际追加临时文件，最终校验两次写入。未使用用户凭据或真实远端推理。
- 浏览器交互回归脚本：`node scripts/runtime-permissions-smoke.mjs`，覆盖默认选项、手动/自动切换、保存重载、键盘焦点、1536 × 960 / 1280 × 720，以及正常/减少动态效果。沿用共享 Select 的进出场与按压反馈，授权请求不受动画延迟。
