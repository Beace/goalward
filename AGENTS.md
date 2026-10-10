# Goalward 项目约束

本文件适用于整个项目，包括工作台、设置页、后续页面、共享组件和交互动效。后续设计与开发必须遵循以下要求。

## 1. 产品与设计依据

- **桌面应用使用 Tauri 2 构建，首个交付平台为 macOS。** 当前前端为 React + TypeScript + Vite，基础组件为 shadcn/ui；不要在后续开发中未经需求变更替换为另一套桌面框架。
- 本机进程启动、停止、可执行文件检测和文件持久化通过 Rust / Tauri 命令执行；浏览器预览不执行本机 Runtime。实际能力和开发命令以 [README.md](README.md) 为准。
- 产品以目标驱动：帮助用户把模糊方向落成目标与任务，组织人与 Coding Agent 执行，收集产物和证据，复盘后决定下一步。单 Agent / 多 Agent 代理、runtime / 模型配置、聊天记录和执行 trace 是这条闭环的执行能力。
- UI 以当前工作台和设置页为视觉基准：高密度、类似 IDE 的分栏布局；默认跟随系统，支持深色和浅色主题。
- 开始 UI 工作前，读取 [.superdesign/design-system.md](.superdesign/design-system.md)。页面行为分别参考 [.superdesign/product-design.md](.superdesign/product-design.md) 和 [.superdesign/settings-design.md](.superdesign/settings-design.md)。
- 历史画布映射与原型草稿保存在本地，不作为当前品牌或正式应用实现已同步的依据。

## 2. UI 统一使用 shadcn/ui

- **项目整体使用 [shadcn/ui](https://ui.shadcn.com/) 作为基础 UI 组件体系。** 新增和重构的正式应用界面均遵守此要求。
- 按官方方式引入可维护的组件源码，在项目内集中管理和扩展。不要假定存在一个可直接导入全部组件的 `@shadcn/ui` 包。
- 基础组件集中放置在项目统一的 UI 目录；建立前端工程时默认采用 `src/components/ui/`，如果实际工程结构另有约定则使用一个等价的统一目录。
- 业务页面复用这些组件。业务特有的 Agent 成员栏、trace 事件树、执行详情等，通过共享组件组合和扩展实现。
- shadcn/ui 已提供的按钮、表单控件、菜单、弹层、标签、表格等，优先使用对应组件；不要在各页面重复手写一套同类交互控件。
- 不引入另一套平行的通用 UI 组件体系。确有缺失能力时，优先组合或扩展现有组件，保持主题、交互和无障碍行为一致。
- 组件的逻辑和可访问性遵循其正式实现，外观通过主题变量、组件 variant 和共享样式适配当前项目风格。

### 常见界面与组件对应

| 界面需求 | 优先使用的 shadcn/ui 组件 |
| --- | --- |
| 操作、启用状态、输入与设置表单 | Button、Input、Textarea、Field、Label、Switch、Checkbox |
| Runtime / 模型选择、搜索选择 | Select、Combobox、Command、Popover |
| 设置分类、对话 / 成员 / 产物视图 | Sidebar、Tabs、Separator |
| 可调整分栏、独立滚动区域 | Resizable、Scroll Area |
| 菜单、详情面板、需要确认的操作 | Dropdown Menu、Context Menu、Dialog、Sheet、Alert Dialog |
| 模型目录、状态、加载和错误提示 | Table / Data Table、Badge、Tooltip、Skeleton、Progress、Alert |
| Trace 事件折叠和高级设置 | Collapsible、Accordion，组合项目自己的业务内容 |

以上对应是实现约束，不要求为了使用组件而增加页面中原本没有的控件。

## 3. 保持当前视觉风格

- **采用 shadcn/ui 不改变当前已确定的视觉风格。** 组件默认主题或官网示例外观不能覆盖本项目设计系统。
- 默认跟随操作系统主题，设置外观支持深色、浅色与跟随系统。深色保留近黑 / 深灰分层背景；浅色使用设计系统中的中性浅色层级。两种主题共享少量暖沙色强调、细分隔线、小圆角和紧凑表单。
- 颜色、字体、尺寸、间距、圆角和阴影以 `.superdesign/design-system.md` 为统一来源；不要在业务页面中重新发明一套 token。
- 使用 shadcn/ui 的语义主题变量统一映射当前配色，如 `background`、`foreground`、`card`、`popover`、`primary`、`accent`、`border`、`ring` 和 `sidebar`。
- 设置页与工作台使用同一份主题和基础组件。按钮、选择器、表格、焦点态、错误态及空状态保持一致。
- 保留 Inter / 系统中文字体及代码区等宽字体、4 / 6 / 8 px 的圆角层级、28 / 32 / 36 px 的控件高度层级；完整参数见设计系统。
- 保留桌面工作台的分栏、可折叠检查器、独立滚动和固定输入 / 保存区域。尺寸使用响应式布局，避免写死窗口宽高导致内容被裁切。
- 使用一致的细线功能图标。不要引入装饰性渐变、发光效果、巨大卡片或与当前风格无关的品牌图形。

### 信息密度与渐进展示（强制）

- **内容优先，列表项和工具栏默认单行。** 文件 / 产物项以 40 px 行高为基准，操作控件不小于 28 px；同一上下文已有 Tab 标题时，不再重复大标题、说明段落或装饰图标占用垂直空间。
- **只常驻展示识别对象、判断状态和执行主要动作所需的信息。** 文件列表在名称后用灰色文字显示路径或 URL，占用同一行的剩余空间，过长省略；复制、预览等操作固定右对齐。完整值可悬停查看或一键复制，不另起一行；来源成员、执行批次通过悬停 / 键盘聚焦提示或详情按需查看。文件扩展名已表达类型时，通常不再重复类型徽标。
- 常见操作优先使用统一的图标按钮，必须有明确的 accessible name 和悬停说明；复制成功等反馈在原位置呈现，不新增永久状态行。不以精简为由隐藏错误、待用户处理状态或有决策意义的信息。
- 长名称单行省略，完整内容可访问；窄面板优先压缩名称，保留主要操作。Tab 文字、图标、关闭按钮及其点击区域必须处于同一个 item 边界内。
- 复用 shadcn/ui 组件和设计 token，不通过极小字体、极小点击区域或裁切控件实现高密度。验收应检查长名称、多条记录、窄分栏、键盘焦点、复制反馈和错误状态，确认行高与按钮边界。
- 具体尺寸和适用例见 [.superdesign/design-system.md](.superdesign/design-system.md) 的“信息密度与渐进展示”。此约束适用于后续新增和修改的所有工作台、列表及检查器界面。

## 4. 动画必须使用 apple-design skill

- **新增、修改或评审动画前，必须定位、读取并使用用户指定的 `apple-design` skill。** 本要求涵盖页面切换、弹层、侧栏、折叠展开、选择指示器、列表状态和加载反馈。
- 以实际 `SKILL.md` 的动效要求决定运动方式、时长、缓动 / 弹簧、进出场及打断行为；不能仅凭名称自行概括为“Apple 风格”后声称已使用该 skill。
- `apple-design` 在本项目中负责动效规范；静态配色、字体、组件尺寸和桌面布局仍以当前设计系统为准。
- 接入 shadcn/ui 后，同一控件的内置进出场动画与项目动画需要统一，避免同一属性被多套动画重复驱动。
- 具体动画参数集中管理，禁止各个页面随意填写不同的持续时间、缓动或弹簧参数。
- 原型中历史上的 `120–180 ms ease-out` 不能作为全局动效标准；实际实现按下列规则和该 skill 校准。

### 前端交互动效的默认开发流程

- **每次新增或修改交互界面，都必须主动检查并实现本次功能所需的交互反馈，无需用户额外提出“加动画”。** 检查范围包括按压反馈、选中状态、展开 / 折叠、菜单 / 弹层进出和异步状态转换；有助于反馈或理解空间关系的动效随功能一起交付。按交互目的和使用频率判断，适合即时更新的场景保留即时反馈，不要求所有组件都发生位移或缩放。
- **使用 `apple-design` 确定动效行为，使用 `animate` 编写实际代码。** 开始实施前读取对应的实际 `SKILL.md`。本项目约束与 `apple-design` 动效要求优先于其他 skill 的示例参数和组件库建议；沿用默认克制、可打断的行为，不因示例中的弹跳或固定时长另建一套规则。
- 为已有页面系统性补齐动效时，先用 `find-animation-opportunities` 只读识别优先项，再切换到 `animate` 实施已授权范围内的改动。用户要求实现时，应完成必要动效及验证；用户仅要求审计或建议时，交付发现即可，不扩大为代码修改。
- 动效通过 `src/components/ui/` 中的 shadcn/ui 共享组件及业务组合组件实现，保留原有键盘交互、焦点管理和禁用语义。复用 `src/lib/motion.ts`；必要的 CSS 动效参数在 `src/index.css` 中集中管理，其他样式引用共享参数。简单颜色 / 透明度反馈可用 CSS transition，弹簧及手势交互复用项目已有 Motion 能力，避免同一属性被重复驱动。
- **验证动画样式和挂载生命周期确实生效。** 使用 `animate-in`、`animate-out`、`fade-*` 等工具类时，检查对应依赖、CSS 导入及构建结果中的样式定义；在正常动态效果设置下运行界面，确认预期的进出场动效生效，关闭动画不会因立即卸载而丢失。仅存在类名、依赖声明或动效配置不能作为实现完成的证据。
- 高频键盘操作、聊天 token 和 trace 流式更新保持即时，不重复触发整块内容入场、不打乱滚动位置、不用动画延迟业务请求；具体行为遵循下方“项目场景补充”。
- 交付前按第 5 节实际验证本次涉及的交互，报告已实现的反馈、适用检查结果和未验证项；未运行的检查不能宣称通过。用户显式请求动效评审时，使用 `review-animations` 检查实现，并仍以本项目与 `apple-design` 的要求为准。

### 技能来源

- `apple-design` 的本机常见安装位置为 `~/.agents/skills/apple-design/SKILL.md`；每次动效工作都应重新读取实际文件。
- 下列动效要求依据该 skill 的 Response、Direct manipulation、Interruptibility、Springs、Velocity handoff、Spatial consistency 和 Reduced motion 等章节整理。后续会话应读取实际 skill；迁移环境时重新解析安装路径。
- 动效实施使用 `animate`；缺失动效发现使用 `find-animation-opportunities`；显式动效评审使用 `review-animations`。这些技能的分工与默认开发流程是项目补充约定，不作为 `apple-design` 原文转述；迁移环境时重新定位实际文件。

### apple-design 动效要求

- **即时反馈**：按下时立即显示反馈，点击 / 键盘激活语义保持正常；不在按下瞬间提前执行原本需要完成点击的操作。不得用人工等待或动画完成回调延迟业务操作。
- **可打断、可反向**：动画期间不锁定输入。目标变化时从屏幕当前值衔接，并保留连续的速度；不能从上一次逻辑目标跳到新目标。
- **默认克制的弹簧**：交互位置变化默认采用临界阻尼、无回弹的行为。skill 的参考为阻尼比 `1.0`、response `0.3–0.4 s`；只有甩动、拖拽释放等真实带动量的交互才考虑少量回弹（阻尼比约 `0.8`）。菜单点击、模型切换和设置分类切换不添加装饰性弹跳。
- **参数语义准确**：response 不是固定动画时长，阻尼比也不等于动画库的物理 `damping` 参数。适配实际选用的库，不能直接把 `damping: 1` 当作临界阻尼配置；统一配置需区分设计参数与库参数。
- **直接操控**：拖动面板或分栏时按指针 1:1 跟随，保留抓取偏移并正确处理 pointer capture / cancel；不在拖动过程中叠加滞后的缓动。手势驱动的运动使用可打断的弹簧 / 运动值，不依赖固定 CSS transition 或 keyframes。
- **动量衔接**：如实现可甩动或吸附的面板，释放时传递手势速度，根据投影落点选择吸附位置。普通分栏调整只实时跟随并保留最终尺寸，不额外制造惯性。
- **空间一致**：进出场沿同一路径；菜单和弹层以触发控件为运动起点。连续开关或快速切换时保持位置连续，关闭后正确恢复焦点。
- **性能与可访问性**：动效优先使用 `transform` / `opacity`；真实分栏布局更新保持即时。减少动态效果时，以短淡入淡出或静态更新替代位移、缩放、弹簧和回弹，保留必要的状态反馈。已有半透明表面需响应减少透明度偏好，增强对比度偏好需提供清晰边界；这些适配沿用当前所选主题的配色。

### 项目场景补充

以下是本项目的补充要求，不作为 `apple-design` 的内容转述：

- 运行启动、暂停、停止和发送消息等操作立即进入真实请求流程；动效只反映实际状态，不延迟请求，也不提前宣告完成。
- 聊天 token 与 trace 流式更新不得每次触发整块内容的入场动画，也不得打乱用户当前滚动位置。
- 可拖动分栏与实时执行状态不因装饰性动画产生滞后。动效需要帮助理解状态或空间关系。
- 不因 skill 中的材质或字体示例自动引入毛玻璃、亮色背景、额外阴影或替换现有字体；本次约定的 skill 应用范围为动效及其可访问性。

## 5. 实现与验收边界

- `.superdesign/*.html` 是设计参考原型，不能据此声称正式应用已采用 shadcn/ui 或已经接入真实 runtime。
- 将设计落地为正式界面时，检查基础控件确实来自统一的 shadcn/ui 组件目录，主题确实使用项目 token。
- 视觉检查覆盖工作台、设置页、菜单 / 弹层、焦点 / 禁用 / 错误状态，以及 1536 × 960 与 1280 × 720 的桌面尺寸。
- 动效检查覆盖正常 / 减少动态效果、动画中途反向、快速连续切换、拖动取消、键盘 / 焦点恢复及流式内容更新。交付时提供可交互验证，必要时慢放检查跳变，报告使用的 `apple-design` 来源和实际检查结果。
- 纯文档约束更新不等同于安装依赖、初始化前端工程、修改远端画布或迁移现有原型。

## 6. Git 开发与发版流程（强制）

- 每个任务从最新 `origin/main` 新建独立分支；Codex 分支使用 `codex/<任务名>`。变更只推到该任务分支，并发起 Pull Request。不得直接提交或推送到 `main`，也不得让自动化绕过 PR 修改 `main`。GitHub 对 `main` 强制经过 PR，并只允许 squash merge。
- PR 标题就是合入 `main` 后的 squash commit 标题，应使用 Conventional Commit 形式，例如 `feat: ...`、`fix: ...`、`docs: ...`。不兼容改动用 `feat!: ...` 或在提交正文写 `BREAKING CHANGE:`。保持标题能独立说明用户可见的变更；合并前检查 CI。PR CI 只运行前端、Rust 和发版工具单测，不构建 App、DMG 或 ZIP。
- PR 合入 `main` **不立即发布**。本地 Codex 定时任务「Goalward 每日下午发布」每天 **Asia/Shanghai 14:00** 检查待发布变更，并在需要时从 `main` 手动触发 GitHub Actions 发布工作流；工作流自身不使用 GitHub cron，也可由维护者在 GitHub Actions 手动触发。以运行时选定的 `main` 提交为快照，与最近一个已公开 GitHub Release 及其已验证的版本 tag 比较；首次使用 `.github/release-baseline.json` 的 0.1.1 基线。现有无 tag 的 `v0.1.1` 草稿保持原样，不计作已公开版本。没有新提交，或选定提交已经被较新版本覆盖时，跳过构建和发布。
- 对两个版本之间实际合入的所有 squash commits 判定 SemVer：breaking change 升 major，`feat` 升 minor，其他变更升 patch；没有规范前缀也按 patch。**整批只按最高等级升一次版本**，不是每个 PR 各发一版。版本计算与变更记录只读取已合入的 Git commit 和已公开 Release/tag，不以 PR 草稿或本机文件为准。定时与手动发布必须串行，不能因重复触发创建相同版本或覆盖不匹配的草稿及产物。
- GitHub Release notes 是后续版本的 changelog：采用 “What's Changed” 列表，逐条列出本批次的 commit 标题、作者、PR，并附从上个已公开版本到本版的 Full Changelog 对比链接。发布工作流在隔离的构建工作区将计算出的版本同步到 npm、Tauri 和 Cargo 版本文件；成功构建并复验 universal 安装包后，显式创建指向本次 `main` 提交的版本 tag，核对远端 tag 后才创建、公开 prerelease。绝不从 PR 分支建版本 tag，也不把版本回写到 `main`。源码中的版本字段只是开发构建基线，正式下载以 Release 版本号及包内版本为准。
- 当前 macOS 发布包仅临时签名、未经 Apple 公证。自动预发布必须如实标注这一点；在完成 Developer ID 签名、公证和安装验证前，不得称为已公证正式版。发布流程与故障恢复见 [docs/releasing.md](docs/releasing.md)。

## 官方参考

- [shadcn/ui 介绍](https://ui.shadcn.com/docs)
- [组件目录](https://ui.shadcn.com/docs/components)
- [主题与 CSS 变量](https://ui.shadcn.com/docs/theming)

<!-- CODEGRAPH_START -->
## CodeGraph

In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tool** (when available): `codegraph_explore` answers most code questions in one call — the relevant symbols' verbatim source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a file or symbol in the query to read its current line-numbered source. If it's listed but deferred, load it by name via tool search.
- **Shell** (always works): `codegraph explore "<symbol names or question>"` prints the same output.

If there is no `.codegraph/` directory, skip CodeGraph entirely — indexing is the user's decision.
<!-- CODEGRAPH_END -->
