# 织点 HTTPS 回环试点

这是 P5 验收环境，不是公网部署指南。默认服务器监听 `127.0.0.1`；受控私网模式只有在显式配置私有 IPv4、客户端白名单、HTTPS、主人认证和实例密钥环后才会启动。保持原实例运行，本次验收使用新的端口和隔离的数据目录。先用测试项目、假凭据和 mock 渠道，避免任务或通知落到生产环境。

## 启动

1. 使用 Node.js 24 与 pnpm，运行 `pnpm build`。沿用 README 的 PowerShell 7 主人密钥生成步骤，配置 `ZHIDIAN_OWNER_KEY_HASH`；不要将明文密钥写进启动脚本。
2. 配置实例密钥环与可信证书。证书必须匹配浏览器输入的名称；本例使用带 `IP:127.0.0.1` SAN 的 PEM 证书。仅在测试代码中使用临时证书，正常浏览器验收不能跳过证书校验。TLS 私钥与密钥环都要限制文件权限。
3. 在同一 PowerShell 7 窗口设置以下变量。路径需替换为你准备的隔离测试目录及凭据文件。先构建再启动，不使用 `pnpm dev`：

```powershell
$env:ZHIDIAN_API_PORT = '9443'
$env:ZHIDIAN_HTTPS_ORIGIN = 'https://127.0.0.1:9443'
$env:ZHIDIAN_STORAGE = 'sqlite'
$env:ZHIDIAN_DATA_DIR = 'C:\Dev\ZhidianPilot\data'
$env:ZHIDIAN_CREDENTIAL_KEYRING = 'C:\Dev\ZhidianPilotSecrets\keyring.json'
$env:ZHIDIAN_TLS_CERT = 'C:\Dev\ZhidianPilotSecrets\server-chain.pem'
$env:ZHIDIAN_TLS_KEY = 'C:\Dev\ZhidianPilotSecrets\server-key.pem'
pnpm api
```

用浏览器访问设置的 HTTPS Origin，并用主人密钥登录。服务在启动前检查叶证书有效期、SAN 和私钥匹配；客户端仍必须独立验证证书链。部署主机与第二台设备均可用以下探针，不需要访问密钥。第二个参数是已通过可信渠道获得的 CA **公有证书**，不是服务器私钥；使用 Node 已信任的 CA 时可以省略。

```powershell
node scripts/pilot-probe.mjs https://127.0.0.1:9443 'C:\Dev\ZhidianPilot\trusted-ca.pem'
```

通过时返回 TLS 版本、证书到期时间、叶证书 SHA-256 指纹，以及匿名请求和错误来源被拒绝的 HTTP 状态。不验证账号、模型调用或飞书投递。两台设备在同一验收窗口内应看到相同的证书指纹；再用相同的任务和线程记录确认访问的是同一实例，仅比较证书不足以证明这一点。

## 受控私网绑定

这是可选的代码路径，不是本机自动化回归的替代品。服务不接受 `0.0.0.0` 或公网地址，只接受私有 IPv4（包括 RFC1918 和 Tailscale 常见的 `100.64.0.0/10` 地址），并要求客户端 IPv4 白名单。配置示例：

```powershell
$env:ZHIDIAN_BIND_HOST = '192.168.1.10'
$env:ZHIDIAN_PRIVATE_BIND_CONFIRM = 'I_UNDERSTAND_PRIVATE_TLS'
$env:ZHIDIAN_PRIVATE_CLIENTS = '192.168.1.20'
$env:ZHIDIAN_API_PORT = '9443'
$env:ZHIDIAN_HTTPS_ORIGIN = 'https://192.168.1.10:9443'
```

证书 SAN 必须匹配 `ZHIDIAN_BIND_HOST`，并且必须同时配置 `ZHIDIAN_OWNER_KEY_HASH`、`ZHIDIAN_CREDENTIAL_KEYRING`、`ZHIDIAN_TLS_CERT` 和 `ZHIDIAN_TLS_KEY`。启动前先运行 `node server.mjs --check-pilot`，然后在服务器和第二台设备分别运行 `pilot-probe.mjs`。示例白名单只给设备 B；若设备 A 也是部署主机，并要从该主机访问绑定的私网地址，还需明确加入 A 实际使用的私有源 IP。不要使用网段代替精确地址。没有第二台设备、受控私网和可信证书时，不要把本机绑定成功记录为远程验收通过。

服务器本机可以先运行 `ZHIDIAN_SMOKE_HOST=192.168.1.10 ZHIDIAN_SMOKE_CLIENT=192.168.1.10 node scripts/private-bind-smoke.mjs`（PowerShell 中先设置两个环境变量）。该脚本只验证私网地址绑定、TLS、匿名拒绝和错误 Origin 拒绝，并在结束后清理临时数据；输出的 `same-host-private-bind-only` 不能替代第二台设备验收。

## 两台实机验收

如果不启用受控私网绑定，可在**已授权、已配置的私有 SSH 连接**上尝试仅本地回环的 TCP 转发，端到端 TLS 仍由织点终止；不为此新增公网监听、别名或放宽转发头校验。第二台机器上如果本机端口可用，并且已验证 SSH 主机身份和应用证书，可用：

```sh
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:9443:127.0.0.1:9443 user@private-host
```

第二台设备先运行探针，再用浏览器访问 `https://127.0.0.1:9443`。不要暴露任何一端的本地监听到互联网。没有现有私有链路或真实受信证书时，停在回环测试，不做这一步。

- 设备 A 用主人身份创建测试项目/线程，并给设备 B 创建只读成员。两边均验证证书无报警；B 只能看到授权项目状态，直接访问主人接口应失败。
- 在 A 提交一个测试任务，B 在刷新周期内看到同一线程和运行状态。中断再恢复 B 的网络，确认能够继续查看状态。对同一 `Idempotency-Key` 重试，应返回相同的任务 ID；用同键改内容应返回冲突。若 A 没收到有效回执，用原标签页刷新，重新输入完全相同的请求（也不修改项目或岗位配置），手动重提并核对原任务 ID。页面不会自动重发，只保留最近至多 32 条未确认请求的指纹和随机标识，不保存表单正文。关闭标签页、清除或禁用会话存储、请求内容不同、旧记录被淘汰时，不依赖页面去重，先检查服务端任务记录。
- 停机过程中观察运行恢复：排队任务会恢复；已在运行的阶段标记中断，不自动重放。重启后用原账号重新登录；撤销成员应使它已有的会话立即失效。
- 停机测试使用服务的正常 `SIGTERM`/`SIGINT` 路径，不直接强制结束进程。确认活动模型/CLI 收到取消，SSE 连接结束，待写入记录和通知状态落盘，进程退出后数据锁可被新实例取得；重启后活动阶段标记为中断且只保留一次运行记录。
- 验证备份恢复与上线前检查，不记录会话、访问密钥、模型 API Key 或私钥。CLI、QA 和模型网络策略要在实际主机单独验证。

验收记录最少保留：两台设备的日期、探针结果、同一个测试任务及线程 ID、B 断线和恢复的时间、重复提交返回的任务 ID、越权请求状态，以及撤销后旧会话的结果。主机另记录实际部署账户下允许和拒绝的出站测试、审计采集端收到的脱敏 `requestId`、恢复核对的记录数与容量数据。没有采集端回执时只能记作本地轮换有效，不能记作集中留存通过。

### 成员探针取证

1. 在设备 A 创建两个隔离测试项目，每个项目各提交一项测试任务。为设备 B 建一个只授权其中一个项目的临时成员。主人可以从浏览器开发者工具的网络面板中，在任务提交响应里核对 `thread.projectId`、`thread.id`、`task.id` 和 `run.id`，在「项目成员」记录成员 ID。确认另一个项目的运行确实存在；不要导出网络归档或会话 Cookie。选近期任务，因为成员工作台只显示最近 100 条授权运行。
2. 通过可信渠道确认部署证书的叶证书 SHA-256 指纹。从设备 A 的预检报告或已验证的匿名探针输出取 `certificateFingerprint256`。设备 B 的 JSON 文件只填写以下字段，不放密钥、令牌或项目正文：

```json
{
  "memberId": "临时成员ID",
  "projectId": "授权项目ID",
  "threadId": "授权线程ID",
  "taskId": "授权任务ID",
  "excludedProjectId": "另一个项目ID",
  "excludedRunId": "另一个项目的运行ID",
  "certificateFingerprint256": "从设备 A 核验得到的带冒号指纹"
}
```

3. 设备 B 从 PowerShell 7 的遮罩提示输入临时成员访问密钥。以下示例使用私网直连；经回环转发时，把 `$origin` 换成浏览器实际使用的精确 HTTPS 地址，证书必须匹配。Node 已信任 CA 时可省略 `$ca` 参数。

```powershell
$origin = 'https://192.168.1.10:9443'
$ca = 'C:\Dev\ZhidianPilot\trusted-ca.pem'
Read-Host -MaskInput '临时成员访问密钥' | node scripts/pilot-probe.mjs $origin $ca --member .\member-probe.json --watch-revocation
```

4. 探针提示后，设备 A 在 90 秒内停用该临时成员，不要重启服务。设备 B 应得到带时间、任务和线程 ID 的 JSON：`ownerWorkbenchStatus: 403`、`excludedRunStatus: 404`、`oldSessionStatus: 401`。两台设备各自保存无凭据的结果，并将 `401` 与 A 的停用操作时间对照。网络中断或 TLS 验证失败不会计作撤销成功。不加 `--watch-revocation` 只验证观察权限，探针完成后主动注销。

该报告证明所测连接看到了指定项目，并记录所测授权结果；它不证明客户端一定是另一台物理设备，也不替代浏览器断线恢复、去重和主机运维验收。本机 HTTPS 回归对其验证使用临时测试成员、错误指纹、缺失任务和真实禁用操作。

### 部署侧 HTTPS 取样

在获准的测试实例上，按上节准备单项目临时成员和探针 JSON。在停用成员之前，从部署主机及第二台装有 Node 的设备各取一次样；使用各自访问的精确 HTTPS 地址，确认两边证书指纹与验收配置一致。测量窗口内不要改动获授权项目的线程历史。

```powershell
Read-Host -MaskInput '临时成员访问密钥' | node scripts/pilot-probe.mjs $origin $ca --member .\member-probe.json --measure-history
```

`scope: member-history-measurement` 的报告包含获授权的测试任务 ID、首屏条数与正文字节数，以及端到端耗时。探针指定同一成员会话分三轮、每轮四次并行条件请求；稳定时收到 12 个 `304`、总正文 0 B，同时另一个项目的历史请求返回 `404`。每次请求都新建 TLS 连接，耗时含握手，不可直接和浏览器复用连接的延迟相比。探针只测试线程首屏，不读取旧全量成员快照；不提交任务或调用模型，临时登录和注销会留下审计事件，报告不包含页面内容、凭据或 ETag。页面在取样过程中发生变化时，命令退出非零；在安静窗口重测，不记作空闲轮询通过。测量不能和 `--watch-revocation` 同时使用。

这组数据用于对比真实部署路径上的静态读延迟和响应大小，不是多账号容量上限。仍需在实际部署账户与接近真实体量的隔离数据上验证主机内存、并发运行数及升级回退。手机没有 Node 时继续使用浏览器完成两台实机的同步和断线验收；没有客户端探针报告就不记录该端的脚本测量。当前仅同机 HTTPS 验证通过。

## 审计采集

在部署主机上用能读取审计文件的账户运行下面的命令。导出器只读当前和上一份审计文件，不修改源文件、不读取工作流数据库，也不主动连接采集端。先创建访问受限的暂存目录；以下 PowerShell 示例只在导出成功后写入无 BOM 的 UTF-8 快照，每次用新文件。

```powershell
$snapshot = Join-Path 'C:\ZhidianAuditInbox' ('audit-' + [guid]::NewGuid().ToString('N') + '.jsonl')
$lines = @(node scripts/pilot-audit.mjs $env:ZHIDIAN_DATA_DIR)
if ($LASTEXITCODE -ne 0) { throw 'Audit export failed; do not send the snapshot.' }
$jsonl = if ($lines.Count) { ($lines -join "`n") + "`n" } else { '' }
[IO.File]::WriteAllText($snapshot, $jsonl, [Text.UTF8Encoding]::new($false))
```

用已有的受保护传输把快照交给采集端；不要给采集工具开网络端口。可以使用既有采集器，也可在独立采集账户下用本仓库的 SQLite 归档工具。归档路径和快照路径须是采集端的绝对路径；数据库应存于权限受限的独立目录，不是织点的 `workflow.sqlite`。为每个来源实例分配唯一、稳定的实例标识，不能按快照临时生成，也不能给不同实例复用。

```powershell
node scripts/pilot-audit-archive.mjs ingest 'C:\ZhidianAudit\archive.sqlite' 'office-pilot-01' $receivedSnapshot
node scripts/pilot-audit-archive.mjs find 'C:\ZhidianAudit\archive.sqlite' 'office-pilot-01' $requestId
```

`ingest` 输入最多 16 MiB，先校验再写入，返回 `received`、`inserted` 和 `duplicates`。同一个实例、`requestId` 和 `phase` 的相同记录只存一次；同键但内容不同则整批失败。`find` 只查询对应实例的一次请求。日志不含凭据或请求正文，但仍含操作类型与内部 ID；应限制暂存文件、数据库及其辅助文件、备份和查询输出的访问权限，Windows 上由管理员配置 ACL。

现场验证：提交一个测试任务，从其审计结果的 `resourceId`（任务 ID）查到 `requestId`，在采集端核对同一请求的 `attempt` 和 `result`、HTTP `202` 和任务 ID。重复导入同一快照应返回 `inserted: 0`；源日志轮换覆盖后，已归档事件仍应能查到。导出失败或写入冲突不能作为成功回执；轮换导致快照读取失败时可重试，持续失败则检查文件或停机副本。

导出是本机保留窗口内的快照，不是增量。采集间隔应短于高峰期的日志覆盖时间，并监控失败、容量和留存。工具不负责传输、自动留存或防篡改，也无法补回采集前已被覆盖的日志。本机回归已验证导入、重开查询、去重、冲突回滚和轮换后可查；实际部署的账户、传输、留存和恢复仍须现场验收。

## 主机出站验收

准备两个明确授权的 HTTPS 测试端点：一个应允许、另一个应拒绝建立 TCP。拒绝端点也应正常运行，且能从获准的对照环境访问。使用精确 Origin，不带路径、访问密钥或 Webhook 参数；可选单独提供测试 CA 的公有证书。探针不发送 HTTP 或业务数据，也不修改防火墙。

```powershell
node scripts/pilot-egress.mjs control $allowOrigin $denyOrigin
node scripts/pilot-egress.mjs deployment $allowOrigin $denyOrigin
```

第一条在获准的对照环境运行，要求两端 TLS 都通过；第二条在同一时间段用实际织点服务账户和 Node 程序运行，要求允测端 TLS 通过、禁测端的 TCP 连接失败。保存两份结果，并在防火墙或网关日志找到对应拒绝。DNS 失败不算出站拒绝，证书失败不算阻断 TCP；超时或连接拒绝本身也不能证明是策略生效。

探针只覆盖所测两个目的地上的 **Node 直接连接**。若部署通过代理，需验证实际代理路径；Codex CLI、Claude Code 及获准的 QA 程序可能受不同的进程策略约束，应在实际身份和边界下单独测试。回环自动化验证的是探针行为，不是生产出站策略。

## 升级与回退

1. 停止新提交，等待当前阶段与通知确认结束；停机前记下版本和项目、线程、运行数量。完全停机后用下方命令创建、校验备份，恢复到新的验收目录。另存旧版本程序与启动配置，受保护地另存匹配的原密钥环。备份包含工作流和审计数据，不包含项目文件或 TLS 私钥；按 [安全架构](SECURITY-ARCHITECTURE.md) 保护备份和恢复目录。
2. 用候选版本先运行 `pnpm build`，再沿用上面的 HTTPS 变量，将 `ZHIDIAN_DATA_DIR` 指向已初始化的停机 SQLite 副本，运行 `node server.mjs --check-pilot`。它检查数据库完整性、凭据可解密、TLS 证书和密钥、构建入口的资源引用、审计文件类型与大小，不启动 API、调度、任务或投递，也不迁移业务数据。SQLite 可能需要副本目录可写来管理 WAL 辅助文件。核对报告记录数、待恢复事项和指纹；`pilot.notVerified` 列出的客户端信任、私有链路、主机 ACL、出站和日志采集仍需现场验证。只核查数据或使用 JSON 时仍用 `node server.mjs --check-data`。确认后再用隔离工作区和 mock 跑 `pnpm test:https`。
3. 实际升级后用探针和浏览器核对证书、登入、已有任务、SSE 和调度状态。验证 `audit.jsonl` 能关联测试任务的提交与结果；如探针报 `503`，先查日志写入权限和空间。失败时先停新实例，保留排障副本，评估升级后已提交记录和已经发生的文件修改或外部投递；数据回退不会撤销这些副作用。用 `restore` 恢复到另一个未使用目录，再以旧版本和匹配配置启动。不要直接用旧版本打开已经迁移的新数据，也不要同时启动两个副本处理真实任务。

```powershell
node scripts/pilot-backup.mjs create 'C:\Dev\ZhidianPilot\data' 'C:\Dev\ZhidianBackups\before-upgrade'
node scripts/pilot-backup.mjs verify 'C:\Dev\ZhidianBackups\before-upgrade'
node scripts/pilot-backup.mjs restore 'C:\Dev\ZhidianBackups\before-upgrade' 'C:\Dev\ZhidianPilot\upgrade-check'
```

所有路径须为绝对路径，目标父目录须预先存在并有适当访问权限；工具不覆盖已有目录。若恢复中断，使用另一个新目录重新恢复。自动化已在隔离数据上验证 JSON 迁移前原件恢复、SQLite WAL 恢复、篡改检测，以及从 HTTPS 备份恢复后重新登录、查看旧任务和执行项目授权检查；没有在实际部署主机上执行升级。

另在 Windows、Node 24.22.1 上用仓库基线 `05d08c0` 的服务生成一条旧 JSON 项目记录。当前服务在新目录将其导入 SQLite v4，保留原项目 ID，并登记第二个项目。再次从原备份恢复时，JSON 与升级前 SHA-256 一致；使用同一旧版服务启动，只看见原项目。这是隔离目录中的跨版本演练，不是实际部署升级，也未验证真实账号或通知渠道。

## 本机自动化

- `pnpm test:e2e`：工作流、项目授权、SQLite、离线备份与凭据轮换。
- `pnpm test:https`：先执行 `pnpm build`；需要 OpenSSL，可用 `ZHIDIAN_TEST_OPENSSL` 指向可执行文件。测试经过本机独立 TCP 转发端口；握手仍由织点终止，验证可信和不可信证书、匿名访问拒绝和跨来源拒绝。使用 mock DeepSeek，不消耗真实账户额度。
- 可将 `ZHIDIAN_TEST_PLAYWRIGHT` 设为本机 Playwright 入口文件的绝对路径、`ZHIDIAN_TEST_CHROMIUM` 设为本机 Chromium 或 Chrome 可执行文件，追加桌面和手机尺寸的浏览器测试。两个独立会话验证了新任务自动同步、成员侧断网恢复、私有任务隔离，以及禁用成员后无需刷新即退出。主人浏览器还验证了翻页打开旧任务日志、搜索打开旧线程、编辑历史任务来源的定时计划、真实 SSE 交接事件触发 CEO 移动，以及从模拟飞书草稿选择同项目历史源任务、确认并打开详情。故意丢弃新任务回执、替换线程跟进回执后，刷新重提都返回原任务 ID。浏览器测试只对本次证书的公钥设临时例外，不修改系统信任库；不替代第二台设备或真实飞书应用。

## 本机容量基准

运行 `pnpm bench:pilot 1000` 或 `pnpm bench:pilot 5000`。脚本在一次性目录生成历史数据，并启动隔离的回环 HTTP 服务；不读取现有数据或调用外部模型。Windows、Node `v24.22.1` 的单次测量如下。每组包含 20 次单记录变更提交、8 个主人会话分 6 轮空闲轮询，以及一次项目登记后的 8 会话变更轮询。

| 样本 | 原完整快照 | 浏览器首屏快照 | 48 次空闲轮询正文 | 变更后 8 次轮询正文 | 单记录变更提交 p95 |
|---|---:|---:|---:|---:|---:|
| 1,000 任务 / 6,001 行 | 5,135,482 B | 12,587 B | 0 B | 103,152 B | 12.82 ms |
| 5,000 任务 / 30,001 行 | 25,747,482 B | 12,587 B | 0 B | 103,152 B | 63.46 ms |

两组样本中，单页 40 条的任务列表为 12,340 B，打开一条样本任务的详情为 4,982 B。正文统计不含 HTTP 头；`304` 只有头部。`/api/workflow` 仍保留完整快照兼容性，主人首页使用 `/api/workbench`：显示最近 40 项和仍在执行的任务。任务和线程历史另行分页，运行输出、事件和上下文只在打开详情时加载。摘要 SSE 保留事件 ID 和交接信息，明细 SSE 接口不变。

这些测量不代表生产容量：SQLite 仍逐次比较内存中的完整快照，分页在进程内存中筛选和排序；如果同一线程的消息非常多，打开该线程仍会加载该线程的完整历史。部署前使用接近真实的负载复测延迟、主机内存及同一时间运行的任务数。

成员端使用 `/api/member/history`，按项目和记录类型分页，每页 40 条。授权和分页范围先于条件请求判断；其他项目的写入不会改变当前可见页的验证器。旧 `/api/member/workspace` 接口保留给现有探针。用相同的两个任务量复测成员线程首屏，正文大小如下：

| 样本 | 旧成员全量摘要 | 成员线程首屏 | 48 次空闲轮询正文 | 8 次无关项目写入后轮询正文 |
|---|---:|---:|---:|---:|
| 1,000 任务 | 152,788 B | 4,005 B | 0 B | 0 B |
| 5,000 任务 | 689,088 B | 4,005 B | 0 B | 0 B |

无关变更测试登记了成员无权查看的新项目，再用 8 个成员会话请求同一页。`304` 省的是传输正文，服务器仍需筛选、排序并为当前页计算验证器；以上仅是本机样本，不代表生产容量或第二台设备验收。
