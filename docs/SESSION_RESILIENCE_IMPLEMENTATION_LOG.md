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

## 2026-09-20 — Recovery hardening Rev 6 · PR 1 working tree

### 当前边界

- 每条 WebSocket 连接由应用层 heartbeat 探测：默认 20 秒发出 ping，10 秒内没有 pong 就终止连接，最坏约 30 秒释放 lease，不依赖 Linux 两小时级 TCP keepalive。
- 未认证连接使用有界集合；新的合法连接不会因为四条未完成认证的 socket 被静态拒绝。
- 普通 socket close 或 heartbeat detach 只撤销连接级 capture、location request、Calendar／Email approval，并移除 event sink；已经提交给模型的回答允许继续完成并写入 SQLite。明确结束、session expiry 和 service shutdown 仍执行完整 interrupt。
- capture stop hook 绑定 `connection_id`；被抢占的旧连接迟到 close 时不能清掉新连接刚安装的 hook。
- simulator 的 SQLite 读控件与写控件拆成两个显式、默认关闭的开关；写开关必须依赖读开关，且任一开关都不能在 public host 配置下启动。生产 Even client bundle 不含 test command literal。
- backup verifier 同时检查 conversation/jobs owner 已释放；Calendar 启用时强制要求 ledger 与两份 OAuth JSON，并使用当前代码重新打开恢复副本。
- 自动更新在切换 release 前创建 root-only 数据快照；新 release health gate 失败时同时恢复代码和数据。archive 拒绝链接／目录穿越，只保留最近两份，不代替每日备份或 Lightsail snapshot。

### 自动化结果

1. Root full regression：`350 passed / 0 failed / 2 Windows platform skips`，共 352 tests。两个 skip 仍是当前 Windows 权限不允许创建测试用 file symlink；Linux gate 必须重跑。
2. Even client：`50 passed / 0 failed`；client TypeScript 与 production Vite build 通过。
3. Client release verifier 检查 2 个构建文件，未发现 debug fixture、test command、source map、private key 或明显 credential。
4. Server-only build 通过；不包含 browser lab、SDK、simulator、tests、credentials 或 local data。
5. 三个修改过的 shell script 通过 Git Bash `bash -n`；public audit 扫描 277 个 working-tree source/document files，未发现禁止路径或 credential pattern。

### Gate

Recovery hardening PR 1 自动化与构建：**PASS**。尚未部署 Linux、没有调用真实 provider、没有构建新的 `.ehpk`；scoped device credential、host storage、ACK rotation、同 client 抢占和 durable drafts 仍属于后续独立 PR。

PR #34 已于 2026-09-20 squash merge 到 `main`，commit `0ef947a`。

## 2026-09-20 — Recovery hardening Rev 6 · PR 2 working tree

### 实现

- Even client 不再把新 credential 写入 WebView/browser `localStorage`；稳定 `client_id` 与短期、session-scoped resume credential 改用 SDK 0.0.14 的 `bridge.getLocalStorage`／`setLocalStorage` 原生 host storage。
- 主 `G2_CLIENT_TOKEN` 仍只存在当前页面内存，host adapter 的类型和序列化 schema 均不接受 master token、provider key 或其他 credential。
- 启动时异步读取 host storage，再创建 `ConnectionController`；每次 plugin 启动均可从原生侧读取已保存的受限恢复状态。
- browser v2 数据只作为一次性迁移源：host client ID 与 resume credential 都确认写入成功后才删除旧记录；任一原生写入返回 `false` 或抛错时保留旧数据，供下次冷启动重试。
- host 中无效、过期、字段越界或带额外字段的 resume record fail closed；由于 SDK 没有 remove API，使用已检查成功结果的空字符串写入进行清除。
- 所有原生写入严格串行，避免连续 credential rotation 的旧异步写入晚到并覆盖新值。原生读取在启动期失败时，下一次 credential save 会先补写稳定 client ID，再写 resume record。
- 原生存储失败不会泄漏 secret；当前进程仍可使用内存中的短期凭证，并向用户显示“重开后可能需要重新连接”的有限提示。persisted ACK 与双代 credential window 仍严格留在 PR 4。

### 自动化结果

1. Even client：`56 passed / 0 failed`；新增成功迁移、host 优先、迁移失败保留、无效 record、`setLocalStorage=false`、启动读取失败恢复，以及重叠轮换按序落盘测试。
2. Client TypeScript：通过。
3. Even client production build：通过；release verifier 检查 2 个预期文件，未发现 debug fixture、test command、source map、private key 或明显 credential。
4. Root full regression、Root TypeScript、server-only build 与 public audit：通过；未调用真实 OpenAI、Soniox、Google、SMTP 或 Calendar provider。

### Gate

Recovery hardening PR 2 本地自动化与安全 gate：**PASS**。尚未部署 Linux、没有构建新的 `.ehpk`，也没有提前实现 forced-kill harness、device credential、persisted ACK、foreground lifecycle 或 durable drafts；这些继续由后续独立 PR 负责。

## 2026-09-20 — Recovery hardening Rev 6 · PR 3 working tree

### 实现

- Even companion simulator 新增“模拟 WebView 被系统终止（冷启动）”控制。执行前必须处于已连接状态、存在有效的短期 resume credential，并等待所有 Even host storage 写入完成；原生存储不健康时 fail closed。
- 冷启动控制只在 `import.meta.env.DEV` 动态模块且 loopback WebSocket 目标下安装。它只为本次 reload 跳过正常 pagehide 清理，故意丢弃页面内 JS 状态并保留原生恢复凭证；主 token 仍未持久化。
- 本地 browser lab 提供相同的可见冷启动控制，用于快速检查页面内状态丢失后的 resume 行为。该页面 reload 不能伪造 iOS jetsam 或真实射频 half-open，因此没有把 browser reload 当成 half-open 证明。
- raw WebSocket integration test 使用 `autoPong: false` 的已认证 peer 确定性重放 half-open：心跳清理前第二条连接必须收到 `BUSY`；心跳 deadline 终止旧 peer 后，同一 client/session 的原 credential 仍可成功恢复。这同时证明失败的 BUSY 尝试没有烧掉 credential。
- production client release verifier 新增 forced-cold-start 控件文本与 ID 检查，确保开发 harness 不进入 Even Hub 发布包。公网 Linux server 的 test-control 拒绝边界保持不变。

### 自动化结果

1. Half-open／protocol／browser targeted tests：`13 passed / 0 failed`。
2. Even client full regression：`58 passed / 0 failed`；新增 loopback 控件、异步 action 与公网不安装测试。
3. Root full regression：`350 passed / 0 failed / 2 Windows platform skips`，共 352 tests；两个 skip 仍是 Windows 无权创建测试 symlink，Linux gate 需重跑。
4. Root 与 Even client TypeScript：通过。
5. Server-only build：通过；发布目录不包含 browser lab、SDK、simulator、tests、credentials 或 local data。
6. Even client production build：通过；release verifier 检查 2 个文件，未发现 forced-cold-start/debug fixture、source map、private key 或明显 credential。
7. Public audit：277 个 source/document files 未发现禁止路径或 credential pattern。

### Gate

Recovery hardening PR 3 本地自动化、生产构建与安全 gate：**PASS**。真实 iOS jetsam 白屏、host 是否会自动重载 plugin，以及真机锁屏/内存压力仍只能留到 Physical Acceptance；本 PR 没有部署 Linux、没有构建 `.ehpk`，也没有提前实现 device credential、persisted ACK、同 client lease takeover、foreground lifecycle 或 durable drafts。

## 2026-09-20 — Recovery hardening Rev 6 · PR 4 working tree

### 实现

- conversation SQLite schema 升至 v4，新增独立 `device_credentials` 表。设备 secret 始终只以 SHA-256 hash 保存；记录绑定一个随机 `client_id`，包含到期、前代、persist deadline、ACK／撤销状态，不包含 master token、provider key 或 session 内容。
- protocol v2 增加第三种互斥 hello：`device_credential`。它只能创建新的单用户会话，不能恢复任意 session，也不扩大 Calendar、Email、文件或 provider 权限。未声明 `even_host_v1` 原生存储能力的旧／browser client 不会收到设备凭证。
- master bootstrap、已认证 session resume 或 device auth 都会返回 pending 新代；resume 重新签发覆盖“session secret 已落盘但首次 device secret 尚未落盘就被杀”的窄窗口。客户端必须等待 `bridge.setLocalStorage(...) === true` 才发送 `credential.persisted`；false、异常、字段越界或错误 ACK 一律 fail closed。
- ACK 或 pending secret 首次成功使用会使新代成为权威并撤销前代。未收到 ACK 时新旧两代只在固定 5 分钟窗口内并存；重放旧代不能延长窗口，截止时最新 pending 代胜出。设备凭证使用时轮换，默认 30 天未使用到期，并支持按 client 整体撤销。
- 冷启动顺序为：有效 session resume credential → scoped device credential → 当前页面内存中的 master token。超过 15 分钟恢复窗口时，客户端清除失效 session credential，并用设备凭证建立新 session，不把 master token 写入 SDK/browser storage。
- `SessionRegistry.create()` 的授权回调放在 lease／ID 检查之后、runtime 创建之前；因此失败的 device auth 或已有 active lease 不会创建空 session 或提前消耗 credential。lease takeover、foreground lifecycle 和 audio `requires_reopen` 仍留给 PR 5。

### 自动化结果

1. Device store／protocol／registry targeted tests：`26 passed / 0 failed`。
2. Device WebSocket integration：覆盖 master bootstrap、persisted ACK、无 master token 新建 session、轮换和旧代 replay 拒绝；完整 reconnect suite `13 passed / 0 failed`。
3. Root full regression：`358 passed / 0 failed / 2 Windows platform skips`，共 360 tests。
4. Even client full regression：`63 passed / 0 failed`；覆盖 host write 为 `false` 时绝不 ACK。
5. Root 与 Even client TypeScript：通过。
6. Server-only build：通过；发布目录不含 browser lab、SDK、simulator、tests、credentials 或 local data。
7. Even client production build：通过；release verifier 检查 2 个文件，未发现 debug fixture、source map、private key 或明显 credential。
8. Public audit：277 个 source/document files 未发现禁止路径或 credential pattern；`git diff --check` 通过。

### Gate

Recovery hardening PR 4 的本地自动化、生产构建、公开仓库扫描与最终 diff review：**PASS**。尚未部署 Linux、没有调用真实 provider、没有构建 `.ehpk`，也没有提前实现同 client lease takeover、`FOREGROUND_ENTER_EVENT`、audio `requires_reopen` 或 durable drafts。

PR #38 已于 2026-09-20 squash merge 到 `main`，commit `07231e5`。

## 2026-09-20 — Recovery hardening Rev 6 · PR 5 working tree

### 实现

- 服务端保持独立的认证前连接容量。未认证连接 churn 只能淘汰其他未认证连接，不能挤掉已经认证的 owner；认证后的单一 input lease 仍由 `SessionRegistry` 约束。
- 持有效、未轮换 resume credential 的同一 `client_id` 可以立即抢占自己的旧 live／half-open lease，无需等待 TCP keepalive 或 heartbeat。凭证先验证、再换 lease；伪造 secret、不同 client 或不同 session 都不能驱逐 owner。
- 抢占后旧连接会被终止；旧连接迟到的 message／close 都不能继续输入、detach 新 lease，或清除新连接安装的 capture cancellation hook。
- 正常断线和 heartbeat detach 只撤销连接相关的 capture、location 与临时 approval，并移除 event sink；已经开始的模型回答不被 abort，可在无 viewer 时完成并提交 SQLite。只有显式 end、最终 expire 或 service shutdown 才完整 interrupt。
- Even client 处理原生 `FOREGROUND_ENTER_EVENT`：恢复可见性与既有麦克风意图，并在 transport 已断开时立即触发 reconnect。`pagehide` 改为非破坏性，不再 dispose 可恢复的 connection controller。
- `audioControl(true)` 明确返回 `false` 时进入 terminal `requires_reopen`，不做无效重试，也不保留 `desired=true`；抛出的暂时性 bridge error 仍走最多三次的 bounded retry，并显示不同的用户提示。

### 自动化结果

1. Registry／reconnect／half-open targeted tests：`26 passed / 0 failed`。
2. Protocol／audio targeted tests：`14 passed / 0 failed`。
3. Even lifecycle／connection／audio targeted tests：`28 passed / 0 failed`。
4. Root full regression：366 个 tests 以 exit code 0 完成（当前 Windows 矩阵为 `364 passed / 0 failed / 2 platform skips`）。
5. Even client full regression：`66 passed / 0 failed`。
6. Root 与 Even client TypeScript：通过。
7. Server-only build：通过；发布目录不含 browser lab、SDK、simulator、tests、credentials 或 local data。
8. Even client production build：通过；release verifier 检查 2 个文件，未发现 debug fixture、source map、private key 或明显 credential。
9. Public audit：277 个 working-tree source/document files 未发现禁止路径或 credential pattern；`git diff --check` 通过。

### Gate

Lifecycle and Connection Liveness 的本地自动化、生产构建、公开仓库扫描与最终 diff review：**PASS**。尚未部署 Linux、没有调用真实 provider、没有构建 `.ehpk`，也没有提前实现 durable drafts。

PR #39 已于 2026-09-20 squash merge 到 `main`，commit `20d0d4a`。

## 2026-09-20 — Recovery hardening Rev 6 · PR 6 working tree

### 实现

- conversation SQLite schema 升至 v5，新增按 `session_id + kind` 唯一的 `recovery_drafts`。单项 JSON 上限 256 KiB、外键随 session 删除；只有 active／idle session 可写，明确结束或 15 分钟最终过期会删除草稿，普通 detach 与服务重启保留。
- Email durable state 只保存完成 artifact 的 JobStore ID。冷启动从 JobStore 重建 MD／presentation／可选 ICS；不保存 approval token、收件人、SMTP credential 或“已经同意”。首个发送请求只重新预览，下一轮才可确认；`sending`／`unknown`／`accepted` 读取 ledger 并禁止盲目重发。
- Calendar durable state 保存当前 draft、批次进度及 operation ID，不复制 operation ledger 的授权字段。query candidates、ordinal binding、read choice、route/location 和用户口头确认保持 ephemeral。冷启动先只读 reconcile：已成功则推进／完成，未知则阻塞，其他旧状态必须重新读取并生成预览。
- `ready.recovery` 只返回有限状态摘要；恢复后的 Even client 主动请求 `jobs.list` 与 `calendar.list`，以服务端 SQLite／provider ledger 为权威。列表事件不会进入眼镜对话正文。
- 正常 disconnect、pause、lease replacement 继续只撤销临时 authorization；`shutdown` 保留 durable draft，只有明确 end／expire 清除。所有恢复路径都要求新的不可变预览与独立确认。

### 自动化结果

1. Root full regression：371 个 tests 以 exit code 0 完成（`369 passed / 0 failed / 2 Windows platform skips`）。两个 skip 仍是 Windows 无权创建测试 symlink，Linux gate 需重跑。
2. 新增 cold-start Calendar re-preview、Calendar uncertain reconciliation、Email JobStore hydration 与完整 server restart/resume 测试均通过。
3. Even client full regression：`66 passed / 0 failed`。
4. Root 与 Even client TypeScript：通过。
5. Server-only build：通过；发布目录不含 browser lab、SDK、simulator、tests、credentials 或 local data。
6. Even client production build：通过；release verifier 检查 2 个文件，未发现 debug fixture、source map、private key 或明显 credential。
7. Public audit：278 个 staged source/document files 未发现禁止路径或 credential pattern；`git diff --check` 通过。

### Gate

Durable Draft and Side-effect Recovery 的本地自动化、production builds、公开仓库扫描与最终 diff review：**PASS**。尚未部署 Linux、没有调用真实 provider、没有构建 `.ehpk`；Physical Acceptance 仍须等待独立 PR 和真机 gate。

PR #40 已于 2026-09-20 squash merge 到 `main`，commit `b6ee88b`。

## 2026-09-20 — Recovery hardening Rev 6 · Physical Acceptance readiness working tree

### 实现

- 新增 `docs/validation/v1.3-real-g2.md`，把安装／cold bootstrap、十次重复 cold start、15 分钟恢复边界、前后台／锁屏／memory pressure、换网／half-open、audio wedge、Calendar／Email 防重复、显示／定位共存和 30m／1h／2h soak 拆成独立、可判定的真机用例。
- 所有真机项默认 `NOT RUN`；永久白屏、意外要求 master token、重复副作用、暂停后迟到 transcript 或未授权 input takeover 均为 STOP/FAIL。未观察到 vendor audio wedge 只能写 `NOT OBSERVED`，不能伪装成 PASS。
- 新增离线 `npm run acceptance:preflight`，按固定顺序运行 root tests/typecheck、Even client tests/build、server-only build、public worktree audit 与 `git diff --check`。脚本明确不调用真实 provider、不部署、不打包、不上传。
- production client verifier 与独立测试固定 `Glass Assistant` identity、manifest/package/SDK 版本一致性、仅 `network`／`g2-microphone`／`location` 三项权限，以及精确 HTTPS/WSS whitelist；新增权限、wildcard 或 endpoint 漂移会 fail closed。

### 自动化结果

1. Root full regression：371 个 tests（`369 passed / 0 failed / 2 Windows platform skips`）。
2. Root TypeScript：通过。
3. Even client：`67 passed / 0 failed`；新增 release manifest regression 通过。
4. Even production build：2 个预期文件；release verifier 未发现 debug fixture、source map、private key 或明显 credential，identity／permissions／whitelist gate 通过。
5. Server-only build：通过；不包含 browser lab、SDK、simulator、tests、credentials 或 local data。
6. Public audit：281 个 working-tree source/document files，未发现禁止路径或 credential pattern；`git diff --check` 通过。

### Gate

Physical Acceptance 的**自动化准备阶段 PASS**，真实设备阶段仍为 **NOT RUN**。没有部署 Linux、没有调用 OpenAI／Soniox／Google／SMTP、没有生成或上传 `.ehpk`，也没有把 simulator／browser 证据写成真机通过。下一步必须使用真实 iPhone、G2、R1 和 Private Testing build 执行验收表；如果 Even host 在 WebContent process termination 后保持永久白屏，该项必须失败并阻止 release。
