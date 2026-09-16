# 本地连续对话实验版

此版本是 Conversation MVP 的第一阶段实现，不是已完成的 G2 应用。原有 `npm start` 单轮转录 POC 保持不变；新入口单独使用 3001 端口。

## 当前默认：GPT-5.6 Luna

意图与回答默认均为 `gpt-5.6-luna`，显式设置 reasoning=none。STT 不变。同组回归 Luna 31/33、4.1 mini 30/33；四轮首字中位数 1.85s vs 1.59s。作为个人使用试运行默认，完整限制与回退见 [LUNA_EVAL.md](LUNA_EVAL.md)。下文 4.1 mini 搜索费用为历史基线，不是 Luna 的账单保证。

## 新增：OpenAI 内置联网搜索

用户已确认优先接入只读搜索，不等 G2/R1 完整验收。回答阶段提供 `web_search`，意图/退出判断阶段不提供工具。模型按问题决定是否调用：普通问候不必搜索，新闻、股价和明确查询请求应搜索。无需额外搜索服务 key，沿用服务器端 OpenAI key。

- 页面显示搜索状态；完成后在回答内显示可点击引用，并附来源列表。引用来自 API annotations，不把网页内容当 HTML 执行。
- 插话会取消在途请求，隔离迟到的搜索状态与来源。已发生的 API/搜索费用不会因此撤销。
- 默认每次回答最多 2 次内置工具调用；新增每日 20 次、每个自然月 600 次搜索上限，按 `CONVERSATION_TIMEZONE`（默认芝加哥）结算。剩余 1 次时只向 API 授权 1 次。普通聊天不占搜索次数；达到上限仍可聊天，但不再提供联网工具。不会自动重试失败请求。
- 用量预扣并持久保存于 `.local/search-usage.json`，成功完成后按实际 `web_search_call` 数量退回未用额度。中断、故障或重启导致无法确认用量时保留预扣（可能多计，但不乐观放行）；文件损坏或不可写时停用搜索。不要删除或手动改动账本。自然月满 600 次即停止搜索，即使该月有 31 天。
- 这是本项目单进程应用限额，不是 OpenAI 账户消费硬上限；普通聊天和 STT 另计。Linux 部署要保留账本到持久卷；多实例需改用事务数据库，不能共享此文件并发运行。真实搜索回归也使用此账本，因此不要与服务同时运行；普通对话回归禁用搜索。
- 会给模型当前时间与用户时区，要求核实涨跌前提、标明行情日期/时间与交易时段、区分事实和推测。搜索不是专用实时行情保障，也不保证模型事实判断永远正确。
- 查询内容会通过 OpenAI 搜索服务处理；指令要求查询时避免带入不相关的私人信息，但这不是独立的数据脱敏器。暂不接交易、日历修改或文件发送。

可选 `.env` 设置（改后重启）：

```dotenv
OPENAI_WEB_SEARCH=true
OPENAI_MAX_SEARCH_CALLS=2
CONVERSATION_TIMEZONE=America/Chicago
```

设置 `OPENAI_WEB_SEARCH=false` 可禁用。调用上限接受 1–5。不存在配置时使用以上默认值，不需要重写已有 `.env`。

### 搜索费用估算

按本次核对的官方标准价：搜索 $10/1000 次；`gpt-4.1-mini` 非 preview 搜索每次固定计 8000 个搜索内容输入 token，该模型输入价 $0.40/百万 token。所以搜索调用费＋搜索内容输入约为 `$0.01 + 8000/1000000 × $0.40 = $0.0132/次`。

- 每月 100 次：约 $1.32。
- 每天 20 次、30 天：约 $7.92。
- 以上不含普通提示词/历史、回答、意图判断、语音转写费用及税费；一个问题可能调用多次搜索。不是账户账单或最高费用保证。
- 默认模型不变，换模型后重新核算。API key 是访问凭证，计费对象是实际使用；没有额外购买“搜索 key”。

来源：[官方价格](https://developers.openai.com/api/docs/pricing)、[GPT-4.1 Mini](https://developers.openai.com/api/docs/models/gpt-4.1-mini)、[Web search](https://developers.openai.com/api/docs/guides/tools-web-search)。

## 启动

使用现有 `.env` 中的 `OPENAI_API_KEY` 和 `G2_CLIENT_TOKEN`。这里的 client token 是我们自己的本地访问密码，不需要收到眼镜后才能取得；不要把 OpenAI key 输入浏览器。

这台 Windows 的启动方式（避开系统旧 Node 和 NODE_OPTIONS 问题）：

```powershell
Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
$conversationNode = (Get-Command node.exe).Source # Node 24+
Set-Location 'C:\path\to\even-g2-gpt'
& $conversationNode --use-system-ca --import tsx src/conversation-server.ts
```

使用受支持的 Node 22+ 环境时也可以 `npm run conversation`。浏览器打开 <http://127.0.0.1:3001>，填入本机 `.env` 中的 **G2_CLIENT_TOKEN** 后连接。

1. 可以先发送文字测试问答、追问、否定和退出。
2. 点击“开启麦克风 / 恢复语音”，允许本地页面使用麦克风，然后正常说话。需要支持 AudioWorklet 和 16 kHz AudioContext 的浏览器；推荐先用桌面 Chrome/Edge 测试。
3. 约 1.2 秒安静后提交该语音段，模型再判断语义是否完整。未完成的句子保留，下一段到达后合并。
4. 回答逐步显示。再次开口会打断旧回答；“我说完了”可手动提交，“继续上一答”可恢复被噪声误打断的话题。
5. “退下吧”等直接退出意图会停止收音并弹出模拟确认框。取消退出后保持暂停，需要显式恢复。

## 结构与隐私

- 浏览器电脑麦克风 → AudioWorklet PCM16/16 kHz → 本地认证 WebSocket。
- 本地能量门限与静音计时 → 保留约 300 ms 前置音频 → 单语音段的实时转录连接 → 服务端重采样至 24 kHz → OpenAI。
- 稳定转录结果按采集顺序合并；临时 delta 只显示，不用于退出操作。
- Responses API：先用受约束的 JSON 输出判断 respond/wait/exit/clarify_exit，再流式生成文本回答。
- STT 默认 `gpt-live-transcribe`。意图与回答已拆开：`OPENAI_INTENT_MODEL` 和 `OPENAI_REPLY_MODEL` 分别配置；未设置时各自回退到旧的 `OPENAI_DIALOGUE_MODEL`，再回退到 `gpt-4.1-mini`。连接后页面显示实际模型。实验混合模式将回答设为 `gpt-5-nano`，使用 low reasoning、3072 输出 token（含推理）及名字保留指令；意图仍用 4.1 mini，且不提供搜索工具。没有自动切换到更贵模型或自动重试。
- nano 混合模式未达标，仍为实验。后续双 Luna 对照达到小样本质量基线，已成为当前默认。`npm run luna:eval` / `npm run baseline:eval` 为付费对照回归，先停止服务。实际省费幅度尚未验证。
- OpenAI key 不下发客户端；Responses 请求设置 `store:false`。这不等于承诺服务商零保留，服务商数据政策仍适用。
- 不落盘音频。已提交的用户文字、回答及部分被打断的回答保存在 `.local/conversations/<随机会话ID>.json`，已加入 gitignore；本机明文存储，未做应用层加密或跨设备同步。
- 本地服务仅监听 127.0.0.1，限制 Origin/Host，客户端需要 token，单个已认证会话；不是公网部署方案。
- 同一连接内保留上下文；重新连接开启新会话。磁盘记录尚未接入自动恢复或历史摘要。

## 当前限制与后续

- 这是能量检测基线，不是训练过的语音/说话人识别器：背景谈话、风声或噪声可能误触发，也可能漏掉很轻的声音。
- 当前疑似插话达到门限后即取消旧生成，并提供显式“继续上一答”；尚未实现先暂挂、确定不是噪声后再取消的两阶段恢复。
- 语义判断本身有延迟且可能误判。第一轮真实样例中单次意图判断约 0.6–3.4 秒，不是延迟保证；还需加转录结束与回答首字延迟。后续需要实测并优化，不能把“1.2 秒停顿”当成总响应时间。
- 单语音段约 60 秒强制切分；会话 30 分钟上限、历史约 100 条消息上限、空闲 3 分钟暂停。上限是实验保护措施，不是 G2 平台限制。
- 隐藏浏览器页面即暂停，不测试手机后台保活。浏览器权限、暂停或断线会关闭麦克风轨道。
- 暂停可丢弃未提交的在途音频；只有已提交的对话进入保存记录。明确暂停优先于自动补交。
- G2 SDK、R1 手势、官方退出确认框、原生应用切换、手机锁屏、断线恢复和长历史摘要尚未实现/验收。
- 除只读联网搜索外，没有日历、文件发送、列表写入等工具。模型指令明确禁止声称已经执行这些操作。

## 验证

离线测试，不调用付费 API：

```powershell
& $conversationNode node_modules/typescript/bin/tsc --noEmit
& $conversationNode --import tsx --test tests/*.test.ts
```

显式真实 API 回归（有少量费用）：

```powershell
& $conversationNode --use-system-ca --import tsx tests/live-conversation.ts
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
- [Structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [Streaming responses](https://developers.openai.com/api/docs/guides/streaming-responses)
- [Web search](https://developers.openai.com/api/docs/guides/tools-web-search)

搜索真实接口回归可运行 `npm run search:eval`（有 API 费用）。

## 下一步验收建议

先在安静环境试 10 轮中英混说，记录是否抢话、第一字延迟、噪声误打断和退出误判。之后再接 G2/R1，不能把桌面结果直接当成眼镜体验验收。
