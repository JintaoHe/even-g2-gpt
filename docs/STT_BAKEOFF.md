# Live STT & Bilingual Intent Bake-off

> **已取消/仅供历史参考。** 用户已明确确定 OpenAI，不做 Soniox 或其他 STT 对照。下面的选型与实验步骤不再执行。中文、英文、混说准确率仍需测试；当前入口见 [POC.md](./POC.md)。

**目的：** 为 Even G2 的中英实时字幕和命令理解选择默认 STT provider。
**原则：** 不用厂商宣传替代我们的 G2/用户声音实测。

## 1. 先区分三个概念

### 传输延迟

G2 到我们的 server 永远发送原生 PCM s16le / 16 kHz / mono：

```text
16,000 samples/s × 2 bytes = 32 KB/s
```

如果 provider 要求 24 kHz，只在 server 内流式升采样，再发送给 provider。24 kHz PCM 是 48 KB/s；即使 JSON/Base64 后也不是普通宽带的吞吐瓶颈。

### 音频处理延迟

正确的 stateful streaming resampler 一边收到 chunk 一边输出，不需要等待整句，也不应额外积攒 60 ms。一次本机 Node 参考测试中，线性 16→24 kHz 转换一个 60 ms chunk 的平均 CPU 时间约为 **0.011 ms**；这只是开发机测量，不是生产 SLA，但足以说明 resampling 与几十到几百毫秒的 provider/VAD 延迟不在同一量级。

真正要优化的是：

```text
client queue
+ server aggregation window
+ provider first-partial latency
+ end-of-turn/finalization latency
+ HUD render debounce
```

### 意图延迟与正确率

字幕 partial 可以立刻显示，但任何命令和副作用只使用 final/committed turn。STT 输出再经过 typed bilingual intent parser；不能把 STT 文本准确率当成意图正确率。

## 2. Provider pipeline

```text
G2 16 kHz PCM
      │
      ▼
server native audio bus
      ├── provider accepts 16 kHz → binary pass-through
      └── provider requires 24 kHz → stateful streaming resampler
```

统一接口：

```ts
type AudioFormat = {
  encoding: "pcm_s16le"
  sampleRate: 16000 | 24000
  channels: 1
}

interface Transcriber {
  readonly inputFormat: AudioFormat
  start(config: TranscriptionConfig): Promise<void>
  pushPcm(chunk: Uint8Array, capturedAt: number): void
  commit(): void
  close(): Promise<void>
}
```

Client 不知道 provider，也不做重采样。

## 3. 首轮候选

| Candidate | Native input | 中英混说依据 | 结论 |
|---|---|---|---|
| OpenAI `gpt-live-transcribe` | 24 kHz PCM | 官方支持多个 language hints 和 code-switch；需 16→24 kHz | 对照组 |
| Soniox `stt-rt-v5` | 16 kHz PCM16 | 官方说明统一模型支持 60+ languages、同一句混合语言；可传 `en`,`zh` hints | 首选非 GPT 候选 |
| AssemblyAI `whisper-rt` | 16 kHz | 99+ languages，含 Chinese/English，自动 language detection | 第二备选 |
| Deepgram Nova-3 | 16 kHz | 中文单语可用，但当前 `language=multi`/Flux multilingual 的集合不包含中文 | 不进入首轮中英 bake-off |
| Self-hosted faster-whisper | 16 kHz | 多语言；需 streaming wrapper 和 GPU | 隐私/可控性 track，不预设更快 |

首轮只实现 OpenAI 与 Soniox 两个小 adapter，避免同时维护五套集成。如果两者都不达标，再引入 AssemblyAI Whisper Streaming 或 self-hosted GPU 方案。

## 4. 测试语料

### V0 最小集

至少 60 条由目标用户本人录制的命令：

- 10 条普通话；
- 10 条英文；
- 20 条句内中英 code-switch；
- 10 条技术名词、姓名、数字、日期；
- 10 条易混淆/否定/取消命令。

每条至少录 quiet 和 background-speech 两种条件，共 120 clips。不得使用厂商训练/演示语料作为唯一判断依据。

命令示例类型：

```text
Even，把 deployment date update 到 next Friday。
Even, remember 我下周三要 call Alice。
Even，把刚才那个 API endpoint add to my launch list。
Even, don't add that; cancel it.
```

### V1 release 集

扩展到至少 200 个独立 utterances，并加入：

- G2 真机 microphone；
- 近讲/远讲；
- cafe/TV/步行环境；
- 连续对话中的 false wake phrase；
- Wi-Fi 与 cellular。

## 5. 指标

### STT

- Mandarin CER；
- English WER；
- mixed utterance normalized error rate；
- technical term exact match；
- number/date/entity exact match；
- partial revision rate；
- empty/truncated final rate。

### Intent

- intent exact match；
- critical slot exact match（memory content、list、date、negation）；
- clarification-required accuracy；
- false activation rate；
- unsafe action rate。

最低 gate：

- bilingual command intent exact match ≥ 95%；
- critical slots exact match ≥ 97%；
- 明确的 negation/cancel 召回率 = 100%；
- 测试集中的未经确认写操作 = 0；
- ambient negative set 中 false write activation = 0。

如果达不到 gate，优先增加 clarification，而不是让模型猜。

### Latency

在每个 audio frame 上携带本地 monotonic capture timestamp，记录：

```text
t0 capture at client
t1 server receive
t2 provider send
t3 first non-empty partial
t4 speech end
t5 final transcript
t6 HUD receive
t7 HUD render request
```

派生：

- `client_to_server_ms = t1 - t0`；
- `server_audio_processing_ms = t2 - t1`；
- `provider_first_partial_ms = t3 - t2`；
- `end_to_final_ms = t5 - t4`；
- `first_visible_ms = t7 - t0`。

V0 server-only 目标：

- server audio processing p95 < 2 ms/chunk；
- resampler 不增加人为 buffering；
- provider first partial 和 end-to-final 分 provider 报 p50/p95/p99；
- 稳态无 unbounded queue。

V1 真机 first-visible 目标仍为 p50 < 1 s、p95 < 2 s，但最终阈值由真实 G2 基线重定。

## 6. 公平实验规则

- 使用完全相同的 PCM fixture 和发送节奏；
- 相同语言 hints：`en` + `zh`/`zh-cn`；
- 相同 domain terms；
- 每个 clip 至少重复 3 次；
- 冷连接与 warm session 分开统计；
- partial latency、final latency、accuracy 分开排名；
- provider 报错、限流和断线也计入结果；
- 保存原始事件 timing，但默认不把 transcript 写入普通日志。

选择权重：

```text
intent/slot correctness  40%
latency                  30%
stability                15%
privacy/security          5%
cost                      5%
integration complexity    5%
```

任何 provider 只要出现 confirmation bypass 或重复副作用，直接淘汰；这类问题不能用平均分抵消。

## 7. 关于“最快”的可承诺范围

无法在开发前保证某个云 provider 永远最快。我们能保证的是：

- client 使用 G2 原生 16 kHz，不做多余转换；
- server pipeline 无阻塞、bounded queue、无额外 resample wait；
- 对关键阶段做 monotonic timestamp telemetry；
- 用目标用户和真机数据选择 p95/p99 最优方案；
- provider adapter 可切换，不把项目锁死在 GPT；
- 如需掌控外部排队和数据路径，再评估同区域自托管 GPU，但必须用相同测试集证明它更快。

## 8. 官方参考

- [OpenAI Realtime transcription](https://developers.openai.com/api/docs/guides/realtime-transcription)
- [Soniox realtime STT and native 16 kHz example](https://soniox.com/docs/stt/rt/real-time-transcription)
- [Soniox multilingual language hints](https://soniox.com/docs/stt/concepts/language-hints)
- [Soniox language identification](https://soniox.com/docs/stt/concepts/language-identification)
- [AssemblyAI Whisper Streaming](https://www.assemblyai.com/docs/universal-streaming/multilingual-transcription)
- [Deepgram model/language matrix](https://developers.deepgram.com/docs/models-languages-overview)
- [faster-whisper](https://github.com/SYSTRAN/faster-whisper)
