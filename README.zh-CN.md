# Even G2 Agent

**简体中文** | [English](README.md)

面向 Even Realities G2 的个人 AI 助手：中英文语音对话、眼镜文字显示、联网查询、Google Calendar 管理，以及经确认的 Markdown 邮件发送。

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
| 连续对话 | 中英文混说转录、自动分段、上下文追问、流式文字回答、插话取消与意图退出；不要求每句话按发送键 |
| 收音缓冲 | 800ms 触发前缓冲，保留已采集的句首音频；不额外等待 800ms，不保证消除全部识别遗漏 |
| 眼镜阅读 | 显示正在识别的话语、保留最终问题与回答；默认不自动翻页，可回看本会话；正文去除链接语法，原始来源保留用于导出 |
| 对话通道 | 默认 OpenAI API；可选 Codex CLI，提供等待、真实搜索事件、超时与取消反馈 |
| 联网搜索 | API 默认每回答最多 2 次、每日 20 次、每自然月 600 次；持久化计数。CLI 原生搜索与 API 账本分开 |
| 推理档位 | 默认双 Luna 配置按每轮上下文选择 none / low / medium；不是准确率或延迟保证 |
| 日历查询 | 展示标题／时间／地点／备注、检查冲突；“下一次”最多向后查 93 天，名称不确定时提供候选供确认 |
| 日历写入 | 创建、修改、取消前预览并等待确认；更新原事件，创建后向固定收件人发出 Google 原生邀请 |
| 重复日程 | 有限的按天／按周系列；未给结束日期默认三个月并写入备注；修改／取消区分仅本次与整个系列 |
| 文档与邮件 | 按要求生成计划、说明、讨论要点或对话记录等 MD，保存后确认发送；主题摘要、可读附件名、单次 ICS 附件及受控重发 |
| 持久化 | 对话、任务、文件与用量账本保存在自有后端；认证下载、进程退出与任务恢复保护 |

Google Calendar 事件和邮件 ICS 附件是两种能力：**真实事件可持续修改并通知受邀者，独立 ICS 文件不是持续同步服务。** 重复会议使用 Google 原生邀请，暂不支持自行导出重复 ICS。

## 快速开始

### 1. 准备开发环境

需要 **Node.js 24+**、npm，以及用于 API 对话／语音转录的 OpenAI API key。

```sh
git clone https://github.com/JintaoHe/even-g2-gpt.git
cd even-g2-gpt
npm ci
```

仅在 `.env` 不存在时，将 [.env.example](.env.example) 复制为 `.env`，不要覆盖已有凭据。先配置：

| 配置 | 用途 |
| --- | --- |
| `OPENAI_API_KEY` | 仅服务端使用，不输入网页或眼镜客户端 |
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

- 默认展示芝加哥时间；用户可提出其他时区。写入前核对具体日期、时间和变更内容。
- 草稿与一次性授权分开：听错确认不等于提交；创建／修改／取消仍须确认。
- 查询只覆盖绑定的专用日历；外部、非助手创建或不支持的事件可能只能查看。
- 重复系列默认三个月不是自动续期；整系列操作包括过去的实例。

配置、403 排错、凭据恢复和重复规则边界见 [Google Calendar 指南](docs/google-calendar.md)。

### Markdown、邮件与附件

API 对话可以按用户要求生成独立文档，不限于聊天记录。文件保存在自己的后端数据目录，**不会自动变成 ChatGPT 网页中的文件或公共 artifact**。

邮件使用专用 Gmail 发件账号和固定收件人，显式开启 `EVEN_EMAIL_ENABLED`。生成后先展示摘要／文件信息，经确认才发送；SMTP 接受不保证已进入收件箱。未收到时提供检查、一次确认重发及认证下载路径。

参见 [邮件配置与发送保护](docs/EMAIL_DELIVERY.md)、[日历附件设计](docs/CALENDAR_EMAIL_DESIGN.md)。

### API 与 Codex CLI

API 为当前默认体验。CLI 需要部署者自行登录，使用对应账号额度；**CLI 对话不免除语音转录的 API 调用**，也不保证同等速度、流式体验或工具能力。API 对话式文档生成不能直接等同于 CLI 功能。

详见 [双通道与登录说明](docs/CODEX_CLI_CHANNEL.md)、[应用层推理档位](docs/ADAPTIVE_REASONING.md)。搜索次数限制不是整套应用的美元消费硬上限；聊天、转录和文档生成另计。

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
- 后续重点：Even Hub Private Testing → 真实 G2/R1 验收 → Beta 锁屏／后台测试 → 隐私、支持材料与提交审核。

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
