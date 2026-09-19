# Even G2 Agent — Development Plan

> **近期交付范围已确认：** 优先完成 [Conversation MVP](./CONVERSATION_MVP.md)：手动启动、自动轮次判断、多轮文字对话、插话，以及基于意图的结束会话与系统确认退出。MD 文件生成/发送等工具在该版验收后再加入。该文优先于下文冲突的近期交互安排；[本地实验版](./CONVERSATION_LAB.md) 已实现部分能力并通过小样本真实 API 验证，G2/R1 与完整体验待验收。

> **最新决策（覆盖下文旧选型内容）：** 当前默认 STT 为 Soniox `stt-rt-v5`，直接使用 G2 原生 PCM16/16 kHz，并针对中英文混说启用 `en`/`zh` hints 与自动语言识别；OpenAI `gpt-live-transcribe` adapter 仅保留为显式回退。仍须用未参与调试的新录音和真机进行准确率验收。

**状态：** Accepted for V0 discovery

**日期：** 2026-09-15

**目标版本：** V3 Ambient Agent Platform
**实施原则：** 每一阶段只有在客观 gate 通过后才能进入下一阶段

## 1. 结论

这个项目可行，但“可行”分成两层：

1. **高置信可行：** 在主动打开的 Even Hub app 会话内完成实时字幕、会话上下文、显式记忆、列表写入、OpenAI/Claude 等模型路由，以及服务端工具调用。
2. **条件性可行：** 手机锁屏、App 长时间后台、网络切换后仍像系统级助理一样全天候工作。这个目标受 Even Hub host、iOS WKWebView 生命周期、BLE、电池和 SDK 演进影响，必须用真机验证；不能只靠模拟器得出结论。

因此保留原 blueprint 的总体方向，但增加 **V0 可证伪技术验证**、**V2.5 确定性写操作** 和 **V3 生命周期 gate**。

## 2. 产品定义

Even G2 只承担：

- 麦克风采集；
- HUD 显示；
- tap / double tap / scroll 等用户确认动作；
- 与我们自己的服务端建立 WSS 连接。

服务端承担：

- 身份认证、会话和协议版本；
- 16 kHz → 24 kHz 流式重采样；
- OpenAI Realtime transcription；
- transcript 排序、持久化、摘要和检索；
- 命令理解、模型路由、工具策略、确认和执行；
- secrets、审计、成本限制、日志和指标。

“ChatGPT”是面向用户的产品名，不作为程序接口抽象。代码中使用 `OpenAIProvider`、`AnthropicProvider` 等 API provider；具体模型 ID 全部由配置决定，不写死在业务逻辑中。

## 3. 已核验的技术基线

截至 2026-09-15，以下关键假设与官方资料一致：

- G2 麦克风通过 Even Hub SDK 暴露为 PCM s16le、16 kHz、mono 的 `Uint8Array`。
- 官方 ASR template 已提供麦克风、HUD、120 ms render debounce、pause/exit 和 simulator 基线。
- Even Hub app 需要 `g2-microphone` 和带非空 whitelist 的 `network` 权限；WebView 仍受常规网络/CORS 约束。
- OpenAI 官方建议实时转写从 `gpt-live-transcribe` 开始；示例输入是 24 kHz PCM。
- transcript delta/final 事件存在，跨 turn 的 final 到达顺序不保证，必须用 `item_id` 关联。
- `gpt-live-transcribe` 当前不提供 word-level timestamp、speaker label 或 confidence。

新增产品要求：

- live transcript 必须支持普通话/英文以及同一句内的中英 code-switch；
- “转写字面正确”与“命令意图/参数正确”分别验收；
- STT provider 不能因为 OpenAI 需要 24 kHz 就被预先写死；
- G2 到服务端始终传原生 16 kHz PCM，provider adapter 决定 pass-through 或在服务端转成 24 kHz。

Provider 首轮只比较 OpenAI `gpt-live-transcribe` 与 Soniox `stt-rt-v5`。详细方法和候选边界见 [STT_BAKEOFF.md](./STT_BAKEOFF.md)。

实现时应 pin：

- 官方 ASR template 的 commit SHA；
- `@evenrealities/even_hub_sdk` 精确版本；
- Node/npm 版本；
- 我们自己的 client/server protocol version。

## 4. 对原 blueprint 的关键修订

### 4.1 新增 V0，先证明未知项

在搭 VPS 或构建完整 monorepo 前，用最小 spike 验证：

- 官方 ASR template 能否在当前 simulator 启动；
- 浏览器/WebView 到测试 WSS 的 binary frame 能否稳定传输；
- 16 → 24 kHz stateful resampler 的边界连续性；
- OpenAI session 配置、事件名和错误处理与当前官方协议一致；
- 中文、英文、中英 code-switch 的第一轮实际效果。

V0 产物可丢弃；结论和测试 fixture 必须保留。

### 4.2 本地证明，再部署公网

WAV → local server → fake OpenAI 必须先通过；随后才执行 WAV → local server → real OpenAI。只有需要 Even 真机/远程网络时才部署公网 WSS，避免把 DNS、TLS、systemd 与音频问题混在一起调试。

这里的 fake adapter 改为 provider-neutral `Transcriber` contract；真实 smoke test 分别接 OpenAI 与 Soniox。V0 bake-off 结束后，V1 只保留胜出的默认 provider，另一个 adapter 可作为 feature flag/fallback，但不同时维护更多候选。

### 4.3 命令边界不能只靠 wake phrase

`Hey Even` / `Even` 在 ambient transcript 中可能被他人说出或被 STT 误识别。写操作至少采用：

```text
final transcript
  → wake phrase / gesture-armed command window
  → structured intent
  → resolve references
  → preview
  → tap/voice confirmation when required
  → idempotent execute
  → receipt + audit event
```

首个安全默认值：

- 只读问答：清晰命令可直接执行；
- 写 memory / list：显示目标和内容，单 tap 确认；
- 外发消息、删除、财务、安全设置、代码执行：必须二次明确确认，且 ambient mode 永不直接执行；
- 高风险工具默认不注册。

### 4.4 “this”和“the list”必须做引用解析

`Even, add this to the list` 不应直接交给模型自由猜测。

系统维护显式 `focus`：

- `this` 可指当前选中的 HUD 内容、最近一次 agent answer、或最近一个 final speech span；
- `the list` 必须解析到一个已选择的默认 list；
- 多个候选时必须追问，不执行写入；
- 写入使用 `command_id + idempotency_key`，重连或重复 final 不得产生重复项。

### 4.5 memory 是领域对象，不是 prompt 文本堆

Memory API 至少支持：

- `create`；
- `update`（必须有 memory id 或唯一匹配）；
- `search`；
- `forget`；
- `list_recent`。

每条 memory 包含来源、创建/更新时间、类别、retention、状态和审计信息。`Even, update the memory` 如果未说明对象或新值，应进入澄清状态，而不是修改任意记录。

### 4.6 模型路由与工具路由分离

模型负责理解、规划或生成；工具负责确定性副作用。模型不能直接持有 service token，也不能绕过 policy gate。

```text
command
  → intent router
  → task policy
  → model provider (optional)
  → typed action plan
  → tool policy + confirmation
  → deterministic executor
```

初期只使用一个默认 reasoning provider。第二个 provider 只有在 eval 证明质量、延迟或成本价值后才接入。provider outage 时允许配置 fallback，但写操作不得因为 fallback 而降低确认要求。

### 4.7 Transcript 顺序需要自己的 turn sequence

`item_id` 用于关联 delta/final；接收事件的 `seq` 不能代表原始说话顺序。服务端在 turn start/commit 时分配单调 `turn_seq`，保存 `item_id ↔ turn_seq` 映射，再以 `turn_seq` 投影和持久化。

### 4.8 把手机后台生命周期列为最高风险

Even Hub 当前是 WebView host。已存在 2026 年的公开问题报告：iOS 在后台和内存压力下可能终止 WebContent process，插件无法自行恢复。V1 的目标因此是“主动会话可靠”，V3 的“ambient”只有在真机 soak test 通过或 host/SDK 提供可靠恢复机制后才可宣布完成。

## 5. 目标架构

```text
Even G2 mic/HUD/gestures
          │
          ▼
Even Hub WebView client
          │ binary PCM + JSON control over WSS
          ▼
Gateway / Session Runtime
  ├─ auth + protocol + budgets
  ├─ streaming resampler + STT adapter
  ├─ transcript assembler
  ├─ context + memory store
  ├─ command state machine
  ├─ model provider router
  ├─ policy / confirmation gate
  ├─ tool registry / MCP adapters
  └─ audit + metrics
          │
          ├── OpenAI Realtime transcription
          ├── OpenAI reasoning models
          ├── Anthropic Claude models
          └── approved tools / MCP servers
```

首版仍为一个 Node.js process + SQLite；模块边界清楚，但不拆微服务。

## 6. 核心用户流程

### 6.1 “Even, remember/update the memory”

建议语言行为：

1. `Even, remember that the launch is Friday.`
2. 系统抽取 `{type: memory.create, content: ..., source_span: ...}`。
3. HUD 显示 `REMEMBER: Launch is Friday?`。
4. 用户 tap 或说 `confirm`。
5. 执行一次写入，并显示短 receipt。

对于 `Even, update the memory`：

- 若当前没有唯一 focus，回答 `Which memory?`；
- 用户给出对象后，再询问新内容；
- update 前显示 old → new 摘要；
- 重复事件用 idempotency key 折叠。

### 6.2 “Even, add this to the list”

第一版使用我们自己的 SQLite list，不直接连接第三方任务应用：

1. 解析 `this` 的候选来源；
2. 解析默认 list，默认不存在则追问；
3. 显示 `ADD TO <list>: <item>?`；
4. tap 确认；
5. 写入并返回 item id/receipt。

通过这一条 vertical slice 验证命令、上下文、确认、写工具、幂等和 HUD receipt。之后再把相同 `ListTool` interface 接到 Todoist、TickTick、Notion 或 MCP。

### 6.3 “Use Claude/OpenAI to …”

用户可以显式选择 provider，也可以使用自动策略：

- `provider=auto`：由服务端基于任务类型、可用性、成本预算和 eval 结果选择；
- `provider=openai|anthropic`：尊重显式选择；
- provider 返回的必须是 schema-validated output；
- provider 只能提出 tool action，不能直接执行副作用。

## 7. 版本路线和 release gates

### V0 — Feasibility Spike

交付：

- 版本/commit 清单；
- 5 个可合法保存的 WAV fixtures 或生成脚本；
- fake STT integration harness；
- OpenAI live transcription CLI spike；
- Soniox native-16-kHz live transcription CLI spike；
- 中英 code-switch STT/intent bake-off 报告；
- Even simulator mic/HUD spike；
- lifecycle 风险实验记录。

Gate：

- 16 → 24 kHz 输出时长误差 ≤ 1 sample/streaming boundary 设计容差；
- clean English、Mandarin 和 mixed fixture 都能得到非空且语义正确的 final；
- bilingual command intent、critical slots 和 false activation 达到 `STT_BAKEOFF.md` 的最低 gate；
- binary audio path 无 base64 client overhead；
- 所有 secrets 只在 server/CLI 环境中。

### V1 — Reliable Live STT

#### V1.0 Local pipeline

- npm workspaces monorepo；
- shared versioned protocol；
- `/health`、authenticated `/ws/g2`、hello/ready；
- PCM validator、stateful resampler、chunk buffer；
- fake OpenAI integration tests、WAV injector。

#### V1.1 Real streaming STT pipeline

- 接入 V0 胜出的默认 streaming STT adapter（OpenAI 或 Soniox）；
- 保留统一 `Transcriber` contract 和 sample-rate capability；
- manual commit，再引入 VAD；
- delta/final reconciliation；
- bounded reconnect buffer；
- usage/cost counters。

#### V1.2 Even simulator

- 基于 pin 住的官方 ASR template；
- network whitelist + G2 microphone permission；
- HUD projection、render throttle、pause/resume/exit；
- disconnect/reconnect state；
- client 与 server state machine tests；
- 保留手机伴随页文字输入作为语音的补充，用于邮箱、URL、ID 和不方便说话的场景；
- 覆盖 typed Unicode／邮箱／URL、空输入、超长输入、认证和眼镜历史显示测试。文字输入已经存在于当前客户端，但任意收件人发送仍须独立的安全确认设计。

#### V1.3 Real G2

- Wi-Fi/cellular/network switch；
- English/Mandarin/code-switch；
- 30 min、1 h、2 h battery/lifecycle test；
- foreground/background/lock/unlock；
- 两小时 server soak；
- 验证 packaged phone WebView 中的文字输入、软键盘和眼镜回显；
- 在基础真机 matrix 通过后验证按需单次定位 POC：只在明确路线／当前位置问题中请求，覆盖授权拒绝、超时、低精度／过期位置和网络切换；默认不持续跟踪、不保存精确坐标。路线时间和实时交通由独立的 server-side routing provider 提供，不把地图 key 放进 `.ehpk`。

V1 release gate：

- p50 first visible text < 1.0 s，p95 < 2.0 s（真机目标，测量后可重定基线）；
- server 内音频处理 p95 < 2 ms/chunk，且 resampler 不引入额外等待窗口；
- 连续 30 min 无 crash、无 unbounded memory growth；
- transient reconnect < 5 s 或明确显示失败状态；
- raw audio 默认不落盘；
- simulator 和真机 matrix 通过后才标记 V1 complete。

### V2 — Contextual Assistant

#### V2.0 Persistence and retention

- SQLite WAL + migrations；
- sessions、turns、summaries、commands、memories；
- retention deletion + backup lag policy；
- device pairing、short-lived access token、revocation。

#### V2.1 Context and Q&A

- recent transcript window；
- rolling structured summary；
- SQLite FTS retrieval；
- concise HUD response + full companion response；
- factuality eval：答案必须可回溯到 transcript segment IDs。

#### V2.2 Explicit command mode

- wake phrase detector 只消费 final；
- gesture-armed command window；
- typed intent schema；
- clarification state；
- cancel/timeout；
- no-LLM fast path for deterministic commands。

V2 gate：

- 普通对话 2 小时测试中写操作误触发为 0；
- recent-context benchmark 达到预先建立的正确率阈值；
- 用户能查看、修改、删除自己的 transcript/memory；
- server restart 后 logical session 和 command audit 可恢复。

### V2.5 — First Safe Actions

这是原 blueprint 缺少的桥梁版本。

- internal `MemoryTool`；
- internal `ListTool`；
- preview/confirm/execute/receipt；
- command、tool_call、confirmation、audit_event 数据模型；
- idempotency keys 和 retry semantics；
- prompt-injection/ambient-speech abuse tests。

V2.5 gate：

- 断线重试和重复 final 不产生重复 item/memory；
- 模糊的 `this`/`list` 一律追问；
- 未确认的写操作永不执行；
- 每次副作用均有可查询 audit trail。

### V2.6 — Conditional Task Orchestrator

> 2026-09-18 决策：该专用 runtime 已退役。多站点／户外／旅行请求统一进入 Luna 的
> `planning`，避免单用途 schema 把完整目标压缩成一个地点。Maps／Routes／Weather／AQI／
> Pollen 属于可降级的只读证据：结构化 Google read 失败时，可转入受配额限制的 Luna web
> research，并明确不冒充实时路线或缺失数据。Calendar／Email 属于用户资产与交付能力，
> 必须继续使用专用后端、预览确认、幂等和回执，禁止用模型猜测替代。本节以下内容作为历史
> 设计、安全原则与测试资产保留。

面向真正 personal assistant 的多步骤条件任务层。LLM 生成的是声明式计划，
由后端验证成无环 dependency graph 后执行；LLM 不能声明新工具、风险级别、
retry policy 或授权写入。

- Calendar／location／Weather／AQI／Pollen／Places／Routes 等结构化 read tools；
- 用户只表达户外目标，系统默认选择 Weather／AQI／Pollen 等 evidence pack；未来
  增加经过审核的环境信号时，不要求用户背更长的调用口令；
- 私人 Calendar 只在用户要求查询安排／空闲，或把执行条件绑定到空闲时读取；
  普通室内目的地 ETA 不为“显得智能”而浪费无关花粉调用；
- 先形成地点与户外建议，再对最终候选时段做 Calendar overlap 检查；默认在冲突时寻找
  一个经过查询验证的邻近空档，并为新时段并发重查 Weather／AQI／Pollen；只有用户明确说
  “冲突就不要安排”时才直接停止；
- 每个 turn 独立重判 cognitive mode 与 workflow；户外话题中的地点详情、推荐理由、商业讨论、
  深度问题和路线 ETA 不继承 `conditional_task`。它们分别选择 explain／research／planning／
  deep_reasoning 等认知模式；路线是 navigation workflow，不再是认知模式。只有重新评估条件、
  改时间或安排日程才重启 `conditional_task + outdoor_activity`；
- dependency 与 restricted condition；满足依赖的只读节点安全并发；
- 可暂停、纠正、版本化和恢复的 task state；
- backend normalization + LLM synthesis，输出建议而非原始数据；
- 复杂、多约束 decision 允许更多 read budget 和 medium/high reasoning；
- preview-bound confirmation、单次 write、idempotency 和 unknown-result handling；
- exact GPS 与健康偏好最小化，敏感结果不进入普通日志或持久化 snapshot。

V2.6 gate：

- false condition 不触发不相关的下游 API 或费用；Calendar 只在初步方案可行且用户要求
  查询／安排时读取，方案本身不会因为尚未检查日历而被提前放弃；
- independent read nodes 确实并发，dependent/write nodes 不越过顺序；
- unknown tool、cycle、任意表达式和无 preview write 全部 fail closed；
- Weather/AQI/Pollen 缺失显示 unknown，不等价于 safe/zero；
- write 未确认执行次数为 0，确认后最多 1 次，timeout 后不自动 replay；
- 输出包含明确 recommendation、关键 tradeoff 与 confidence，而不是 raw data dump；
- 完成本地 fake integration、真实服务 adapter contract、本地 simulator、Linux
  安全检查后，才允许进入新的 Even Hub package。

详细产品原则、状态机、并发边界、fallback 与实施顺序见
[Conditional Task Orchestrator](CONDITIONAL_TASK_ORCHESTRATOR.md)。

### V3 — Ambient Agent Platform

#### V3.0 Multi-provider model router

- `ModelProvider` interface；
- OpenAI provider；
- Anthropic provider；
- config-driven model IDs、timeouts、budgets、fallback；
- task evals 决定默认路由，不凭印象路由。

#### V3.1 Tool and MCP layer

- typed tool registry；
- read/write/high-impact risk classification；
- per-tool allowlist 和 least-privilege credentials；
- MCP 作为 adapter，不让远程 MCP 绕过本地 policy；
- circuit breaker、timeout、result size limit、redaction。

#### V3.2 Session modes

- `CAPTION`、`MEETING`、`COMMAND`、`PRIVATE`、`OFF`；
- `PRIVATE` 必须实际关闭 microphone；
- per-mode retention 和 tool policy；
- session rotation 对用户透明。

#### V3.3 Ambient reliability

- iOS/Android 分开做 4 h、8 h soak；
- lock/background/memory pressure/relaunch；
- G2/phone battery 和 thermal；
- network/session rotation；
- SDK/host 恢复能力验证。

V3 gate：

- V3.0–V3.2 可以在主动会话可靠时发布；
- “ambient/all-day” 标签只有 V3.3 真机 gate 通过后才能使用；
- high-impact 工具必须在执行前获得即时、明确、可审计确认；
- provider 或 MCP 故障不能造成重复副作用或静默降权。

## 8. 数据模型增量

除原 blueprint 的 tables 外，增加：

```text
transcript_turns
  id, session_id, provider_item_id, turn_seq, text, final, timestamps

commands
  id, session_id, source_turn_ids, raw_text, intent_json,
  state, idempotency_key, created_at, expires_at

tool_calls
  id, command_id, tool_name, risk, input_json, preview_json,
  status, idempotency_key, provider, started_at, completed_at

confirmations
  id, command_id, tool_call_id, method, challenge, decision, decided_at

audit_events
  id, session_id, command_id, actor, event, redacted_data_json, created_at
```

任何 secret、OAuth token、Authorization header、raw audio 都不得进入这些表或普通日志。

## 9. 测试与评估

### 自动化

- unit：PCM、resampler、buffer、schema、state machine、reference resolver；
- integration：fake OpenAI WS、fake model provider、fake tools；
- contract：Even client/server protocol、OpenAI adapter event fixtures；
- property tests：任意 chunk boundary 下的 resampling continuity；
- failure tests：断线、乱序、duplicate、timeout、partial database failure；
- security tests：binary before auth、oversized frame、token theft budget、prompt injection、confirmation bypass。

### 人工/真机

- clean/noisy/near/far speech；
- English/Mandarin/code-switch；
- phone foreground/background/locked；
- Wi-Fi ↔ cellular；
- false wake phrase 和旁人说话；
- command cancel、clarification、double confirmation；
- battery/thermal/long session。

每个 release 保存一份 `docs/validation/<version>.md`，记录设备、OS、Even App、SDK、网络、模型配置和结果。

## 10. 风险登记

| 风险 | 概率 | 影响 | 处理 |
|---|---:|---:|---|
| iOS background WebView 被终止 | 高 | 高 | V1 主动会话定位；V3.3 真机 gate；检测 host/SDK 修复 |
| G2/phone battery 不支持长时采集 | 中 | 高 | 30m/1h/2h/4h/8h 分级实测；提供 COMMAND mode |
| ambient speech 误触发写工具 | 中 | 高 | gesture arm + preview + confirmation + audit |
| STT 中英 code-switch 错误 | 中 | 中 | language hints、keywords、真实 fixtures、clarification |
| 模型/事件 API 演进 | 中 | 中 | adapter、contract fixtures、pinned versions、config-driven IDs |
| 重连导致重复写入 | 中 | 高 | command/tool idempotency keys、transactional executor |
| 第三方 MCP 不可信或失控 | 中 | 高 | local policy gate、allowlist、timeouts、redaction、no direct secrets |
| transcript 隐私泄漏 | 低/中 | 高 | text-only opt-in persistence、retention、redacted logs、delete flow |
| 成本失控 | 中 | 中 | single STT session、minute budgets、per-provider caps、usage metrics |

## 11. 首批 backlog（按顺序）

1. ADR-001：冻结 V0/V1 范围和“不承诺 always-on”。
2. Pin 官方 ASR template commit、SDK、Node/npm。
3. 建 npm workspaces、TypeScript、lint/test/CI skeleton。
4. 定义 protocol v1 schemas 和 state machines。
5. 实现 fake STT server + WAV injector。
6. 实现 PCM validation、stateful resampler、chunk buffer 及 property tests。
7. 实现 OpenAI/Soniox 最小 adapter，完成 bilingual bake-off 并冻结默认 provider。
8. 实现 G2 simulator client adapter、HUD reducer 和 render throttle。
9. 部署最小公网 WSS，验证 whitelist/TLS/reconnect。
10. 跑 V1.3 真机 matrix，决定是否进入 V2。

## 12. 开始实施前需要由用户提供/决定的事项

这些不阻塞 V0 的本地骨架，但会在相应 gate 前需要：

- 是否已有 G2，以及配对手机是 iPhone 还是 Android；
- OpenAI API project/key 和预算上限；
- 公网域名/VPS，或是否希望我们再选型；
- transcript 默认 retention：ephemeral、24h、30d 或 persistent；
- V2.5 的默认 list 名称；
- V3 首个外部工具目标（建议先选一个，不并行接多个）；
- Anthropic API 是否需要在 V3.0 接入。

## 13. 参考资料

- [Even 官方 ASR template](https://github.com/even-realities/evenhub-templates/tree/main/asr)
- [Even 官方 SDK reference](https://github.com/even-realities/everything-evenhub/blob/main/plugins/everything-evenhub/skills/sdk-reference/SKILL.md)
- [Even 官方 build/deploy reference](https://github.com/even-realities/everything-evenhub/blob/main/plugins/everything-evenhub/skills/build-and-deploy/SKILL.md)
- [OpenAI Realtime transcription](https://developers.openai.com/api/docs/guides/realtime-transcription)
- [OpenAI GPT-Live-Transcribe model](https://developers.openai.com/api/docs/models/gpt-live-transcribe)
- [Anthropic MCP documentation](https://docs.anthropic.com/en/docs/mcp)
- [Even Hub iOS background lifecycle open issue](https://github.com/even-realities/everything-evenhub/issues/16)

## 14. 当前进度与下一步（2026-09-18）

原 V0/V1 的代码骨架、OpenAI 实时转录、连续对话、模拟器 HUD、公网 WSS、Linux 单机部署、安全加固、自动更新、监控、备份与恢复演练均已完成。Calendar、邮件、搜索和安全确认工具也已提前覆盖部分 V2.5/V3 范围。模拟器到生产 WSS 的中英混合语音及工具链路已经通过人工端到端测试。

当前 source 新增自动一次性定位、Google Places 候选／评分、Routes Matrix
路线比较与简洁推荐。默认驾车，语音或伴随页可切换步行／骑车；近期候选仅在
内存保留十分钟，用于“那走路呢”一类重算并重新请求一次定位。公交仍是后续
独立 gate；天气、空气质量与花粉 adapter 已完成本地 contract 测试，但专用
conditional-task runtime 已退役。正式 gate 仍是
**V1.3 真机验收**，不能因为后端功能较多而跳过。已有 `.ehpk` 是较早的
`0.2.0` 候选，不为每次 source 更新重复打包。接下来的顺序是：

户外、多站点和旅行计划现统一由 Luna `planning` 处理。Google Maps／Routes 的
结构化 read 失败时转入受配额限制的 web research，并明确不把公开资料冒充实时
ETA、实时路况或当前位置。对有明确时间的户外计划，通用 planning loop 会使用一次性
定位，并发读取 Weather／AQI／Pollen；可重试错误最多重试一次，仍失败的项目保持
unknown，再由 Luna 进行受配额限制的公开资料补充。Calendar／Email 继续使用专用服务、确认与回执，
不允许用模型 fallback。历史 DAG 设计与安全测试保留在
[Orchestrator reference](CONDITIONAL_TASK_ORCHESTRATOR.md)。

多站行程写入 Calendar 时采用渐进确认：Luna 先复用当前 topic 已知的出发时间、
地点、已查询车程和活动时长，并可使用 5–10 分钟的可逆衔接缓冲；真正无法推断且
会改变结果的信息每轮只问一个原子信息槽，不能在同一句中同时询问出发地与返回地、
日期与时间或其他两个事实。该规则适用于普通对话和所有 workflow，不只适用于 Calendar。
用户明确要求分别创建，或接受已有分点行程后要求写入 Calendar 时，系统一次规划最多 6 个
事件，但眼镜每次只显示和确认一个；当前项保存后才展示下一项，任何一次“确认”
都不能授权后续项目。

眼镜长内容采用语义分页：编号／项目符号尽量一项一页；单项超过五行时按连续、
不重叠的五行页拆分。Up／Down 每次进入新页，不再用重复两行的滑动窗口。

地点解析遵循“合法候选不按类型硬删除”的原则：Target 门店、Target Mobile、
停车场、药房或公交站都可能是用户真实目的地。只有候选用途不同时才由 Luna
基于用户原话做结构化消歧；已明确则筛选对应类型，未明确则只问一个简短问题，
用户回答后重新进行一次性定位与查询。坐标不会进入 Luna。

Calendar 相对时间不再使用固定芝加哥时区：Google Time Zone API 是当前位置到
IANA 时区的首选权威来源。可重试失败经过最多三次有界尝试后，Luna fallback 只看
本 session 的有界上下文和手机验证过的 IANA 时区提示，不接收坐标、工具或 web
search；它必须返回严格结构化时区，或在证据冲突／不足时一次只追问当前城市／地区。
目的地和未来行程城市不能覆盖当前所在地。任何 fallback 都不降低 Calendar 的预览、
冲突检查和用户确认要求。

Calendar planner 采用严格 JSON Schema 加后端语义校验，等价于 Pydantic 风格的
固定输入／输出边界。日期、时间顺序、DST 偏移、候选编号、重复规则或多段行程顺序
校验失败时，只把受控的修复原因交回 Luna，最多三次规划尝试；不再把内部错误码直接
显示给用户。待确认草稿的 notes／时间／地点／标题补充必须修改同一草稿并重新预览。
这项 retry 只覆盖无副作用的 planning：Google Calendar 写入结果未知、冲突或失败时
不得自动重放，仍须核对远端状态，避免重复创建。

1. 完成开发者本地 build/test/security scan，再由用户在本地 simulator 验收附近地点比较、评分建议、交通方式切换、定位三次重试、权限提示和手动地址 fallback；
2. 只有本地验收通过后，配置受限 Maps key，部署 Linux server-only release 并做 live route test；
3. Linux 部署后完成端口、TLS/WSS、Origin/token、Secret 权限、service sandbox、Maps key/API/IP 限制和无坐标日志的 security check；
4. 完成其他区域／网络／失败测试，再统一生成一个新的 `.ehpk` 并上传 Private Testing；
5. 核对 packaged WebView Origin，在 G2/R1 上完成权限、语音、手势、退出重连、网络切换与 30m/1h/2h 测试；
6. 进入 Beta，完成 5 分钟锁屏与后台 reviewer-parity 测试；通过 V1 gate 后，再扩展长期上下文／显式记忆等 V2 能力。

发布边界：当前 Private Testing 包固定连接个人后端，只适合本人安装。公开源码的自建用户必须使用自己的域名、精确 network whitelist、访问 token 和后端凭据重新构建；在平台没有可审核的用户自定义 endpoint 方案之前，不能把连接维护者个人服务器的通用二进制发布给公众，也不能用 wildcard Origin／whitelist 绕过限制。手机文字输入、动态收件人和定位的详细安全设计见 [伴随输入、定位与安全分发](COMPANION_INPUT_LOCATION_AND_DISTRIBUTION.md)。

具体操作与记录模板见 [Even Hub 打包与 Private Testing](EVEN_HUB_PACKAGING.md) 和 [发布准备清单](RELEASE_READINESS.md)。
