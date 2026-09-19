# Glass Assistant for Even G2

**简体中文** | [English](README.md)

面向 Even Realities G2 的自建、单用户个人 AI 助手。它可以进行中英文混合语音对话，记住当前会话，在不同话题间思考，联网查资料，比较地点与路线，管理专用 Google Calendar，并通过邮件发送 Markdown 文档。

> **独立社区项目。** 本项目与 Even Realities 没有隶属、背书或官方发布关系。应用暂用名为 **Glass Assistant**，避免把它包装成 Even 官方产品。

[![CI](https://github.com/JintaoHe/even-g2-gpt/actions/workflows/ci.yml/badge.svg)](https://github.com/JintaoHe/even-g2-gpt/actions/workflows/ci.yml)

## 当前状态

当前源码已经通过本地网页和 Even SDK 模拟器验收，覆盖中英文语音、上下文对话、联网研究、路线、Calendar 创建／修改／取消、邮件发送、插话、分页以及退出后重连。单用户 Linux 部署路径、HTTPS/WSS 反向代理、监控、备份和回滚流程也已实现。

最新源码仍需重新部署到 Linux 并完成 live acceptance，之后才会生成下一版 Even Hub 包。**真实 G2/R1 测试和 Even Hub 发布仍未完成。** 本仓库不提供托管的多用户服务。

## 我们想做成怎样的助手

Glass Assistant 的目标是成为个人助手，而不是只会返回数据的机器人：

- **自然交流：** Soniox `stt-rt-v5` 直接处理原生 16 kHz 中英文混说，带 800 ms 触发前缓冲，并支持插话取消。
- **记住当前对话：** 有界的 session 短期上下文可以理解“前面第 2 点”“刚才那个 idea”“你推荐的那家”。它可以暂停行程话题、讨论 business idea，再回到行程，同时不会把两个主题的导出文档混在一起。
- **每轮动态思考：** 当前目标会选择九种认知模式之一：`casual`、`explain`、`research`、`brainstorm`、`decision_support`、`planning`、`deep_reasoning`、`compose` 或 `coaching`；工具 workflow 另行授权。
- **既有能力也有温度：** 助手可以执行任务、一起分析，也可以只是陪用户聊几句。面对感谢、挫折或结束对话时，应先回应情绪，而不是机械地再抛出一张信息收集表。
- **每次只问一个问题：** 真正缺少信息时，每轮只追问一个原子事实或决定，不在眼镜上一次列出长问卷。
- **适合眼镜阅读：** 正在说／最终识别结果和回答采用语义化、不重叠的手动分页；眼镜正文不显示 URL 和内部 metadata，导出内容仍可保留来源。

## 当前能力

| 能力 | 当前行为 |
| --- | --- |
| 语音对话 | Soniox 实时中英文 STT、自动判断一句话结束、流式回答、插话取消、会话退出意图；OpenAI STT 保留为明确的回滚方案 |
| Session 智能 | 向模型提供完整但有界的 session 上下文，并隔离不同主题线程；每一轮重新判断模式和 workflow，不会把整个会话永久锁定成路线或 planning |
| 联网研究 | OpenAI API 搜索，按单次回答／session／日／月持久化计数；收到真实搜索事件后显示进度，不让用户无反馈等待 |
| 地点与路线 | 仅 session 保存的手机位置、Places 候选与评分、考虑路况的 Routes Matrix、驾车／步行／骑行、模糊地点追问，以及临时场地的有界公开资料 fallback |
| 户外信息 | 对有明确时间的户外计划并发获取天气、空气质量和花粉；缺少的数据保持 unknown，不会被当成“安全”或“0” |
| Google Calendar | 查询标题、时间、地点、备注与冲突；创建／修改／取消单次或有限重复事件；一次规划最多六个行程事件，并逐个预览确认 |
| 动态时区 | 首选 Google Time Zone；有界 Luna fallback 不接收坐标，只能返回有效 IANA 时区，或只追问一个地点问题 |
| 文档与邮件 | 根据当前主题生成 Markdown，预览并确认后发给固定收件人；邮件使用可读的主题、摘要和附件名 |
| 可选 CLI 通道 | Codex CLI 继续为偏好 subscription-backed execution 的用户保留，带超时／取消反馈；默认仍使用低延迟 API 通道 |
| 持久化 | 后端保存对话、任务、文档和额度账本；凭证与精确坐标不进入这些记录 |

Calendar 和 Email 是用户私有状态的权威 workflow，不能用模型猜测替代。写入必须经过后端校验、绑定预览的确认、幂等处理和结果回执。Maps、Weather、Air Quality 与 Pollen 属于只读证据，失败时可以使用明确披露且受额度限制的公开资料 fallback。

## 技术结构

```text
Even G2 / R1 或本地模拟器
              |
              | 带认证的 WSS
              v
         自建 Node 后端
       |        |         |
     Soniox   OpenAI   受校验的工具
       STT     Luna     Calendar / Email
                         Maps / Environment
```

- Even 客户端不包含模型、SMTP、Calendar 或 Maps 密钥。
- 生产环境 Node 只监听本机回环，通过 HTTPS/WSS 对外提供服务。
- 每位自建用户都必须使用自己的后端 URL 和精确 network whitelist 重新构建 Hub 包。
- 当前只面向**一个受信任用户**，没有多人账户隔离。

参见[项目结构与部署边界](docs/PROJECT_STRUCTURE.md)和[认知模式／workflow 路由](docs/COGNITIVE_WORKFLOW_ROUTING.md)。

## 快速开始

### 1. 安装

需要 **Node.js 24+**、npm、用于对话的 OpenAI API key，以及默认语音路径所需的 Soniox API key。

```sh
git clone https://github.com/JintaoHe/even-g2-gpt.git
cd even-g2-gpt
npm ci
```

只有在 `.env` 不存在时，才把 [.env.example](.env.example) 复制为 `.env`。不要提交 `.env`，也不要把真实凭证复制到 Issue、日志、模拟器 bundle 或 Hub 包中。

最小配置：

| 设置 | 用途 |
| --- | --- |
| `OPENAI_API_KEY` | 仅后端使用，用于对话和获准的联网搜索 |
| `SONIOX_API_KEY` | 仅后端使用的实时语音转录凭证 |
| `STT_PROVIDER=soniox` | 默认中英文 STT；`openai` 只用于回滚／测试 |
| `G2_CLIENT_TOKEN` | 自己生成的后端访问密钥，至少 32 个字符；不是 Even 官方 token |
| `DIALOGUE_PROVIDER=api` | 默认低延迟对话通道；`cli` 为可选方案 |

Calendar、Email、Maps、Time Zone、Weather、Air Quality 与 Pollen 默认关闭，只有在完成各自的 server-side credential 和访问限制之后才启用。

### 2. 启动网页对话测试

```sh
npm run conversation
```

打开 <http://127.0.0.1:3001>，输入 `G2_CLIENT_TOKEN`，先测试文字，再明确开启麦克风。参见[网页对话实验室](docs/CONVERSATION_LAB.md)。

`npm start` 是早期单轮转录 POC，不是连续对话助手服务。

### 3. 启动 Even 客户端与模拟器

保持后端运行，并从仓库根目录另外打开两个终端：

```sh
# 终端 A：Even SDK 前端
cd clients/even
npm ci
npm run dev
```

```sh
# 终端 B：本地模拟器
cd tools/even-simulator
npm ci
npm start
```

在 companion page 输入应用 token。后端只允许一个已认证 owner 连接，因此从网页实验室切换到模拟器前需要先断开网页连接。参见 [Even 客户端控制](clients/even/README.md)与[模拟器排障](tools/even-simulator/README.md)。

## 可选服务

| 服务 | 提供的能力 | 配置文档 |
| --- | --- | --- |
| Google Calendar | 查询、冲突检查、邀请、重复事件以及经确认的修改／取消 | [Calendar 指南](docs/google-calendar.md) |
| Gmail SMTP | 向一个固定收件人确认发送 Markdown 与 ICS 附件 | [邮件发送](docs/EMAIL_DELIVERY.md) |
| Google Places 与 Routes | 附近／远距离目的地、ETA、距离、路况与评分 | [Maps 与 Routes](docs/setup/GOOGLE_MAPS_ROUTES.md) |
| Time Zone API | 根据 location 为相对时间日历请求取得 IANA 时区 | [Google API Production](docs/setup/GOOGLE_API_PRODUCTION.md) |
| Weather、Air Quality、Pollen | 户外规划所需的结构化信息 | [Maps 与环境 API](docs/setup/GOOGLE_MAPS_ROUTES.md) |
| Codex CLI | 带 lifecycle、超时与取消控制的可选对话执行通道 | [CLI 通道](docs/CODEX_CLI_CHANNEL.md) |

个人部署建议把 OpenAI project 硬上限设为每月 `$40`。应用内搜索计数只是纵深保护，不能代替 provider 的账单上限；Google 与 AWS 使用各自独立的费用控制。

## 安全与隐私边界

- 只提交源码、合成测试和文档；不要提交 `.env`、OAuth JSON、CLI 登录、录音、私人对话、生成文件或 runtime database。
- 精确 GPS 坐标只存在于 session 内存 adapter：最多每 10 秒刷新，两分钟后不再视为可用；不会进入 Luna、search、history、日志、artifact 或眼镜正文，并在停止、断线或 session 退出时清除。
- Calendar 和 Email 凭证只保存在后端。模型不能任意选择收件人、读取任意服务器文件或直接执行 shell。
- 认知模式、以前的确认或模型的一句话都不能授权写入；每次副作用都必须重新绑定并校验当前 preview。
- Calendar／Email 写入结果不确定时先检查远端状态，不自动重放，避免创建重复事件或重复邮件。
- `.gitignore` 不是加密。后端访问控制、保留期限、加密备份、provider policy 和凭证轮换仍由部署者负责。

把后端开放到互联网前，请阅读 [SECURITY.md](SECURITY.md)。不要在公开 Issue 中发布凭证或私人日志。

## 项目结构与部署

```text
src/                   后端与早期 POC 入口
web/                   本地网页对话实验室
clients/even/          独立构建的 Even SDK 前端
tools/even-simulator/  模拟器与开发工具
tests/                 自动化测试及需要显式运行的 paid/live 测试
scripts/               构建、审计、授权与 smoke test
deploy/                Linux systemd、监控、备份与更新模板
docs/                  配置、产品、安全与验收文档
.local/                私有 runtime 数据（已忽略，禁止从 Git 部署）
```

`npm run build:server` 会生成独立的 `dist/server-*` 后端发布包。只部署已经验证的 server artifact，不要把整个开发 checkout 上传到服务器。发布包不包含网页实验室、SDK 源码、模拟器、测试、凭证和本地运行数据。

从 [Linux 部署](docs/setup/LINUX_DEPLOYMENT.md)、[运维](docs/LINUX_OPERATIONS.md)、[自动更新与回滚](docs/setup/AUTOMATIC_UPDATES.md)及[监控／备份恢复](docs/setup/MONITORING_BACKUP_RECOVERY.md)开始。

## 验证

在仓库根目录运行：

```sh
npm run typecheck
npm test
npm run build:server
node scripts/audit-public.mjs --worktree
node scripts/audit-public.mjs --history
```

然后单独验证 Even 客户端：

```sh
cd clients/even
npm test
npm run build
```

Calendar、Email、Maps、环境、STT 和真实模型脚本可能消耗额度或产生外部副作用，因此不属于默认 CI；必须逐项审查并单独授权。

## 当前限制与下一步

- 模拟器成功不能证明真机 BLE、手机权限、电池、温度、锁屏／后台生命周期、字体或 R1 手势一定正常。
- 尚未实现 always-on 唤醒词或有保证的全天后台助手模式。
- Session context 只是短期记忆；重新连接不会自动恢复上一次对话，也不是长期个人记忆。
- 重复事件目前只覆盖有限的按天／按周系列，不支持按月、多星期几、全天系列或“本次及以后”。
- 尚未接入公交路线，也不能直接把目的地交给 Apple Maps／Google Maps 启动导航。

下一步顺序：把当前 `main` 的 server build 部署到 Linux → 完成 live 路线／环境／Calendar／Email 验收及部署后安全复查 → 统一生成一份新的 Even Hub 包 → 进行真实 G2/R1 与后台生命周期测试。

## 文档导航

查看双语 **[文档索引](docs/README.zh-CN.md)**。

| 目标 | 从这里开始 |
| --- | --- |
| 了解认知模式、topic memory、工具和陪伴语气 | [认知／workflow 路由](docs/COGNITIVE_WORKFLOW_ROUTING.md) · [自适应推理](docs/ADAPTIVE_REASONING.md) |
| 测试语音对话和网页实验室 | [网页对话实验室](docs/CONVERSATION_LAB.md) |
| 测试眼镜显示、控制、定位与模拟器 | [Even 客户端](clients/even/README.md) · [模拟器](tools/even-simulator/README.md) |
| 配置 Calendar、邀请和重复事件 | [Google Calendar](docs/google-calendar.md) |
| 生成 Markdown 并发送邮件 | [邮件发送](docs/EMAIL_DELIVERY.md) |
| 部署和维护私人 Linux 后端 | [Linux 部署](docs/setup/LINUX_DEPLOYMENT.md) · [Linux 运维](docs/LINUX_OPERATIONS.md) |
| 检查发布门槛和剩余工作 | [Release readiness](docs/RELEASE_READINESS.md) · [开发计划](docs/DEVELOPMENT_PLAN.md) |
