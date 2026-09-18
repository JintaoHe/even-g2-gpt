# 部署与账号设置指南

这一目录保存 Even G2 Agent 的可重复部署手册。指南按实际操作顺序编写，即使第一次维护 Linux 服务器，也应当可以逐项核对完成。

1. [Linux 后端部署](LINUX_DEPLOYMENT.md)：创建服务器、收紧网络、安装运行时、部署后端、配置 systemd/Caddy，并完成上线验收。
2. [生产监控、日志与恢复](MONITORING_BACKUP_RECOVERY.md)：健康探测、journald 留存、每日一致性备份和非破坏性恢复演练。
3. [Google Calendar API 发布与长期授权](GOOGLE_API_PRODUCTION.md)：启用 Calendar API、配置 OAuth、从 Testing 发布到 Production、重新授权及排错。
4. [Tailscale 私有管理通道](TAILSCALE_SETUP.md)：安装 Tailscale、加入私人 tailnet，并通过私网 SSH/WinSCP 管理服务器。
5. [使用 WinSCP 登录 Lightsail](WINSCP_LIGHTSAIL.md)：Windows 安装、PEM 转 PPK、MagicDNS、首次 host key 核验、安全上传和换电脑流程。
6. [Linux 自动更新与回滚](AUTOMATIC_UPDATES.md)：定时跟踪受保护的 main、低权限构建、原子切换、健康检查与失败回滚。

## 先理解三个边界

- **源码**可以进入 Git；真实 `.env`、OAuth JSON、refresh token、SSH 私钥、数据库、对话、录音和生成文件绝不能进入 Git。
- **公开服务**只通过 HTTPS/WSS 的 443 端口进入 Caddy；Node 后端只监听 `127.0.0.1:3001`。
- **管理通道**使用密钥 SSH、AWS 浏览器 SSH或 Tailscale。Tailscale 不替代公开网站，也不要求开放新的公网端口。

## 文档中的占位符

尖括号表示必须换成你自己的值，例如：

```text
<server-ip>
<your-domain.example>
<admin-user>
<fixed-recipient@example.com>
```

不要把替换后的真实值提交回公共仓库。命令示例只展示变量名，不展示任何真实密钥。

## 每次部署后的最小验收

- `even-agent`、`caddy` 和 `tailscaled`（如使用）均为 `active`；`even-agent` 为 `enabled`。
- `ss -lntup` 只显示 Node 监听 `127.0.0.1:3001`，没有公网 `3001`、`3002`、SMTP 或数据库监听。
- 外部机器访问 `http://<server-ip>:3001` 失败；访问 `https://<your-domain.example>` 成功。
- 未带应用令牌下载附件得到 `401`；应用令牌不出现在 URL、日志或截图中。
- `/etc/even-agent.env`、Google OAuth 文件为 `0600`，数据目录为 `0700`。
- Google 只读连接检查成功；SMTP 只做 `verify()` 时不会发送邮件。

## 相关文档

- [项目与部署边界](../PROJECT_STRUCTURE.md)
- [Linux 生命周期与持久化数据](../LINUX_OPERATIONS.md)
- [Google Calendar 功能与交互规则](../google-calendar.md)
- [安全政策](../../SECURITY.md)
