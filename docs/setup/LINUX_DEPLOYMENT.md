# Linux 后端部署：从零到可验收

本指南以 Ubuntu 24.04 LTS 和单用户自建后端为基线，AWS Lightsail 只是示例厂商。其他云主机也可以使用，但必须提供静态公网 IP、可配置防火墙、持久磁盘和系统控制台。

> 安全原则：先收紧防火墙和 SSH，再复制任何密钥或个人数据。每完成一个阶段就验证，不要一次性执行未知脚本。

## 1. 准备清单

你需要：

- 一台 Ubuntu 24.04 LTS 服务器；建议至少 2 vCPU、2 GB RAM、40 GB SSD。
- 一个静态公网 IPv4 地址。
- 一个专用子域名，例如 `<your-domain.example>`，DNS A 记录指向该静态 IP。
- 可以进入服务器的云厂商控制台，以及一把本地备份的 SSH 私钥。
- 本地开发机上的干净源码和 Node.js 24+。
- 已在本地准备好的私密配置；不要把这些内容放进镜像、启动脚本、Git、工单或聊天记录。

## 2. AWS 账号和 Lightsail 实例

如果使用 AWS，先把账号管理和应用主机分开：

1. Root account 开启 MFA，只用于账单、账号恢复和少数必须由 root 完成的操作。
2. 日常使用 IAM Identity Center 用户登录，不长期使用 root。
3. 为 Even G2 项目建立独立 permission set/角色，只授予所需的 Lightsail 管理和只读账单权限。不要把 root access key 保存到电脑或服务器。
4. 创建 AWS Budget，并设置多个阈值通知。**Budget 是预警，不是硬封顶**；AWS Lightsail 套餐限制实例规格，但快照、流量、DNS 或其他服务仍可能额外计费。
5. 定期查看 Cost Explorer/Billing，确认没有遗留实例、磁盘、静态 IP、快照或其他区域资源。

创建 Lightsail 实例时：

- 选择距离主要使用地点较近的单一区域；第一版不做多区域复制。
- 镜像选择 Ubuntu 24.04 LTS。
- 个人单用户建议从至少 2 vCPU、2 GB RAM 的套餐开始，再根据内存和延迟监控调整。
- 创建并绑定静态 IP，DNS 永远指向静态 IP，不指向可能变化的临时地址。
- 开启自动快照，并确认保留数量和费用。快照可用于误操作/升级回滚，但不是入侵后的可信恢复证明。
- 下载并加密备份实例 SSH 私钥；同时验证 Lightsail 浏览器 SSH，以免换电脑后失去恢复通道。
- 不要把任何 API key、OAuth JSON 或 `.env` 放进 Launch Script/User Data；它们可能出现在控制台历史或实例元数据中。

实例创建完成后，先记录区域、实例名、静态 IP、快照策略和恢复流程，再继续配置网络。

## 3. 云防火墙

在云厂商控制台只开放：

| 协议/端口 | 来源 | 用途 |
| --- | --- | --- |
| TCP 80 | Internet | ACME 证书验证及重定向到 HTTPS |
| TCP 443 | Internet | HTTPS 和 WSS |
| TCP 22 | 管理员 IP、云厂商浏览器 SSH 所需来源，或临时受控范围 | 密钥 SSH |

不要开放 25、465、587、3001、3002、数据库端口或宽泛端口区间。SMTP、OpenAI 和 Google API 都是**出站连接**，不需要入站端口。

如果平台分别管理 IPv4 和 IPv6，请同步检查两套规则。没有使用 IPv6 时，不要因为忘记配置而留下更宽松的 IPv6 入口。

## 4. 首次登录与更新

先保留当前云控制台会话，再执行系统更新：

```bash
sudo apt-get update
sudo apt-get upgrade -y
sudo apt-get install -y ca-certificates curl gnupg ufw unattended-upgrades
```

确认系统版本和时间：

```bash
cat /etc/os-release
timedatectl
```

服务器系统时区保持 UTC。应用通过一次性当前位置和 Google Time Zone API 解析 Calendar 的相对本地时间；显式指定的事件时区优先。`CONVERSATION_TIMEZONE` 仍用于配额日界线及无定位组件的离线工具，不应通过修改服务器系统时区修复日历问题。

## 5. 主机防火墙 UFW

**先允许 SSH，再启用 UFW**，否则可能把自己锁在外面：

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw limit 22/tcp comment 'SSH rate limit'
sudo ufw allow 80/tcp comment 'Caddy HTTP ACME redirect'
sudo ufw allow 443/tcp comment 'Caddy HTTPS WSS'
sudo ufw enable
sudo ufw status verbose
```

预期结果是 `Status: active`、默认拒绝入站，并且只有 22、80、443 的入站规则。UFW 不是云防火墙的替代品；两层都要配置。

## 6. SSH 加固，且避免锁死

1. 确认密钥登录已经成功。
2. 保持第一个 SSH 会话打开，再新开第二个会话验证。
3. 确认云厂商浏览器 SSH 或恢复控制台可用。
4. 修改 SSH 配置，使 `PasswordAuthentication no`、`PermitRootLogin no`。
5. 先运行 `sudo sshd -t`；只有无输出且第二个密钥会话能登录时，才重新加载 SSH。

Ubuntu 24.04 可能通过 `/etc/ssh/sshd_config.d/*.conf` 覆盖主文件。不要只看一处配置；用以下命令查看最终值：

```bash
sudo sshd -T | grep -E 'passwordauthentication|permitrootlogin|pubkeyauthentication'
```

如果验证失败，不要关闭仍可用的会话。先修复配置，再重新验证。

## 7. 安装 Node.js 24 和 Caddy

### Node.js 24

本项目的 systemd 模板预期 `/usr/local/bin/node`。下面使用 Node.js 官方二进制包；先在 [Node.js 官方 latest-v24.x 目录](https://nodejs.org/download/release/latest-v24.x/) 查看当前完整版本号，并把示例版本替换掉。不要把 `latest` 当成 24 系列，因为它可能已经是更高的非 LTS 主版本。

```bash
cd /tmp
NODE_VERSION=v24.21.0       # 示例；先去官方目录确认当前 v24.x
NODE_ARCH=linux-x64         # ARM64 主机改为 linux-arm64

curl -fsSLO --proto '=https' --tlsv1.2 \
  "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-${NODE_ARCH}.tar.xz"
curl -fsSLO --proto '=https' --tlsv1.2 \
  "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt"

grep " node-${NODE_VERSION}-${NODE_ARCH}.tar.xz$" SHASUMS256.txt | sha256sum -c -
```

只有校验结果为 `OK` 才安装：

```bash
sudo tar -xJf "node-${NODE_VERSION}-${NODE_ARCH}.tar.xz" \
  -C /usr/local --strip-components=1 --no-same-owner

/usr/local/bin/node --version
/usr/local/bin/npm --version
```

如果机器上已有其他 Node 安装，先用 `command -v node`、`readlink -f "$(command -v node)"` 和 `node --version` 确认来源。不要让 systemd 与交互 shell 使用两个不同主版本。

### Caddy

使用 Caddy 官方 Ubuntu/Debian 软件源：

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
sudo chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg
sudo chmod o+r /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update
sudo apt-get install -y caddy

caddy version
systemctl is-enabled caddy
systemctl is-active caddy
```

Caddy 负责 TLS 和反向代理。先确认 DNS 已解析到服务器，再安装生产 Caddyfile 并申请证书。官方安装页：[Install Caddy](https://caddyserver.com/docs/install)。

## 8. 创建最小权限服务账号和目录

```bash
sudo useradd --system --create-home --home-dir /home/even-agent --shell /usr/sbin/nologin even-agent
sudo install -d -o root -g root -m 0755 /opt/even-agent
sudo install -d -o even-agent -g even-agent -m 0700 /var/lib/even-agent
sudo install -d -o even-agent -g even-agent -m 0700 /home/even-agent/.codex
sudo install -d -o root -g root -m 0755 /var/www/even-calendar
```

代码目录由 root 管理；运行时用户只写数据目录。不要让服务用户修改 `/opt/even-agent` 或 Caddy 网站目录。

## 9. 在开发机生成 server-only 发布包

在本地仓库根目录运行：

```bash
npm ci
npm run typecheck
npm test
npm run audit:public
npm run build:server
```

构建命令会输出一个新的 `dist/server-*` 目录。只部署这个目录，并检查其中的 `BUILD-MANIFEST.json`。它不应包含：

- `.env`、`.local/` 或 OAuth JSON；
- `web/` 实验室、Even 模拟器、tests 或录音；
- Git 元数据、编辑器配置、日志、数据库；
- Windows `node_modules`。

不要把整个仓库复制到服务器。

## 10. 安全上传和原子发布

可以使用 SFTP/WinSCP 或 `scp` 把发布包上传到管理员家目录下的临时目录。不要直接覆盖正在运行的 `/opt/even-agent`，也不要以 root 身份运行图形文件传输客户端。

推荐流程：

```bash
# 服务器上：检查临时目录，不要把路径替换成 / 或 home 根目录
find /home/<admin-user>/even-release -maxdepth 3 -type f -printf '%P\n' | sort

sudo systemctl stop even-agent
sudo rsync -a --delete /home/<admin-user>/even-release/ /opt/even-agent/
cd /opt/even-agent
sudo npm ci --omit=dev
sudo chown -R root:root /opt/even-agent
sudo find /opt/even-agent -type d -exec chmod 0755 {} \;
sudo find /opt/even-agent -type f -exec chmod 0644 {} \;
```

`rsync --delete` 只能针对已经核对的发布目录和 `/opt/even-agent/` 使用。路径不明确时立即停止，不要猜。

## 11. 私密配置

打包后的 Even App 页面可能使用每次启动变化的 `http://127.0.0.1:<port>` Origin。
需要真机连接时，在私密环境文件里显式设 `EVEN_ALLOW_LOOPBACK_ORIGIN=true`；默认关闭，
只接受精确的 `true` / `false`，其他值（包括空值、大小写和空白变体）会在打开数据库前拒绝启动。
这不是任意 Origin 或域名通配符：仅允许规范形式的 HTTP、精确主机 `127.0.0.1`、
显式端口 1–65535；URL 会规范化掉的默认端口 80 也不接受。localhost、IPv6、HTTPS 回环、
其他 IP、路径和用户信息均不允许。公网 Host 和原有网页 Origin 检查保持不变。
本机回环 Origin 不是认证或 Even 身份证明；仍须通过 token／设备认证，保持访客隔离和限流，
3001 仍只监听本机。多用户共用服务器需要另做账号与数据隔离，不能共享主人 token。
本次仅处理 WebSocket，不增加 HTTP CORS 响应头；以后插件直接请求 HTTP 接口时，
CORS 应使用同一条严格 Origin 规则，并保留接口认证。
握手放行只记录 `origin_accepted`、`kind=loopback` 和端口，不代表认证成功。
本次无需重打 EHPK；部署后按真机清单验证重开、网络切换和新手机授权，不以离线测试代替。

创建 `/etc/even-agent.env`，所有真实值只存在服务器私密文件或密码管理器：

```dotenv
OPENAI_API_KEY=<secret>
DIALOGUE_PROVIDER=api
G2_CLIENT_TOKEN=<at-least-32-random-characters>
STT_PROVIDER=soniox
SONIOX_API_KEY=<secret>
SONIOX_TRANSCRIBE_MODEL=stt-rt-v5
# Optional rollback only:
OPENAI_TRANSCRIBE_MODEL=gpt-live-transcribe
OPENAI_TRANSCRIBE_USD_PER_MINUTE=0.017
OPENAI_INTENT_MODEL=<model-name>
OPENAI_REPLY_MODEL=<model-name>
OPENAI_WEB_SEARCH=true
OPENAI_MAX_SEARCH_CALLS=10
OPENAI_SEARCH_SESSION_LIMIT=50
OPENAI_SEARCH_DAILY_LIMIT=100
OPENAI_SEARCH_MONTHLY_LIMIT=1200
COST_TOTAL_MONTHLY_USD=80
COST_OPENAI_MONTHLY_USD=50
COST_SONIOX_MONTHLY_USD=20
COST_GOOGLE_MONTHLY_USD=10
# Keep these aligned with the deployed OpenAI model's official pricing.
OPENAI_INPUT_USD_PER_M=0.20
OPENAI_CACHED_INPUT_USD_PER_M=0.02
OPENAI_CACHE_WRITE_USD_PER_M=0.25
OPENAI_OUTPUT_USD_PER_M=1.20
OPENAI_WEB_SEARCH_USD_PER_CALL=0.01
CONVERSATION_PORT=3001
CONVERSATION_TIMEZONE=America/Chicago
EVEN_PUBLIC_HOST=<your-domain.example>
EVEN_PUBLIC_ORIGIN=https://<your-domain.example>
GOOGLE_CALENDAR_ACCOUNT=<assistant-account@example.com>
GOOGLE_CALENDAR_NAME=Even Assistant
GOOGLE_CALENDAR_ENABLED=true
# Only after local route acceptance and Maps key/IP/API restrictions are complete:
GOOGLE_MAPS_ENABLED=false
GOOGLE_MAPS_API_KEY=<restricted-server-key>
EVEN_EMAIL_ENABLED=true
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=<assistant-account@example.com>
SMTP_PASS=<gmail-app-password>
EMAIL_FROM=<assistant-account@example.com>
EMAIL_TO=<fixed-recipient@example.com>
EMAIL_AI_SUMMARY=true
```

`GOOGLE_MAPS_ENABLED` 在本地人工路线验收前保持 `false`。启用前按
[Google Maps 路线指南](GOOGLE_MAPS_ROUTES.md) 把 key 限制到 Places API
(New)、Routes API 和 Lightsail 静态出口 IP。Calendar OAuth 文件不能代替该
key。OpenAI 的 `$50/月` project hard limit 必须在 API Dashboard 单独开启；
环境变量中的 `$80/月` 跨 provider 账本是应用层纵深保护，不能替代 provider 控制台预算。

这只是字段清单。不要把真实文件放进仓库，也不要把 Secret 作为 shell 命令参数写入历史。安装后设置：

```bash
sudo chown root:root /etc/even-agent.env
sudo chmod 0600 /etc/even-agent.env
```

首次创建之后的 key／Secret 轮换不要直接从 WinSCP 覆盖 `/etc`。应使用
[WinSCP 手册中的生产 `.env` 轮换流程](WINSCP_LIGHTSAIL.md#11-安全轮换生产-env)：
经 Tailscale SFTP 上传到管理员的 `0700` 暂存目录，独立核验 SSH host key，
只检查键名和格式、不打印值。若服务器含有本地文件没有的生产专用字段，必须以当前
生产文件为基底、只按 allowlist 合并待轮换凭据，禁止整文件覆盖；随后在 `/etc` 内
原子替换，保留短期 root-only 回滚副本，
重启后验证权限、回环健康与公开 HTTPS，再清理临时副本。

Google 私密文件放在：

```text
/var/lib/even-agent/google-oauth-client.json
/var/lib/even-agent/google-calendar-auth.json
```

它们应属于 `even-agent:even-agent` 且权限为 `0600`。不要把 OAuth JSON 存到 `/var/www`、`/opt/even-agent` 或日志中。

## 12. 安装 systemd 服务

```bash
sudo install -o root -g root -m 0644 /opt/even-agent/current/deploy/even-agent.service /etc/systemd/system/even-agent.service
sudo systemd-analyze verify /etc/systemd/system/even-agent.service
sudo systemctl daemon-reload
sudo systemctl enable --now even-agent
sudo systemctl is-enabled even-agent
sudo systemctl is-active even-agent
```

查看近期日志时不要输出环境变量：

```bash
sudo journalctl -u even-agent -n 50 --no-pager
```

如果服务失败，先看 `systemctl status` 和日志，再检查 Node 路径、文件权限、JSON 格式和端口占用。不要把整个 `.env` 打印出来排错。

## 13. Caddy 与静态说明页

将 `deploy/Caddyfile` 中的域名换成你的专用子域名，并安装静态页面。为了让后续精确漂移检查成立，自托管 fork 应把这个非 Secret 的域名配置保存在自己的受保护部署分支中；不要只修改服务器上的 `/etc/caddy/Caddyfile`，否则它会被正确报告为漂移：

```bash
sudo install -o root -g root -m 0644 /opt/even-agent/current/deploy/site/calendar/index.html /var/www/even-calendar/index.html
sudo install -o root -g root -m 0644 /opt/even-agent/current/deploy/site/calendar/privacy.html /var/www/even-calendar/privacy.html
sudo install -o root -g root -m 0644 /opt/even-agent/current/deploy/Caddyfile /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy 只代理 `/ws/conversation` 和 `/artifacts/*` 到 `127.0.0.1:3001`。不要使用全站无条件反向代理，也不要让 Caddy 读取 `/etc/even-agent.env` 或 `/var/lib/even-agent`。

## 13.1 运维文件漂移检查

完成 updater、监控、备份和 Caddy 的生产安装后，从当前已验证 release 安装只读检查器。不要使用 `/dev/stdin`、临时目录或 `/opt/even-agent` 顶层的旧 bootstrap 副本作为 root 脚本来源：

```bash
sudo install -o root -g root -m 0755 /opt/even-agent/current/deploy/even-agent-drift-check.sh /usr/local/sbin/even-agent-drift-check
sudo even-agent-drift-check
```

成功时输出 `OK ... operational files match the current release` 并返回 `0`。返回 `1` 时会逐项输出 `DRIFT <installed> != <source>`，表示已安装副本缺失或与当前 release 不同；返回 `2` 时输出 `SOURCE_MISSING <source>`，表示当前 release 删除或改名了映射中的源文件。任何非零结果都必须先审阅 diff，再从 `/opt/even-agent/current/deploy/` 手动安装；检查器本身只读，不会自动覆盖系统文件。

## 14. 上线验收

服务器内部：

```bash
sudo systemctl is-active even-agent caddy
sudo even-agent-drift-check
sudo ss -lntup
sudo ufw status verbose
sudo stat -c '%n %U:%G %a' \
  /etc/even-agent.env \
  /var/lib/even-agent \
  /var/lib/even-agent/google-oauth-client.json \
  /var/lib/even-agent/google-calendar-auth.json
sudo systemd-analyze security even-agent.service --no-pager
```

预期 Node 只监听 `127.0.0.1:3001`。Caddy 监听 80/443，SSH 监听 22。`systemd-analyze security` 是辅助指标，不是“没有漏洞”的证明。

从另一台机器验证：

```bash
curl -I https://<your-domain.example>/
curl -I https://<your-domain.example>/artifacts/00000000-0000-0000-0000-000000000000
curl --connect-timeout 5 http://<server-ip>:3001/
```

预期依次为有效 HTTPS、安全响应头、附件 `401`、公网 3001 连接失败。应用令牌只放在客户端 Authorization header 或 WebSocket 首条鉴权消息中，绝不能放 URL。

最后重启一次服务并复查：

```bash
sudo systemctl restart even-agent
sudo systemctl is-active even-agent
sudo ss -lntp | grep 127.0.0.1:3001
```

## 15. 更新、回滚和备份

- 默认手动部署，开发及真机验收期间保持 `even-agent-update.timer` disabled/inactive。自动更新需要管理员显式创建启用标记并开启 timer；使用 release 目录与原子 `current` symlink，不要在生产目录直接 `git pull`。安装、停用、恢复及回滚步骤见 [Linux 自动更新与回滚](AUTOMATIC_UPDATES.md)。
- 更新前做快照或一致性备份；SQLite 使用 WAL 时不要只复制主 `.sqlite` 文件。
- 新版本先在独立临时目录解压、检查 manifest、安装依赖和运行自检，再短暂停机切换。
- 保留上一份经过验证的 server-only 发布包，以便回滚代码；Secret 和数据不应打包进代码回滚文件。
- 回滚后仍要运行端口、权限、HTTPS、日历只读和 WebSocket 鉴权检查。
- 云快照不是入侵防护，也不是唯一备份。快照可能包含个人数据和 Secret，应受账号 MFA、最小权限和保留策略保护。

## 16. 常见故障

| 现象 | 检查顺序 |
| --- | --- |
| `EADDRINUSE 127.0.0.1:3001` | `ss -lntp` 查占用者；不要启动第二个后端共享同一数据目录 |
| Caddy 证书失败 | DNS 是否已传播、80/443 两层防火墙是否开放、系统时间是否正确 |
| 服务启动但公网不可用 | Caddy 状态、Caddyfile host、UFW、云防火墙、DNS；不要开放 3001 绕过 |
| Google 连接失败 | 先运行只读检查；核对 OAuth 文件权限和 Production 授权，不打印 token |
| 邮件失败 | 只做 SMTP `verify()`；核对 465/587 与 `SMTP_SECURE` 配对，不开放入站 SMTP |
| 换电脑无法维护 | 使用云控制台恢复、备份 SSH 私钥或 Tailscale；不要把私钥提交 Git |

## PI-3 历史检索部署注意

PR #59 补强后，主人历史检索在 `EVEN_HISTORY_RECALL_ENABLED` 未设置时默认开启；访客始终关闭。Linux 部署前必须显式设置 `EVEN_HISTORY_RECALL_ENABLED=false`，直到当次数据库副本迁移演练及同步查询对语音主循环的 p95 影响评估通过，再单独批准开启。不要直接沿用 `.env.example` 的 `true` 作为生产验收结论。

schema v14 会修复 v13 的历史索引作用域过滤并重建索引。部署前保留一致性备份，在副本验证数据、索引完整性和耗时；旧代码拒绝写入 v14，回滚必须恢复升级前备份。

生产启动硬门禁：`NODE_ENV=production` 或存在 systemd 的 `INVOCATION_ID` 时，若 recall 开启，必须同时精确设置 `EVEN_HISTORY_RECALL_LATENCY_ACCEPTED=true`，否则以 `HISTORY_RECALL_PRODUCTION_GATE` 失败退出。检查早于数据库打开/迁移和 provider 初始化。未验收时设 `EVEN_HISTORY_RECALL_ENABLED=false` 可正常启动；验收声明不是自动测试，也不替代迁移演练。

本次服务单元新增 `Environment=NODE_ENV=production`，部署时从 current/deploy 安装该单元、执行 daemon-reload，并按既有流程运行 drift-check。旧 systemd 单元仍由 `INVOCATION_ID` 兜底；非 systemd 的生产启动必须设置 `NODE_ENV=production`。不要把验收声明复制为默认 true；更换服务器或有影响延迟的改动后应清除声明并重新验收。
