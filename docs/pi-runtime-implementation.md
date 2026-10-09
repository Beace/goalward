# Pi Runtime 接入

Pi 作为独立 Runtime 接入本机发现、模型目录、执行、会话恢复、公开输出和 Trace。应用使用 Pi 的 JSON 事件模式，不把普通终端文本猜测为结构化事件。

## 本机发现与模型身份

- 自动发现读取 Pi Agent 目录中的 `settings.json` 默认 Provider / 模型，以及 `models.json` 中显式登记的模型。
- 可执行文件可用时，额外运行 `pi --offline --no-extensions --list-models`。扫描不加载扩展，扩展注册的模型需要手动登记。
- 模型身份保留为 `provider/model`，避免不同 Provider 的同名模型被合并。
- 发现过程只导出模型识别所需字段，不导出 API Key、Base URL 或其他凭据。
- 模型列表中的 thinking 标记只能证明是否存在思考能力，不能证明支持的具体档位，因此思考强度默认继承 Pi。

## 执行与会话

- Pi Runtime 使用 JSON 事件流，将公开回复、活动状态、会话 ID 和工具事件分别投影到对话与 Trace。
- 原始公开事件继续保留，历史记录可重新投影，不以界面展示内容替代协议记录。
- 同一任务成员在 Runtime 配置和工作目录保持一致时续接保存的 Pi 会话；每次调用仍保存为独立 Run。
- 结束状态以协议事件为准，进程退出码为 0 不单独证明任务执行成功，更不等于业务验收通过。
- 停止操作沿用应用的原生进程组终止与回收机制，并保留停止前已经收到的输出。

## 参数与权限边界

- 模型、会话、JSON 协议和消息传入由适配器统一管理，用户参数不能覆盖这些关键位置。
- 可选启动参数在保存和启动前验证；冲突参数会直接报错，不静默降级为另一种执行方式。
- Pi 没有接入统一的逐次工具审批弹窗。工具、扩展和项目访问策略继续由 Pi 自己的配置决定。
- 本机发现、模型列表和配置读取不等于认证、远端推理或账号权限已经验证。

## 验证

常规回归：

```bash
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

浏览器侧 Pi 投影检查：

```bash
node scripts/pi-runtime-smoke.mjs
```

需要已有可用 Pi 登录和模型配置的原生两轮会话检查为显式忽略测试，不会在普通测试中自动发起远端调用：

```bash
cargo test --manifest-path src-tauri/Cargo.toml pi_live_native_two_turn_session -- --ignored --nocapture
```

浏览器模拟通过只能证明前端事件投影，不替代真实 Tauri 进程、账号认证、远端模型和工具执行的端到端验收。
