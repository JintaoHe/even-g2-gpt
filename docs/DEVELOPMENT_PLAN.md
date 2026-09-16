# Even G2 Agent — Development Plan

> **近期交付范围已确认：** 优先完成 [Conversation MVP](./CONVERSATION_MVP.md)：手动启动、自动轮次判断、多轮文字对话、插话，以及基于意图的结束会话与系统确认退出。MD 文件生成/发送等工具在该版验收后再加入。该文优先于下文冲突的近期交互安排；[本地实验版](./CONVERSATION_LAB.md) 已实现部分能力并通过小样本真实 API 验证，G2/R1 与完整体验待验收。

> **最新决策（覆盖下文旧选型内容）：** STT 固定 OpenAI `gpt-live-transcribe`，取消 Soniox bake-off。已经实现单 turn 的本地转写 POC，参见 [POC.md](./POC.md)。后续依次完成真实 API 验证、Even simulator/真机接入和意图理解。下文中多 STT 比较步骤不再适用。

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
- client 与 server state machine tests。

#### V1.3 Real G2

- Wi-Fi/cellular/network switch；
- English/Mandarin/code-switch；
- 30 min、1 h、2 h battery/lifecycle test；
- foreground/background/lock/unlock；
- 两小时 server soak。

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

## 14. 下一步

下一次工作从 **V0 + backlog 1–3** 开始：记录 ADR、pin 上游版本、建立 monorepo 和测试骨架。除非用户明确要求，本阶段不创建 VPS、不提交任何 API key，也不接入外部写工具。
