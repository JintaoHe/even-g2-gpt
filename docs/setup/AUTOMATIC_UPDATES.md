# Linux 自动更新与回滚

本项目支持由服务器定时检查受保护的 GitHub `main`，但不会在正在运行的目录中执行 `git pull`。每次更新都在隔离目录中构建、测试并生成 server-only 发布包，通过后才原子切换 `/opt/even-agent/current`；新服务无法启动时自动切回上一版。

## 安全边界

- 只拉取固定公开仓库的 `main`，不执行 PR 分支、fork 或任意 URL。
- GitHub 的 branch protection 与 CI 是第一道门；服务器会再次运行 typecheck、完整测试和公开源码扫描。
- 仓库代码和 npm 命令以无登录权限的 `even-deploy` 用户运行。root updater 只负责完成这次 UID/GID 下降；`setpriv --no-new-privs` 在 Git/npm 执行前恢复不可提权边界。该用户不能读取 `/etc/even-agent.env`、日历 OAuth 文件、对话或生成文档。
- `npm ci` 使用 lockfile、`--ignore-scripts`、`--no-audit` 和 `--no-fund`。生产 Secret 不进入构建环境。
- root 只负责把已验证的发布包复制到 root-owned release 目录、切换 symlink、重启服务和失败回滚；unit 只保留 `CHOWN`、`DAC_OVERRIDE`、`FOWNER`、`SETUID`、`SETGID` 五项 capability，并禁止创建 namespaces。
- 切换 release 前，updater 会先停止服务并把 `/var/lib/even-agent` 建成 root-only 的一致性 rollback archive；新 release 健康检查失败时，应用版本和该次更新前的数据会一起恢复。archive 会拒绝链接与目录穿越，且只保留最近两份。
- timer 每 6 小时检查一次，并加入最多 30 分钟随机延迟；无新 commit 时不重启。

这降低了风险，但不等于供应链绝对安全。GitHub 账号、branch protection、依赖 lockfile 或服务器 root 被攻陷仍可能影响生产。保留 MFA、快照和上一版本，不要给外部贡献者绕过 main 保护的权限。

## 首次迁移为 release 结构

以下命令必须在已经通过手动部署验证后执行。先确认 `/opt/even-agent` 是预期目录，绝不能把变量留空或改成 `/`。

1. 创建专用构建账号：

```bash
sudo useradd --system --create-home --home-dir /var/lib/even-agent-updater/home --shell /usr/sbin/nologin even-deploy
sudo install -d -o even-deploy -g even-deploy -m 0700 /var/lib/even-agent-updater
```

2. 将已验证的 server-only 包上传到管理员临时目录，再创建 `/opt/even-agent/releases/<full-commit-sha>`。`<full-commit-sha>` 必须是 GitHub `main` 的 40 位 commit ID。不要直接覆盖当前生产目录，也不要复制 Secret 或数据目录。

3. 核对发布包后写入 commit 标记并建立 current：

```bash
printf '%s\n' '<full-commit-sha>' | sudo tee /opt/even-agent/releases/<full-commit-sha>/RELEASE-COMMIT >/dev/null
sudo chown -R root:root /opt/even-agent/releases/<full-commit-sha>
sudo ln -s /opt/even-agent/releases/<full-commit-sha> /opt/even-agent/current
```

安装新版 `deploy/even-agent.service`，执行 `systemd-analyze verify`，然后 daemon-reload 和 restart。只有在 `current` 指向完整 release 后，服务文件才能切换到 `/opt/even-agent/current`。

## 安装 updater 与 timer

从已经核对的 release 安装固定脚本和 units：

```bash
sudo install -o root -g root -m 0755 /opt/even-agent/current/deploy/even-agent-update.sh /usr/local/sbin/even-agent-update
sudo install -o root -g root -m 0644 /opt/even-agent/current/deploy/even-agent-update.service /etc/systemd/system/even-agent-update.service
sudo install -o root -g root -m 0644 /opt/even-agent/current/deploy/even-agent-update.timer /etc/systemd/system/even-agent-update.timer
sudo systemd-analyze verify /etc/systemd/system/even-agent-update.service /etc/systemd/system/even-agent-update.timer
sudo systemctl daemon-reload
```

先手动执行一次真实检查并观察日志；它会构建当前 main，但只有 commit 不同时才切换：

```bash
sudo systemctl start even-agent-update.service
sudo systemctl status even-agent-update.service --no-pager
sudo journalctl -u even-agent-update.service -n 100 --no-pager
readlink -f /opt/even-agent/current
sudo systemctl is-active even-agent
```

确认成功后再启用 timer：

```bash
sudo systemctl enable --now even-agent-update.timer
systemctl list-timers even-agent-update.timer --all
```

## 更新后的验收

每次发布至少检查：

```bash
cat /opt/even-agent/current/RELEASE-COMMIT
sudo systemctl is-active even-agent caddy
curl --fail -sS -o /dev/null http://127.0.0.1:3001/healthz
sudo ss -lntup
sudo journalctl -u even-agent-update.service -n 100 --no-pager
```

再从外部验证 HTTPS/WSS、无令牌拒绝、真实令牌连接，以及 3001 未开放公网。脚本的本机 HTTP 检查只证明进程能响应，不代替完整端到端测试。

## 暂停、手动触发和回滚

暂停自动检查不会停止当前服务：

```bash
sudo systemctl disable --now even-agent-update.timer
```

手动检查：

```bash
sudo systemctl start even-agent-update.service
```

若更新发生在服务健康检查之后才暴露业务问题，选择 `/opt/even-agent/releases/` 中已知良好的完整 commit，原子改回 symlink 并重启。不要删除当前数据目录或 Secret：

```bash
sudo ln -s /opt/even-agent/releases/<known-good-commit> /opt/even-agent/.current-rollback
sudo mv -Tf /opt/even-agent/.current-rollback /opt/even-agent/current
sudo systemctl restart even-agent
```

确认稳定后再调查，不要强行重新运行失败 commit。release 目录暂不自动删除；定期人工保留最近几个已验证版本，删除前必须确认它不是 `current` 或计划回滚的目标。

自动 health gate 失败时，脚本会使用 `/var/lib/even-agent-updater/rollback-data/` 中与该 commit 对应的 pre-update archive 恢复数据；这个路径及 archive 均为 root-only。它只保护自动部署窗口，不代替每日备份或 Lightsail snapshot。若服务已经通过自动 gate、之后才发现业务问题，不要直接套用未知时间点的 archive；先停止 timer，核对 release、数据时间点和最近备份，再按恢复文档操作。

## 运维文件不会自动自我替换

自动更新只切换应用 release，不会自动覆盖 `/usr/local/sbin/even-agent-update`、`/etc/systemd/system/*.service`、Caddyfile、防火墙或 Secret。这样可以避免仓库一次提交自动扩大 root 权限或网络暴露。若仓库中的这些文件改变，管理员需审阅 diff、手动安装并重新运行安全检查。
