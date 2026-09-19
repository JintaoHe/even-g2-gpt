# 本地连续对话实验版

本指南介绍本地网页测试入口，不代表真实 G2 已验收。原有 `npm start` 单轮转录 POC 保持不变；连续对话使用 3001 端口。完整功能入口见 [项目首页](../README.md) 和 [文档索引](README.md)；下方费用、模型对照及早期测试数字是历史记录。

## 当前默认：GPT-5.6 Luna

当前示例配置的意图与回答均为 `gpt-5.6-luna`：意图判断使用 medium，回答按每轮上下文选择 low / medium / high，见 [自适应推理](ADAPTIVE_REASONING.md)。STT 默认使用 Soniox `stt-rt-v5`；早期固定档位对照及回退见 [LUNA_EVAL.md](LUNA_EVAL.md)；下文 4.1 mini 搜索费用为历史基线，不是当前账单保证。

## 新增：OpenAI 内置联网搜索

用户已确认优先接入只读搜索，不等 G2/R1 完整验收。回答阶段提供 `web_search`，意图/退出判断阶段不提供工具。模型按问题决定是否调用：普通问候不必搜索，新闻、股价和明确查询请求应搜索。无需额外搜索服务 key，沿用服务器端 OpenAI key。

- 页面显示搜索状态；完成后在回答内显示可点击引用，并附来源列表。引用来自 API annotations，不把网页内容当 HTML 执行。
- 插话会取消在途请求，隔离迟到的搜索状态与来源。已发生的 API/搜索费用不会因此撤销。
- 默认每次回答最多 10 次、每个 30 分钟会话最多 50 次、每日 100 次、每个自然月 1200 次搜索调用，按 `CONVERSATION_TIMEZONE`（默认芝加哥）结算。剩余额度不足时只向 API 授权剩余次数。普通聊天不占搜索次数；达到任一上限仍可聊天，但不再提供联网工具。
- 用量预扣并持久保存于 `.local/search-usage.json`，成功完成后按实际 `web_search_call` 数量退回未用额度。中断、故障或重启导致无法确认用量时保留预扣（可能多计，但不乐观放行）；文件损坏或不可写时停用搜索。不要删除或手动改动账本。会话额度随新认证会话重置，日／月账本不会因此重置。
- 这是本项目单进程的工具次数保护，不是美元硬上限；普通聊天、意图判断、STT、文档生成和 Maps 另计。OpenAI 项目应在平台 **Limits → Spend** 另设 `$40/月` 并开启 **Enforce a hard limit**。官方说明硬限制达到后返回 429，但传播不是瞬时的，因此账单仍可能轻微超过设置值。Linux 部署要保留账本到持久卷；多实例需改用事务数据库，不能共享此文件并发运行。
- 会给模型当前时间与用户时区，要求核实涨跌前提、标明行情日期/时间与交易时段、区分事实和推测。搜索不是专用实时行情保障，也不保证模型事实判断永远正确。
- 查询内容会通过 OpenAI 搜索服务处理；指令要求查询时避免带入不相关的私人信息，但这不是独立的数据脱敏器。搜索工具本身只读；日历修改和文件发送由独立的确认流程处理，不接交易。

可选 `.env` 设置（改后重启）：

```dotenv
OPENAI_WEB_SEARCH=true
OPENAI_MAX_SEARCH_CALLS=10
OPENAI_SEARCH_SESSION_LIMIT=50
OPENAI_SEARCH_DAILY_LIMIT=100
OPENAI_SEARCH_MONTHLY_LIMIT=1200
CONVERSATION_TIMEZONE=America/Chicago
```

设置 `OPENAI_WEB_SEARCH=false` 可禁用。每回答调用上限接受 1–10，且必须不大于会话／日／月上限。不存在配置时使用以上默认值；已有 `.env` 中的旧值会覆盖新默认，需要人工核对但不要覆盖其他凭据。

### 搜索费用估算

截至 2026-09-18 核对的标准价：Luna 输入 `$0.20/百万 token`、输出 `$1.20/百万 token`；web search 工具调用 `$10/1000 次`，搜索内容 token 仍按所用模型计费。以下 `$0.017/分钟` 的转录数字是旧 OpenAI STT 基线，**不代表当前 Soniox 价格，也不受 OpenAI project 的 `$40` 限制**；Soniox 必须在其控制台单独设置用量／账单保护。

- 100 次搜索的工具费约 `$1`；1200 次月上限的工具费约 `$12`，均未含搜索内容及回答 token。
- 每天使用麦克风 30 分钟、30 天，单转录约 `$15.30`；每天 1 小时约 `$30.60`。
- 连续 24 小时一次的转录约 `$24.48`；若 30 天每天 24 小时，单转录理论值约 `$734.40`，尚未算对话／搜索。`$40` 项目硬限制会提前中断 API，而不会让这种极端使用继续一个月。
- 仅按转录估算，`$40` 约覆盖 2353 分钟（约 39.2 小时）；实际可用时长更短，因为对话、意图、搜索和文档也计费。这不是账单保证。
- API key 是访问凭证，不是预付搜索套餐。Google Maps 和 AWS 费用也不受 OpenAI `$40` 限制。

来源：[OpenAI 官方价格](https://developers.openai.com/api/docs/pricing)、[GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna)、[Web search](https://developers.openai.com/api/docs/guides/tools-web-search)、[Spend limits](https://developers.openai.com/api/docs/guides/spend-limits)。

## 启动

使用现有 `.env` 中的 `OPENAI_API_KEY`、`SONIOX_API_KEY` 和 `G2_CLIENT_TOKEN`。这里的 client token 是我们自己的本地访问密码，不需要收到眼镜后才能取得；不要把任何 provider key 输入浏览器。

这台 Windows 的启动方式（避开系统旧 Node 和 NODE_OPTIONS 问题）：

```powershell
Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
$conversationNode = (Get-Command node.exe).Source # Node 24+
Set-Location 'C:\path\to\even-g2-gpt'
& $conversationNode --use-system-ca --import tsx src/conversation-server.ts
```

使用 Node 24+ 环境时也可以 `npm run conversation`。浏览器打开 <http://127.0.0.1:3001>，填入本机 `.env` 中的 **G2_CLIENT_TOKEN** 后连接。

1. 可以先发送文字测试问答、追问、否定和退出。
2. 点击“开启麦克风 / 恢复语音”，允许本地页面使用麦克风，然后正常说话。需要支持 AudioWorklet 和 16 kHz AudioContext 的浏览器；推荐先用桌面 Chrome/Edge 测试。
3. 约 1.2 秒安静后提交该语音段，模型再判断语义是否完整。未完成的句子保留，下一段到达后合并。
4. 回答逐步显示。再次开口会打断旧回答；“我说完了”可手动提交，“继续上一答”可恢复被噪声误打断的话题。
5. “退下吧”等直接退出意图会停止收音并弹出模拟确认框。取消退出后保持暂停，需要显式恢复。

## 结构与隐私

- 浏览器电脑麦克风 → AudioWorklet PCM16/16 kHz → 本地认证 WebSocket。
- 本地能量门限与静音计时 → 保留 800 ms 触发前音频（含 160 ms 起音确认）→ 单语音段实时转录连接 → 原生 PCM16/16 kHz 直接发送 Soniox。回放已采集缓冲，不额外等待 800 ms；麦克风未开启时的声音无法补回。
- 稳定转录结果按采集顺序合并；临时 delta 只显示，不用于退出操作。
- Responses API：先用受约束的 JSON 输出判断 respond/wait/exit/clarify_exit，再流式生成文本回答。
- STT 默认 Soniox `stt-rt-v5`，使用 `en`/`zh` hints 与自动语言识别，但不做严格语言限制；OpenAI `gpt-live-transcribe` adapter 仅作为 `STT_PROVIDER=openai` 的回退。意图与回答由 `OPENAI_INTENT_MODEL` 和 `OPENAI_REPLY_MODEL` 分别配置；连接后页面显示对话模型与 STT provider。
- nano 混合模式未达标，仍为实验。后续双 Luna 对照达到小样本质量基线，已成为当前默认。`npm run luna:eval` / `npm run baseline:eval` 为付费对照回归，先停止服务。实际省费幅度尚未验证。
- OpenAI key 不下发客户端；Responses 请求设置 `store:false`。这不等于承诺服务商零保留，服务商数据政策仍适用。
- 不落盘音频。已提交的用户文字、回答及部分被打断的回答保存在 `.local/conversations/<随机会话ID>.json`，已加入 gitignore；本机明文存储，未做应用层加密或跨设备同步。
- 本地服务仅监听 127.0.0.1，限制 Origin/Host，客户端需要 token，单个已认证会话；不是公网部署方案。
- 同一连接内把完整、受消息数上限约束的 session 历史作为 Luna 的短期记忆；topic 标记帮助它区分当前与较早讨论，因此可以回到“之前的 idea／第几点／刚才推荐的店”。生成 MD／Email 时后端仍只提供当前 topic，避免把旅行和 business 文档混在一起。重新连接开启新会话；磁盘记录尚未接入自动恢复或历史摘要，因此这不是跨 session 的永久 memory。

## 当前限制与后续

- 这是能量检测基线，不是训练过的语音/说话人识别器：背景谈话、风声或噪声可能误触发，也可能漏掉很轻的声音。
- 当前疑似插话达到门限后即取消旧生成，并提供显式“继续上一答”；尚未实现先暂挂、确定不是噪声后再取消的两阶段恢复。
- 语义判断本身有延迟且可能误判。第一轮真实样例中单次意图判断约 0.6–3.4 秒，不是延迟保证；还需加转录结束与回答首字延迟。后续需要实测并优化，不能把“1.2 秒停顿”当成总响应时间。
- 单语音段约 60 秒强制切分；会话 30 分钟上限、历史约 100 条消息上限、空闲 3 分钟暂停。上限是实验保护措施，不是 G2 平台限制。
- 隐藏浏览器页面即暂停，不测试手机后台保活。浏览器权限、暂停或断线会关闭麦克风轨道。
- 暂停可丢弃未提交的在途音频；只有已提交的对话进入保存记录。明确暂停优先于自动补交。
- Even SDK 与模拟器已接通，包含分页、语音适配和退出后重连恢复；真实 R1 手势、系统确认、原生应用切换与手机锁屏仍需真机验收，长历史摘要尚未完成。
- 日历查询与确认写入、MD 生成与确认发送已接入，分别见 [Calendar 指南](google-calendar.md) 和 [邮件指南](EMAIL_DELIVERY.md)。列表写入等规划不能当作已完成工具。

## 验证

离线测试，不调用付费 API：

```powershell
& $conversationNode node_modules/typescript/bin/tsc --noEmit
& $conversationNode --import tsx --test tests/*.test.ts
```

显式真实 API 回归（有少量费用）：

```powershell
& $conversationNode --use-system-ca --import tsx tests/live-conversation.ts
# 单独测试 Soniox（付费，使用本地 16 kHz mono WAV）：
& $conversationNode --use-system-ca --import tsx scripts/soniox-smoke.ts 'tests/Recording.16k.wav'
# 需先启动 3001 对话服务，发送已授权使用的录音：
& $conversationNode --use-system-ca --import tsx src/conversation-inject.ts 'tests/Recording.16k.wav'
```

本次已验证：

- 搜索扩展后 21 项离线测试通过。真实 API：问候未触发搜索；NVDA 查询触发搜索且返回有效引用。只验证链路与引用存在，不代表逐条财经事实已人工复核。

- TypeScript 和浏览器 JS 语法检查通过；离线测试覆盖多轮、取消、乱序转录、暂停、退出、持久化、SSE、认证、音频分段和旧 POC。
- 真实接口：10 条意图样例通过；两轮上下文+流式回答通过；基于上下文的退出确认通过。这是小样本验证，不证明所有自然语言都正确。
- 已有 16.62 秒 WAV：自动分段→真实转录→意图判断→回答链路通过（1 段、1 回答）；没有验证文字与原话逐字一致。
- 浏览器 UI（隔离 mock 实例）：连接、发送文字、显示回答、退出确认、取消后保持暂停通过。电脑麦克风实时采集仍待用户试用，不能用 WAV 注入代替这一项验收。

官方接口参考：

- [Realtime transcription](https://developers.openai.com/api/docs/guides/realtime-transcription)
- [Soniox realtime transcription](https://soniox.com/docs/stt/rt/real-time-transcription)
- [Soniox language hints](https://soniox.com/docs/stt/concepts/language-hints)
- [Structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [Streaming responses](https://developers.openai.com/api/docs/guides/streaming-responses)
- [Web search](https://developers.openai.com/api/docs/guides/tools-web-search)

搜索真实接口回归可运行 `npm run search:eval`（有 API 费用）。

## 下一步验收建议

先在安静环境试 10 轮中英混说，记录是否抢话、第一字延迟、噪声误打断和退出误判。之后再接 G2/R1，不能把桌面结果直接当成眼镜体验验收。
