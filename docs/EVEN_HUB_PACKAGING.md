# Even Hub 打包、Private Testing 与真机验收

本指南只处理 `clients/even/` 前端。Linux 后端、模拟器和测试代码不会进入 `.ehpk`。截至 2026-09-18，官方 CLI 已成功生成首个本地 Private Testing 包；尚未上传到 Even Hub，也未完成真实 G2/R1 验收。

## 1. 固定发布身份

- 显示名称：`Glass Assistant`
- Package ID：`com.eveng2assistant.glassassistant`
- App 版本：`0.1.0`
- SDK：`@evenrealities/even_hub_sdk@0.0.14`
- CLI：`@evenrealities/evenhub-cli@0.1.14`
- CLI 自动写入的最低 Even App 版本：`2.2.9`

名称不能包含大小写任意形式的 `Even`，否则按当前审核规则会被当作冒充第一方应用。Package ID 使用自己持有的 `eveng2assistant.com` 反向域名，必须全小写、无连字符。Released 版本不可覆盖或回滚，修复只能提升 semver 后重新发布。

`Glass Assistant` 是当前 Private Testing 工作名；它不声称由 Even Realities 发布或背书。公开页面必须明确写明独立社区项目／非官方，并在永久注册 package ID 前再检查名称与 ID 可用性。仓库可以说明兼容 Even G2，但应用标题、图标和 tagline 不得制造官方关系。

## 2. 权限与网络边界

`app.json` 只申请：

1. `g2-microphone`：用户主动开始对话后才收音；退出、暂停、页面隐藏或断线会停收音。
2. `network`：只允许 `https://calendar.eveng2assistant.com` 与 `wss://calendar.eveng2assistant.com`。

OpenAI、Google、Gmail 和 OAuth 凭据全部留在 Linux 后端。`.ehpk` 内只有公开后端地址，没有 `G2_CLIENT_TOKEN`、API key、OAuth refresh token 或邮箱密码。访问 token 由用户在手机伴随页面输入，只保存在当前 WebView 内存；页面关闭后需要重新输入。

手机伴随页已经包含文字输入框，适合输入邮箱、URL、ID 或在不方便说话时发问；眼镜本身没有键盘。当前包没有申请定位权限。后续定位／路线功能与任意 To/CC 收件人都必须先完成显式授权、预览确认、最小留存和真机测试，详见 [伴随输入、定位与安全分发](COMPANION_INPUT_LOCATION_AND_DISTRIBUTION.md)。

Even 的 network whitelist 与浏览器的 Origin/CORS 是两道独立检查。当前后端继续严格校验 Host 与 Origin。真实 `.ehpk` 第一次连接时，如果 WebView 使用了不同的稳定 Origin，先从安全日志确认精确值，再决定是否加入后端 allowlist；不得为了跑通而允许任意 Origin、通配符或公开 3001 端口。

## 3. 本地验证与打包

使用 Node 24 或更高版本：

```powershell
Set-Location '<repository>\clients\even'
Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
npm ci
npm test
npm run build
npm run pack:hub
```

生产构建固定连接 `wss://calendar.eveng2assistant.com`。确有需要时，可在**构建前**用 `EVEN_HUB_BACKEND_ORIGIN` 覆盖，但只能是无路径、无凭据、无 query 的 `wss://` origin；改域名时也必须同步修改 `app.json` whitelist 并重新审核。

这意味着当前 `.ehpk` 只能作为个人 Private Testing 包。不得把它当作“每个用户填写自己服务器即可”的公共二进制：manifest 的精确 network whitelist 不会随输入框动态改变。自建用户需要用自己的域名重建 `.ehpk`；不能为方便公开发行而改成 wildcard whitelist、开放 Origin 或共享维护者服务器 token。

`npm run build` 完成后会扫描 `dist/`：拒绝 source map、测试／开发目录、意外文件类型、私钥头和常见 secret assignment。`npm run pack:hub` 使用固定 SDK 版本推导最低 Even App 版本，输出 `glass-assistant-0.1.0.ehpk`。`.ehpk` 和 `dist/` 都被 Git 忽略。

若 Windows 系统 Node 不是 24，先安装／切换 Node 24。不要把 `--use-system-ca` 放进旧 Node 的 `NODE_OPTIONS`；企业证书环境可直接用 Node 24 的 `node.exe --use-system-ca` 启动 npm/CLI。不要关闭 TLS 验证。

## 4. Package ID 可用性

`-c` 是联网只读检查，不会上传或预留 ID，但需要本机 CLI 登录：

```powershell
npx --no-install evenhub login
npm run pack:hub:check
```

登录信息只应留在本机 CLI 配置中，不得复制到仓库、`.ehpk` 或 Linux 应用目录。当前自动化环境尚未登录，因此第一次本地构建没有完成 ID availability check。

## 5. Private Testing

1. 登录 [Even Hub Developer Portal](https://evenhub.evenrealities.com/)。开发者账号邮箱应与手机 Even Realities App 使用的邮箱一致。
2. 创建或打开对应项目，在 Private builds／Builds 页面上传 `.ehpk`。
3. 将 build 从 Draft 移到 Test；不要在真机验收前提交公开审核。
4. 手机 Even Realities App 开启 Developer Mode，进入 `Me → Apps → Private builds` 并安装。
5. 从眼镜主菜单启动。手机伴随页输入服务器配置的助手访问 token；不要输入 OpenAI key。
6. 首次触发麦克风时核对真实权限提示，只应出现网络和 G2 麦克风权限。

Private Testing 能验证真实包、manifest、权限和启动流程，但不等同于 Beta 的锁屏生命周期。平台目前也不提供自动安装测试，每轮上传／安装需要手动完成。

## 6. 第一轮真机检查

按顺序记录到 `docs/validation/v1.3-real-g2.md`：

- 首屏不是黑屏；未配置时明确提示去手机伴随页连接。
- 输入 token 后通过 WSS 认证；错误 token 不泄漏细节。
- 中英文混合语音、数字、日期、人名和技术词。
- 联网搜索、Calendar 读取，以及创建／修改／取消的确认流程。
- MD 邮件发送确认与成功回执。
- 单击收音／暂停、滑动阅读、双击系统退出框、取消退出、确认退出后重开。
- Wi-Fi、蜂窝网络及二者切换；断网后的安全失败和恢复。
- 手机前台、后台、锁屏；Private build 先 smoke，Beta 再做 5 分钟锁屏 reviewer-parity 测试。
- 30 分钟、1 小时、2 小时稳定性、延迟、电量与温度。
- 退出后能正常启动 Conversate 等第一方应用。

首次 packaged WSS 若失败，优先检查：manifest whitelist、TLS 证书、WebView 实际 Origin、后端 Host/Origin 拒绝记录。不得改成开放 Origin、关闭证书校验或开放公网 3001。

## 7. 上传前安全复核

```powershell
git status --short
npm run build
Get-FileHash .\glass-assistant-0.1.0.ehpk -Algorithm SHA256
Set-Location ..\..
node scripts/audit-public.mjs --worktree
```

另外人工确认：包名／版本正确，`dist/` 只有预期静态文件，manifest 无额外权限，WSS 域名属于自己，没有音频、个人邮件、日志、数据库或密钥。不要把 `.ehpk` 提交到公开 Git；通过 Even Hub Portal 手动上传。

官方参考：

- [Packaging & Deployment](https://hub.evenrealities.com/docs/ship/packaging)
- [Networking](https://hub.evenrealities.com/docs/build/networking)
- [Private Testing](https://hub.evenrealities.com/docs/test/private-testing)
- [App Submission & QA](https://hub.evenrealities.com/docs/ship/app-submission)
- [CLI](https://hub.evenrealities.com/docs/reference/cli)
