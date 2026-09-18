# 文档索引

**简体中文** | [English](README.md)

[返回项目首页](../README.zh-CN.md)

项目首页与本索引提供中英文版本；下方详细指南暂时保留原有语言，并非全部已有英文翻译。

优先从运行／配置指南开始。设计计划和评估记录含历史阶段信息，不代表所有规划均已实现；当前范围以项目首页、对应功能指南和发布准备清单为准。

## 运行与客户端

- [连续对话实验室](CONVERSATION_LAB.md)：网页启动、收音、追问、搜索与限制。
- [Even SDK 前端](../clients/even/README.md)：连接、分页、用户转录、历史与退出恢复。
- [官方模拟器](../tools/even-simulator/README.md)：启动、独立依赖与已知平台问题。
- [早期单轮 POC](POC.md)：音频注入与初始转录链路，不是当前连续对话入口。

## 功能配置

- [Google Calendar](google-calendar.md)：OAuth、专用日历、排错与凭据恢复、确认写入、冲突和重复会议。
- [Markdown 与邮件](EMAIL_DELIVERY.md)：专用 Gmail、固定收件人、生成／发送确认、重发与下载。
- [日历附件设计](CALENDAR_EMAIL_DESIGN.md)：MD／ICS 交付与时区；真实 Google 事件以 Calendar 指南为准。
- [API / Codex CLI](CODEX_CLI_CHANNEL.md)：通道选择、原生搜索、认证和能力差异。
- [自适应推理](ADAPTIVE_REASONING.md)：none / low / medium 的应用层选择与保护。

## 部署、安全与贡献

- [部署与账号设置指南](setup/README.md)：面向初次运维者的 Linux、Google OAuth Production 和 Tailscale 分步手册。
- [使用 WinSCP 登录 Lightsail](setup/WINSCP_LIGHTSAIL.md)：通过 Tailscale 私网登录 SFTP、转换密钥、核对 host key 及安全上传的逐步指南。
- [项目结构与部署边界](PROJECT_STRUCTURE.md)：后端白名单构建、客户端／模拟器隔离。
- [Linux 运维](LINUX_OPERATIONS.md)：进程、systemd、任务存储、备份和迁移。
- [发布准备清单](RELEASE_READINESS.md)：已验证范围与真机／Linux／Even Hub 验收。
- [配置示例](../.env.example)：空凭据与默认值，真实配置不提交。
- [安全政策](../SECURITY.md) · [贡献指南](../CONTRIBUTING.md)。

## 设计与历史评估

这些文档用于理解设计演进，不是当前价格、延迟或服务可用性的保证。

- [Development Plan](DEVELOPMENT_PLAN.md)：实施基线与长期方向。
- [Conversation MVP](CONVERSATION_MVP.md)：早期范围与交互目标。
- [STT 评估计划](STT_BAKEOFF.md)：历史方案；当前使用 OpenAI，Soniox 对照已取消。
- [GPT-5 Nano 评估](GPT5_NANO_EVAL.md) · [Luna 评估](LUNA_EVAL.md)。
- [动态推理评估](DYNAMIC_REASONING_EVAL.md)：小样本测试记录，实现见自适应推理指南。

真实模型、SMTP 和 Calendar smoke test 可能计费、发送邮件或修改日程。请先阅读对应指南，不要批量执行全部脚本。
