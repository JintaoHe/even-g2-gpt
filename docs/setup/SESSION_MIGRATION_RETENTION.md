# 会话迁移、三年留存与容量检查

本文面向单用户自托管实例。命令不会要求或显示 OpenAI、Soniox、Google、SMTP 密钥，也不会调用任何外部 provider。迁移前仍应把 `/var/lib/even-agent` 视为敏感个人数据。

## 1. 当前数据模型

- `assistant-memory.sqlite` 是 conversation session、topic、turn、message、摘要和迁移记录的唯一权威来源。
- 旧版 `${EVEN_DATA_DIR}/conversations/<UUID>.json` 只作为待迁移输入；成功导入后仍保留，直到备份和人工核对完成。
- `jobs.sqlite`、Calendar OAuth 文件、邮件状态、成本账本和生成文件保持独立，不会被 conversation retention 连带删除。
- SQLite 历史主要占用磁盘。服务只分页读取近期消息，并通过有界摘要构建模型上下文，不会把三年历史全部常驻 RAM。

## 2. 迁移前检查

先确认当前 release 已包含迁移入口：

```bash
cd /opt/even-agent/current
npm run sessions:migrate -- --data-dir=/var/lib/even-agent
```

不带 `--apply` 永远是 dry-run。它只验证 UUID 文件名、普通文件、大小和 JSON schema，不创建数据库、不移动文件。输出只有文件名、计数和安全错误码，不打印对话正文。

在正式迁移前创建并验证备份：

```bash
sudo systemctl start even-agent-backup.service
sudo /usr/local/sbin/even-agent-restore-check
```

如果任一步失败，停止，不要继续迁移。

## 3. Linux 正式迁移

迁移必须独占 `assistant-memory.sqlite`，因此先停止服务：

```bash
sudo systemctl stop even-agent.service
sudo -u even-agent \
  /usr/local/bin/node /opt/even-agent/current/src/legacy-session-import-cli.js \
  --data-dir=/var/lib/even-agent
```

再次确认 dry-run 的 `errors=0`。然后显式加入 `--apply`：

```bash
sudo -u even-agent \
  /usr/local/bin/node /opt/even-agent/current/src/legacy-session-import-cli.js \
  --data-dir=/var/lib/even-agent --apply
sudo systemctl start even-agent.service
```

成功文件按 SHA-256 写入 import ledger，重复运行只报告 duplicate，不重复创建 session/message。非法、截断或超限的普通 JSON 在 apply 模式被移动到 `conversations/.quarantine/`；符号链接绝不跟随，也不会自动移动。单个文件失败不阻塞其他合法文件，每个 session 的写入均在独立 transaction 内完成。

迁移后检查：

```bash
curl --fail --silent http://127.0.0.1:3001/healthz
curl --fail --silent http://127.0.0.1:3001/internal/health/storage
sudo systemctl status even-agent.service --no-pager
```

在人工核对和下一份完整备份通过前，不删除原 JSON 或 quarantine。不要把这些文件上传到公开 Issue。

## 4. 三年留存

默认配置：

```dotenv
SESSION_RETENTION_DAYS=1095
SESSION_DATABASE_WARNING_MB=1024
SESSION_DISK_FREE_WARNING_MB=2048
```

服务启动时以及之后每 24 小时运行一次维护。只有 `ended`／`expired` 且 `ended_at` 严格早于 Unix-time cutoff 的 session 才可删除。active／idle session、边界时刻以及存在 `queued`／`running`／`unknown` 摘要任务的 session 均保留。删除使用 transaction 和 foreign-key cascade，不留下 orphan rows。

`SESSION_RETENTION_DAYS=0` 只表示明确关闭自动 conversation 清理；容量 warning 仍继续工作，也不会因为 warning 擅自删除数据。修改 `/etc/even-agent.env` 后需要重启服务。

需要人工预览时，先停止服务（maintenance CLI 也要求 SQLite 独占），默认命令不会删除：

```bash
sudo systemctl stop even-agent.service
cd /opt/even-agent/current
sudo -u even-agent /usr/local/bin/node src/conversation-maintenance-cli.js \
  --data-dir=/var/lib/even-agent
```

核对 `eligible_sessions`／`eligible_messages` 后，只有明确决定执行时才加 `--apply`。完成后重新启动服务。输出仅包含计数、字节数和 warning code。

`/internal/health/storage` 只允许回环地址访问，返回 SQLite 字节数、可用磁盘、session/message 数和 warning code，不返回正文、session ID 或凭证。Caddy 不代理该路径。公开 `/healthz` 仍只返回最小状态。

## 5. 备份与恢复边界

每日备份会先停止服务，因此已提交的 main DB 与 WAL 状态会一起进入 archive。恢复检查会：

1. 校验 checksum、相对路径并拒绝链接；
2. 对每个 SQLite 运行 `integrity_check`；
3. 对 `assistant-memory.sqlite` 运行 `foreign_key_check`；
4. 验证 session/message/turn 引用及 sequence；
5. 读取最新 session、committed message 和 summary metadata，但不输出正文；
6. 在隔离恢复目录重新打开 conversation store。

自动检查绝不覆盖生产目录。真正恢复仍须遵循 [监控、备份与恢复](MONITORING_BACKUP_RECOVERY.md) 的人工 gate。
