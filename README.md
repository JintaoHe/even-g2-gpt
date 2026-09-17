# Even G2 Agent

- [Even SDK 客户端](./clients/even/README.md) 与 [官方模拟器](./tools/even-simulator/README.md)：独立依赖和构建，本地显示、分页、对话连接与 SDK 收音适配；不进入后端部署包。

- [目录与部署边界](./docs/PROJECT_STRUCTURE.md)：`npm run build:server` 生成白名单后端发布目录；不包含网页实验室、Even SDK 前端、模拟器、测试、密钥或本地数据。

这是一个以 Even Realities G2 为输入/显示终端、以自有服务端为控制面的个人 AI 助手项目。

当前状态：**本地连续对话实验版已实现并通过小样本真实 API 验证；G2/R1 尚未接入。**

- [连续对话测试页运行指南](./docs/CONVERSATION_LAB.md)：`npm run conversation` → 打开 `http://127.0.0.1:3001`，支持电脑麦克风或文字输入。
- [Linux 生命周期与持久化存储](./docs/LINUX_OPERATIONS.md)：Node 24+、systemd 模板、后台 MD 导出与认证下载；Linux 真机验收尚未进行。
- [Google Calendar 配置、排错与凭据恢复](./docs/google-calendar.md)：专用账号 OAuth、自然语言查询／消歧／确认修改、冲突保护、事件测试入口与 Linux 迁移。仅涵盖助手专用日历。
- [API / Codex CLI 双通道部署](./docs/CODEX_CLI_CHANNEL.md)：API 默认不变；CLI 已接入原生搜索事件与等待反馈，通过本地模拟测试，需单独登录后实测。CLI 搜索使用 Codex 账号额度；语音转录仍需 API key。
- 已接入 OpenAI 内置联网搜索、搜索状态与可点击引用；每次回答最多 2 次搜索，每日 20 次、每自然月 600 次（芝加哥时区），账本重启保留。费用及关闭方式见上述指南。

- [POC 运行指南](./docs/POC.md)：`npm ci` → 配置 `.env` → `npm start` → `npm run inject -- recording.wav`。
- `npm run typecheck` 和 `npm test` 验证本地软件链路。

- [Development Plan](./docs/DEVELOPMENT_PLAN.md)
- [已确认的 Conversation MVP 范围](./docs/CONVERSATION_MVP.md)：先完成连续对话、插话与意图退出，再扩展文件生成/发送等工具；本地实验版已实现部分能力，真机待验收。
- STT 已确定使用 OpenAI `gpt-live-transcribe`；Soniox 对照计划已取消。
- 原始 blueprint 作为设计输入保留在工作区之外，本仓库中的 Development Plan 是实施基线。

## 当前判断

当前版本整理、重复日程支持边界与 Even Hub 上架准备见 [发布准备清单](./docs/RELEASE_READINESS.md)。重复日程目前仅支持查询，不支持创建或修改整个系列。

项目总体可行。实时字幕、显式记忆、列表写入、多模型调用和受控工具执行都有明确实现路径；“全天候、手机锁屏后仍永久运行”的 ambient 模式暂时只能作为条件性目标，必须通过真实 G2、手机系统和 Even Hub 生命周期测试后才能承诺。

## 工作名称

暂用 `Even G2 Agent`。本文把用户所说的 “Even STD” 理解为 “Even STT/Agent”；如果 `STD` 是有意的产品名，后续只需统一改名，不影响架构。
