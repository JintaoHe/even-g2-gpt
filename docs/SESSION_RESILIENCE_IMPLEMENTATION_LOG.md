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
