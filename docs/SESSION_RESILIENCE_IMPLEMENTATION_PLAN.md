# 会话持久化与断线恢复实施清单

> 状态：Approved — 可以按 gate 顺序实施
> 日期：2026-09-19
> 当前主平台：Even Realities / Even Hub
> 实施原则：一次只完成一个可验证的小项；目标测试、完整回归和安全检查全部通过后，才进入下一项。

## 1. 本阶段目标

把当前“一个 WebSocket 连接就是一段对话”的实现，改造成“连接只是可恢复会话的临时载体”。完成后应满足：

- 每个 session、turn、message、topic 都有稳定 ID；
- 对话以 SQLite 为权威数据源，不再依赖进程内 history 或仅写不读的 JSON；
- 短暂网络断开、页面刷新和 Linux 服务重启后，可以恢复最近会话；
- 重复提交、重复 ACK 和重连补发不会产生重复消息或重复工具副作用；
- 麦克风、网络连接和逻辑会话拥有彼此独立的生命周期；
- 100 条以上的会话可以继续使用，但模型只接收受控的上下文窗口；
- Calendar、Email 等写操作继续遵守预览、确认、幂等和回执边界；
- Even Hub 仍是唯一当前平台，不建设 Mentra adapter 或通用多平台框架。

## 2. 明确不在本阶段实施

以下事项保留为真机验收项或以后选项，不在本计划中写代码：

- iPhone 锁屏后的持续收音保证；
- WebView 被 iOS 回收后的宿主级自动恢复保证；
- 长时间后台常驻和全天持续麦克风占用；
- Even AI 与 Even Hub plugin 之间的麦克风仲裁修复；
- 真机耗电结论；
- Mentra 客户端、Mentra 后端或双平台发布流程；
- 跨 session 的长期人物记忆、向量数据库和自动行为画像；
- 多用户 SaaS、共享后端账号隔离或云端托管服务。

本阶段可以让服务器和客户端具备“全天可恢复”的基础，但不能将其描述为“全天持续监听”。

## 3. 已确认的默认参数

- [x] 正式环境使用 `SESSION_RESUME_WINDOW_MINUTES=15`：最后活动或断线后 15 分钟内默认恢复原 session；超过后新建 session。
- [x] simulator 使用相同的 15 分钟产品语义，但增加仅限开发环境的“立即模拟会话过期”控制，不必真实等待恢复窗口。
- [x] 明确说“新对话”或确认退出时立即结束当前 session，不等待恢复窗口。
- [x] 第二个输入客户端连接同一 owner 时默认拒绝，不做自动抢占。
- [x] 普通 LLM 回答在连接中断后取消并标记为 `interrupted`，不自动重新生成。
- [x] 用户明确说“刚才没看到，请重新回答／回顾”时才恢复上一轮：已完整 commit 的回答原样补发；中断回答则读取原问题和上下文，创建新的 turn 重新回答或 recap，不覆盖旧记录。
- [x] Calendar／Email 断线恢复时先核对本地 audit store 和 provider 状态：已成功则只报告回执，未提交或仍需修改则重新预览和确认，`unknown` 状态绝不自动重放。
- [x] `SESSION_RETENTION_DAYS=1095`：个人自托管默认保留三年；`0` 只作为用户明确选择的关闭自动清理选项。
- [x] 精确 GPS 坐标只保存在活跃 runtime；退出、过期或服务重启后清除，不写入 conversation SQLite。
- [x] 第一期不保存原始音频，只保存最终 transcript 及必要的中断状态。
- [x] 按本文件中的 5 个 PR 顺序逐步实施；当前 PR 的必需测试未通过时停止，不进入下一个 PR。

## 4. 不可破坏的安全与产品约束

以下约束适用于所有 PR 和全部实现阶段：

- `.env`、API key、OAuth refresh token、SMTP 凭据和 `G2_CLIENT_TOKEN` 不进入会话数据库、日志、测试 fixture 或 Git。
- 不把主 `G2_CLIENT_TOKEN` 写入浏览器或 SDK 普通 local storage。
- 可持久化的 resume credential 必须是随机、单用途、受限、可吊销且有到期时间的凭证；数据库只保存其 hash。
- `client_id` 只是设备标识，不是授权凭证，不能单独恢复会话。
- 所有 SQLite 文件位于 `EVEN_DATA_DIR`，目录权限保持 `0700`，文件权限保持 `0600`，拒绝符号链接。
- 会话恢复只能恢复文本上下文和显示状态，不能恢复 Calendar／Email 执行授权。
- Calendar、Email、删除、修改等副作用继续使用已有的确认和 idempotency 机制。
- 模型摘要不能作为 Calendar、Email、成本账本或外部状态的事实来源；这些信息必须重新查询权威 API／数据库。
- 不在日志中打印完整用户 transcript、resume credential、精确坐标或邮件正文。
- 所有协议输入继续执行长度、类型、速率和 ownership 校验。
- 不修改当前与本计划无关的未提交成本控制工作；实施时按文件逐项检查工作树，避免覆盖已有更改。

### 4.1 resume credential 的用途和边界

初次连接仍然使用主 `G2_CLIENT_TOKEN`。如果 WebSocket 短暂断开或页面刷新，客户端需要再次证明“我是刚才那个已认证客户端”，否则任何知道 session ID 的人都可能尝试恢复对话。

不应把主 token 永久写进 local storage。推荐由服务器在首次认证后签发一张类似“临时房卡”的 resume credential：

- 只能恢复指定 client 的指定 session；
- 到期时间不超过 session 恢复窗口加少量网络宽限；
- 不能调用管理接口，不能绕过 Calendar／Email 确认；
- 每次成功使用后轮换，退出时撤销；
- 服务器只保存 hash，即使 SQLite 被读取也没有明文 credential；
- 客户端可通过 Even SDK local storage 保存这张临时凭证，而不是保存主 token。

这样做对单人项目仍有价值：既避免每次短暂掉线都重新输入主 token，也把凭证被读取后的影响限制在一个很短的恢复窗口内。第一版不使用长期 device credential；超过 15 分钟且原 WebView 已消失时，仍需要主 token 重新认证。是否以后增加长期设备注册属于新的安全决策，不在本阶段自动扩大范围。

## 5. 目标模块边界

本阶段只建立必要的内部边界，不创建多平台 framework：

```text
Even Hub / browser client
  ├─ ConnectionController  WebSocket、认证、重连、补发
  ├─ AudioController       麦克风、设备状态、有限重试
  └─ DisplayController     HUD／网页显示与恢复快照
               │
               ▼
Conversation server
  ├─ SessionRegistry       活跃 logical session 与 connection 绑定
  ├─ ConversationRuntime   当前轮次、模型取消、事件订阅
  ├─ ConversationStore     SQLite transaction 与恢复查询
  ├─ ContextBuilder        最近消息、topic 和摘要的受控上下文
  └─ Existing tools        Calendar、Email、Routes、Search 等
```

建议新增文件：

- `src/conversation-types.ts`
- `src/conversation-store.ts`
- `src/session-registry.ts`
- `src/conversation-protocol.ts`
- `src/context-builder.ts`
- `src/session-summary.ts`
- `src/legacy-session-import.ts`
- `clients/even/src/connection-controller.ts`
- `clients/even/src/audio-controller.ts`

最终文件名可以在实现时微调，但职责不能重新混回 `conversation-server.ts` 或 `clients/even/src/main.ts`。

## 6. 数据模型草案

第一版使用独立的 `assistant-memory.sqlite`，不和 `jobs.sqlite`、Calendar OAuth／event store 混表。

### 6.1 `sessions`

- `id TEXT PRIMARY KEY`
- `owner_scope TEXT NOT NULL`
- `status TEXT NOT NULL`：`active | idle | ended | expired`
- `created_at INTEGER NOT NULL`
- `updated_at INTEGER NOT NULL`
- `last_activity_at INTEGER NOT NULL`
- `ended_at INTEGER`
- `end_reason TEXT`
- `latest_sequence INTEGER NOT NULL DEFAULT 0`
- `summary_through_sequence INTEGER NOT NULL DEFAULT 0`

`owner_scope` 由服务端配置确定，不能由客户端自由提交。当前单用户自托管部署可以使用固定的服务端 owner scope。

### 6.2 `clients` 与 `resume_credentials`

`clients`：

- `id TEXT PRIMARY KEY`
- `created_at INTEGER NOT NULL`
- `last_seen_at INTEGER NOT NULL`
- `label TEXT`

`resume_credentials`：

- `id TEXT PRIMARY KEY`
- `client_id TEXT NOT NULL`
- `session_id TEXT NOT NULL`
- `secret_hash TEXT NOT NULL UNIQUE`
- `created_at INTEGER NOT NULL`
- `expires_at INTEGER NOT NULL`
- `revoked_at INTEGER`

恢复凭证只允许恢复指定 client/session，不允许更换 owner、调用管理接口或绕过写操作确认。

### 6.3 `topics`

- `id TEXT PRIMARY KEY`
- `session_id TEXT NOT NULL`
- `label TEXT NOT NULL`
- `status TEXT NOT NULL`：`active | paused | completed`
- `created_at INTEGER NOT NULL`
- `updated_at INTEGER NOT NULL`

当前每条消息只属于一个 topic，因此第一版不创建 `message_topics` 多对多表。

### 6.4 `turns`

- `id TEXT PRIMARY KEY`
- `session_id TEXT NOT NULL`
- `topic_id TEXT`
- `input_message_id TEXT`
- `output_message_id TEXT`
- `retry_of_turn_id TEXT`
- `status TEXT NOT NULL`：`accepted | planning | answering | committed | interrupted | failed`
- `cognitive_mode TEXT`
- `reasoning_effort TEXT`
- `created_at INTEGER NOT NULL`
- `updated_at INTEGER NOT NULL`
- `error_code TEXT`

### 6.5 `messages`

- `id TEXT PRIMARY KEY`
- `session_id TEXT NOT NULL`
- `turn_id TEXT`
- `topic_id TEXT`
- `sequence INTEGER NOT NULL`
- `role TEXT NOT NULL`：`user | assistant | system`
- `status TEXT NOT NULL`：`committed | streaming | interrupted | failed`
- `content TEXT NOT NULL`
- `citations_json TEXT`
- `created_at INTEGER NOT NULL`
- `updated_at INTEGER NOT NULL`
- `UNIQUE(session_id, sequence)`

`message_id` 提供提交去重；`sequence` 提供有序补发。两者用途不同，不能互相替代。

### 6.6 `session_summaries`

- `id TEXT PRIMARY KEY`
- `session_id TEXT NOT NULL`
- `through_sequence INTEGER NOT NULL`
- `summary_json TEXT NOT NULL`
- `model TEXT NOT NULL`
- `created_at INTEGER NOT NULL`
- `UNIQUE(session_id, through_sequence)`

摘要结构至少包含：已确认事实、用户偏好、当前 topic、决定、未完成事项和明确不确定项。摘要不保存执行授权。

### 6.7 `schema_migrations`

- `version INTEGER PRIMARY KEY`
- `name TEXT NOT NULL`
- `applied_at INTEGER NOT NULL`

所有迁移必须向前执行、可重复检测，不能通过删除数据库重新开始。

## 7. 分阶段实施任务

### Phase 0 — 固定基线和验收契约

#### 0.1 保存实施前基线

- [x] 记录当前 commit、Node 版本、Even SDK 版本和 protocol version。
- [x] 运行当前 server unit tests、typecheck、Even client tests 和 build。
- [x] 记录现有测试数量、失败项、耗时和已知 flaky tests。
- [x] 单独记录当前工作树中与本计划无关的修改，后续不得覆盖。

目标测试：

```powershell
npm test
npm run typecheck
npm --prefix clients/even test
npm --prefix clients/even run build
npm run build:server
npm run audit:public
```

通过门槛：现有测试全绿，或把已存在且与本计划无关的失败明确记录并得到用户同意。未通过则停止，不进入 Phase 1。

#### 0.2 固定协议和状态定义

- [x] 写出 protocol v2 的 TypeScript discriminated unions。
- [x] 明确 connection、audio、conversation 三套独立状态。
- [x] 明确 session 结束、暂停、过期、恢复和模型中断的状态转换。
- [x] 为每个核心客户端事件标记：是否持久化、是否可补发、是否允许重复。
- [x] 明确 Calendar／Email 在断线前、提交中和 provider 回执后三个时间点的处理。

新增测试：`tests/conversation-protocol.test.ts`。

必须覆盖：未知字段、缺失 ID、无效 UUID、超长内容、乱序 ACK、重复事件、旧 protocol 版本。

通过门槛：类型检查和 protocol test 全绿，且不调用真实 API。

---

### Phase 1 — SQLite 会话存储

#### 1.1 建立 `ConversationStore`

- [x] 创建安全数据目录并拒绝符号链接。
- [x] 以 `DatabaseSync` 打开 `assistant-memory.sqlite`。
- [x] 启用 `WAL`、`synchronous=FULL`、`foreign_keys=ON`、`busy_timeout`。
- [x] 创建 schema migrations 和第一版表结构。
- [x] 实现显式 transaction helper；transaction 失败必须 rollback。
- [x] 实现 `close()` 和测试 teardown，避免 Windows 文件锁残留。

新增测试：`tests/conversation-store.test.ts`。

必须覆盖：首次创建、重复打开、并发 owner、符号链接、权限、migration 幂等、constraint、rollback、数据库关闭后拒绝写入。

通过门槛：目标测试、完整 `npm test` 和 `npm run typecheck` 全绿。

#### 1.2 实现稳定 ID 和原子写入

- [x] server 生成 session、turn、assistant message 和 topic UUID。
- [x] typed input 的 `message_id` 由客户端生成，服务端验证并去重。
- [x] STT final 的 user message ID 由服务端分配并持久化。
- [x] 在一个 transaction 中写入 user message、turn 和 sequence。
- [x] 相同 `message_id`、相同内容重复提交返回原 ACK。
- [x] 相同 `message_id`、不同内容返回冲突错误，不覆盖原记录。
- [x] sequence 只在 transaction commit 时递增。

新增测试：`tests/conversation-idempotency.test.ts`。

必须覆盖：同 ID 同内容、同 ID 不同内容、并行重复提交、transaction crash、sequence 无空洞或重复。

通过门槛：目标测试重复运行至少 20 次无不稳定结果；之后完整回归全绿。

#### 1.3 改造回答持久化顺序

- [x] 完成 SQLite 层的 streaming placeholder、checkpoint、final commit 和 interruption 原语；现有 WebSocket runtime 的正式接线仍按下列条目在 Phase 2 完成。
- [x] `answer.start` 时创建 `streaming` assistant message／turn 状态。
- [x] 流式内容按时间或字符阈值做节流 checkpoint，禁止每个 token 单独写 SQLite。
- [x] 最终内容、citation、message status 和 turn status 在同一 transaction commit。
- [x] 只有 commit 成功后才发送 `answer.committed`。
- [x] 现有 JSON runtime 的 `answer.done` 已改为等待 save 成功；SQLite 接线后仍须验证它不早于 durable commit。
- [x] SQLite store 启动时把遗留的 `streaming/planning/answering` 标记为 `interrupted`。
- [x] interrupted partial 不能伪装成完整回答；恢复上下文与 snapshot 带明确中断状态／标签。

新增测试：`tests/conversation-commit-order.test.ts`、`tests/conversation-crash-recovery.test.ts`。

故障注入点：user commit 前、user commit 后、第一段 delta 后、final DB commit 前、final commit 后但客户端未收到。

通过门槛：每个故障点恢复后数据库状态唯一且可解释；不得出现客户端收到 committed、数据库却不存在的状态。

---

### Phase 2 — Logical session 与 WebSocket 解耦

#### 2.1 建立 `SessionRegistry`

- [x] `ConversationRuntime` 不再由 WebSocket connection 构造函数独占。
- [x] `SessionRegistry` 根据 session ID 创建、查找、绑定、解绑和过期 runtime。
- [x] WebSocket close 只 detach connection；不立即调用 conversation `close()`。
- [x] runtime 在恢复窗口内保留；过期后 flush、结束并释放模型／工具资源。
- [x] production 和 simulator 都使用 15 分钟恢复窗口；simulator 显示 server 返回的实际配置，并提供受限的立即过期控制。
- [x] 时间判断依赖可注入 clock，自动化测试不使用真实 sleep。
- [x] 本地开发控制可以强制当前 detached session 过期；正式 build 和公网服务器拒绝注册该控制。
- [x] Linux 服务重启后按需从 SQLite hydrate 最近 session。
- [x] event sink 支持连接替换，不把旧 socket callback 永久捕获在 Conversation 中。
- [x] 当前 `owner` socket 规则改为 active input client lease。

新增测试：`tests/session-registry.test.ts`。

必须覆盖：detach/reattach、两个连接争用、过期、新 session、明确退出、服务重启 lazy hydrate、旧 socket 不再收到事件。

通过门槛：目标测试、完整 server 回归全绿。

#### 2.2 实现 resume credential

- [x] 初始主 token 认证成功后签发随机 scoped resume credential。
- [x] 数据库只保存 hash，客户端只接收明文凭证。
- [x] 凭证绑定 `client_id + session_id`，并通过 session 绑定 `owner_scope` 和到期时间。
- [x] 默认到期时间不超过 15 分钟恢复窗口加 1 分钟网络宽限；它不是长期设备登录凭证。
- [x] 长连接在凭证过期前收到新的短期凭证；成功恢复会轮换凭证并原子撤销同一 client/session 的全部旧凭证。
- [ ] 明确退出会撤销凭证；管理员吊销和 owner token 轮换尚无产品入口，留作后续安全管理功能。
- [x] 日志不记录 resume credential secret。

新增测试：`tests/session-credential.test.ts`。

必须覆盖：正确恢复、错误 client、错误 session、过期、撤销、重放、并行使用、hash 泄漏检查。

通过门槛：任何仅持有 `client_id` 或 session ID 的客户端都不能恢复会话。

#### 2.3 实现 reconnect handshake 与增量补发

- [x] `hello` 增加 `protocol_version`、`client_id`、`resume_session_id`、`last_seen_sequence` 和 resume credential。
- [x] `ready` 返回 `connection_id`、`session_id`、`resumed`、`latest_sequence` 和恢复快照。
- [x] 服务端只补发客户端缺少的 committed／interrupted messages。
- [x] 超出恢复窗口时明确返回新 session，不把旧历史误接到新会话。
- [x] 快照包含显示所需的 user/assistant messages、conversation state 和 interrupted turn 提示。
- [x] snapshot 不包含精确位置、API credential、审批 token 或邮件附件内容。

新增测试：`tests/conversation-reconnect.test.ts`。

必须覆盖：断线前无消息、user ACK 后断线、回答中断、final commit 后断线、客户端重复 ACK、错过多个 sequence、服务重启后恢复。

通过门槛：相同场景重复至少 50 次，无重复消息、漏掉的 committed message 或重复副作用。

#### 2.4 显式恢复上一轮回答

- [x] 识别明确的“刚才没看到／再说一次／重新回答”等恢复请求，但普通重连不自动触发模型；宽泛 recap 留给 ContextBuilder。
- [x] 查询当前 session 最近一个相关 turn，而不是依赖进程内变量。
- [x] 如果 assistant message 已经 `committed`，`answer.retry` 原样补发已存回答，不重新调用模型、不重复计费。
- [x] 如果 turn 是 `interrupted`，只有显式 `answer.retry` 才把带中断标签的 session context 交给 LLM，创建新的 turn 回答。
- [x] 新 turn 使用新的 message/turn ID，并通过 `retry_of_turn_id` 指向原 turn；不覆盖或伪造旧回答。
- [ ] 用户要求 recap 时，可以使用 ContextBuilder 总结相关 committed conversation；不得把中断 partial 当成已确认结论。
- [x] 没有可恢复 turn 时只返回一个简短说明，不调用模型。

新增测试：`tests/conversation-turn-recovery.test.ts`。

必须覆盖：committed 回答客户端未看到、中断回答、上一轮为 Calendar／Email 写操作、多个 topic、无上一轮、重复恢复请求。

通过门槛：完整回答只补发一次存量内容；中断回答只有在用户明确要求后才产生一个新 turn；任何情况都不重放外部副作用。

---

### Phase 3 — Calendar／Email 恢复安全

#### 3.1 把草稿内容和执行授权彻底分开

- [x] 断线、暂停、连接替换时立即使 Calendar／Email approval token 失效。
- [x] 对话历史和 Calendar 草稿可以保留预览内容，但不得保留可直接执行的授权。
- [x] 恢复后用户再次确认时，如果授权已失效，Calendar 重新读取 provider 后生成新预览；未发送的 Email 自动签发全新的预览／确认 token。
- [x] provider 请求已经发送时，不因为 socket 断线而重复发送。
- [x] provider 返回成功、失败或不确定状态后，都写入现有 job／calendar audit store。
- [x] 恢复后的 receipt 使用权威 store 查询，不依赖 LLM 回忆。
- [x] Calendar 已提交或结果未知时使用原 operation/event ID 只读核对 Google Calendar：内容匹配才报告已保存；无法证明时保持 unknown，绝不重放写入。
- [x] Email 已获得明确 SMTP/provider receipt 时报告已发送，不再次发送。
- [x] Email 在 provider 已接收请求但本地没有确定 receipt 时保持 `unknown`；SMTP 通常无法证明最终收件，因此先提示用户检查收件箱，只有用户明确要求重发后才生成新预览和新确认。
- [x] 用户要求修改已经成功提交的 Calendar／Email 内容时，把它视为新操作，重新预览和确认。

新增测试：`tests/conversation-write-recovery.test.ts`。

必须覆盖：预览前断线、预览后确认前断线、确认后请求前断线、provider 成功但 ACK 丢失、provider timeout/unknown、重复确认。

通过门槛：Calendar event 和 Email delivery 在全部断线点最多执行一次；恢复后不存在无预览直接写入。

#### 3.2 保护批量 Calendar loop

- [x] 正在逐项删除／修改多个 event 时，把“已选择哪些项目”和“处理到第几项”视为会话内容状态。
- [x] 每个实际写操作仍拥有独立 idempotency key 和独立 receipt。
- [x] 断线恢复后从权威 Calendar 状态重新读取，不能直接假设上一项成功。
- [x] 继续下一项前给出简短反馈，不一次要求用户记住多个确认问题；恢复预览继续显示第 n/总数项。

新增测试：在现有 Calendar choice/dialogue/recurrence tests 上增加断线和重复确认场景。

通过门槛：批量 3–5 项测试中没有重复删除、跳项或把只读事件当成可修改事件。

---

### Phase 4 — 客户端生命周期拆分

#### 4.1 提取 `ConnectionController`

- [x] 从 `clients/even/src/main.ts` 提取连接、hello、ACK、重连和 snapshot restore。
- [x] 使用带 jitter 的退避：0.5s、1s、2s、5s、10s、30s 上限。
- [x] 网络恢复或设备重新连接时允许立即触发一次重连，不等待下一个 timer。
- [x] 页面隐藏不再发送 conversation `pause`；它只能影响 audio/display/connection。
- [x] page unload 不发送“结束会话”；服务端依靠 detach 和恢复窗口处理。
- [x] 明确退出仍走系统确认，并撤销 resume credential／清除 session location。
- [x] UI 明确显示：正在重连、会话已恢复、恢复失败后新会话、凭证过期。

新增测试：`clients/even/tests/connection-controller.test.ts`。

必须覆盖：退避、jitter 范围、快速恢复、重复 timer 清理、过期凭证、旧 socket 事件、页面隐藏、明确退出。

通过门槛：client tests 和 client build 全绿；不需要真实 SDK 或真实服务器。

#### 4.2 提取 `AudioController`

- [x] 把用户希望收音的 `desired` 状态和 SDK 实际 `actual` 状态分开。
- [x] 状态至少包含 `off | starting | streaming | unavailable`。
- [x] 麦克风失败不关闭 conversation，不清空历史，不撤销 session。
- [x] 串行化所有 `audioControl(true/false)`，避免 open/close 竞态。
- [x] 开启失败最多进行 3 次有限重试，每次重新核验 backend、visibility 和设备状态。
- [x] 连续失败后显示“请重新打开应用”的可操作提示，不做无限循环。
- [x] 用户主动关闭麦克风时取消尚未执行的 retry。
- [x] 页面隐藏默认安全地停麦，但保留 desired 和 logical session；恢复可见后按原意图重试。

新增测试：`clients/even/tests/audio-controller.test.ts`。

必须覆盖：开关竞态、失败重试、用户取消、socket 断线、设备断开、重新连接、旧 promise 晚到、dispose。

通过门槛：100 次模拟开关／断线循环没有残留 timer、重复 listener 或错误的 `audio=true` 状态。

#### 4.3 接入 Even SDK 设备状态

- [x] 使用 `onDeviceStatusChanged` 监听 connecting、connected、disconnected 和 connectionFailed。
- [x] glasses disconnected 时停止实际 audio，但保留 `desired` 和 logical session。
- [x] connected 后仅在用户此前希望收音时尝试重新获取麦克风。
- [x] 区分 SDK microphone unavailable 与 STT/network unavailable。
- [x] 不把 `audioControl(false)` 解释为 session 结束。
- [x] simulator 没有完整设备事件时使用 fake bridge 做自动测试。

新增测试：扩展 `clients/even/tests/client-lifecycle.test.ts`。

通过门槛：所有 SDK 状态转换可重放且结果确定；不声称解决 iOS 锁屏或宿主 WebView 被回收。

#### 4.4 同步 browser simulator/reference client

- [x] `web/app.js` 使用相同 protocol v2、session ID、message ID、ACK 和重连规则。
- [x] 页面上明确显示 local/Linux backend、connection ID、session ID 短前缀和 resumed/new 状态。
- [x] 浏览器 visibility change 不结束 logical session。
- [x] simulator 能手动制造 socket drop、服务端重启和重复 submit。
- [x] simulator 显示当前恢复窗口：读取 server 配置，默认 15 分钟。
- [x] 增加“模拟会话恢复窗口过期”按钮：仅在 `DEV`、loopback backend 且 server 显式启用 test controls 时可用。
- [x] 点击后由测试 server 关闭并 detach 当前 connection、立即过期该 session，再由客户端使用内存中的主 token 建立新 session。
- [x] production client build、`.ehpk` 和 Linux 公网 WSS 不包含也不接受该测试控制消息。

新增测试：优先把可测逻辑提取成 TypeScript/纯函数；避免只靠人工点击。

通过门槛：本地浏览器可以演示同 session 断开重连，并且显示历史不重复。

---

### Phase 5 — 长对话上下文

#### 5.1 建立 `ContextBuilder`

- [ ] 删除 `history.length >= 100` 的会话终止逻辑。
- [ ] 存储层允许 100+ messages；模型上下文层按 token／字符预算选择内容。
- [ ] 默认组合：session summary、当前 topic summary、最近 20–30 条原始消息、未完成事项和本轮输入。
- [ ] artifact 生成可以选择 topic／时间范围，不默认导出整个无限历史。
- [ ] interrupted/failed assistant message带状态进入上下文，不能伪装成已确认结论。
- [ ] Calendar／Email／成本／路线的当前事实始终由工具重新读取。

新增测试：`tests/context-builder.test.ts`。

必须覆盖：120、500 条消息；多 topic resume；中英文；超长消息；中断回答；最新消息必定保留；预算不超限。

通过门槛：长对话不会因为数量暂停，ContextBuilder 输出稳定、可预测且不超过配置预算。

#### 5.2 实现异步 session summary

- [ ] 只在达到消息／token threshold 后排队生成摘要。
- [ ] 摘要生成失败不能阻塞当前回答。
- [ ] 摘要使用固定 schema，经过 runtime validation。
- [ ] 摘要保存 `through_sequence`，只总结尚未覆盖的 committed messages。
- [ ] 同一范围的重复任务幂等；服务重启后不重复收费。
- [ ] 摘要模型调用计入现有跨 provider 成本账本。
- [ ] 摘要禁止启用 web search 或 Calendar／Email 写工具。

新增测试：`tests/session-summary.test.ts`。

必须覆盖：schema invalid 自修复／放弃、模型失败、重复任务、服务重启、费用记录、消息在摘要过程中新增。

通过门槛：摘要失败时对话仍正常；摘要成功后能显著缩短输入且保留已确认决定和未完成事项。

#### 5.3 修正 MD 导出的 100-message 耦合

- [ ] `JobStore.enqueue` 不再把“会话消息数”当作文档输入的唯一限制。
- [ ] 导出请求先形成经过用户确认的 document/topic selection，再提交 immutable document input。
- [ ] 继续保留总字节、附件大小和邮件大小限制。
- [ ] 不允许 job worker 在后台读取不断变化的整个 session。

新增测试：扩展 `tests/job-store.test.ts`、`tests/delivery.test.ts`。

通过门槛：超过 100 条的会话可以导出选定内容，同时不能用超大输入绕过邮件／磁盘限制。

---

### Phase 6 — 旧数据迁移、备份与恢复

#### 6.1 导入现有 JSON session

- [ ] 只读取合法 UUID 文件名、普通文件和预期 schema。
- [ ] 导入采用 transaction，并在 `schema_migrations` 或独立 import ledger 中记录来源 hash。
- [ ] 重复运行不产生重复 session／message。
- [ ] 非法、截断或超限 JSON 被隔离并记录安全错误，不阻止其他文件导入。
- [ ] 成功导入后保留原 JSON，不自动删除；等待一次完整备份和人工确认。

新增测试：`tests/legacy-session-import.test.ts`。

必须覆盖：合法文件、重复文件、恶意路径、符号链接、截断 JSON、超大文件、部分失败 rollback。

通过门槛：导入工具可 dry-run，正式运行结果可重复验证。

#### 6.2 扩展备份验证

- [ ] 确认 backup 停服务后包含 `assistant-memory.sqlite` 及必要 WAL 状态。
- [ ] `verify-backup.mjs` 对新数据库执行 `integrity_check` 和 `foreign_key_check`。
- [ ] 验证 session/message/turn 引用关系。
- [ ] 验证最新 session、最新 committed message 和 summary sequence 可以读取。
- [ ] restore drill 验证服务能从恢复目录重新启动并恢复 session。
- [ ] 备份输出不打印 transcript 内容。

新增测试：扩展 `tests/deploy-update.test.ts`，并增加隔离临时目录中的 backup verifier test。

通过门槛：本地恢复演练成功；之后才能安排 Linux 恢复演练。

#### 6.3 数据保留和清理

- [ ] 实现可配置 retention；默认 `1095` 代表三年保留期，`0` 只用于明确关闭自动清理。
- [ ] retention 大于 `0` 时，只清理已经结束／过期且超过期限的 session；默认清理三年前的数据。
- [ ] 使用 foreign key cascade 或显式 transaction，不能留下 orphan rows。
- [ ] active session、运行中的 job 和未确定 provider receipt 不得清理。
- [ ] 清理前后记录数量指标，不记录正文。
- [ ] 提供 dry-run 模式。
- [ ] 增加 SQLite 文件大小、message 数和剩余磁盘空间的健康指标／warning；达到 warning 只通知，不在 `0` 模式下擅自删除。
- [ ] 文档说明 SQLite 历史主要占用磁盘，不会把整个数据库常驻 RAM；ContextBuilder 也不得把三年历史全部加载到内存。

新增测试：`tests/conversation-retention.test.ts`。

通过门槛：时间边界、夏令时和服务重启不影响以 Unix time 计算的 retention。

---

### Phase 7 — 完整验收与部署 gate

#### 7.1 本地自动化回归

- [ ] server unit/integration tests 全绿。
- [ ] TypeScript typecheck 全绿。
- [ ] Even client tests/build 全绿。
- [ ] server production build 全绿。
- [ ] public secret/privacy audit 全绿。
- [ ] 测试不得默认调用 OpenAI、Soniox、Google、SMTP 或真实 Calendar。

#### 7.2 本地 fault-injection 验收

- [ ] 提交 user message 前断网。
- [ ] user ACK 后断网。
- [ ] Luna streaming 中断网。
- [ ] final commit 后、客户端收到前断网。
- [ ] 连续刷新页面 10 次。
- [ ] simulator 使用开发按钮验证立即过期；重连后必须产生新 session，旧 session 仍保留在 SQLite 中但不再恢复。
- [ ] server 在 listening、thinking、answering 三种状态分别重启。
- [ ] 重复发送同一 `message_id` 10 次。
- [ ] 120+ message 长对话。
- [ ] 第二个 client 连接争用。
- [ ] Calendar／Email 预览后断网、确认后断网和 provider ACK 丢失。

通过门槛：无重复消息、无重复邮件、无重复 Calendar 写入、无未经确认的副作用。

#### 7.3 用户本地 simulator 验收

- [ ] 用户确认新 session 和 resumed session 显示清楚。
- [ ] 用户确认断线恢复后可以继续 refer back 到先前内容。
- [ ] 用户确认回答中断提示简洁，不显示内部 metadata／error dump。
- [ ] 用户确认麦克风失败不导致对话丢失。
- [ ] 用户确认 Calendar／Email 恢复后仍要求正确预览／确认。

停止条件：用户尚未验收时，不创建部署 PR，不部署 Linux，不构建新的 `.ehpk`。

#### 7.4 GitHub 与 Linux

- [ ] 用户验收后进行 diff、secret、个人数据和生成文件扫描。
- [ ] 创建独立 PR；CI 全绿后再由用户决定 squash merge。
- [ ] Linux 部署前备份当前 data directory 和已知可用 release。
- [ ] 迁移工具先 dry-run，再停服务迁移，再启动服务。
- [ ] 验证 `/health`、WSS、SQLite、Calendar、Email、成本账本和 backup timer。
- [ ] 从本地 simulator 连接 Linux WSS，重复核心断线恢复测试。
- [ ] 完成 Linux security check：开放端口、systemd 用户、目录权限、日志、数据库权限、Tailscale、防火墙和备份。
- [ ] 完成一次 Linux backup/restore 演练后才标记阶段完成。

#### 7.5 Even Hub package

- [ ] 只有本地和 Linux 验收都完成后才构建新的 `.ehpk`。
- [ ] 更新 client/protocol/min SDK version 和 release notes。
- [ ] package 中不得包含 backend secret、测试音频、`.env`、本地 URL 或恢复凭证明文。
- [ ] 真机到货前只验证 package/build/manifest，不宣称锁屏常驻或全天持续收音。

## 8. 每个任务统一执行模板

以后实现每一个 checkbox 时都采用同一流程：

1. **检查工作树：** 确认没有覆盖用户或其他阶段的未提交修改。
2. **写失败测试：** 先建立能稳定复现目标或 bug 的最小测试。
3. **最小实现：** 只修改当前 checkbox 所需模块。
4. **目标测试：** 重复运行目标测试；涉及竞态时至少循环 20–100 次。
5. **相关回归：** 运行与该模块相邻的 Conversation、Calendar、Email、client tests。
6. **完整回归：** 运行 `npm test`、typecheck；客户端改动还要运行 client test/build。
7. **安全检查：** 检查日志、凭证、位置、权限、重复副作用和 public repository 内容。
8. **记录结果：** 在 PR／开发记录中写明命令、结果、已知限制和下一项。
9. **Gate：** 任意必需测试失败时停止，不开始下一 checkbox；先修复或向用户说明阻塞。

真实 Calendar、Email、Google、OpenAI 或 Soniox smoke test 必须单独标记，并在可能产生费用／真实副作用时先取得用户确认。自动回归不得依赖真实 provider。

## 9. 预计 PR 划分和工程量

### PR 1 — `conversation-store`

范围：Phase 0、Phase 1。
预计：3–4 个有效开发日。
可独立回滚；尚不改变用户连接体验。

### PR 2 — `resumable-session-protocol`

范围：Phase 2、Phase 3。
预计：4–6 个有效开发日。
这是风险最高的 PR，应增加最多 fault-injection tests。

### PR 3 — `client-lifecycle`

范围：Phase 4。
预计：2–4 个有效开发日。
只保证 SDK 可控状态和有限恢复，不包含锁屏／全天收音承诺。

### PR 4 — `bounded-long-context`

范围：Phase 5。
预计：3–5 个有效开发日。
摘要调用必须接入现有成本账本。

### PR 5 — `migration-backup-release`

范围：Phase 6、Phase 7 文档与部署支持。
预计：2–3 个有效开发日，加用户本地验收和 Linux 演练时间。

总预计：14–22 个有效开发日。实际时间取决于 fault-injection 暴露的 Calendar／Email 恢复边界问题，不包括真机平台限制调查。

## 10. 第一阶段 Definition of Done

只有以下条件全部满足，才能宣布这一阶段完成：

- [ ] SQLite 是 conversation 的唯一权威持久化来源；
- [ ] server restart 后最近 session 可以恢复；
- [ ] WebSocket 断线、页面刷新不会自动创建新 session；
- [ ] 100+ messages 不触发硬停止，模型上下文保持有界；
- [ ] user／assistant committed message 都有稳定 ID 和 sequence；
- [ ] 所有重复 submit/ACK 都是幂等的；
- [ ] 中断回答可识别，不伪装成完整回答；
- [ ] 麦克风失败、蓝牙断开和网络断开不会删除 conversation；
- [ ] Calendar／Email 无重复副作用且断线后不会绕过确认；
- [ ] 精确位置、主 token 和执行授权未被写入 conversation store；
- [ ] JSON legacy import、backup verification 和 restore drill 通过；
- [ ] 本地自动化、用户 simulator、Linux WSS 和安全检查全部通过；
- [ ] README／运行文档明确说明已实现范围和仍待真机验证的限制；
- [ ] 新 `.ehpk` 只在全部前置 gate 通过后生成。

## 11. Review 状态

以下决定已经确认：

1. 正式环境和 simulator 都使用 15 分钟恢复窗口；simulator 提供严格受限的开发过期按钮；
2. 默认保存三年（`SESSION_RETENTION_DAYS=1095`），`0` 只作为明确关闭自动清理的可选值；
3. 普通回答断线后标记中断，只有用户明确请求时才补发 committed 回答或新建 turn 重新回答；
4. 第二个输入客户端默认拒绝；
5. Calendar／Email 先核对 provider/audit 状态，无法确认时绝不自动重放；需要修改或再次发送时重新预览、确认；
6. 按 5 个 PR 和逐项 gate 顺序实施。

7. 允许把第 4.1 节所述的短期、受限、可吊销 resume credential 存入 Even SDK local storage；主 `G2_CLIENT_TOKEN` 仍不得持久化。

本计划已获批准。实施必须遵守逐项测试和停止 gate，不因批准而跳过验证。
