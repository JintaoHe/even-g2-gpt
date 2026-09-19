# Even G2 Agent

**简体中文** | [English](README.md)

面向 Even Realities G2 的个人 AI 助手：中英文语音对话、眼镜文字显示、联网查询、Google Calendar 管理，以及经确认的 Markdown 邮件发送。

**本项目是独立社区项目，与 Even Realities 无隶属、背书或官方发布关系。** 打包应用暂用名为 **Glass Assistant**，避免把应用本身包装成 Even 官方产品。

**用户自建后端，个人单用户使用。** API 是默认对话通道，也可选 Codex CLI。密钥、日历授权与邮件凭据只保存在自己的后端，不进入眼镜客户端或公开仓库。

当前为开发测试版：网页对话实验室与 Even SDK 模拟器已接通，单用户 Linux 后端已通过主机级部署检查；**真实 G2/R1 端到端测试和 Even Hub 发布仍待验收**。本仓库不是已上架应用，也不提供托管的多用户服务。

## 目录

- [当前能力](#当前能力)
- [快速开始](#快速开始)
- [可选工具与配置](#可选工具与配置)
- [项目结构与部署](#项目结构与部署)
- [安全与数据边界](#安全与数据边界)
- [开发与验证](#开发与验证)
- [当前限制与下一步](#当前限制与下一步)
- [文档导航](#文档导航)

## 当前能力

| 模块 | 已实现范围 |
| --- | --- |
| 连续对话 | Soniox `stt-rt-v5` 原生 16 kHz 中英文混说转录、自动分段、每轮只问一个原子问题、流式文字回答、插话取消与意图退出；同一会话可暂停／恢复相互隔离的行程、business 等主题线程 |
| 伴随页输入 | 手机端可选文字框，适合输入问题、邮箱、URL、ID 等精确内容；眼镜本身不提供键盘 |
| 定位与 ETA | 指定地点／附近地点意图会请求一次短期手机定位（最多三次尝试），支持跨城市目的地，结合 Places 评分与 Routes Matrix；临时活动无法识别时可使用一次受配额约束的网页搜索，并须重新经 Places 验证。坐标不进入 LLM／历史／日志。用户本地、Linux 与真机验收仍待完成 |
| 收音缓冲 | 800ms 触发前缓冲，保留已采集的句首音频；不额外等待 800ms，不保证消除全部识别遗漏 |
| 眼镜阅读 | 显示正在识别的话语、保留最终问题与回答；默认不自动翻页，可回看本会话；正文去除链接语法，原始来源保留用于导出 |
| 对话通道 | 默认 OpenAI API；可选 Codex CLI，提供等待、真实搜索事件、超时与取消反馈 |
| 联网搜索 | API 默认每回答最多 10 次、每 30 分钟会话 50 次、每日 100 次、每自然月 1200 次；持久化计数。CLI 原生搜索与 API 账本分开 |
| 推理档位 | 默认双 Luna 会独立判断九种认知模式、workflow 与任务类型，再约束 low / medium / high；工具权限仍单独授权 |
| 日历查询 | 展示标题／时间／地点／备注、检查冲突；“下一次”最多向后查 93 天，名称不确定时提供候选供确认 |
| 日历写入 | 创建、修改、取消前预览并等待确认；更新原事件，创建后向固定收件人发出 Google 原生邀请 |
| 重复日程 | 有限的按天／按周系列；未给结束日期默认三个月并写入备注；修改／取消区分仅本次与整个系列 |
| 文档与邮件 | 按要求生成当前主题范围内的计划、说明、讨论要点或对话记录等 MD，不混入其他 business／trip 线程；保存后确认发送，支持可读附件名、单次 ICS 与受控重发 |
| 持久化 | 对话、任务、文件与用量账本保存在自有后端；认证下载、进程退出与任务恢复保护 |

Google Calendar 事件和邮件 ICS 附件是两种能力：**真实事件可持续修改并通知受邀者，独立 ICS 文件不是持续同步服务。** 重复会议使用 Google 原生邀请，暂不支持自行导出重复 ICS。

## 快速开始

### 1. 准备开发环境

需要 **Node.js 24+**、npm、用于 API 对话的 OpenAI API key，以及默认语音转录所需的 Soniox API key。

```sh
git clone https://github.com/JintaoHe/even-g2-gpt.git
cd even-g2-gpt
npm ci
```

仅在 `.env` 不存在时，将 [.env.example](.env.example) 复制为 `.env`，不要覆盖已有凭据。先配置：

| 配置 | 用途 |
| --- | --- |
| `OPENAI_API_KEY` | 仅服务端使用，不输入网页或眼镜客户端 |
| `SONIOX_API_KEY` | 仅服务端使用的实时 STT 凭据，不能进入 Even 客户端或 Hub 安装包 |
| `STT_PROVIDER=soniox` | 默认原生 16 kHz 双语转录；`openai` 仅作为显式回退 |
| `G2_CLIENT_TOKEN` | 自己生成的至少 32 字符随机访问密码；不是 Even 官方 token，不需要眼镜到货 |
| `DIALOGUE_PROVIDER=api` | 默认 API 对话；改用 CLI 前需独立完成 CLI 登录 |

其余模型与端口配置可先保留示例值。邮件和 Google Calendar 默认关闭，可以等基本对话跑通后再启用。

### 2. 启动网页对话测试

```sh
npm run conversation
```

打开 <http://127.0.0.1:3001>，输入 **G2_CLIENT_TOKEN** 连接。先测试文字，再显式开启麦克风；页面显示实际 API／CLI 通道。Windows 启动排错见 [运行指南](docs/CONVERSATION_LAB.md#启动)。

`npm start` 是早期单轮转录 POC，不是连续对话入口。

### 3. 接入 SDK 与模拟器

保持后端运行，在两个独立终端分别启动：

```sh
# 终端 A：从仓库根目录进入 SDK 前端
cd clients/even
npm ci
npm run dev
```

```sh
# 终端 B：从仓库根目录进入模拟器目录
cd tools/even-simulator
npm ci
npm start
```

在模拟器 companion 页面输入应用 token。后端只允许一个活跃的认证拥有者，切换到模拟器前先断开网页实验室。参见 [SDK 操作与分页](clients/even/README.md)、[模拟器运行与退出排错](tools/even-simulator/README.md)。

## 可选工具与配置

### Google Calendar

使用助手专用 Google 账号及独立日历（默认名称 `Even Assistant`），完成 OAuth 后显式开启 `GOOGLE_CALENDAR_ENABLED`。不要授权个人主账号来替代专用账号。

- Calendar 的相对时间默认采用一次性当前位置解析出的 IANA 时区（如洛杉矶或纽约）；用户明确指定的事件时区优先。Google Time Zone 是首选；若仍不可用，Luna 只接收本 session 的有界上下文与验证过的设备时区提示，不接收坐标，并返回严格 IANA 时区或只追问一个城市／地区问题。系统不会静默假设芝加哥，fallback 也不能绕过写入确认。
- 草稿与一次性授权分开：听错确认不等于提交；创建／修改／取消仍须确认。
- 查询只覆盖绑定的专用日历；外部、非助手创建或不支持的事件可能只能查看。
- 重复系列默认三个月不是自动续期；整系列操作包括过去的实例。

配置、403 排错、凭据恢复和重复规则边界见 [Google Calendar 指南](docs/google-calendar.md)。

### 当前位置 ETA

可选路线功能会自动请求手机定位，并在当前 session 内最多每 10 秒刷新一次内存位置，再调用 Places Text Search (New)
取得最多三个候选及评分，并用一次 Routes Compute Route Matrix 比较。默认
驾车；语音或伴随页可切换步行／骑车。眼镜只显示精简的时间、距离、适用的
路况、评分可信度与建议；近期追问复用仍新鲜的 session 位置和短期 Place ID。坐标只存在运行内存中，明确停止、断线或 session 退出即清除。该功能默认
关闭，必须使用独立的服务端 Google Maps key，并限制为上述两个 API 和调用电脑／服务器 IP；Calendar OAuth
secret 不能代替 Maps key。本地测试前先看
[Google Maps 路线配置](docs/setup/GOOGLE_MAPS_ROUTES.md)。

### Markdown、邮件与附件

API 对话可以按用户要求生成独立文档，不限于聊天记录。文件保存在自己的后端数据目录，**不会自动变成 ChatGPT 网页中的文件或公共 artifact**。

邮件使用专用 Gmail 发件账号和固定收件人，显式开启 `EVEN_EMAIL_ENABLED`。生成后先展示摘要／文件信息，经确认才发送；SMTP 接受不保证已进入收件箱。未收到时提供检查、一次确认重发及认证下载路径。

参见 [邮件配置与发送保护](docs/EMAIL_DELIVERY.md)、[日历附件设计](docs/CALENDAR_EMAIL_DESIGN.md)。

### API 与 Codex CLI

API 为当前默认对话体验。CLI 需要部署者自行登录，使用对应账号额度；**对话通道与 STT 相互独立**，语音默认走 Soniox，仍会产生对应 provider 用量。CLI 也不保证同等速度、流式体验或工具能力。API 对话式文档生成不能直接等同于 CLI 功能。

详见 [双通道与登录说明](docs/CODEX_CLI_CHANNEL.md)、[应用层推理档位](docs/ADAPTIVE_REASONING.md)。搜索次数限制不是整套应用的美元消费硬上限；聊天、转录和文档生成另计。

本个人部署应在 OpenAI API Dashboard 给该 **project** 设置 `$40/月`，并开启
hard-limit enforcement。应用内搜索账本只是纵深保护，不能替代平台硬限制；
Google Maps 与 AWS 费用需要各自单独控制。

## 项目结构与部署

```text
src/                   后端与历史 POC 入口
web/                   本地网页对话实验室
clients/even/          独立构建的 Even SDK 前端
tools/even-simulator/  模拟器及开发调试工具
tests/                 自动化测试与显式运行的 live 检查
scripts/               构建、授权、扫描与 smoke test 工具
deploy/                Linux systemd 模板
docs/                  配置、运维、设计与验收文档
.local/                私有运行数据（不提交）
```

`npm run build:server` 生成独立的 `dist/server-*` 后端发布目录。**只部署成功构建的目录，并检查 `BUILD-MANIFEST.json`；不要上传整个开发目录。**

后端部署包不含网页实验室、SDK 前端、模拟器、测试、密钥或本地数据。SDK 单独构建；Linux 凭据与数据单独配置。Node 只监听 loopback，并由已部署的 HTTPS/WSS 反向代理对外服务，3001 不开放公网。Even Hub 客户端已有独立生产 bundle 与精确网络白名单，但 Private Testing 和真机验收仍待完成。

详见 [部署边界](docs/PROJECT_STRUCTURE.md)、[Linux 进程、存储与迁移](docs/LINUX_OPERATIONS.md) 和 [Linux 自动更新与回滚](docs/setup/AUTOMATIC_UPDATES.md)。

## 安全与数据边界

- 只提交源码、合成测试和文档；不提交 `.env`、OAuth JSON、CLI 登录信息、录音、私人对话、生成文件或运行数据库。
- `.local` 数据由部署者管理；忽略 Git 不等于加密，需要自行设置访问权限、备份和保留策略。
- 日历和邮件权限由后端约束；模型不能任意选择收件人、读取服务器文件或直接执行 shell。
- 写入结果不确定时不自动重放，避免重复会议或邮件；只读请求的有限重试与写入重试不同。
- 模拟器自动化端口仅用于本地调试，不能暴露公网。
- 模型／搜索会将相关内容交由相应服务处理；本地存储或 `store:false` 不是服务商零保留承诺。

报告漏洞请按 [安全政策](SECURITY.md) 操作，不要将凭据或私人日志贴到公开 Issue。

## 开发与验证

根目录离线检查：

```sh
npm run typecheck
npm test
npm run build:server
node scripts/audit-public.mjs --worktree
```

SDK 独立检查：

```sh
cd clients/even
npm test
npm run build
```

发布前还需扫描实际暂存内容（`npm run audit:public`）及历史文件（`node scripts/audit-public.mjs --history`）。扫描不能替代人工审查，也不扫描 Git 作者身份。真实模型评估会消耗额度，邮件／日历 live 脚本可能产生外部副作用，**必须按文档单独确认，不属于默认 CI**。

贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)；验收门槛见 [发布准备清单](docs/RELEASE_READINESS.md)。

## 当前限制与下一步

- 模拟器不代表真机 BLE、字体、电量、权限、手机锁屏或后台生命周期已通过验收；不承诺全天候唤醒或后台常驻。
- 重复日程暂不支持月度、多星期几、全天系列或“本次及以后”的拆分。真实重复邀请收件与同步仍待专门验收。
- 收音是能量检测基线，噪声、轻声、转录及语义判断仍可能出错；800ms 缓冲只能保留已采集音频。
- 当前没有多租户隔离；断线重连不等于自动恢复完整对话上下文。
- 后续重点：用户本地路线验收 → Linux 路线部署／live test → 部署后安全检查 → 最终 Even Hub 包／Private Testing → 真实 G2/R1 验收 → Beta 锁屏／后台测试。

## 文档导航

完整分类入口见 **[文档索引](docs/README.zh-CN.md)**。

| 我想做什么 | 从这里开始 |
| --- | --- |
| 跑通语音和网页对话 | [对话实验室](docs/CONVERSATION_LAB.md) |
| 查看眼镜画面和手势 | [SDK 前端](clients/even/README.md) · [模拟器](tools/even-simulator/README.md) |
| 配置日历、邀请与重复事件 | [Google Calendar](docs/google-calendar.md) |
| 生成 MD 并发邮件 | [邮件与文件交付](docs/EMAIL_DELIVERY.md) |
| 部署自己的 Linux 后端 | [部署边界](docs/PROJECT_STRUCTURE.md) · [Linux 运维](docs/LINUX_OPERATIONS.md) |
| 了解路线和未完成事项 | [发布准备](docs/RELEASE_READINESS.md) · [Development Plan](docs/DEVELOPMENT_PLAN.md) |
