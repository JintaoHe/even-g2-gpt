# OpenAI transcription POC

用户已确定只使用 OpenAI，取消 Soniox 对照实验。本决策优先于旧计划中的 provider bake-off。

当前实现：WAV（16 kHz PCM16 mono）→ 本地认证 WebSocket → 有状态 24 kHz 重采样 → OpenAI Realtime → delta/final → 终端。

## 运行

建议 Node.js 22 LTS 或更新的受支持 LTS。当前开发机 Node 19 已过期，应在正式开发前升级。

这台电脑已经有随应用提供的 Node 24。旧版 npm.cmd 可能继续调用它旁边的 Node 19，即使调整 PATH 也不能保证使用 Node 24。因此在两个 PowerShell 终端分别执行：

```powershell
Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
$pocNode = (Get-Command node.exe).Source # Node 24+
Set-Location 'C:\path\to\even-g2-gpt'
& $pocNode --version
```

```powershell
# 已安装依赖时可跳过安装；显式传入证书选项，避免污染旧 Node 子进程。
& $pocNode --use-system-ca 'C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js' ci --ignore-scripts
if (!(Test-Path .env)) { Copy-Item .env.example .env }
& $pocNode -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

将生成的 token 写入 `.env` 的 `G2_CLIENT_TOKEN`，并在同一文件配置 `OPENAI_API_KEY`。密钥只供本地服务端读取，不要提交或粘贴到聊天。

终端一：

```powershell
& $pocNode --use-system-ca --import tsx src/server.ts
```

终端二：

```powershell
& $pocNode --use-system-ca --import tsx src/inject.ts 'C:\path\mixed-language.wav'
```

如已有 FFmpeg，可将自己的录音转换成输入格式：

```powershell
ffmpeg -i original.wav -ar 16000 -ac 1 -c:a pcm_s16le mixed-language.wav
```

录音建议：“Even，把 deployment date update 到 next Friday。不要删除原来的备注。”实际转写内容会打印到终端，但服务端不记录音频或 transcript。

## 验证

```powershell
& $pocNode node_modules/typescript/bin/tsc --noEmit
& $pocNode --import tsx --test tests/poc.test.ts
```

测试覆盖 chunk 边界、时长、WAV 验证、认证、协议拒绝和真实 WebSocket 的模拟 OpenAI 链路。Mock 返回固定文字，仅证明软件接线，不证明语音识别质量。

## POC 边界

- 每个连接只处理一个手动提交的 turn；完成后重新连接开始下一次。
- 单 active transcription、最多 120 秒音频、连接最多五分钟；无自动重试以免重复计费。
- 仅监听 127.0.0.1；没有公网部署或 TLS，不能直接暴露到互联网。
- 等 OpenAI `session.updated` 才允许发送音频。
- 每约 60 ms 聚合后发送；关闭时 flush 尾部，再 commit。
- 本 POC 验证实时转写；语义意图理解、工具执行、G2 SDK/HUD、VAD、持久化和后台生命周期属于下一阶段。
- 未配置 API key 时不能验证真实 API 账户权限、模型可用性、识别效果与端到端延迟。

下一步：用户录音的真实 OpenAI smoke test → 接 Even 官方 ASR template/simulator → 真机采集和 HUD → 意图解析。

## 本次验证记录

- Node 24.19.0：TypeScript 检查通过。
- 三组自动测试通过（音频边界和时长、WAV 校验、WebSocket 端到端与错误路径）。
- `npm install` 审计：0 vulnerabilities。
- 环境未提供 `OPENAI_API_KEY`，未调用付费 API，未验证实际识别质量。
- 没有连接 G2 或运行 Even simulator；这部分不属于已通过测试的范围。
