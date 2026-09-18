# Google Calendar API：从 Testing 发布到 Production

本指南说明如何为单用户、自建后端配置 Google Calendar OAuth，并避免 Testing 状态下授权约七天失效的问题。它不承诺 refresh token 永久有效；用户撤销、账号安全事件、OAuth Client 轮换或 Google 政策变化仍可能要求重新授权。

本项目只请求：

```text
https://www.googleapis.com/auth/calendar.calendarlist.readonly
https://www.googleapis.com/auth/calendar.events.owned
```

第一个 scope 用于找到并绑定专用日历；第二个只允许操作授权账号**拥有的日历**中的事件。不要为了“省事”改成完整 `calendar` scope，也不要添加 Gmail、Drive、联系人或 Calendar ACL 权限。

## 1. 账号与项目隔离

建议使用专用助手 Google 账号，而不是个人主账号。该账号应当：

- 开启两步验证；
- 只保存助手所需日历；
- 不授予 Gmail 收件箱读取权限；
- 在密码管理器记录 Cloud 项目标识和恢复方式。

在 Google Cloud Console 创建或选择一个专门的项目。每一步都确认右上角/顶部项目选择器仍是同一个项目。

## 2. 启用 Google Calendar API

1. 打开 Google Cloud Console。
2. 进入 **APIs & Services → Library**。
3. 搜索 **Google Calendar API**。
4. 点击 **Enable**。
5. 返回 API 详情，确认状态为 Enabled。

创建 OAuth Client 不会自动启用 Calendar API。这一步漏掉时，授权可能成功，但 API 请求仍返回 403。

## 3. 配置 Google Auth Platform

### Branding

进入 **Google Auth Platform → Branding**，填写：

- App name：清晰说明这是你的助手；
- User support email：能收到 Google 通知的邮箱；
- App home page：你的专用 HTTPS 说明页；
- Privacy policy：同一受控域名下的隐私说明页；
- Developer contact information：长期可用的联系邮箱。

公开页面不要包含密钥、账号恢复信息、日历内容或内部调试日志。页面可以是静态 HTML，并保持在线，以便同意页面和后续审核引用。

如果控制台要求 Authorized domains/域名验证，添加你拥有的**可注册主域名**（例如 `<example.com>`），而不是只填子域名。Google 可能要求通过 Search Console 或 DNS 证明域名所有权。实际主页和隐私页仍可只放在 `calendar.<example.com>`，其他子域名留给未来项目；不要把整台服务器目录或管理页面公开给 Google。

### Audience

个人 Gmail 项目选择 **External**。Testing 阶段只有已加入 Test users 的账号可以授权，而且 Google 官方说明测试用户授权会在七天后过期。

### Data Access / Scopes

只添加本页开头的两个 Calendar scopes。逐项核对，删除不使用的 scope。增加新 Google scope 后，现有 refresh token 不会自动获得新权限，必须更新配置并重新授权一次。

## 4. 创建 OAuth Client

1. 进入 **Google Auth Platform → Clients**。
2. 选择 **Create Client**。
3. 类型选择 **Web application**。
4. 添加完全一致的 Authorized redirect URI：

   ```text
   http://127.0.0.1:3002/oauth/google/callback
   ```

5. 这不是 JavaScript origin；不要同时猜测添加 `localhost`、公网 IP 或生产域名回调。
6. 创建后立即安全下载客户端 JSON。

OAuth Client Secret 相当于应用密码。它可能只在创建时完整显示；保存在密码管理器/加密备份和私密数据目录，不要截图、发邮件或提交 Git。

开发机文件位置：

```text
<repo>/.local/google-oauth-client.json
```

Linux 生产位置：

```text
/var/lib/even-agent/google-oauth-client.json
```

## 5. 创建专用日历

使用助手账号登录 Google Calendar：

1. 在 “Other calendars/其他日历” 旁选择创建新日历。
2. 名称使用配置中的 `GOOGLE_CALENDAR_NAME`，默认 `Even Assistant`。
3. 确认该日历由助手账号 owner 持有，而且不是 primary calendar。
4. 不要创建多个同名日历；授权工具会因为无法唯一绑定而拒绝继续。

Apple Calendar 可以显示这个 Google 日历，但这不扩大后端权限。助手仍只访问绑定的专用 Google 日历。

## 6. Testing 阶段首次授权

私密 `.env` 至少配置变量名对应的值：

```dotenv
GOOGLE_CALENDAR_ACCOUNT=<assistant-account@example.com>
GOOGLE_CALENDAR_NAME=Even Assistant
```

将助手账号加入 **Audience → Test users**，然后在可信开发机运行：

```bash
npm ci
npm run calendar:authorize
```

打开本次生成的 Google URL，选择助手账号并授权两项 Calendar 权限。回调监听：

- 只绑定 `127.0.0.1:3002`；
- 十分钟后过期；
- 使用 state 和 PKCE；
- 一次成功或失败后即关闭。

成功后会生成：

```text
<repo>/.local/google-calendar-auth.json
```

它包含 refresh token 和绑定 Calendar ID，是最高敏感级别凭据。不要打印其内容。

只读验证：

```bash
npm run calendar:check
```

该命令只刷新凭据并读取绑定日历元数据，不读取、创建、修改或删除事件。

## 7. 发布到 Production

1. 再次检查 Branding、Audience、Data Access 和 Clients 都属于正确项目。
2. 确认主页和隐私页面是有效 HTTPS，内容与实际用途一致。
3. 打开 **Google Auth Platform → Audience**。
4. 选择 **Publish app**，把 Publishing status 从 Testing 改成 **In production**。
5. 返回 Audience 页面，确认页面明确显示 In production，而不是只看到一个成功提示。

个人使用、少于 100 个用户的应用可能不必完成完整 OAuth verification，但仍可能显示 “unverified app” 警告，并受未验证应用限制。是否需要品牌或 scope 验证，以 Google 控制台当前提示和官方政策为准；不要用缩减安全信息、伪造用途或扩大 scope 的方式绕过审核。

Production 的意义是移除 Testing 授权的七天生命周期限制，并让非测试用户可以进入授权流程；它不等于 token 永久有效，也不等于应用已经通过 Google 验证。

## 8. 发布后必须重新授权

旧 Testing refresh token 不应被当作长期生产凭据。发布完成后：

1. 保留旧凭据的加密备份，暂时不要删除。
2. 再次运行 `npm run calendar:authorize`。
3. 使用同一个助手账号完成授权。
4. 检查新的 `google-calendar-auth.json` 已安全保存。
5. 运行 `npm run calendar:check`。
6. 只有只读检查通过后，才安全替换服务器文件并重启服务。

Linux 权限：

```bash
sudo chown even-agent:even-agent /var/lib/even-agent/google-oauth-client.json
sudo chown even-agent:even-agent /var/lib/even-agent/google-calendar-auth.json
sudo chmod 0600 /var/lib/even-agent/google-oauth-client.json
sudo chmod 0600 /var/lib/even-agent/google-calendar-auth.json
sudo systemctl restart even-agent
```

不要在 shell 命令行中粘贴 JSON 内容；通过 SFTP/Tailscale 传到管理员暂存目录，再用 `sudo install -o even-agent -g even-agent -m 0600` 安装。

## 9. 哪些变化需要重新授权

| 变化 | 是否重新授权 |
| --- | --- |
| 后端代码更新，但 scope 和 OAuth Client 不变 | 通常不需要 |
| 修改模型、OpenAI key、SMTP 配置 | 不影响 Google OAuth |
| 增加新的 Google API 或 scope | 需要用户重新同意一次 |
| 更换 OAuth Client ID | 必须重新授权 |
| 轮换同一 Client 的 Secret | 更新客户端文件；如果刷新失败则重新授权 |
| refresh token 被撤销、丢失或失效 | 必须重新授权 |
| 修改绑定日历 | 重新运行授权工具并人工核对账本迁移，不能直接覆盖 |

增加 Gmail API、Drive 或 Contacts 是新的权限项目，不能复用 Calendar 授权“偷偷获得”访问能力。当前邮件发送使用 Gmail App Password，与 Calendar OAuth 分开。

## 10. 常见错误

| 错误/现象 | 原因和处理 |
| --- | --- |
| 403 `access_denied`，提示仅限测试用户 | Testing 阶段未把助手账号加入 Test users；添加后生成新的授权链接 |
| `GOOGLE_HTTP_403` | 先确认 Calendar API 已启用，再核对项目、账号和 scope；不要盲目更换 Secret |
| `redirect_uri_mismatch` | 回调必须与 Client 中的 `127.0.0.1:3002` URI 完全一致 |
| `GOOGLE_CALENDAR_MISSING_OR_AMBIGUOUS` | 没有唯一、非主、owner 为助手账号的同名日历 |
| `GOOGLE_WRONG_ACCOUNT` | 浏览器选错账号或 `.env` 账号不一致；不要放宽校验 |
| `CALENDAR_REAUTHORIZE` | refresh token 撤销/失效、Secret 或账号策略改变；重新授权并做只读检查 |
| Production 后仍很快失效 | 检查是否真的重新授权并替换了服务器旧 Testing token |
| API 返回空 | 只有合法的空事件列表才是零事件；网络/HTTP 错误必须报告并按后端策略重试，不能当作空结果 |

## 11. 泄漏与恢复

怀疑泄漏时：

1. 暂停 Calendar 写入或停止服务。
2. 在 Google 账号安全页面撤销该应用访问。
3. 在 Cloud Console 轮换泄漏的 Client Secret。
4. 生成新的客户端文件，重新授权。
5. 运行只读检查，通过后再恢复服务。
6. 检查 Git 历史、CI 日志、终端录屏、云快照和共享聊天；只删除工作区文件不足以撤销已泄漏凭据。

## 12. 官方参考

- [Manage App Audience](https://support.google.com/cloud/answer/15549945)
- [When verification is not needed](https://support.google.com/cloud/answer/13464323)
- [Submitting your app for verification](https://support.google.com/cloud/answer/13461325)
- [Manage OAuth Clients](https://support.google.com/cloud/answer/15549257)
- [Choose Google Calendar API scopes](https://developers.google.com/workspace/calendar/api/auth)
- [OAuth 2.0 for web server applications](https://developers.google.com/identity/protocols/oauth2/web-server)
