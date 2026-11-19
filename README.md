# 织点 AI 工作团队

一个用于展示和运行多 Agent 团队协作流程的本地 Web 应用。工作台保留作战大屏、真实小人、岗位模型路由、Skills 绑定、任务流水线和人工验收视图，同时提供真实本地任务执行工作流。

## 当前能力

- 作战大屏与 Agent 岗位：CEO、前端、后端、测试、研究、设计和运营等岗位可分别配置模型服务商、Model ID、Skills 和执行器。
- 五类执行器：通用模型 API 受控文件补丁、专用 DeepSeek API 执行器、本机 Codex CLI、本机 Claude Code CLI，以及显式开启的 Pi CLI。Claude Code 和 Pi 仅启用受限文件工具且不开放 Shell；Pi 默认不注册，需设置 `ZHIDIAN_ENABLE_PI=1`。在只读项目中，通用模型 API 和 DeepSeek 可作为专业岗位分析项目快照，不得提交补丁或命令；直接操作工作区的 CLI 不可作为该项目的专业岗位。
- 执行器由注册表统一声明能力并执行项目权限检查；运行具有超时/取消信号，任务详情可取消排队或正在运行的阶段。取消后不会自动重放写入阶段；本机 CLI 在被终止前可能已修改部分文件，因此取消后应检查工作区差异。
- 任务按 `Project / Session / Task / Run / Review` 保存；任务后台串行排队，CEO 计划把工作交给选中的专业 Agent，按计划中的岗位顺序逐个交接，最后交给独立 QA。
- UI 通过 SSE 接收运行事件；任务中断不会自动重放正在运行的写入阶段，排队中的阶段会在服务重启后恢复。失败阶段可重试，包括 CEO、专业 Agent 和 QA。
- **工作线程**：真实工作流会在侧栏形成一个持久线程。打开线程可以看消息、任务与运行记录，并按原项目及原 Agent 配置继续跟进；恢复历史使用限长快照，不会装入其他线程的消息。
- **定时任务**：从已有真实任务创建一次、每日或每周计划。支持暂停、修改、立即触发和取消；错过的计划可跳过或补跑一次，同一计划不会并发。周期规则使用 IANA 时区；夏令时重复时刻只触发较早一次，不存在的时刻顺延一个时差。可对规划超时退避重试，写入后失败不自动重跑。
- **结果交付**：可按项目配置飞书或 Lark 自定义机器人，勾选终态事件并查看投递历史。只发送固定状态和任务编号；Webhook 和签名密钥支持实例密钥环加密，兼容旧 Windows DPAPI。明确限流会退避，发送结果不明不会自动重发。实际群聊需用专用测试群验证。
- **飞书/Lark 入站**：主人可按项目管理收件箱。群内查询只返回任务状态；建任务和续接先进入收件箱，主人确认后才启动。审批请求只可标为已阅，不更改验收结果。已通过本机模拟联调，真实群聊待验收。
  确认新建任务时，可以按标题搜索或翻页选择同项目已有任务，复用其岗位配置；确认后点击「查看任务」打开新任务。
- 独立 QA 在 `execute` 项目模式下运行用户单独配置的验收命令；任意命令失败、跳过、超时或未配置验收命令，都会阻止任务通过。
- 长期上下文独立于一次性会话/任务记录管理，支持个人偏好、项目资料、标签与 Skills。任务创建时只检索当前项目和个人资料中与标题/背景关键词匹配的条目，命中内容快照随任务保存，详情页可查看。
- 默认只监听回环；支持可选主人登录与按项目授权的只读成员。HTTPS 回环试点强制登录、SQLite 与实例密钥环，不是公网部署模式。密钥明文不返回前端。

## 本地运行

需要 Node.js 24 和 pnpm：

```bash
pnpm install
pnpm dev
```

访问 `http://127.0.0.1:5173`。验证命令：

```bash
pnpm lint
pnpm build
pnpm test
pnpm test:e2e
pnpm test:https
```

如果原实例仍在运行，可另设 `ZHIDIAN_UI_PORT`、`ZHIDIAN_API_PORT` 和 `ZHIDIAN_DATA_DIR` 启动独立实例。服务验证精确的本机 UI 端口，保持回环绑定。

## 本机登录（可选）

生成高熵随机访问密钥，在启动服务的 PowerShell 窗口设置其 SHA-256 摘要（不要用可猜测口令）：

```powershell
$key = node -p "require('node:crypto').randomBytes(32).toString('base64url')"
$env:ZHIDIAN_OWNER_KEY_HASH = [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData([System.Text.Encoding]::UTF8.GetBytes($key))).ToLowerInvariant()
$key
pnpm dev
```

浏览器输入生成的密钥。会话最长 8 小时，退出或服务重启后失效；退出同时关闭实时运行流。开启登录后，主人可在「项目成员」发放可撤销的只读访问密钥。成员只能查看获授权项目的状态，不可执行、读原始日志或管理配置。不要提交、截图或在群聊发送访问密钥。

## 数据迁移与恢复

工作流当前为 v4。默认使用 JSON；`ZHIDIAN_STORAGE=sqlite` 首次启动会导入 `workflow.sqlite` 并保留原 JSON。已有 SQLite 时后续启动会自动选择 SQLite，不要将旧 JSON 当作同步副本。直接用 JSON 模式启动旧文件时，升级前的 `workflow.json` 会保存为 `workflow.json.backup-v*-*.json`，旧 `runs.json` 不会被改写。降级应使用匹配版本的完整备份，新版本期间的记录不会自动合并回旧版。

备份前先停服务并确认无写进程，再备份整个数据目录（含可能存在的 SQLite WAL/SHM 文件和 `providers.json`）；密钥环单独保管。恢复时先对停机副本运行 `node server.mjs --check-data`，核查记录和密钥，不启动调度或任务。实际试运行仍需隔离工作区和通知渠道。旧 DPAPI 记录依赖原 Windows 用户及其系统凭据。轮换和恢复操作见 [安全架构](SECURITY-ARCHITECTURE.md)。

## HTTPS 本机试点

构建后以 `pnpm api` 启动，按 [HTTPS 验收说明](HTTPS-PILOT.md) 配置证书、绝对路径密钥环、认证及 SQLite。开发用 `pnpm dev` 仍使用本机 HTTP。默认仍只监听回环；`pnpm test:https` 使用临时自签证书和本机模型 mock，需要 `openssl` 或 `ZHIDIAN_TEST_OPENSSL` 指向其可执行文件。

本机回调测试可额外设置 `ZHIDIAN_ENABLE_INBOUND=1`，由主人在「飞书 / Lark 入站」为项目填写应用 ID、租户 Key、验证令牌、加密密钥及允许的用户 Open ID 或群聊 ID，再启用项目入口。回调路径为 `/api/inbound/<项目 ID>`。应用密钥可选，用于回复原消息；不填时状态及收件回执仅记录在工作台。支持 `状态 <任务编号>`、`任务：标题`（可换行补充背景）、`回复 <线程编号>：内容`、`审批 <任务编号>`。外部平台不能直接访问本机回环；不要为联调开放工作台公网端口。撤销项目入口会停止新请求和未发送的应用回复；历史仍可查，旧草稿不能继续执行。停掉全局开关需重启。

需要接测试群时，见 [飞书 / Lark 回调试点](FEISHU-PILOT.md)。专用转发进程默认不运行，只允许指定项目的回调进入回环 HTTPS 服务，不转发工作台。外部入口需单独授权并验收。

需要在受控私网中直接访问时，必须使用明确的私有 IPv4、HTTPS、主人认证、实例密钥环和客户端地址白名单；服务拒绝 `0.0.0.0`、公网地址和未确认的非回环监听：

```powershell
$env:ZHIDIAN_BIND_HOST = '192.168.1.10'
$env:ZHIDIAN_PRIVATE_BIND_CONFIRM = 'I_UNDERSTAND_PRIVATE_TLS'
$env:ZHIDIAN_PRIVATE_CLIENTS = '192.168.1.20'
$env:ZHIDIAN_API_PORT = '9443'
$env:ZHIDIAN_HTTPS_ORIGIN = 'https://192.168.1.10:9443'
$env:ZHIDIAN_STORAGE = 'sqlite'
$env:ZHIDIAN_OWNER_KEY_HASH = '<主人密钥 SHA-256，不要填写明文密钥>'
$env:ZHIDIAN_CREDENTIAL_KEYRING = 'C:\Dev\ZhidianPilotSecrets\keyring.json'
$env:ZHIDIAN_TLS_CERT = 'C:\Dev\ZhidianPilotSecrets\server-chain.pem'
$env:ZHIDIAN_TLS_KEY = 'C:\Dev\ZhidianPilotSecrets\server-key.pem'
pnpm api
```

证书 SAN 必须包含 `ZHIDIAN_BIND_HOST`，第二台设备只能从 `ZHIDIAN_PRIVATE_CLIENTS` 中的地址访问。该模式只是受控私网试点，仍需按 [HTTPS 验收说明](HTTPS-PILOT.md) 完成第二台实机、出站策略、审计采集和恢复验收，不支持公网发布。

可用 `ZHIDIAN_SMOKE_HOST` 和 `ZHIDIAN_SMOKE_CLIENT` 运行同机私网绑定烟测；它只创建临时数据和证书，结果明确标记为同机范围：`node scripts/private-bind-smoke.mjs`。

升级前可对已初始化的停机 SQLite 副本运行 `node server.mjs --check-pilot`，核对证书、构建、数据与凭据，不启动服务或执行任务。此检查不代替第二台设备的证书信任、网络与权限验收。

## 模型与执行器配置

打开“模型接入”填写 API 地址、API Key 和用于测试的 Model ID；再到“Agent 团队”为每个岗位选模型、执行器和 Skills。API Key 只在对应服务商网站创建，不要提交到 Git、截图或聊天中；若此前泄露，应立即撤销并重新签发。

使用 Codex CLI 执行器前，请在本机安装并登录 Codex CLI。可用 `ZHIDIAN_CODEX_PATH` 指向可执行程序。Claude Code 执行器需安装并登录 Claude Code CLI 2.1.314 或更高版本；可用 `ZHIDIAN_CLAUDE_PATH` 指向可执行程序。每次运行前会检查版本，并以受限模式启动，禁用会话持久化及定制扩展，只开放 `Read/Grep/Glob`（只读）或 `Read/Edit/Write/Grep/Glob`（写入），并要求 CLI 阻止工作区外读写。Claude 不开放 Shell，QA 验收命令仍由织点单独运行。DeepSeek API 执行器使用模型接入页保存的 DeepSeek API Key；岗位配置的服务商会自动切换为 DeepSeek。当前官方示例模型 ID 为 `deepseek-flash`；连接测试会验证模型是否返回文本，不创建任务。旧工作区已保存的岗位 Model ID 不会被自动改写，停用的旧模型 ID 需在「Agent 团队」显式更新。DeepSeek 与通用模型 API 一样只返回受控文件补丁，不直接写项目文件。Claude Code 的 Model ID 是可选 CLI 覆盖项，留空时沿用 CLI 默认模型。两种 CLI 都使用本机登录态，不在织点填写 API Key。可选 `ZHIDIAN_DATA_DIR` 与 `ZHIDIAN_API_PORT` 调整本地数据目录和 API 端口。

DeepSeek 新实例默认使用官方 API 根地址；已经保存的 `/v1` 地址会继续按原配置调用，不会自动迁移。

Pi CLI 适配器默认关闭。确认已安装并登录 Pi、理解其仍以当前 Windows 用户身份运行后，才在启动服务的 PowerShell 中设置 `$env:ZHIDIAN_ENABLE_PI = '1'`；可用 `$env:ZHIDIAN_PI_PATH` 指向 Pi 可执行程序。织点使用 Pi 的 JSON 模式并关闭会话、扩展、技能、MCP、项目上下文、提示模板和主题，只开放 `read/grep/find/ls`（只读）或加上 `edit/write`（写入）；不开放 `bash`、`powershell` 或其他命令工具。Pi 的工具白名单不是 OS 级隔离，真实部署仍需主机账户、项目目录 ACL、出站策略和 CLI 登录态验收。取消或超时会终止进程树，但不能回滚已经落盘的文件修改。

可将 `ZHIDIAN_TEST_CODEX_PATH` 指向部署使用的 Codex 可执行文件，再运行 `pnpm test`，检查其是否接受织点生成的只读与工作区写入参数。此测试仅调用 CLI 的 `--help`，不消耗模型额度，也不验证登录状态。

真实账号验收应在临时测试项目中进行：放一份不含秘密的 README，在「模型接入」保存待测 API 凭据或在本机登录相应 CLI。验收模型 API 或 DeepSeek 时，在「Agent 团队」把待测执行器选为专业岗位，提交「总结 README，只给出结论，不改文件、不执行命令」的只读任务。验收 CLI 登录和只读调用时，可在 CEO 或 QA 岗位选择待测 CLI，专业岗位仍使用已验收的快照 API。若要单独验收 CLI 的专业岗位，则需要另用临时目录授权其相应的 `write` 或 `execute` 模式，不用正式项目。检查运行记录中的执行器、模型、岗位与返回结果，并核对项目文件是否符合预期。只记录时间和任务编号，不记录访问密钥；本机 mock 不算真实账号验收。

Codex CLI 能在其工作区沙箱中执行命令，因此专业岗位选择 Codex CLI 时必须把项目明确授权为 `execute`；只需写文件时可选 Claude Code 或模型 API 执行器。取消运行会终止可控的 provider 请求/CLI 子进程和白名单命令；取消不是文件回滚，任何已落盘的部分改动都必须人工检查。取消的任务为终止状态，不会被队列自动恢复或重试。

创建任务时明确填写并授权项目绝对路径。首次建议选“只读分析”；确认可信后再开写入。对于 `execute` 模式，单独填写 QA 验收命令（例如 `pnpm test`、`pnpm build`）。模型 API 执行器所使用的命令还受精确白名单控制；QA 验收命令则是用户在任务表单中直接明确填写、由本机进程运行的独立命令。

## 安全边界（重要）

- Codex CLI 的 sandbox 不是 Docker/虚拟机或完整 OS 级隔离；它不能替代对本机 Coding Agent 的信任判断。`workspace-write` 模式下 CLI 可能在授权项目工作区中运行命令。Claude Code 的工具白名单和工作区读写设置同样不是 OS 级隔离；虽不开放 Shell，进程仍以当前用户身份运行。两种 CLI 都只建议用于可信代码库；不可信项目请勿启用写入。
- 模型 API 的补丁执行器只写入授权项目内普通文件；它拒绝路径遍历、符号链接/目录联接与硬链接目标。模型提出的命令必须逐字出现在该项目的白名单中。白名单命令会以启动织点的当前 Windows 用户权限运行，因此也只能填写可信命令。
- QA 验收命令以本机当前用户权限运行，并受超时与输出上限约束；只填写你自己检查并信任的命令。不要把密钥放入上下文资料或 Skills。
- 长期上下文保存在本机应用数据目录的 JSON 或 SQLite 中，不是加密保险库；只保存非秘密信息。检索按关键词与项目筛选，不是向量数据库。
- 本机浏览器请求会校验精确 Origin/Host，但这不是账号认证，无法防御能直接访问回环 API 的本机进程或同源 XSS。应用数据中的项目路径、任务、上下文和模型输出不是应用层加密保险库。远程部署前必须完成认证、资源授权、多用户存储、TLS、备份与恢复等安全门槛；详见 `SECURITY-ARCHITECTURE.md`。
- 非回环监听只有在显式配置私有 IPv4、精确客户端白名单、HTTPS、主人认证和实例密钥环时才会启动；它仍依赖主机防火墙、网络隔离和服务账户 ACL，不等同于公网安全或 OS 级租户隔离。
- 运行前请检查项目目录、访问模式、执行器及将要运行的命令。即使任务通过 QA，也应在 Git 中检查实际差异。

## 技术栈

React、TypeScript、Vite、Node.js。

## 开源许可证

本项目采用 MIT License，详见仓库根目录的 `LICENSE` 文件。

## CI

GitHub Actions 会运行 lint、build、单元测试和 mock 驱动的端到端工作流测试。测试使用临时目录与本地 mock 服务，不会调用真实模型 API。
