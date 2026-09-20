# 会话持久化与断线恢复实施记录

本文件只记录可复现的实施与测试结果。产品范围和未实施项目见 [实施清单](./SESSION_RESILIENCE_IMPLEMENTATION_PLAN.md)。

## 2026-09-19 — Phase 0.1 基线

### 版本

- Git commit：`cd5e38038251`
- 实施分支：`codex/conversation-store`
- 项目要求：Node.js `>=24`
- 实际测试 runtime：Node.js `v24.19.0`
- 当前 PowerShell 默认 Node：`v19.6.1`，不满足项目要求，因此未用于项目测试
- Even client：`0.2.0`
- `@evenrealities/even_hub_sdk`：`0.0.14`
- 当前线上协议：未显式版本化；本阶段将定义 protocol v2

### 实施前工作树

基线开始时工作树已经包含未提交的成本控制、provider metering、文档和相关 server adapter 修改。这些修改不是本阶段创建，不得被覆盖、回退或意外纳入会话存储提交。实施前状态已经通过 `git status --short` 记录在当前任务的工具日志中。

### 自动化结果

1. Root tests：`249 passed / 0 failed`，约 25.1 秒。
2. Root TypeScript：通过。
3. Even client tests：`26 passed / 0 failed`，约 0.77 秒。
4. Even client production build：通过；Vite 生成 2 个 release files，build verifier 未发现 debug fixture、source map、private key 或明显 credential。
5. Server-only build：通过；输出位于本地忽略目录 `dist/server-PdQKu8`。
6. Public audit：通过；扫描 227 个 staged source/document files，未发现禁止路径或 credential pattern。

客户端 Vite 首次在受限文件系统中运行时，esbuild 无法读取工作区父目录；使用相同 Node 24 runtime 在获准的构建环境中重跑后通过。该问题属于执行沙箱权限，不是产品代码失败。

### Gate

Phase 0.1：**PASS**。没有已知 flaky test，可以进入 Phase 0.2。

## 2026-09-19 — Phase 0.2 协议与状态定义

### 实现

- 新增 protocol v2 核心 client/server discriminated unions。
- 新增 connection、audio、conversation 三套正交状态及 fail-closed transition table。
- 为核心 client messages 定义 persistence、idempotency 和 replay policy。
- `text.submit` 要求稳定 UUID；所有核心控制指令要求 `command_id`。
- `test.session.expire` 默认拒绝，只有显式 test gate 才能解析。
- resume hello 要求 client/session/credential 绑定和非负 `last_seen_sequence`。

### 自动化结果

1. Protocol target tests：`7 passed / 0 failed`。
2. Root TypeScript：通过。
3. Root full regression：`256 passed / 0 failed`，约 26.3 秒。

### Gate

Phase 0.2：**PASS**。协议尚未接入当前 WebSocket runtime，因此没有改变现有用户行为。可以进入 Phase 1.1。

## 2026-09-19 — Phase 1.1 ConversationStore foundation

### 实现

- 独立创建 `assistant-memory.sqlite`，不与 jobs、Calendar 数据库混表。
- 启用 WAL、FULL synchronous、foreign keys 和 5 秒 busy timeout。
- 建立 schema v1、migration ledger、single-process owner lease 和显式 transaction helper。
- 建立 sessions、clients、resume credentials、topics、turns、messages、session summaries 表及索引。
- 数据目录／数据库拒绝符号链接；目录和数据库分别收紧到 `0700`／`0600`。
- 提供幂等 close；关闭后释放 owner lease 并拒绝继续操作。

### 自动化结果

1. Store target tests：4 passed，0 failed。
2. Windows 无权限创建 file symlink，数据库文件 symlink case 按平台 skip；目录 junction symlink 的实际拒绝测试通过。该 case 必须在 Linux gate 重跑。
3. Root TypeScript：通过。
4. Root full regression：260 passed，0 failed，1 platform skip，约 26.1 秒。

### Gate

Phase 1.1：**PASS**。Store 尚未接入现有 server 或 JSON saver，可以进入 Phase 1.2。

## 2026-09-19 — Phase 1.2 原子 user turn 与 idempotency

### 实现

- 新增 user message、turn 和 session sequence 的单 transaction commit。
- 相同 message ID／相同 normalized content 返回第一次 ACK，不创建新 turn。
- 相同 message ID／不同内容 fail closed，返回 typed conflict。
- transaction 后段发生 turn constraint failure 时，session sequence 和 message insert 一起 rollback。
- message 查询有分页上限，避免未来把三年历史一次性加载进内存。

### 自动化结果

1. Idempotency target tests：5 passed，0 failed。
2. Store combined target tests：9 passed，0 failed，1 Windows platform skip。
3. 20 个并发到达的同 ID 提交均返回第一次 ACK。
4. Rollback 后下一条 sequence 连续，无空洞。
5. Root TypeScript：通过。
6. Root full regression：265 passed，0 failed，1 platform skip，约 26.5 秒。

### Gate

Phase 1.2 storage portion：**PASS**。三个 integration checkbox 保留未完成，必须在 Phase 2 接入 server/client 时关闭，不能仅凭 store 测试标记完成。

## 2026-09-19 — Phase 1.3 回答提交顺序与 crash recovery foundation

### 实现

- SQLite store 在回答开始时分配稳定 sequence 并创建 `streaming` assistant message。
- checkpoint 只更新仍处于 `streaming` 的 message，并限制单条 partial 大小。
- final content、citations、message status 和 turn status 在同一个 transaction 中提交；重复 final commit 幂等，不同内容 fail closed。
- 显式中断保留 partial，但把 message／turn 明确标记为 `interrupted`，不冒充完整回答。
- store 重启时把遗留的 streaming message、accepted／planning／answering turn 标记为 interrupted，并把 active session 转为 idle。
- 当前 JSON runtime 也已收紧顺序：save 成功之后才发 `answer.done`；save 失败时不发完成事件并进入 paused。
- commit 等待期间发生 interrupt 时不再重复写入一条“被打断”的 assistant history。

### 自动化结果

1. Commit-order 与 crash-recovery target tests：`9 passed / 0 failed`。
2. 覆盖 user commit 前、user commit 后、stream checkpoint 后、final transaction 失败，以及 final commit 后客户端尚未收到五个故障边界。
3. Idempotency target test 连续运行 20 次：全部通过。
4. Root TypeScript：通过。
5. Shared working-tree full regression（包含实施前已存在、未纳入本 PR 的 cost-control tests）：`276 passed / 0 failed / 1 Windows platform skip`，共 277 tests，约 26.7 秒。
6. Windows skip 仍是无权限创建数据库文件 symlink；Linux gate 必须补跑该 case。
7. Server-only build：通过；working-tree public audit 扫描 241 个 source/document files，未发现禁止路径或 credential pattern。
8. 将本 PR 的提交内容复制到不含共享工作树修改的 clean review clone 后重跑：`271 passed / 0 failed / 1 Windows platform skip`，共 272 tests；TypeScript、server-only build、236-file working-tree audit 和 443-file Git history audit 全部通过。

### Gate

Phase 1.3 storage foundation：**PASS**。SQLite 原语和现有 runtime 的 save-before-done 契约已验证；WebSocket runtime 尚未切换到 SQLite，也尚未发送 protocol v2 的 `answer.committed`。这些 integration 条目保持未完成，进入 Phase 2 后逐项关闭。

## 2026-09-19 — Phase 2／3 resumable session protocol 与写操作恢复边界

### 实现

- 新增与 WebSocket 解耦的 `SessionRegistry`；连接关闭只 detach，logical session 在 15 分钟窗口内保留，明确退出／过期才结束。
- `Conversation` 正式接入 SQLite：user ACK、streaming placeholder、节流 checkpoint、final transaction 和 `answer.committed` 均遵守 durable-before-visible 顺序。
- protocol v2 支持 client/session ID、`last_seen_sequence`、增量 snapshot、单 active input lease、服务重启 lazy hydrate 和显式 `answer.retry`。
- resume credential 使用 32-byte 随机 secret，SQLite 只保存 SHA-256 hash；绑定 client/session，短期到期，恢复时轮换并撤销全部 sibling credentials。
- 长连接在 credential 到期前收到 `resume.credential` replacement，避免连接超过 16 分钟后失去断线恢复能力。
- loopback 开发服务器支持“立即模拟会话过期”的 wire control；配置公网 host 时构造直接失败，不能误部署该控制。
- Calendar／Email 在断线、暂停和连接替换时撤销执行授权但保留可恢复草稿；provider 请求已发出后不自动重放。
- Calendar 批量取消恢复后重新读取权威事件、重新生成逐项预览，并保留“第 n/总数项”进度。
- 明确的自然语言“刚才没看到／请再说一次”会查询 SQLite：committed 回答零模型调用原样补发，interrupted 回答创建带 `retry_of_turn_id` 的新 turn。
- stale Email confirmation 会查询 durable mail state：未发送则生成新预览，accepted／unknown 则报告权威状态；Calendar unknown operation 只读核对 Google，证据吻合才晋升 succeeded。

### 自动化结果

1. Session/durable/reconnect/write-recovery target tests：`27 passed / 0 failed`；随后 TypeScript 通过。
2. Calendar／Email adjacent regression（含新增 batch/reconcile cases）：`70 passed / 0 failed`。
3. 额外 fault cases 覆盖：断线前待确认、provider 请求进行中断线、成功回执丢失、旧确认重放、long-lived credential refresh、credential sibling replay。
4. `SessionRegistry` 进行 50 轮双客户端并发恢复争用；每轮恰好一个成功、另一个 fail closed。
5. Shared working-tree full regression（包含未纳入本 PR 的 5 个 cost-control tests）：`309 passed / 0 failed / 1 Windows platform skip`，共 310 tests。
6. Windows skip 仍是无权限创建数据库文件 symlink；目录 junction 拒绝测试通过，Linux gate 仍需重跑 file symlink case。
7. Root TypeScript：通过。
8. Production dependency audit：`0 vulnerabilities`；shared working-tree public audit 扫描 249 个 source/document files，未发现禁止路径或本地 credential value。
9. 将未提交的 cost-control／文档改动临时隔离后，对 PR commit 精确重跑：`304 passed / 0 failed / 1 Windows platform skip`，共 305 tests；TypeScript、server-only build 和 244-file public audit 全部通过。随后已原样恢复隔离的本地改动。

### Gate

Phase 2 server foundation 与 Phase 3 write-safety foundation：**PASS**。客户端 credential 持久化、自动重连、恢复 UI 和 simulator“立即过期”按钮仍属于 Phase 4，不在本阶段冒充完成。宽泛的跨 topic recap 仍留给 Phase 5 ContextBuilder；普通重连不会自动调用模型或重放副作用。

## 2026-09-19 — Phase 4 client lifecycle 与 simulator 恢复

### 实现

- Even client 新增独立 `ConnectionController`：protocol v2 hello、稳定 client/message/command ID、短期 resume credential、增量 snapshot、单重连 timer、带 jitter 的 0.5/1/2/5/10/30 秒退避，以及网络恢复后的立即重连。
- 主 `G2_CLIENT_TOKEN` 仍只保留在当前页面内存；local storage 只保存稳定 client ID 和 server 签发的短期、session-scoped resume credential。无效、过期或字段越界的记录会 fail closed 并清除。
- 页面隐藏和 unload 不再向 logical conversation 发送 `pause`／结束；明确退出仍通过系统确认，并撤销本地恢复凭证。恢复凭证已过期且内存中没有主 token 时，UI 明确要求重新输入 token。
- 新增独立 `AudioController`，把用户 desired intent 与 SDK actual state 分开；所有 bridge 操作串行，最多重试三次，旧 promise 和取消通过 epoch 失效。
- 接入 `onDeviceStatusChanged`；眼镜或页面暂时不可用时关闭实际 audio，但保留 desired intent，设备／页面恢复后才按原意图重新开启。
- Even companion UI 与 browser lab 均显示 connection/session ID、new/resumed 状态和 server 返回的实际恢复窗口。
- browser reference client 同步 protocol v2、snapshot 去重、自动重连和稳定提交 ID；loopback 开发页面增加 socket drop、立即重连、重复 submit 和立即过期控制。
- “立即过期”消息只有 DEV/loopback UI 会发出，并且 server 还要求显式 test gate 与 loopback peer；production client build 不包含相关开发模块，公网 server 配置拒绝启用该 gate。
- 保持范围边界：本阶段没有声称解决 iOS 锁屏、Even 宿主 WebView 被回收、后台全天收音或真机蓝牙仲裁。

### 自动化结果

1. Browser reference client tests：`2 passed / 0 failed`。
2. Even client tests：`46 passed / 0 failed`，包括 100 次 audio toggle/disconnect 循环、device disconnect/reconnect、visibility hide/show、旧 socket、重复 timer、凭证过期和明确退出。
3. Protocol/reconnect/browser target tests：`16 passed / 0 failed`。
4. Root TypeScript：通过。
5. Root full regression：`311 passed / 0 failed / 1 Windows platform skip`，共 312 tests，约 29 秒。
6. Windows skip 仍是无权限创建数据库文件 symlink；目录 junction 拒绝测试通过，Linux gate 仍需重跑 file symlink case。
7. Even client production build：通过；Vite 生成 2 个 release files，build verifier 未发现 debug fixture、source map、private key 或明显 credential。
8. Server-only build：通过；public audit 扫描 244 个 source/document files，未发现禁止路径或 credential pattern。
9. 提交后将未提交的成本控制／文档改动临时隔离，对 PR commit 精确重跑：`306 passed / 0 failed / 1 Windows platform skip`，共 307 个 root tests；Even client `46 passed / 0 failed`；TypeScript、server-only build、255-file public audit 和 client production build 全部通过。随后已原样恢复隔离的本地改动。

### Gate

Phase 4：**PASS（自动化与构建）**。进入 Phase 5 前仍需通过 PR review；本阶段的 browser/Even simulator 人工断线体验将在后续本地验收 gate 统一执行，不提前部署 Linux 或构建 `.ehpk`。

## 2026-09-19 — Phase 5 bounded long context（PR #32）

### 实现

- SQLite 成为 conversation 唯一权威历史；`ContextBuilder` 只读取有界 summary、当前 topic、相关旧 topic 片段和近期 turns。
- durable summary job 使用固定 sequence boundary，schema invalid 最多自修复一次；失败不阻塞对话，也不获得 Web／Calendar／Email 工具。
- 超过 100 条消息的 session 不再硬停止；500-message 中英文历史仍保持有界输入和 topic 恢复。
- MD 导出冻结用户选择的 topic/document，不再把 100-message 限制错误复用为导出上限。

### Gate

PR #32 已 squash merge 到 `main`，commit `356f81c`。Phase 5 自动化、构建及 public audit 已通过；人工 simulator 验收统一留到 PR5 gate。

## 2026-09-20 — Phase 6 与 Phase 7 自动化 gate（PR5 working tree）

### 实现

- schema v3 增加 legacy import ledger；迁移只接受 UUID 普通 JSON 文件、严格 schema 与有界大小，默认 dry-run，`--apply` 才写入／隔离异常文件。成功原文件保留，来源 SHA-256 保证幂等。
- 读取使用 no-follow file handle、inode/device 复核和 bounded buffer；单文件错误不阻止其他合法文件，graph/reference 在 transaction 前完整验证。
- backup verifier 要求 `jobs.sqlite` 与 `assistant-memory.sqlite`，运行 integrity/foreign-key/reference/sequence 检查，并在隔离目录重新打开 conversation store。输出只含计数，不含正文。
- 默认 `SESSION_RETENTION_DAYS=1095`；`0` 明确关闭自动 conversation 清理。只有超过 Unix-time cutoff 的 ended/expired session 可删，active/idle 和 queued/running/unknown summary job 保留。
- retention 使用 transaction + foreign-key cascade；服务启动和每 24 小时运行一次。数据库/WAL/SHM 字节数、session/message 数和剩余磁盘只进入 metadata health/log，不读取或打印正文。
- `/internal/health/storage` 仅回环可访问，Caddy 不代理；公网 `/healthz` 保持最小响应。
- server-only release 包含两个离线入口：`sessions:migrate` 与 `sessions:maintain`；二者默认 dry-run，正式执行要求显式 `--apply` 与 SQLite 独占。
- 新增面向初学者的迁移、留存、备份边界文档；没有部署 Linux，也没有构建 `.ehpk`。

### 自动化结果

1. Root full regression：`338 passed / 0 failed / 2 Windows platform skips`，共 340 tests。两个 skip 均为当前 Windows 权限不允许创建测试用 file symlink；Linux gate 必须重跑。
2. Root TypeScript：通过。
3. Even client：`47 passed / 0 failed`；包含连续 10 次 page-style controller 重建与轮换 credential 恢复同一 session。
4. Even client production build：通过；release verifier 只发现 2 个预期文件，无 debug fixture、source map、private key 或明显 credential。
5. Server-only build：通过；发布包包含 compiled migration/maintenance CLI，不包含 browser lab、simulator、测试、凭证或本地数据。
6. Public audit：274 个 working-tree source/document files 与 556 个 Git-history files 均未发现禁止路径或 credential pattern。
7. Fault injection 覆盖 user commit 前后、stream/final commit 边界、服务重启、重复 ID、120/500-message context、双客户端争用、Calendar/Email 断线和 provider ACK 丢失；无重复副作用。
8. 自动回归未调用 OpenAI、Soniox、Google、SMTP 或真实 Calendar。

### Gate

Phase 6 与 Phase 7.1/7.2：**PASS**。Phase 7.3 用户本地 simulator 验收仍待完成；在用户确认前不得创建部署 PR、部署 Linux 或构建新 `.ehpk`。

### Simulator 会话／SQLite 实验台补充

- companion simulator 与本地 browser lab 新增一键 `session resume`、SQLite metadata、写入固定三年前测试记录、清理预览和清理测试记录按钮。
- 所有 wire command 默认拒绝，只有 server 显式启用 local controls 且 WebSocket 对端是 loopback 时才接受；配置 public host 会在 server 构造阶段失败。production client build 不包含动态开发面板。
- 状态报告只包含 schema/WAL/foreign-key、session/message 数、数据库与可用磁盘字节、警告、当前会话状态和 retention 计数，不包含正文、数据库路径、session ID 或 credential。
- simulator 清理固定使用 `local-retention-test` owner scope；测试证明真实三年前历史不会被该按钮删除。
- 补充后 root regression 为 `340 passed / 0 failed / 2 Windows platform skips`，Even client 为 `50 passed / 0 failed`；root/client typecheck、server/client build 与 public audit 通过。
