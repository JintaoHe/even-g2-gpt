# 使用 WinSCP 通过 Tailscale 登录 AWS Lightsail

这份指南面向第一次使用 WinSCP 的维护者。目标是在 Windows 上通过 Tailscale 私网，以 SSH 私钥登录 Lightsail 的 SFTP 服务。整个过程不需要开放新的公网端口，也不启用 SSH 密码登录。

## 1. 连接结构

```text
Windows + WinSCP
       │
       │ SFTP / SSH，TCP 22
       │ Tailscale 加密私网
       ▼
AWS Lightsail Ubuntu
```

WinSCP 负责文件浏览和传输；Tailscale 只提供私有网络路径；Ubuntu 的 OpenSSH 仍负责用户名、私钥和 host key 验证。不要启用 WinSCP 的 FTP、Lightsail root 登录或 SSH 密码登录。

## 2. 开始前准备

确认以下条件全部满足：

- Windows 已安装 Tailscale 和 WinSCP；
- Windows 与 Lightsail 登录同一个 tailnet；
- Tailscale Machines 页面显示两台设备均在线；
- Lightsail 的 `tailscaled` 和 `ssh` 服务为 `active`；
- 你知道服务器的 MagicDNS 名称，或能在 Machines 页面查看它的 Tailscale IP；
- 你持有与服务器 `authorized_keys` 对应的 Lightsail 私钥；
- AWS/Lightsail 浏览器 SSH 仍可用，作为核对指纹和恢复连接的独立通道。

真实 IP、私钥、登录 URL 和 host key 指纹都不要提交到 GitHub。

## 3. 安装 Windows 客户端

在 PowerShell 中运行：

```powershell
winget install --id Tailscale.Tailscale --exact --source winget
winget install --id WinSCP.WinSCP --exact --source winget
```

安装完成后：

1. 在 Windows 系统托盘打开 Tailscale；
2. 选择 **Log in**；
3. 浏览器中使用服务器所在 tailnet 的同一个账号授权；
4. 回到托盘，确认状态为 **Connected**。

Tailscale 身份登录必须由账号本人完成。不要转发授权 URL、验证码或浏览器会话。

## 4. 先验证私网是否通畅

从 Tailscale Machines 页面复制服务器的 MagicDNS 名称。以下命令中的占位符不应原样使用：

```powershell
tailscale ping <server-magicdns-name>
Test-NetConnection -ComputerName <server-magicdns-name> -Port 22
```

继续配置 WinSCP 前，应当看到：

- `tailscale ping` 收到服务器响应；
- `TcpTestSucceeded : True`。

如果 Windows 提示无权读取 Tailscale 本地服务状态，请使用管理员 PowerShell 重试。不要因此修改服务器 SSH 权限或打开密码登录。

## 5. 把 Lightsail PEM 转换成 WinSCP PPK

Lightsail 下载的默认私钥通常是 PEM。WinSCP 能识别该格式，但登录时需要转换为 PuTTY PPK。**不要覆盖唯一的原始 PEM。**

### 方法 A：使用 WinSCP 界面

1. 打开 WinSCP 的 **Login** 窗口；
2. 选择 **New Site**，再选择 **Advanced…**；
3. 打开 **SSH > Authentication**；
4. 在 **Private key file** 选择原始 `.pem`；
5. WinSCP 提示转换时，选择确认转换；
6. 把新文件保存到 `%USERPROFILE%\.ssh\`，扩展名使用 `.ppk`；
7. 原始 `.pem` 保留在受保护的位置。

### 方法 B：使用 WinSCP 命令行

先找到 `WinSCP.com`，然后使用占位符路径运行：

```powershell
$winscp = '<path-to-WinSCP.com>'
$sourceKey = '<path-to-original-lightsail.pem>'
$ppkKey = "$env:USERPROFILE\.ssh\even-g2-lightsail.ppk"

New-Item -ItemType Directory -Path "$env:USERPROFILE\.ssh" -Force
& $winscp /keygen $sourceKey "/output=$ppkKey" '/comment=Even G2 Lightsail via Tailscale'

icacls $ppkKey /inheritance:r
icacls $ppkKey /grant:r "$env:USERNAME`:(R,W)"
```

最后确认 PPK 存在，但不要输出或打开它的内容：

```powershell
Get-Item -LiteralPath $ppkKey | Select-Object FullName, Length
```

PPK 是真正的登录凭据，不是普通配置文件。不要通过电子邮件发送，不要放进项目目录，也不要上传 GitHub。

## 6. 从可信通道获取 SSH host key 指纹

首次连接时，WinSCP 会显示服务器 host key。接受之前必须从独立可信通道取得正确指纹。

在 AWS/Lightsail 浏览器 SSH 中运行：

```bash
sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

记下完整的 SHA-256 指纹。host key 的公钥指纹不是密码，但仍不建议把实际基础设施信息写进公共仓库。

如果服务器没有 Ed25519 host key，可列出其他 host key：

```bash
for key in /etc/ssh/ssh_host_*_key.pub; do
  sudo ssh-keygen -lf "$key"
done
```

## 7. 在 WinSCP 新建 Lightsail 站点

打开 WinSCP，在 **Login > New Site** 填写：

| 字段 | 填写内容 |
| --- | --- |
| File protocol | `SFTP` |
| Host name | Lightsail 的 MagicDNS 名称；也可使用 Tailscale IP |
| Port number | `22` |
| User name | Ubuntu Lightsail 通常为 `ubuntu` |
| Password | 留空 |

然后：

1. 选择 **Advanced…**；
2. 打开 **SSH > Authentication**；
3. 在 **Private key file** 选择刚生成的 `.ppk`；
4. 返回 Login 页面；
5. 选择 **Save**；
6. 站点名称可设为 `Even G2 Lightsail (Tailscale)`；
7. 不要保存密码；
8. 选择 **Login**。

站点配置可以保存主机名、用户名、PPK 路径和已核验的 host key；它不应包含密码、私钥内容或应用 Secret。

## 8. 第一次登录时验证 host key

WinSCP 第一次连接会显示服务器指纹：

1. 与第 6 节从 AWS 浏览器 SSH 获取的 SHA-256 指纹逐字符比较；
2. 完全一致才选择 **Accept**；
3. 不一致、看不到指纹或无法确认来源时选择 **Cancel**；
4. 不使用 `Accept any host key`、通配符或跳过验证。

成功后，右侧远程目录应进入：

```text
/home/ubuntu
```

能够只读浏览该目录就足以证明 WinSCP、SFTP、SSH 私钥和 Tailscale 私网均正常。第一次验收不需要上传任何文件。

## 9. 安全上传文件

不要从 WinSCP 直接覆盖 `/opt/even-agent`、`/etc` 或 `/var/lib/even-agent`。先在服务器创建只属于管理员的暂存目录：

```bash
install -d -m 0700 /home/<admin-user>/staging
```

在 WinSCP 中：

1. 左侧选择本地文件；
2. 右侧进入 `/home/<admin-user>/staging/`；
3. 拖入需要传输的文件；
4. 不启用自动同步；
5. 不直接用 WinSCP 编辑 Secret。

上传后在 SSH 中核对文件，再安装到最终位置。例如：

```bash
ls -l /home/<admin-user>/staging
sha256sum /home/<admin-user>/staging/<uploaded-file>

sudo install -o even-agent -g even-agent -m 0600 \
  /home/<admin-user>/staging/<secret-file> \
  /var/lib/even-agent/<secret-file>
```

确认服务能读取最终文件、备份状态明确且暂存路径准确后，再清理暂存副本。不要使用宽泛路径、通配符或递归删除命令。

## 10. 日常登录流程

以后登录通常只需要：

1. 确认 Windows Tailscale 为 **Connected**；
2. 打开 WinSCP；
3. 双击已保存的 `Even G2 Lightsail (Tailscale)`；
4. 确认远程路径为 `/home/ubuntu`；
5. 只在暂存目录传输文件。

服务器重启后，`tailscaled` 会自动启动；只要设备仍在 tailnet 且 key 未过期，WinSCP 无需重新配置。若服务器节点已关闭 key expiry，它会保持授权，直到管理员手动移除该节点。

## 11. 安全轮换生产 `.env`

生产 Secret 轮换与普通文件上传不同。目标是：Secret 只经过 Tailscale
私网中的 SFTP；WinSCP 固定服务器 host key；新旧配置都不进入 Git、命令参数、
终端历史、日志或截图；最终文件在 `/etc` 内原子替换，启动失败时可以立即回滚。

### 11.1 本地预检

在项目目录检查文件存在、被 Git 忽略且未被跟踪。不要运行 `Get-Content .env`，
也不要把文件拖进浏览器、Issue、PR 或聊天窗口：

```powershell
$envFile = Join-Path (Get-Location) '.env'
Get-Item -LiteralPath $envFile | Select-Object Name, Length, LastWriteTime
git check-ignore .env
git ls-files --error-unmatch .env 2>$null
```

期望 `git check-ignore` 返回 `.env`，而 `git ls-files` 找不到它。上传前重新运行
`tailscale ping <server-magicdns-name>`，并按照第 6–8 节从 AWS 浏览器 SSH
独立核对 host key；不要使用 `Accept any host key` 或 `-hostkey=*`。

### 11.2 只上传到管理员暂存目录

先在服务器创建或确认暂存目录：

```bash
install -d -m 0700 /home/<admin-user>/staging
```

用 WinSCP/SFTP 将本地 `.env` 上传为：

```text
/home/<admin-user>/staging/even-agent.env.next
```

不要直接上传到 `/etc/even-agent.env`，不要启用同步，也不要让 WinSCP 或文本编辑器
保存远程副本。传输完成后，分别在本地和服务器计算 SHA-256，只比较是否相等；
不要把 hash 发到公开仓库：

```powershell
(Get-FileHash -Algorithm SHA256 -LiteralPath .env).Hash
```

```bash
sha256sum /home/<admin-user>/staging/even-agent.env.next
chmod 0600 /home/<admin-user>/staging/even-agent.env.next
```

### 11.3 不显示值地检查格式

以下检查只验证非注释行是否为合法的 `KEY=value`，不会输出值：

```bash
awk '
  /^[[:space:]]*($|#)/ { next }
  /^[A-Za-z_][A-Za-z0-9_]*=/ { next }
  { bad=1 }
  END { exit bad }
' /home/<admin-user>/staging/even-agent.env.next
```

如果需要比较新旧键集合，只输出键名并在 root-only 临时目录中比较；不要输出整行：

```bash
sudo install -d -o root -g root -m 0700 /run/even-agent-env-check
sudo awk -F= '/^[A-Za-z_][A-Za-z0-9_]*=/{print $1}' /etc/even-agent.env \
  | sudo sort -u > /run/even-agent-env-check/old.keys
awk -F= '/^[A-Za-z_][A-Za-z0-9_]*=/{print $1}' \
  /home/<admin-user>/staging/even-agent.env.next \
  | sort -u | sudo tee /run/even-agent-env-check/new.keys >/dev/null
sudo diff -u /run/even-agent-env-check/old.keys \
  /run/even-agent-env-check/new.keys || true
```

键名差异可能是有意新增或撤销，但必须逐项解释后才能继续。**只要服务器含有本地
文件没有的生产专用字段，就禁止整文件覆盖。** 本项目常见的生产专用字段包括公网
host/origin、监听端口、模型、时区和 provider 开关；覆盖掉它们会让服务使用错误默认值
或无法启动。

轮换现有凭据时，以 `/etc/even-agent.env` 为基底，只允许从暂存文件替换已批准的完整
行。本项目当前的凭据 allowlist 是 `G2_CLIENT_TOKEN`、`OPENAI_API_KEY`、
`SONIOX_API_KEY`、`GOOGLE_MAPS_API_KEY` 和 `SMTP_PASS`。合并脚本必须在 root-only
`/run` 目录生成候选文件，并满足以下条件后才可安装：

1. 暂存文件中五个字段各出现一次；
2. 只替换 allowlist 中的完整 `KEY=value` 行，不把值放入命令参数、日志或 shell 历史；
3. 候选文件与当前生产文件的排序后键名集合 hash 完全相同；
4. 候选文件只在 `/run` 和 `/etc` 中短暂存在，权限始终为 `0600`；
5. 任何检查失败都保持当前生产文件不变。

不要 `source` 两份 `.env`，不要用包含真实值的 `sed` 命令，也不要在 WinSCP 中直接
编辑生产文件。只有在新旧键名集合完全一致、且本地文件本来就是生产配置的 canonical
副本时，才允许按下一节做整文件原子替换。此检查不能证明 Secret 本身有效；
provider/API 的最小只读 smoke test 仍要在安装前执行。

### 11.4 原子替换、回滚与验收

键名集合一致时，先把现有配置保存为单一 root-only 回滚副本，再把完整新文件安装到
`/etc` 的临时名。若使用上一节的 allowlist 合并，则下列 `even-agent.env.next` 应当是
已在 root-only `/run` 中构造并通过键名 hash 检查的候选文件，而不是原始本地 `.env`。
`mv -T` 在同一文件系统内原子替换，避免服务读到半个文件：

```bash
sudo install -o root -g root -m 0600 \
  /etc/even-agent.env /etc/even-agent.env.rollback
sudo install -o root -g root -m 0600 \
  /home/<admin-user>/staging/even-agent.env.next \
  /etc/even-agent.env.next
sudo mv -T /etc/even-agent.env.next /etc/even-agent.env
sudo systemctl daemon-reload
sudo systemctl restart even-agent
```

若候选文件来自 `/run` 的 allowlist 合并，把第二条命令的来源路径替换为该 root-only
候选文件。不要先把候选文件复制回普通用户目录。

服务启动和监听端口之间可能相差数秒。最多等待 30 秒、每秒检查一次状态和回环健康，
超时才触发回滚；不要在 restart 返回后的第一毫秒把正常启动误判为失败。随后检查权限
和公开 HTTPS。不要用 `systemctl show` 打印 environment，也不要 `cat` 配置：

```bash
sudo systemctl is-active even-agent
sudo stat -c '%n %U:%G %a' /etc/even-agent.env
curl --fail --silent http://127.0.0.1:3001/healthz
curl --fail --silent https://<your-domain.example>/healthz
sudo journalctl -u even-agent -n 30 --no-pager
```

若 restart 或健康检查失败，立即恢复旧文件并再次检查：

```bash
sudo install -o root -g root -m 0600 \
  /etc/even-agent.env.rollback /etc/even-agent.env.next
sudo mv -T /etc/even-agent.env.next /etc/even-agent.env
sudo systemctl restart even-agent
```

确认新 key 的最小 smoke test 成功后，删除管理员暂存副本和 `/run` 中的键名清单；
回滚副本只保留到本次轮换验收完成，之后也应移除，避免服务器长期存放多份有效
Secret。清理时使用上述三个完整文件路径，不使用通配符、变量拼接或递归删除。

## 12. 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| `Unable to use key file ... old PEM format` | 仍在直接使用 PEM；按第 5 节转换为 PPK |
| `No supported authentication methods` | 私钥格式错误、选错区域的 Lightsail key、用户名错误，或公钥不在服务器 `authorized_keys` |
| `Connection timed out` | Windows/服务器 Tailscale 未连接、不同 tailnet、访问策略阻止，或 SSH 服务未运行 |
| `TcpTestSucceeded : False` | 先修复 Tailscale/SSH 路径，不要开放密码登录或公网应用端口 |
| Host key 首次出现 | 用 AWS 浏览器 SSH 独立核对后再接受 |
| Host key 突然改变 | 立即停止；确认服务器是否重建、DNS/IP 是否指向错误设备，排除中间人攻击 |
| 公网 IP 能连、MagicDNS 不能连 | 检查同一 tailnet、MagicDNS 和访问策略；可临时使用 Tailscale IP 诊断，但不要改用公网作为长期方案 |
| WinSCP 能连接但无权写系统目录 | 正常；先上传到用户暂存目录，再用 SSH 和 `sudo install` 安装 |
| 服务器显示 key expired | 从 AWS 控制台恢复，重新认证或调整该服务器的 key expiry；失效的 Tailscale 通道不能自行恢复 |

## 13. 更换电脑

不要把 WinSCP 站点配置当成唯一备份。换电脑时：

1. 在新电脑安装 Tailscale 和 WinSCP；
2. 使用自己的 tailnet 账号登录 Tailscale；
3. 最佳做法是在新电脑生成新的 SSH key pair；
4. 通过 AWS 浏览器 SSH 把新电脑的**公钥**加入服务器；
5. 私钥只保存在新电脑，并设置强 passphrase 或使用 SSH agent；
6. 移除退役电脑的 Tailscale 节点和旧 SSH 公钥。

如果暂时沿用 Lightsail 默认私钥，必须通过加密、受控的离线方式迁移，并重新收紧本地文件权限；不要通过 Git、普通邮件或聊天发送。

## 14. 安全验收清单

- WinSCP 使用 `SFTP`，不是 FTP；
- Host 使用 MagicDNS 或 Tailscale IP，不是 Lightsail 公网 IP；
- SSH 端口为 22，但没有为 WinSCP 新增任何公网防火墙规则；
- 用户为普通管理员用户，不是 root；
- Password 为空，使用受限权限的 PPK；
- 首次 host key 与 AWS 浏览器 SSH 输出一致；
- WinSCP 已进入 `/home/ubuntu`；
- 上传只进入 `staging`，不直接覆盖系统目录；
- PEM、PPK、`.env`、OAuth JSON、token 和 WinSCP 日志均不在 Git 仓库中。

## 官方参考

- [WinSCP：公钥认证](https://winscp.net/eng/docs/public_key)
- [WinSCP：命令行密钥转换](https://winscp.net/eng/docs/commandline#keygen)
- [WinSCP：验证 SSH host key](https://winscp.net/eng/docs/ssh_verifying_the_host_key)
- [Tailscale：Windows 安装](https://tailscale.com/docs/install/windows)
- [Tailscale：key expiry](https://tailscale.com/docs/features/access-control/key-expiry)
