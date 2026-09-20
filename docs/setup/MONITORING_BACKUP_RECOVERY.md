# 生产监控、日志与恢复

这套配置面向单用户自部署。目标是在不公开 Secret、不开放新端口、不发送测试邮件、不创建日历事件的前提下，发现服务、TLS 入口或 Google Calendar 只读访问故障，并每天生成可验证的本机备份。

## 设计边界

| 层级 | 检查或保护 | 不会做什么 |
| --- | --- | --- |
| GitHub Actions | 每小时访问公开的 `/healthz` | 不持有应用令牌，不访问对话、邮件或日历 |
| 服务器 health timer | 检查本机 Node、Caddy TLS 和 Calendar 只读 API | 不调用 OpenAI，不发送邮件，不写日历 |
| 手动 soak monitor | 连续记录资源、连接、聚合延迟、provider 结果与成本变化 | 不读取正文、不制造会话、不调用 provider |
| journald | 持久化、压缩并限制系统日志占用 | 不把日志上传到第三方 |
| backup timer | 短暂停止应用，归档整个私有数据目录并校验恢复副本 | 不上传备份，不覆盖生产数据 |
| Lightsail snapshot | 主机级灾难恢复 | 不代替应用数据一致性检查 |

公开 `/healthz` 只返回 `{"status":"ok"}`。Calendar、storage 与 runtime 聚合指标分别只存在于回环地址 `/internal/health/calendar`、`/internal/health/storage` 与 `/internal/health/runtime`，Caddy 不代理这些路径。它们不包含正文、session ID、地址、坐标、凭证或 provider 错误正文。health timer 会对短暂 storage 读取失败进行最多五次有界重试；响应格式无效或出现容量 warning 时仍会失败并触发告警，而不是把 warning 当作健康。

## 安装监控文件

运维文件不会由应用自动更新器自我替换。管理员必须先核对当前 release 的 diff，再手动安装：

```bash
sudo install -o root -g root -m 0755 /opt/even-agent/current/deploy/even-agent-healthcheck.sh /usr/local/sbin/even-agent-healthcheck
sudo install -o root -g root -m 0644 /opt/even-agent/current/deploy/even-agent-healthcheck.service /etc/systemd/system/even-agent-healthcheck.service
sudo install -o root -g root -m 0644 /opt/even-agent/current/deploy/even-agent-healthcheck.timer /etc/systemd/system/even-agent-healthcheck.timer
sudo install -o root -g root -m 0644 /opt/even-agent/current/deploy/even-agent-health-failure@.service /etc/systemd/system/even-agent-health-failure@.service
sudo systemd-analyze verify /etc/systemd/system/even-agent-healthcheck.service /etc/systemd/system/even-agent-healthcheck.timer /etc/systemd/system/even-agent-health-failure@.service
sudo systemctl daemon-reload
sudo systemctl start even-agent-healthcheck.service
sudo systemctl enable --now even-agent-healthcheck.timer
```

timer 每小时执行，最多随机延迟 5 分钟，重启或离线后补跑。失败会成为明确的 systemd failed unit，并额外写入 `daemon.err`。查看结果：

```bash
systemctl list-timers even-agent-healthcheck.timer --all
sudo systemctl status even-agent-healthcheck.service --no-pager
sudo journalctl -u even-agent-healthcheck.service -n 50 --no-pager
```

仓库中的 `Production health` GitHub Actions workflow 从服务器外部检查 HTTPS。GitHub 是否发送邮件取决于仓库所有者的 Actions 通知设置；它不能替代服务器告警或 AWS 账号告警。

## 12／24 小时真实 soak

soak monitor 是手动的一次性任务，不会随部署自动启动。它每 60 秒从回环接口采样一次：RSS、heap、累计 CPU、全部 SQLite／WAL／SHM 字节数、连接数、turn 的 first-visible／complete p50/p95、OpenAI／Soniox／Google 的成功率与耗时，以及成本账本变化。报告只含聚合数值，写入 `/var/lib/even-agent/soak`，目录为 `0700`、文件为 `0600`。

它只观察真实使用，不发送合成问题、不调用模型、不发送邮件、不读写 Calendar，也不需要或读取 `/etc/even-agent.env`。因此 provider 指标为零表示测试期间没有相应真实流量，不代表 provider 已通过压力测试。测试期间应按 [soak 与剩余 live-test 清单](../validation/LINUX_SOAK_AND_LIVE_TESTS.md) 使用本地 simulator 或真机完成代表性对话。

先安装并检查 unit：

```bash
sudo install -o root -g root -m 0644 /opt/even-agent/current/deploy/even-agent-soak@.service /etc/systemd/system/even-agent-soak@.service
sudo systemd-analyze verify /etc/systemd/system/even-agent-soak@.service /etc/systemd/system/even-agent-health-failure@.service
sudo systemctl daemon-reload
```

首次先跑 12 小时；稳定后再跑 24 小时。实例名只允许监控器支持的 1–24 整数，正式验收使用 12 或 24：

```bash
sudo systemctl start even-agent-soak@12.service
sudo systemctl status even-agent-soak@12.service --no-pager
sudo journalctl -u even-agent-soak@12.service -f
```

完成后查看汇总；不要把 JSONL、summary 或 journal 未审查地上传到公开仓库：

```bash
sudo find /var/lib/even-agent/soak -maxdepth 1 -type f -printf '%f %s bytes\n'
sudo python3 -m json.tool /var/lib/even-agent/soak/<soak-summary-file>.json
```

初始验收要求：没有意外 process restart；没有 storage warning；采样失败不是持续状态；socket 能在客户端离线后回落；RSS/SQLite 增长能由真实会话与文件数量解释；provider failure 不被隐藏；成本增量与实际使用相符。p50/p95 先作为基线记录，等真实 G2 后再给出硬件端 release threshold。systemd 失败只写脱敏告警；未处理 Promise rejection 会先关闭资源，再以非零状态退出并由 `Restart=on-failure` 拉起，而不是吞掉异常继续运行。

## 日志留存

Node 直接写 journald，不创建可被 Web 服务误发布的日志文件。建议安装受限的全局 journald drop-in：

```bash
sudo install -d -o root -g root -m 0755 /etc/systemd/journald.conf.d
sudo install -o root -g root -m 0644 /opt/even-agent/current/deploy/even-agent-journald.conf /etc/systemd/journald.conf.d/even-agent.conf
sudo systemd-analyze cat-config systemd/journald.conf
sudo systemctl restart systemd-journald
```

配置最多使用 256 MiB 持久日志、64 MiB 运行时日志，最长保留 14 天。它影响整台主机的 journald，而不仅是 Even Agent。应用 unit 还限制 30 秒内最多接收 200 条日志，避免异常循环占满磁盘。

日志可能包含错误时间和运行状态；应用不应打印令牌、OAuth 内容、完整对话或邮件正文。排查时也不要把未审查的 journal 直接贴到公开 Issue。

## 每日一致性备份

备份包含 `/var/lib/even-agent` 下的 OAuth 授权、SQLite、对话和生成文件，属于高度敏感数据。文件保存在同机 `/var/backups/even-agent`，仅 root 可读。它用于快速误操作恢复；Lightsail 自动快照仍负责主机损坏场景。

安装：

```bash
sudo install -d -o root -g root -m 0700 /var/backups/even-agent /usr/local/lib/even-agent
sudo install -o root -g root -m 0755 /opt/even-agent/current/deploy/even-agent-backup.sh /usr/local/sbin/even-agent-backup
sudo install -o root -g root -m 0755 /opt/even-agent/current/deploy/even-agent-restore-check.sh /usr/local/sbin/even-agent-restore-check
sudo install -o root -g root -m 0644 /opt/even-agent/current/deploy/verify-backup.mjs /usr/local/lib/even-agent/verify-backup.mjs
sudo install -o root -g root -m 0644 /opt/even-agent/current/deploy/even-agent-backup.service /etc/systemd/system/even-agent-backup.service
sudo install -o root -g root -m 0644 /opt/even-agent/current/deploy/even-agent-backup.timer /etc/systemd/system/even-agent-backup.timer
sudo systemd-analyze verify /etc/systemd/system/even-agent-backup.service /etc/systemd/system/even-agent-backup.timer
sudo systemctl daemon-reload
sudo systemctl start even-agent-backup.service
sudo systemctl enable --now even-agent-backup.timer
```

每天 09:00 UTC（芝加哥夏令时约 04:00、冬令时约 03:00）运行，最多随机延迟 15 分钟。备份会短暂停止应用，完成压缩与 checksum 后立即恢复；随后在隔离目录解压，解析有界 JSON，并对每个 SQLite 数据库运行 `PRAGMA integrity_check`。conversation DB 还执行 `foreign_key_check`、引用与 sequence 验证，并由当前 release 的代码真正重新打开一次，确保 schema／migration guard 可启动；conversation 和 jobs DB 都必须已经释放 service owner。启用 Google Calendar 时，备份还必须包含 Calendar ledger、OAuth client 配置和授权记录。输出不包含正文。只有验证成功才会清理旧备份，最多保留 7 份。

```bash
systemctl list-timers even-agent-backup.timer --all
sudo systemctl status even-agent-backup.service --no-pager
sudo journalctl -u even-agent-backup.service -n 100 --no-pager
sudo find /var/backups/even-agent -maxdepth 1 -type f -printf '%f %s bytes\n'
```

## 非破坏性恢复演练

以下命令只验证最新备份，不写生产数据：

```bash
sudo /usr/local/sbin/even-agent-restore-check
sudo systemctl is-active even-agent
```

恢复检查固定使用 `/var/backups/even-agent/.restore-check`，拒绝绝对路径、目录穿越和链接，结束后删除检查副本。它会在隔离目录重新打开 conversation store，验证恢复后的 schema 可启动；仍不能证明每段自然语言内容在业务上正确。

## 真正恢复时

真正恢复会替换 OAuth、日历绑定、邮件状态、对话和生成文件，必须先确认目标备份与影响范围：

1. 禁用 backup timer 并停止 `even-agent`。
2. 再次运行 restore-check，并记录目标 archive 与 checksum。
3. 将当前 `/var/lib/even-agent` 原子移动到同一磁盘的隔离目录，不要直接删除。
4. 把目标 archive 解压到新建的 `0700` 目录，拒绝链接并设为 `even-agent:even-agent`。
5. 将新目录移动为 `/var/lib/even-agent`，启动服务。
6. 检查 `/healthz`、WSS 登录和 Calendar 只读查询；不要用创建事件或发送邮件作为第一项恢复测试。
7. 确认稳定后再重新启用 timer。隔离的旧数据含 Secret，必须按敏感数据处理。

不要在没有明确选择备份时间点时自动执行真实恢复；不要把 archive、checksum、OAuth 文件或日志上传到公开仓库。
