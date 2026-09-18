# Tailscale 私有管理通道

Tailscale 用于从受信任电脑通过私有 WireGuard 网络管理 Linux 服务器。它适合 SSH、SFTP 和 WinSCP，但不替代公开的 HTTPS/WSS 服务。

本方案明确保持：

- `Tailscale SSH` 关闭；继续使用系统原生 OpenSSH 和 SSH 私钥。
- 不接受其他节点发布的 DNS 或子网路由。
- 不把服务器配置成 exit node。
- 不新增 Lightsail/云防火墙公网端口。

这样可以保留已有 SSH 加固和回滚路径，也避免 Tailscale 接管端口 22 的认证流程。

## 1. 安装前检查

确认：

```bash
cat /etc/os-release
uname -m
sudo systemctl is-active even-agent
sudo ufw status verbose
```

本指南的仓库地址适用于 Ubuntu 24.04 `noble`。其他发行版必须从 Tailscale 官方安装页选择对应命令，不能直接复制 `noble` 配置。

## 2. 添加官方签名软件源

不使用 `curl | sh`，而是分别下载 GPG key 和 apt source，先核对 source 行，再安装：

```bash
sudo install -d -m 0755 /usr/share/keyrings

curl -fsSL --proto '=https' --tlsv1.2 \
  https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg \
  -o /tmp/tailscale.gpg

curl -fsSL --proto '=https' --tlsv1.2 \
  https://pkgs.tailscale.com/stable/ubuntu/noble.tailscale-keyring.list \
  -o /tmp/tailscale.list

grep -Fx \
  'deb [signed-by=/usr/share/keyrings/tailscale-archive-keyring.gpg] https://pkgs.tailscale.com/stable/ubuntu noble main' \
  /tmp/tailscale.list

sudo install -o root -g root -m 0644 \
  /tmp/tailscale.gpg /usr/share/keyrings/tailscale-archive-keyring.gpg
sudo install -o root -g root -m 0644 \
  /tmp/tailscale.list /etc/apt/sources.list.d/tailscale.list
rm -f /tmp/tailscale.gpg /tmp/tailscale.list
```

如果 `grep` 没有原样输出预期行，停止安装并重新查看官方说明；不要忽略差异。

## 3. 安装和启动 daemon

```bash
sudo apt-get update
sudo env DEBIAN_FRONTEND=noninteractive \
  apt-get install -y --no-install-recommends tailscale
sudo systemctl enable --now tailscaled

tailscale version
systemctl is-enabled tailscaled
systemctl is-active tailscaled
```

预期服务为 `enabled` 和 `active`。安装 Tailscale 不会自动把设备加入你的 tailnet。

## 4. 加入私人 tailnet

```bash
sudo tailscale up \
  --hostname=even-g2-calendar-prod \
  --accept-dns=false \
  --accept-routes=false \
  --ssh=false
```

终端会显示一次性登录 URL。只在你控制的浏览器打开，不要把链接发到聊天、工单、Git 或截图中。选择自己的身份提供商登录并批准这台服务器。

授权完成后，原命令返回。验证：

```bash
tailscale status
tailscale ip -4
tailscale debug prefs
```

检查：

- 设备名称正确；
- 有一个 `100.x.y.z` Tailscale IPv4；
- `Tailscale SSH` 未启用；
- 没有启用 exit node、子网路由或接受其他节点 DNS；
- `even-agent` 和 Caddy 状态未被改变。

## 5. 在管理电脑安装客户端

从 Tailscale 官方下载与你的操作系统匹配的客户端，使用**同一个 tailnet 账号**登录。然后：

Windows 也可以使用官方 WinGet 包：

```powershell
winget install --id Tailscale.Tailscale --exact --source winget
winget install --id WinSCP.WinSCP --exact --source winget
```

安装后从系统托盘打开 Tailscale，选择 **Log in**，并在浏览器中使用同一个 tailnet 身份完成授权。不要把登录 URL、验证码或浏览器会话交给他人。Windows 客户端状态查询可能需要管理员终端，这是本机服务权限边界，不代表应开启服务器密码登录。

验证私网路径：

```powershell
tailscale ping <server-magicdns-name>
Test-NetConnection -ComputerName <server-magicdns-name> -Port 22
```

只有 `TcpTestSucceeded` 为 `True` 才继续配置 WinSCP。

```text
ping <server-tailscale-ip>
ssh <admin-user>@<server-tailscale-ip>
```

这里的 SSH 仍然要求原有私钥；Tailscale 只提供私有网络路径。首次连接仍要核对 SSH host key，不能因为地址是 `100.x` 就忽略 host key 警告。

## 6. WinSCP 设置

第一次使用时，建议直接按照独立的 [WinSCP 登录 Lightsail 分步指南](WINSCP_LIGHTSAIL.md) 操作；本节只保留安全配置摘要。

在 Windows WinSCP 创建站点：

| 字段 | 值 |
| --- | --- |
| File protocol | SFTP |
| Host name | 服务器的 Tailscale IP 或 MagicDNS 名称 |
| Port | 22 |
| User name | 管理员 Linux 用户，例如 `ubuntu` |
| Password | 留空；使用私钥 |
| Private key | 对应服务器 `authorized_keys` 的本地私钥 |

首次连接保存前核对 host key 指纹。不要在 WinSCP 中保存 root 密码，也不要允许密码 SSH。

Lightsail 下载的密钥可能是旧 PEM 格式。WinSCP 能识别但不会直接用它登录。不要修改唯一的原始 PEM；用 WinSCP 自带的 `/keygen` 在用户的 `.ssh` 目录生成 PPK 副本：

```powershell
$winscp = '<path-to-WinSCP.com>'
$sourceKey = '<path-to-original-lightsail.pem>'
$ppkKey = "$env:USERPROFILE\.ssh\even-g2-lightsail.ppk"

& $winscp /keygen $sourceKey "/output=$ppkKey" '/comment=Even G2 Lightsail via Tailscale'

icacls $ppkKey /inheritance:r
icacls $ppkKey /grant:r "$env:USERNAME`:(R,W)"
```

保留原始 PEM 作为受保护的恢复凭据；PPK 只允许当前 Windows 用户读写。不要把 PEM、PPK、WinSCP 日志或包含真实密钥路径的测试脚本放进仓库。WinSCP 站点可以保存主机名、用户名、PPK 路径和已核验的 host key，但不要保存密码。

在接受首次 SSH host key 前，通过 AWS/Lightsail 浏览器 SSH 或另一条可信管理路径读取服务器指纹：

```bash
sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

只有 WinSCP 显示的 SHA-256 指纹完全一致时才接受。不要使用 `accept any host key`。

上传规则：

1. 只上传到 `/home/<admin-user>/staging/` 之类的暂存目录。
2. 不直接写 `/opt/even-agent`、`/etc` 或 `/var/lib/even-agent`。
3. 在 SSH 中检查文件名、大小和必要时的 SHA-256。
4. 使用 `sudo install` 设置明确的 owner 和 mode。
5. Secret 安装完成后清理暂存副本；删除前确认准确路径和备份状态。

安装 OAuth 文件示例：

```bash
sudo install -o even-agent -g even-agent -m 0600 \
  /home/<admin-user>/staging/google-oauth-client.json \
  /var/lib/even-agent/google-oauth-client.json

sudo install -o even-agent -g even-agent -m 0600 \
  /home/<admin-user>/staging/google-calendar-auth.json \
  /var/lib/even-agent/google-calendar-auth.json
```

不要在 WinSCP 内直接编辑 Secret；编辑器缓存和自动备份可能留下副本。

## 7. 公网 SSH 与 Tailscale 的关系

Tailscale 成功后，可以进一步缩小云防火墙的 TCP 22 来源，但不要立即移除最后的恢复入口。推荐顺序：

1. 从管理电脑通过 Tailscale IP 完成一次密钥 SSH。
2. 保持该会话打开，再开第二个 Tailscale SSH 会话。
3. 确认 AWS/Lightsail 浏览器 SSH 或恢复控制台仍可用。
4. 再把云防火墙 22 限制到平台要求或你的固定管理来源。

UFW 仍保留 SSH 规则，云防火墙负责阻止公网扫描。不要为了 Tailscale 开放 UDP 41641 入站；Tailscale 可以通过出站连接和 DERP 工作，是否允许直接 UDP 应依据实际网络和威胁模型评估。

## 8. Key expiry

Tailscale 新 tailnet 的设备 node key 默认通常为 180 天。远程服务器过期后，私网管理会中断，但公开 HTTPS 服务不受影响。

可选择：

- 保持 key expiry：安全性更高，需要定期重新认证；
- 对这台受信任服务器禁用 key expiry：维护更省事，但一旦设备凭据泄漏，访问持续时间更长。

如果选择禁用，在 Tailscale Admin Console 的 Machines 页面找到准确设备，使用设备菜单的 **Disable key expiry**。这属于持续访问策略变更，应在确认设备身份后手动完成。无论是否禁用，都要保留 AWS 控制台恢复路径，并定期检查 tailnet 设备列表。

过期的服务器不能通过已经失效的 Tailscale 通道“自己登录回来”。`tailscale up --force-reauth` 会生成新的授权流程，并可能立刻切断当前 Tailscale 连接；必须使用 AWS 浏览器 SSH、云控制台或另一条独立恢复路径执行。不要把长期、可复用 auth key 留在服务器上作为自动恢复方案。

对单人维护、长期在线且有 AWS 恢复入口的服务器，实用折中是：仅对这台服务器禁用 key expiry；Windows 笔记本和手机仍保留定期过期。这样减少远程服务器失联风险，同时限制永久凭据的范围。服务器丢失、重建或疑似被入侵时，应立即从 Machines 页面移除该设备。

## 9. 访问控制

个人 tailnet 也应遵守最小权限：

- 只允许自己的受信任设备加入；
- 删除或禁用丢失、出售、退役的设备；
- Tailscale 账号开启 MFA；
- 定期查看 Machines 和 Users；
- 如果未来增加其他用户，使用 Grants/ACL 只允许管理设备访问服务器的 TCP 22，而不是沿用宽松默认策略；
- 不在 Git 中保存 auth key、API token、一次性登录 URL 或完整 `tailscale status --json` 输出。

## 10. 验收

服务器：

```bash
systemctl is-enabled tailscaled
systemctl is-active tailscaled
tailscale status
tailscale ip -4
sudo ss -lntup
sudo ufw status verbose
sudo systemctl is-active even-agent caddy
```

管理电脑：

```text
1. Tailscale 客户端显示 Connected。
2. 可以 ping 或 tailscale ping 服务器。
3. SSH/SFTP 使用 Tailscale IP 成功。
4. 仍然需要正确 SSH 私钥。
5. 公开域名 HTTPS/WSS 仍正常。
6. 公网 http://<server-ip>:3001 仍失败。
```

## 11. 故障排查

| 现象 | 检查 |
| --- | --- |
| `tailscale status` 显示 Logged out | 重新运行受控的 `tailscale up`，使用本次 URL 登录 |
| 管理电脑看不到服务器 | 是否登录同一 tailnet、设备是否待批准、访问策略是否允许 |
| 能 ping 但 SSH 失败 | OpenSSH 服务、UFW、用户名、私钥和 `authorized_keys`；不要打开密码登录 |
| WinSCP 报 host key 改变 | 停止连接，使用云控制台核对服务器 host key；不要盲点接受 |
| 服务器 key 过期 | 通过 AWS 控制台恢复并重新认证，或在 Admin Console 延长/调整；不要删除重建服务器 |
| Tailscale 正常但应用不可用 | Tailscale 不是应用反代；检查 `even-agent`、Caddy、DNS 和 443 |

## 12. 升级与移除

升级：

```bash
sudo apt-get update
sudo apt-get install --only-upgrade tailscale
tailscale version
systemctl is-active tailscaled
```

移除设备前先确认还有 AWS 控制台或另一条 SSH 路径。设备退出/删除会中断私网连接，因此不要从正在使用的唯一 Tailscale SSH 会话中操作。

官方参考：

- [Install Tailscale on Linux](https://tailscale.com/docs/install/linux)
- [Stable package repository](https://pkgs.tailscale.com/stable/)
- [SSH over Tailscale](https://tailscale.com/docs/reference/ssh-over-tailscale)
- [Tailscale SSH differences](https://tailscale.com/docs/features/tailscale-ssh)
- [Key expiry](https://tailscale.com/docs/features/access-control/key-expiry)
- [Access control](https://tailscale.com/docs/features/access-control)
