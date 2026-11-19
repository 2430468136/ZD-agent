# 织点桌面应用路线图

> 更新日期：2026-11-19。产品方向已调整：织点优先成为 Windows 本机 Agent 指挥应用，调度用户已有的 Codex 与 DeepSeek Harness；原 Web/远程控制面工作保留为能力基线，不再作为首发主线。

## 现状：哪些已有，哪些还没做

| 能力 | 当前状态 | 代码证据 / 缺口 |
|---|---|---|
| Web 工作台 | **本机已实现；HTTPS 回环试点通过** | 主人管理和执行，项目成员按项目只读。HTTPS 同源服务提供构建页面和 API，强制认证；默认监听 `127.0.0.1`，受控私网模式待两台实机验收。 |
| 持久记录与工作线程 | **单机范围已实现** | `Project / Thread / Message / Session / Task / Run / Review` 等使用 v4 工作流，默认 JSON，可迁移至 SQLite；旧 JSON 原样保留。离线备份恢复已用副本验证。尚无跨主机共享数据库和长期归档方案。 |
| 持续工作线程 / 跨次对话 | **单机 MVP 已完成** | 线程列表、详情、同线程续接与重启恢复已实现；续接固定原项目和线程 Agent 配置，上下文限长并脱敏。新任务与线程续接有持久提交回执，同一请求重试返回原任务。 |
| 定时任务 | **本机 MVP 已实现** | 一次/每天/每周、IANA 时区、重启恢复与补跑策略、幂等、单实例锁、规划超时退避、取消和运行记录。运行始终复核项目授权，不自动重放中断的写入。 |
| 结果交付 | **Feishu/Lark 双向 MVP 已实现；本机 mock 已验收** | 可发送终态通知，接收状态查询、任务草稿、续接与审批请求；可配置应用回执。主人能从导航查看各项目的投递异常。外部消息不直接启动执行或改写验收状态。真实应用与群聊待联调；邮件和通用 Webhook 未做。 |
| 执行器选择 | **注册式 Harness 契约已实现** | 通用模型 API、DeepSeek API、Codex CLI、Claude Code CLI 已通过注册表统一能力声明、权限校验、超时/取消、事件与错误契约；Pi 适配器也已实现但默认不注册。真实第三方账户冒烟仍待用户环境联调。见 `server/executor-registry.mjs` 与各适配器测试。 |
| Pi 等新增 Harness | **Pi opt-in 已实现；默认关闭** | `ZHIDIAN_ENABLE_PI=1` 才注册 Pi CLI。运行强制 JSON 模式、无会话、无扩展/技能/MCP/项目上下文/提示模板/主题，仅允许 `read/grep/find/ls` 或 `edit/write` 文件工具，并在运行前检查 CLI 帮助参数；`server/pi-executor.mjs` 不是 OS 级隔离，真实 Pi 登录态仍待联调。 |
| 第三方真实联调 | **未完全验证** | DeepSeek 单测使用 mock；CLI 适配器有自动化测试，但这不等于用户本机登录态、真实模型账户和生产环境联调已经通过。 |
| 桌面应用与本机 Harness 工作区 | **Windows 预览版已实现真实 Codex 派单、独立 QA、人工确认、分屏与非空记录恢复；首发未完成** | 免安装包支持按 Run 打开最多四个窗格，桌面重启会恢复窗格。真实 Codex 不要求在织点填写 API Key。DeepSeek 目前只探测 `dsh --version`，本机未发现 dsh CLI，尚无本机 Harness 执行适配。完整行级差异、桌面图标和升级回滚仍待补齐。 |

## 上一版路线图进度（Web/本机控制面）

以下是已有实现与验收记录，不代表新的桌面应用目标已经完成。

- [x] P0 设计：部署前置条件写入 `SECURITY-ARCHITECTURE.md`，监听保持回环。
- [x] P1：Harness 注册契约、四个现有执行器、Pi opt-in 适配器、取消/超时/权限测试已完成；DeepSeek、Codex、Claude、Pi 的真实账户/本机登录态冒烟未做。
- [x] P1 只读专业岗位：通用模型 API 和 DeepSeek 可根据授权快照返回分析。工作流拒绝文件或命令提议，项目提权不改变已提交任务的只读权限，本机 CLI 仍不可作为只读项目的专业岗位。通用 API 与 DeepSeek 均通过本机模拟验收，后者验证了专业岗位完结、文件和命令零变化。
- [x] P1 实际二进制兼容性：本机 Codex CLI `0.151.0` 拒绝将 `--ask-for-approval` 放在 `exec` 后；已修正并用真实 CLI 验证只读、工作区写入两组参数。测试不登录、不调用模型，不替代账号联调。
- [x] P1 DeepSeek 调用兼容性：新安装默认使用官方根 API 地址与 `deepseek-flash`；已保存 `/v1` 的实例按原地址继续调用，不自动迁移。任务、规划和连接测试共用受取消/超时控制的请求适配器，官方请求显式关闭思考模式。连接测试要求返回最终文本才成功；空结果和鉴权失败不误报成功、不泄漏临时凭据。HTTPS mock 和单测通过，未调用真实账号；既有用户保存的岗位 Model ID 不自动改写。
- [x] P2：线程 API/UI、历史上下文、跨项目隔离、重启续接及 v1/v2→v3 备份迁移通过本地 E2E。
- [x] P3：本机定时调度、计划管理页、重启补跑/幂等/权限回归已完成；多实例调度不是本阶段支持范围。
- [x] P4 单向交付：通知页、签名、加密存储、限流退避、轮换和撤销在 Windows mock 端到端验收通过。
- [x] P4 投递告警：主人桌面侧栏、手机导航提示异常；可按项目区分明确失败与结果未知，进入对应历史。计数和列表都以每项目最近创建的 100 条投递为准，不是待确认告警队列；查看不消除告警，结果未知不自动重发。HTTPS mock 与 Chromium 验证了跨项目记录挤占回归、拒绝和 HTTP 503、重启不重发、主人导航及成员明细拒绝。
- [x] P4 通知任务链接：按项目在 HTTPS 工作台显式启用，默认关闭。链接使用实例地址和任务编号，不带凭据；主人打开详情，只读成员仅能看到已授权项目的状态。HTTPS mock 捕获实际投递链接，Chromium 验证登录后定位、手机关闭和跨项目拒绝；尚未验证真实客户端的链接渲染。
- [x] P4 双向 MVP：在本机 HTTPS mock 验证回调握手、签名、加密消息、租户和项目隔离、并发与重启去重、主人确认、线程续接、配置撤销和原消息状态回复。
- [x] P4 收件箱浏览器验收：主人可搜索或翻页选择同项目的历史源任务，不必复制任务编号；确认后可直接打开新任务。Chromium 用模拟飞书事件验证了待确认、跨项目筛选、确认建任务和打开详情。真实飞书/Lark 群仍未联调。
- [x] P4 专用回调转发：独立进程只监听回环，只转发一个指定项目的 JSON POST，保留原始验签字节并验证上游 TLS。本机 HTTPS mock 覆盖握手、事件、误路由、错误证书和超限拒绝；外部边缘未部署。见 `FEISHU-PILOT.md`。
- [x] P0 单机安全基础：主人/只读成员授权、会话撤销、项目 SSE 脱敏、SQLite v4 迁移与离线恢复、凭据轮换与中断续转已自动化验收。
- [x] P5 本地试点：HTTPS、Secure Cookie、Host/Origin 校验、模型 HTTP 出站限制、SSE 游标重连、持久提交回执及运行中重启验收。使用同一台电脑上的 Chromium 桌面与手机尺寸分别登录，并非两台实机。
- [x] P5 运维准备：`--check-data` 核查停机数据与凭据；HTTPS 部署可用 `--check-pilot` 追加 TLS、构建和审计路径检查。已验证拒绝活动实例和错误配置，预检不改业务数据、不启动服务。`pilot-probe.mjs` 经本机 TCP 转发验证证书信任、健康、匿名拒绝，并输出可用于实机对照的证书指纹。升级、恢复、回退及实机取证要求见 `HTTPS-PILOT.md`。
- [x] P5 离线备份与回退演练：`scripts/pilot-backup.mjs` 持数据锁生成 SHA-256 文件清单，只恢复至新目录。已验证拒绝运行中备份、拒绝损坏副本、保留 JSON 迁移前原件及 SQLite WAL；回环 HTTPS 从升级前副本重新启动，保留任务、成员授权、凭据和审计，不带入候选实例新写入。另用 `05d08c0` 生成旧 JSON，当前版迁移至 SQLite v4，再恢复原件并启动该旧版成功。实际部署账户和发布包仍待现场验收。
- [x] P5 审计及会话同步：控制面操作日志可跨重启查询，脱敏、轮换和存储故障拒绝变更已通过测试。本机两个独立 Chromium 会话验证新任务自动同步、恢复网络后无需刷新、项目隔离，以及禁用成员后活动页面退回登录。
- [x] P5 页面刷新后重试：同一浏览器标签页保留待确认请求的指纹与提交标识。Chromium 验证服务已保存、确认丢失或损坏时，刷新后手动重提相同任务或线程跟进仍返回原任务 ID；不自动重放，不存表单正文。
- [x] P5 审计采集准备：`pilot-audit.mjs` 只读导出两份保留日志；`pilot-audit-archive.mjs` 导入独立 SQLite、按实例和请求阶段去重，并支持请求查询。本机验证了 HTTPS 实例任务 `attempt`/`result` 关联、重开查询、重复导入零新增、同键冲突整批回滚、损坏输入拒绝和源轮换覆盖后仍能查询。部署侧的传输、账户权限、留存与恢复待现场验收。
- [x] P5 出站检测准备：`pilot-egress.mjs` 支持获准对照环境与部署账户的比较。回环测试覆盖 TCP 可达、拒绝连接和 TLS 信任失败；防火墙与代理配置、CLI 和 QA 实际出站仍需现场核对。
- [x] P5 有序停机：服务信号路径会关闭 SSE、取消活动执行器/通知、等待队列与串行持久化完成，再释放 SQLite 数据锁；工作流和 HTTPS 回归覆盖停机后重启恢复，不自动重放运行中阶段。
- [x] P5 本机容量基准：SQLite 单次事务只写变化和删除的记录；主人端首屏与轮询使用轻量快照，空闲时返回无正文的 `304`。任务、线程可翻页和搜索，完整运行日志按任务加载；旧 API 保持兼容。5,000 条历史任务时，首屏响应从 25,747,482 B 降至 12,587 B。浏览器已测试旧计划源任务编辑、CEO 交接动画和授权会话同步，复测见 `HTTPS-PILOT.md`。
- [x] P5 成员历史：只读取当前项目和记录类型，每页 40 条。浏览器验证了手机翻页、项目切换、断线恢复和停用后退出；验证器只按成员可见内容生成，无权访问或会话失效不返回 `304`。5,000 条历史的成员线程首屏从 689,088 B 降至 4,005 B，48 次空闲轮询及 8 次无关项目写入后的轮询响应正文均为 0 B。旧成员接口继续供现有探针使用。
- [x] P5 受控私网绑定门槛：默认仍为回环；非回环只接受私有 IPv4、精确 HTTPS Origin、主人认证、实例密钥环、确认字符串和客户端地址白名单。专项测试覆盖公网/错误配置拒绝；第二台实机、私有链路、证书信任和主机策略仍待现场验收。
- [x] P5 同机私网绑定烟测：`scripts/private-bind-smoke.mjs` 临时生成匹配证书和 SQLite，真实绑定私有 IPv4 后通过探针验证 TLS、匿名拒绝和错误 Origin 拒绝；结果仅限同机，不替代第二台实机验收。
- [x] P5 成员验收探针：`scripts/pilot-probe.mjs --member` 固定可信证书指纹，核对指定任务和线程，检查主人接口及未授权运行被拒绝，并可观察停用后旧会话返回 `401`。本机 HTTPS 回归已通过，第二台设备的报告仍需现场取得。
- [x] P5 部署侧容量取样准备：成员探针 `--measure-history` 对配置的 HTTPS 实例测量线程首屏与三轮共 12 次条件请求。回环验收覆盖首屏大小核对、越权拒绝、条件请求 `304` 且正文 0 B，以及报告不泄露凭据和页面内容。实际部署路径、代表性数据和多会话/运行容量仍待现场验收。
- [延期] P5 远程交付：受控私有链路及两台实机验收。桌面本机 MVP 不以远程多设备为发布门槛；若后续恢复远程部署，仍须按 `HTTPS-PILOT.md` 完成这些验收。SQLite 不是共享多实例数据库，暂不支持公网发布。
- [延期/待验证] 第三方真实 Harness：新主线先验证 Codex 与 DeepSeek Harness。旧计划中的 Claude、Pi 全量账号验收不属于首发范围；本机曾检测到 Codex CLI 已安装但未登录，真实联调需在本机 Harness 完成登录后进行。
- [延期] 飞书/Lark 真实群验收：现有本机 mock 双向 MVP 保留；真实企业应用、群聊和外部回调边缘安排在桌面核心工作流稳定后，不是首发阻塞项。

## 产品目标

织点是一款本机优先的桌面 Agent 指挥应用，而不是另一个模型 API 配置器或通用代码编辑器。织点负责团队、角色、任务拆解、派发、权限、独立 QA 和人工验收；Codex 与 DeepSeek Harness 是可被织点调用的本地执行 Harness。作战大屏、Agent 小人、CEO 到专业岗位的真实交接动画，以及 Harness 分屏是首发体验，不作为后续装饰项。

### 产品约束

- 首发以 Windows 桌面应用为目标。用户通过安装应用启动，不需要手动开浏览器、运行 `pnpm dev` 或维护服务端口；内部可以复用 React/Vite 与 Node 工作流服务。
- 织点默认不收集或保存 Codex、DeepSeek Harness 的 API Key。凭据由对应 Harness 按其支持的登录/配置流程管理；织点只读取官方接口允许读取的状态，不扫描或解析私密凭据文件。
- 通过公开的本地协议、SDK 或 CLI 适配 Harness；不依赖坐标点击、私有 HTTP 接口、DOM 抓取或注入对方应用。
- “分屏 Harness”首选显示与具体 Agent/Run 绑定的实时事件、阶段、工具活动、最终结果和差异；需要 Harness 完整原生界面时提供“打开 Harness”入口。仅在官方支持稳定嵌入时才考虑内嵌第三方 UI。
- 并行写入必须隔离工作区。Git 项目优先使用每项并行工作的独立 Worktree；不适用时退回串行共享目录并阻止并行写入。
- 远程多设备、公网部署、Claude/Pi 扩展及真实飞书/Lark 群集成不是桌面 MVP 的发布门槛；既有代码和安全文档保留，待本机核心路径稳定后再评估。

## 现有资产与缺口

| 部分 | 可复用资产 | 新主线缺口 |
|---|---|---|
| 作战大屏 | `src/App.tsx` 已有 Agent 办公室、角色小人、任务和 CEO 交接动画；`src/App.css` 已实现交接路线动效。 | 部分首页状态仍是演示数据；需让 Agent 在线状态、派发、动画和分屏内容全部由真实 Harness 事件驱动。 |
| 工作流 | `Project / Thread / Message / Session / Task / Run / Review`、CEO 规划、专业岗位、独立 QA、取消、重启恢复和幂等提交已实现。 | 需把任务派发映射为可关联的持久 Harness 会话/线程，跨 Harness 汇总事件和最终产物。 |
| Codex | `server/codex-executor.mjs` 提供 `codex exec --json`；`server/codex-app-server-executor.mjs` 已接入官方 App Server，支持线程创建/续接、事件投影、取消和拒绝额外授权，并将 Harness thread/turn ID 关联到织点运行记录。 | 当前本机状态探测为 CLI 0.151.0 / connected；仍需真实 App Server 模型任务与打包桌面端端到端验证。 |
| DeepSeek | `server/deepseek-executor.mjs` 直接调用 DeepSeek HTTP API；统一注册表支持能力与权限声明。隔离 `DSH_HOME` 的 SDK runtime handshake/shutdown 曾在临时空配置目录通过。 | 面向本机 Harness 的执行适配尚未接入；将 SDK 加入本仓库的尝试被 pnpm 的 ignored-builds 安全门槛阻止（涉及 `dsh-subprocess-local`、`koffi`、`node-pty`），依赖随后已移除。必须先审查构建脚本与打包/隔离方案；不读取或复用正在运行 GUI 的私密 profile。 |
| 桌面生命周期 | 现有 React/Vite 与 Node 服务可作为 UI/工作流基础。 | 尚无安装包、桌面进程管理、原生窗口菜单、打包运行时、Harness 发现与用户级升级/恢复流程。 |
| 安全与数据 | 本机权限、数据迁移、审计、备份/恢复、回环 HTTPS 和外部入口 mock 已有代码及回归。 | 需把桌面 IPC/本机服务边界纳入威胁模型；不能因安装成桌面应用就放松现有路径、命令和凭据隔离。 |

## 新路线图

### D0 — Harness 与桌面集成可行性验证

- Codex：在受控临时项目中验证官方 `app-server` 的启动、会话/线程恢复、发送任务、事件流、取消和审批交互；确认可使用用户本机已登录配置且不向织点复制凭据。比较现有 `codex exec` 的已知行为，保留其作为短任务/降级适配器的可能性。
- DeepSeek Harness：优先固定经验证的官方 TypeScript SDK/CLI 版本，验证最小任务、事件、会话恢复、取消和权限配置。明确 Node/原生依赖、独立 `DSH_HOME` 与 GUI profile 的关系；凭据由独立 Harness profile 管理，不在织点收集。
- 对“分屏”做一次交互原型：织点内实时事件面板、可打开 Harness 原生窗口；只有公开支持的嵌入接口能满足稳定性和登录要求时，才采用原生 UI 内嵌。
- 对 Electron/Tauri 等桌面壳做限时垂直切片比较：验证现有 Node 服务的打包、Node/SQLite 兼容、进程关闭与子进程终止、Windows 安装和自动启动；依据实测选择框架，不预先锁死技术。

**验收门槛：** Codex 与 DeepSeek Harness 各自在隔离测试目录完成一次受控任务，任务/事件/最终结果能被织点侧关联；取消确实停止可控运行；密钥不进入织点日志、数据库、前端存储或测试报告。若 DeepSeek Harness 不能通过受支持接口复用既有运行环境，记录差距并先采用官方 SDK 的显式 profile 配置，不做 GUI 逆向。

#### D0/D1 执行记录（2026-11-19）

- D0 Codex：本机 Codex CLI 0.151.0 的 `app-server` JSON-RPC `initialize` / `account/read` 可用；另在临时目录、只读沙箱、ephemeral thread 中完成一次 CLI 短任务，收到 20 个事件、`turn/completed` 和 `D0_OK`。这证明 CLI 登录态可用于受控短任务，不等于已完成 app-server 的线程恢复、事件续接、取消和审批验收；这些仍待验证。测试没有触发工具操作，临时目录已删除。
- D0 DeepSeek Harness：官方 `@deepseek-ai/dsh-sdk-client@0.2.2-rc.5` 曾在临时空 `DSH_HOME` 中完成 runtime handshake 和正常 shutdown；尚未用真实账户执行模型任务，也未验证恢复、事件流、取消、Agent Teams 或与 GUI 共用 profile。官方发布包核验显示客户端依赖同版本完整 `dsh`；Node 要求为 `>=24.9.0`，运行栈含 `koffi` 与 `node-pty` 原生依赖。此前 pnpm 因 `ERR_PNPM_IGNORED_BUILDS` 阻止这些包的构建脚本；依赖已移除，未跳过安全门槛。官方 `sdk-minimal` 依赖 `DEEPSEEK_API_KEY` 环境变量、默认 `danger-full-access`，且其 DeepSeek session-log 默认会随请求上传未接受事件，因此不适合作为织点默认 profile。后续若接 SDK，应采用标准 `sdk` profile、织点专属 `DSH_HOME`，并通过独立补丁关闭 `session-log-deepseek` 与 `plugin-package-inventory-deepseek`；任务权限需从 `workspace-write` 起步、额外审批默认拒绝，并向用户披露 Windows 沙箱目前仅为部分强制。真实运行能力尚不能判定通过。
- D0 桌面框架（2026-11-19）：Windows x64 上 Electron `45.4.1` 实际运行成功；`pnpm desktop:dir` 与 `pnpm desktop:installer` 均成功，`@electron/get` 对下载二进制完成 SHA-256 校验。已验证 app.asar 中的 Node utility process 可启动工作服务。Electron 作为 MVP 框架的实测依据已成立；未做完整 Tauri 对照，D0 总体验收仍受 Harness 验证项阻塞。
- D1 Electron 桌面壳（2026-11-19）：保留单实例、最小 preload、随机回环端口与 32 字节一次性令牌；只对当前可信窗口请求添加授权头，启用 `contextIsolation`、`sandbox`、禁用 Node integration，并阻止外部导航/弹窗。Electron utility process 运行 app.asar 内的 `server.mjs`，令牌校验后从服务进程环境移除。实际窗口已打开并渲染现有工作台。
- D1 桌面运行验收（2026-11-19）：真实 Electron 进程仅在 `127.0.0.1:<随机端口>` 监听；未带授权头的 `/` 与 `/api/health` 均为 HTTP 403。以临时 `--user-data-dir` 顺序执行关闭、重启，初始化后的空 `data/workflow.json` SHA-256 不变；关闭后监听消失。NSIS 安装器在全新临时目录安装成功（退出码 0），已安装应用启动并监听回环地址，正常关闭后静默卸载成功（退出码 0，安装 EXE 已移除）。产物未签名（无代码签名证书）。尚未验收桌面图标入口、非空业务记录恢复、活动任务子进程清理及升级回滚。
- D2 Codex（2026-11-19）：新增 `server/harness-discovery.mjs`，使用 `codex --version` 和 App Server `initialize` / `account/read` 只探测兼容性与连接状态；不持久化账户详情。此机实测 CLI `0.151.0`、状态 `connected`，不发起模型任务。`codex-app-server` 执行器支持 thread start/resume、turn、事件、取消和拒绝审批，并把 thread/turn ID 写入织点运行记录；相关 mock 单测与 E2E 状态接口检查通过。一次独立状态探测在打印结果后未按预期退出；随后将 Windows 进程树清理改为有超时的 taskkill 与目标进程回退终止，并新增卡住 taskkill 的回归测试。修改后同一只读状态探测输出 `connected` 并在 2.28 秒内正常退出。真实账户只读任务及线程续接/取消已在下文补测；Windows 临时工作区和 CLI 进程退出异常仍待定位；未证明打包版可发现 PATH 中的 Codex。
- D2 DeepSeek 发现（2026-11-19）：`inspectDeepSeekHarness` 只运行 `dsh --version`，采用精简环境，不读取 DSH_HOME、凭据或账号状态；CLI 找到时也只返回“适配待完成”，不会注册为可分配执行器。新增 mock 回归检查版本解析、未安装状态与环境脱敏。此机实际未发现 `dsh` 命令；没有执行 DeepSeek 模型任务。
- D2 Codex App Server 真实冒烟（2026-11-19）：在隔离临时目录、`readOnly: true` 下通过当前 Codex 登录态调用 `runCodexAppServer`，收到精确回复 `ZHIDIAN_D2_CODEX_APPSERVER_OK`，捕获线程/回合 ID 和真实事件，目录未产生文件；随后连续验证持久线程创建、`thread/resume` 续接及收到 `turn/started` 后取消，三项底层操作均返回通过，事件计数依次为 12/14/2。未触发工具或文件修改。**Windows 清理异常：** 两次临时工作区均为空，但 `fs.rm` 返回 `EBUSY`；第二个 PowerShell stdin 管道运行器在输出全部通过记录后仍未退出，手动中断后进程退出码为 1。根因尚未定位，故这些操作结果不是完整的干净进程生命周期验收；未终止任何在测试开始前已运行的 Codex 进程，也未强删仍被占用的临时目录。真实调用会消耗本机 Codex 账户用量。
- D2 DeepSeek SDK 替代路线（2026-11-19）：PyPI 提供 `deepseek-harness-sdk` 与 Windows x64 `deepseek-harness-runtime-bin` `0.2.2rc2`；下载元数据显示 runtime wheel 约 87 MB，显著增加桌面包体。尝试获取 wheel 时大文件传输无进展，已停止该下载；未取得 wheel/source、未安装或执行，故 SDK 的隐私、profile、权限、恢复与取消行为仍待源码审计和实测。此机没有 `dsh` CLI；未读取 GUI profile，未向 DeepSeek 发送请求。DeepSeek 本机 Harness 接入保持未完成。
- 当前回归（2026-11-19）：本次更新后 `pnpm lint`、`pnpm build`、`pnpm test`（89 项：88 通过、1 跳过、0 失败）、`pnpm test:e2e`、`pnpm test:https` 均通过；Electron 主/预加载脚本未改动。

### D1 — Windows 桌面应用壳

- 复用现有 React 界面和 Node 工作流服务；桌面应用负责启动/停止本地服务或进程宿主，保持单实例，关闭时有序停机。
- 应用窗口直接加载本机 UI，不要求用户手动管理浏览器标签、开发服务器或 API 端口。主进程与 UI 之间使用受限 IPC；若阶段性仍需本机 HTTP，使用回环绑定、随机端口/短期令牌并拒绝外部访问。
- 处理 Windows 路径、工作目录、用户数据目录、日志位置、应用退出、崩溃和升级中断；不得把项目数据、密钥或 Harness 登录态打入安装包。
- 先完成可本地安装/卸载的开发包，不在此阶段承诺代码签名或静默自动更新。

**验收门槛：** 在未启动开发服务器的情况下，从桌面图标启动应用、关闭并重开；工作流记录保留，子进程按策略停止或记录中断；没有非预期公网/局域网监听；干净测试账户不要求全局安装项目依赖。

### D2 — 本机 Harness 发现与会话适配

- 把“模型接入”主路径改为“本机 Harness”：显示已发现/未发现、版本、连接状态、支持能力、可打开原生 Harness 的入口；检查项只调用官方 CLI/SDK 能力，不读取密钥内容。
- Codex 适配器优先接官方 `app-server`：映射织点 Agent、Thread、Task、Run 与 Harness thread/turn ID，消费通知，支持恢复和取消；为审批/工具活动定义最小事件投影。
- DeepSeek Harness 适配器封装在独立进程/SDK 边界；固定受支持版本，显式指定受控 `DSH_HOME` 和工作区，不直接复制或回写用户的私密配置。标准 profile/Agent Teams 能力在实测前标记为实验性。
- 将直接 DeepSeek API 配置从普通用户首选路径移除；旧 API 执行器可保留为高级/兼容模式，旧凭据不删除、不自动迁移、不再次展示明文。
- 统一能力声明、权限检查、超时、取消、错误脱敏、输出限制和结构化事件；Harness 不可用时明确提示，不静默改走另一服务商。

**验收门槛：** 断网/未安装/未登录/版本不兼容时显示明确状态；两个官方 Harness 各完成真实本机冒烟任务；线程、运行、取消及错误与织点记录一一关联；Harness API Key 不出现在织点配置页面。

### D3 — 跨 Harness 的角色编排与工作区隔离

- CEO 计划显式指定岗位、Harness、任务依赖和并行组；用户可在提交前检查/修改派发方案。
- 执行器路由支持 CEO 用一个 Harness、专业 Agent 用另一个 Harness、QA 使用独立角色；结果统一回到织点的任务/Run 时间线。
- Git 项目为并行写入岗位建立独立 Worktree；检测到未提交变更、分支冲突或不安全路径时先拒绝或要求用户处置。非 Git 项目或无法创建 Worktree 的任务使用共享目录串行锁。
- 聚合部分结果、失败、重试、超时、取消和服务重启恢复；取消不声称回滚已发生的文件改动。
- [x] 独立 QA 与人工确认分离。真实任务 QA 通过后进入 `awaiting-approval`，此时不会发送 `approved` 通知。主人可确认交付，或填写原因退回；退回不会自动重跑，重新执行后由新 QA 记录重新进入验收。旧的 `approved` 记录保持原样，不补记人工决定。

**验收门槛：** 一个任务由 CEO 规划后至少派发给 Codex 与 DeepSeek Harness 各一个岗位，状态和产物能关联；并行写入不修改同一工作目录；QA 失败可阻止任务通过；重复提交不重复启动 Harness 会话。

### D4 — 作战大屏与分屏 Harness

- 保留现有办公室大屏、小人、角色岗位、任务流水线和人工验收视图，替换或明确标记所有演示数据。
- CEO 派单事件驱动小人移动到目标岗位；动画开始、交接完成、Harness 启动、运行中、等待审批、完成/失败分别对应真实事件，不用定时器模拟执行成功。
- 每个活动 Agent 可在分屏中打开对应 Harness 运行面板，显示 Harness 名称/版本、线程、事件流、工具活动摘要、最终文本、文件差异、QA 状态和错误；提供停止/重试/打开原生 Harness 操作。
- 允许切换 1/2/多窗格布局，记住窗口布局但不在浏览器 LocalStorage 保存密钥或完整敏感提示；适配小屏幕时退化为可切换标签而不挤压文本。
- 将状态可视化与权限、任务数据绑定；只读成员/访客视图不得暴露原始 Harness 输出、项目路径或未授权任务。

**验收门槛：** Playwright 与打包桌面应用均通过桌面/窄窗口截图检查；真实交接事件可复现动画；多个运行窗口不串流、不串项目；关闭或重开窗口后布局可恢复，运行数据不会重复提交。

**当前验收进度（2026-11-19，D4 部分完成）：**

- 从作战大屏提交任务后不再跳到任务列表。修复交接动画的帧与计时器清理、目标人物接收动效的横向偏移，以及窄屏派单表单无法滚动、办公室右侧岗位被裁切的问题。
- `pnpm test:https` 启用 Playwright 后通过。在 1440px 和 390px 从大屏表单提交只读测试任务，由真实工作流服务发出 `handoff.created`，模型响应使用本地 mock。测试核对前端 Agent 是唯一目标，CEO 人物从自己的工位移动到目标旁边，动画结束后恢复待命，办公室不横向溢出。修改前复现了提交后跳页，以及 390px 下提交按钮超出视口的问题。截图保存在 `release/desktop/d4-evidence/`；可用 `ZHIDIAN_TEST_OFFICE_SCREENSHOTS` 指定截图目录复跑。`pnpm lint`、`pnpm build`、`pnpm test`（88 通过、1 跳过）及 `pnpm test:e2e` 通过；后者曾有一次重启恢复用例未通过，串行重跑通过。
- Windows x64 免安装预览位于 `release/desktop/d4/win-unpacked/织点.exe`。用独立临时 profile 验证了窗口启动、只监听 `127.0.0.1`、匿名 `/api/health` 返回 `403` 与正常退出后端口关闭。预览未签名；未更新旧安装器。
- **真实 Codex 桌面实测：** 使用上述免安装包和隔离 `--user-data-dir`，以 Playwright 连接仅测试实例启用的本机回环调试端口。从「作战大屏」表单提交后返回 HTTP 202，CEO 小人走到前端 Agent 旁；CEO、前端、QA 三个岗位均经本机 Codex App Server 完成，分别保存不同的 Harness thread/turn ID。前端只新增临时项目中的 `report.txt`；独立 `node verify.cjs` 退出码为 0，输出 `ZHIDIAN_D4_QA_OK`。重启同一测试 profile 后恢复原任务、线程、三条运行与 QA 记录；两次退出码均为 0，工作台端口均释放。未使用 mock，未输入织点 API Key，未修改预览包。打包应用画面与结果见 `release/desktop/d4-evidence/office-dispatch-packaged-live-codex.png` 和 `release/desktop/d4-evidence/packaged-live-codex.json`。
- **Harness 分屏已实现：** 作战大屏工位可打开对应运行，切换页面不会重播已处理的交接动画。最多打开四个固定到 Run ID 的窗格，可按项目选运行，显示 Harness、线程/回合、实时事件、工具活动摘要、输出、变更文件、QA 与错误；可停止指定运行、打开对应任务详情重试，或在桌面端打开新的 Codex 终端。窄屏只显示当前窗格，可切换。桌面配置只保存窗格 ID、焦点及布局，不保存输出或凭据。
- **分屏验证：** `pnpm lint`、`pnpm build`、`pnpm test`（89 通过、1 跳过）、`pnpm test:e2e` 与带 Playwright 的 `pnpm test:https` 通过。浏览器 mock 测试验证两个项目窗格并排、不串数据、仅取消选中的运行、刷新恢复布局和 390px 切换；匿名与只读成员不能读取 owner 的运行详情。打包版实测收到了真实 Codex 事件，独立 `node verify.cjs` 退出 0。最终包在隔离 profile 打开该真实记录的副本，验证前端与 QA 并排以及换回环端口后重启恢复。证据位于 `release/desktop/d4-split-evidence/`，免安装版位于 `release/desktop/d4-split/win-unpacked/织点.exe`；未签名，旧安装器不变。
- **人工验收：** 大屏验收队列只列真实待确认任务；定时触发在等待确认时不视作占用执行器，确认后才算完成。`pnpm lint`、`pnpm build`、`pnpm test`（89 通过、1 跳过）、`pnpm test:e2e` 和带 Playwright 的 `pnpm test:https` 通过。专项回归覆盖重启恢复、退回重跑、旧 QA 决策被拒、并发确认幂等、只读权限及 mock 飞书仅投递一次。新版免安装包 `release/desktop/human-gate/win-unpacked/织点.exe`（未签名），旧预览和安装器未替换。
- **人工验收桌面实测：** 新免安装包在隔离 profile 使用本机真实 Codex 完成 CEO、前端、独立 QA 三段。临时项目生成 `report.txt`；独立 `node verify.cjs` 退出 0，输出 `ZHIDIAN_HUMAN_GATE_QA_OK`。关窗重启后，同一条 QA 记录仍待确认，从大屏打开并点击「确认交付」后才成为已交付，无额外运行。两次关窗均正常退出并释放回环端口。测试日志、脚本和应用截图在 `release/desktop/human-gate-evidence/`；没有配置真实飞书群投递。
- **仍待实现或验收：** 本机 DeepSeek Harness、窗格内完整行级差异、运行时版本和原生会话直达、可编辑的 CEO 计划、跨 Harness Worktree 隔离、升级回滚及有活动任务时的桌面关闭。截图来自打包应用自身的 Electron renderer 或浏览器回归，不是操作系统窗口抓图。

### D5 — 桌面 MVP 稳定性与现有能力接入

- 接入已有持久线程、定时计划、项目授权、备份/恢复、操作审计、投递记录与安全停机；优先复用现有服务端逻辑，不重复实现业务规则。
- 保留飞书/Lark 本地入站草稿与主人确认模型；真实群聊和公网回调暂缓。应用内通知先交付；外部通知仅在用户显式配置时启用。
- 增加数据库/文件迁移说明、日志导出/脱敏、异常恢复和“打开数据目录”能力；升级必须先备份，失败可回到上一个可启动版本。
- 运行全量回归、依赖审计、桌面 IPC/服务端口安全检查和真实 Harness 账户的最小流程测试。

**桌面 MVP 发布门槛：** 新用户可安装并启动应用；连接本机 Codex 与 DeepSeek Harness；在作战大屏创建任务、查看 CEO 派发动画、同时观察对应 Harness 分屏运行、完成独立 QA 和人工验收；关闭/重启后线程和运行历史一致；不需要在织点录入 Harness API Key；默认不对局域网或公网开放服务。

### D6 — 后续可选能力

- 受控私网/多设备访问、生产级远程服务、外部日志采集和集中部署验收继续以 `SECURITY-ARCHITECTURE.md`、`HTTPS-PILOT.md` 为准，单独立项，不因桌面 MVP 通过而宣称完成。
- 真实飞书/Lark 群、更多 Harness（Claude、Pi）、团队共享数据库、签名更新和跨设备同步按实际用户需求排期。
- 公网服务不在当前计划范围内；现有 SQLite 单主机模型不支持多实例共享写入。

## 推荐执行顺序与首个垂直切片

顺序：**D0 可行性验证 → D1 桌面应用壳 → D2 Codex/DeepSeek Harness 连接 → D3 角色编排和 Worktree 隔离 → D4 作战大屏/分屏实况 → D5 桌面稳定性与发布包**。D6 延后。

首个垂直切片：用户从桌面应用选择一个临时 Git 项目并提交任务；CEO 生成可编辑派发计划；用户确认后，前端岗位通过本机 Codex、研究岗位通过本机 DeepSeek Harness 在各自隔离工作区执行；作战大屏显示 CEO 小人真实移动；两个 Harness 分屏显示对应事件；独立 QA 验证结果；用户检查差异并确认。整个流程不在织点输入模型 API Key，不向公网开放监听。

## 当前可复用回归

- `pnpm lint`
- `pnpm build`
- `pnpm test`
- `pnpm test:e2e`
- `pnpm test:https`（保留为现有回环 HTTPS/安全行为回归，不代表桌面安装包验收）
- `pnpm bench:pilot 1000`（本机临时 SQLite、8 个会话；不访问外部服务）

每个 D 阶段除上述回归外，都需有针对性测试；mock 只证明协议/逻辑，不替代本地真实 Harness 冒烟。涉及真实账号时，不将密钥粘贴到聊天、测试报告或织点日志。

## 集成依据与待验证假设

- Codex：采用官方公开的 `app-server` 集成协议进行本机可行性验证；具体 CLI 版本、认证复用、审批和线程恢复行为以实际安装版本测试为准。
- DeepSeek Harness：采用官方 TypeScript SDK/CLI 受支持接口，不假设 SDK 与桌面 GUI 的私有状态天然共享；固定 SDK/Node 版本，并通过启动、停止、隔离登录、取消和升级演练。
- 分屏：织点面板先消费官方运行事件并展示过程；不把未经支持的第三方 GUI 嵌入、抓取或自动点击列为交付承诺。
- 桌面框架：在 D0 的真实打包垂直切片后决定；决策标准为 Windows 进程生命周期、Node/SQLite 兼容、子进程管理、应用安全边界和增量升级/回滚，而非只看 UI 开发速度。
