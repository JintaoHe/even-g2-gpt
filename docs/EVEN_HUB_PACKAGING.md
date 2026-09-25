# Even Hub 打包、Private Testing 与真机验收

本指南只处理 `clients/even/` 前端。Linux 后端、模拟器和测试代码不会进入 `.ehpk`。截至 2026-09-18，官方 CLI 已成功生成首个本地 Private Testing 包；尚未上传到 Even Hub，也未完成真实 G2/R1 验收。

## 1. 固定发布身份

- 显示名称：`Glass Assistant`
- Package ID：`com.eveng2assistant.glassassistant`
- App 版本：`0.2.0`（定位传输 POC；首个已验证本地包为 `0.1.0`）
- SDK：`@evenrealities/even_hub_sdk@0.0.14`
- CLI：`@evenrealities/evenhub-cli@0.1.14`
- CLI 自动写入的最低 Even App 版本：`2.2.9`

名称不能包含大小写任意形式的 `Even`，否则按当前审核规则会被当作冒充第一方应用。Package ID 使用自己持有的 `eveng2assistant.com` 反向域名，必须全小写、无连字符。Released 版本不可覆盖或回滚，修复只能提升 semver 后重新发布。

`Glass Assistant` 是当前 Private Testing 工作名；它不声称由 Even Realities 发布或背书。公开页面必须明确写明独立社区项目／非官方，并在永久注册 package ID 前再检查名称与 ID 可用性。仓库可以说明兼容 Even G2，但应用标题、图标和 tagline 不得制造官方关系。

## 2. 权限与网络边界

`app.json` 只申请：

1. `g2-microphone`：0.2.2 启动并通过语音连接认证后自动开麦；手机最小化、锁屏及伴随页隐藏不主动关麦。手动暂停、真正退出、设备／后端断连及权限／上下文撤销仍会停收音。后台实际音频交付取决于 Even App／系统，必须真机验收，不能仅凭离线测试宣称支持。
2. `network`：只允许 `https://calendar.eveng2assistant.com` 与 `wss://calendar.eveng2assistant.com`。
3. `location`：明确的路线意图可自动请求一次短期定位；最多三次有限尝试后停止并清除。手动一次／连续按钮仅用于开发诊断，连续定位仍须显式启动并可停止。

OpenAI、Google、Gmail 和 OAuth 凭据全部留在 Linux 后端。`.ehpk` 内只有公开后端地址，没有 `G2_CLIENT_TOKEN`、API key、OAuth refresh token 或邮箱密码。访问 token 由用户在手机伴随页面输入，只保存在当前 WebView 内存；页面关闭后需要重新输入。

手机伴随页已经包含文字输入框，适合输入邮箱、URL、ID 或在不方便说话时发问；眼镜本身没有键盘。当前 source 在 `0.2.0` 包之后增加自动一次性定位与服务端 Places/Routes：精确坐标绑定当前 WSS 请求，不写入 LLM／对话／日志／MD，完成、失败、中断或退出后清除；失败会请求用户输入出发地址。Google Maps key 只留在后端。任意 To/CC 收件人仍未启用，详见 [伴随输入、定位与安全分发](COMPANION_INPUT_LOCATION_AND_DISTRIBUTION.md)。

Even 的 network whitelist 与浏览器的 Origin/CORS 是两道独立检查。后端继续严格校验 Host 与 Origin。真机已观察到内部页面使用 `http://127.0.0.1:<port>`，端口可能每次启动变化。服务端可显式设 `EVEN_ALLOW_LOOPBACK_ORIGIN=true`（默认关闭）兼容：只接受规范 HTTP、精确 `127.0.0.1` 和合法显式非默认端口，不接受 localhost、IPv6、其他 IP、路径或用户信息。这是有界回环来源规则，不是任意 Origin 或域名通配符；它不证明 Even 身份，也不替代 token／设备认证。不得开放公网 3001。只改服务端，无需重打 `.ehpk`；当前不加 HTTP CORS 响应头，未来 HTTP 接口须按同一规则单独处理。

## 3. 本地验证与打包

使用 Node 24 或更高版本：

```powershell
Set-Location '<repository>\clients\even'
Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
npm ci
npm test
npm run build
```

日常 source 更新到这里停止：`npm run build` 只验证前端 bundle，不生成新的
`.ehpk`。只有本地人工验收、Linux 部署／live test、部署后安全检查全部通过，
准备进入 Private Testing 时，才单独运行 `npm run pack:hub`。

生产构建固定连接 `wss://calendar.eveng2assistant.com`。确有需要时，可在**构建前**用 `EVEN_HUB_BACKEND_ORIGIN` 覆盖，但只能是无路径、无凭据、无 query 的 `wss://` origin；改域名时也必须同步修改 `app.json` whitelist 并重新审核。

这意味着当前 `.ehpk` 只能作为个人 Private Testing 包。不得把它当作“每个用户填写自己服务器即可”的公共二进制：manifest 的精确 network whitelist 不会随输入框动态改变。自建用户需要用自己的域名重建 `.ehpk`；不能为方便公开发行而改成 wildcard whitelist、开放 Origin 或共享维护者服务器 token。

`npm run build` 完成后会扫描 `dist/`：拒绝 source map、测试／开发目录、意外文件类型、私钥头和常见 secret assignment。`npm run pack:hub` 使用固定 SDK 版本推导最低 Even App 版本，输出 `glass-assistant-0.2.0.ehpk`。`.ehpk` 和 `dist/` 都被 Git 忽略。

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
6. 首次触发麦克风与定位时分别核对真实权限提示；定位被拒绝时应用必须继续支持非定位对话。

Private Testing 能验证真实包、manifest、权限和启动流程，但不等同于 Beta 的锁屏生命周期。平台目前也不提供自动安装测试，每轮上传／安装需要手动完成。

## 6. 第一轮真机检查

0.2.8 候选（当前选择，替代以下自动滚动实验）：用户决定取消打字效果与自动推进。
正式入口使用 manual-pages，显示定时器不再调用 advanceReading；首屏自然接收输出，
内容超过一页后保持页码不变，只有用户手势翻到下一页，每页最多六行、非重叠分页。
新问题从第一页开始，伴随页“最新”进入最新记录的第一页。正文宽度 560→576px，
x=0、padding=2，换行预算由 32→40 列，保留英文短词；地址不人为删减或改写。
模型已有的显式换行保留，长地址仍可能多行；全宽排版须真机检查右边缘与底行裁切。
麦克风、访客与遗忘清屏不变；仅客户端更新，不改 Linux／模型。
包名 `glass-assistant-0.2.8.ehpk`。

0.2.7 候选：根据真机反馈改为逐字展示，而非等待整行后再推进。
服务器正文完整接收，客户端对净化后的显示正文按码点逐步放行（目标 8 字/秒），
逗号停 350ms、句末停 650ms；现有 300ms 显示刷新一次最多增加 3 个码点，
慢 BLE／后台恢复不追赶积压。不是逐字一个 BLE 包，也不是像素平滑动画。
六行满后随新字换行推进；上滑暂停展示但继续接收，回到已展示末尾继续。
伴随页“最新”可显式跳过已接收积压；生成结束继续展示，取消／新问题／清屏终止旧展示。
用户转录、重要通知和恢复快照不做打字动画；不改模型、账本或 Linux。
本轮文件 `glass-assistant-0.2.7.ehpk`，需真机确认打字节奏和 BLE 稳定性。

0.2.6 候选：0.2.5 真机反馈模型输出快时直接跳到末尾。改为阅读节奏：
回答始终从开头显示，有待读行后首屏至少停留 4 秒，其后至少每 1.8 秒推进一行。
生成结束仍继续读完积压内容，不跳尾；后台恢复最多推进一行、不追赶计时。
上滑立即暂停自动推进，手动回到底部恢复；伴随页“最新”是显式跳尾。
新问题重置节奏，打断／清屏取消原阅读进度。使用 monotonic performance.now，
不改模型流速、不增加逐字动画或 API 调用。97 项客户端测试通过，节奏待真机试读。
本轮文件为 `glass-assistant-0.2.6.ehpk`，不需 Linux 更新。

0.2.5 候选：接入 Scroll Probe 0.0.7 已通过真机的 236px 正文框和六行阅读窗口。
顶部独立单行状态栏显示访客／助手、MIC/OFF 和阅读位置；回答流式跟随底部，
上滑冻结阅读窗口但保留后续全文，回到底部或点伴随页“最新”恢复跟随。
输出结束不抢回看位置，新问题恢复跟随。两块容器均纳入隐私清屏，
旧单容器热重载须重建布局。单击麦克风／双击退出不变；实验页的单击重播不进入产品。
仅客户端变化，无 Linux 部署／迁移。实验通过不等于正式助手通过，
本包仍待真机验收：长回答回看、冷启动麦克风、重连、访客切换清屏。
上传候选为 `glass-assistant-0.2.5.ehpk`，不要覆盖 Scroll Probe 项目。

0.2.4 补充：普通可恢复断连清屏时只暂停实际收音，不清除用户开麦意图；重新认证后才能恢复。手动静音、上下文重置、模式切换、4003 撤权及真正退出仍清除意图。SDK 开麦失败提示优先于服务端 listening 状态；客户端控制台的 `[even-audio]` 仅记录启动来源枚举、状态、布尔返回值及耗时，不含凭证、音频或原始异常。须真机核对实际冷启动路径，未宣称宿主返回 false 的问题已解决。

0.2.3 补充：冷启动首次认证若恢复到 paused 会话，仅在本次启动仍有开麦意图时发送一次 resume；收到服务端 listening 后且显示容器就绪才开麦。普通前后台切换及重复 ready 不覆盖手动静音。须真机验证「手机锁屏 → 眼镜菜单启动 → 保存凭证认证 → MIC」，离线回归不代表宿主锁屏音频权限已验证。

按顺序记录到 [`docs/validation/v1.3-real-g2.md`](validation/v1.3-real-g2.md)。该文件默认全部为 `NOT RUN`，只有真实 iPhone、G2 和 R1 证据才能改为 PASS：

- 首屏不是黑屏；未配置时明确提示去手机伴随页连接。
- 输入 token 后通过 WSS 认证；错误 token 不泄漏细节。
- 中英文混合语音、数字、日期、人名和技术词。
- 联网搜索、Calendar 读取，以及创建／修改／取消的确认流程。
- MD 邮件发送确认与成功回执。
- 单击收音／暂停、滑动阅读、双击系统退出框、取消退出、确认退出后重开。
- Wi-Fi、蜂窝网络及二者切换；断网后的安全失败和恢复。
- 路线意图自动一次定位、首次权限提示、最多三次尝试、手动地址 fallback、停止／清除、拒绝、超时、低精度和页面退出；确认未自动开始连续／后台跟踪。
- 手机前台、后台、锁屏；Private build 先 smoke，Beta 再做 5 分钟锁屏 reviewer-parity 测试。
- 30 分钟、1 小时、2 小时稳定性、延迟、电量与温度。
- 退出后能正常启动 Conversate 等第一方应用。

首次 packaged WSS 若失败，优先检查：manifest whitelist、TLS 证书、WebView 实际 Origin、后端 Host/Origin 拒绝记录。若来源符合上述回环规则，核对服务端显式开关，而不是把某次启动的端口写成精确 allowlist。该有界规则不属于开放任意 Origin；不得扩大为域名通配符、关闭证书校验或开放公网 3001。多用户共用服务仍需单独的账号与数据隔离。

### 0.2.9 候选：首轮自动开麦，后续按住说话

每次打开／reload 在认证及显示就绪后自动开麦；恢复到 paused 的首次启动仅发送一次 resume。
第一轮 answer.start 时关闭收音，之后镜腿／戒指 LONG_PRESS_EVENT 开麦，
LONG_PRESS_RELEASE_EVENT 立即关闭 PCM 转发并发送 turn.submit（不等原生关麦或定位完成）。
单击不再切换开麦；伴随页按钮支持 pointer 按住／松开。普通重连、设备恢复不会自动重新开麦。
每次首轮启动或长按请求一次位置；定位拒绝不阻塞语音，松手、断线、换会话后的迟到定位丢弃。
定位仍受手机授权约束，不自动启用连续定位。按住最长 60 秒后自动停止提交，服务端另有 65 秒取消兜底。

**此包需要同步更新后端**：ready.capabilities.push_to_talk=true 与 turn.begin。
后端按住期间保留静音、不提前提交，松手后等待 STT 完成再处理问题；旧客户端自动断句不变。
旧后端没有此能力时只保留首轮原有自动语音，后续长按不打开麦克风并提示更新后端。
无 schema 变更；后端与 EHPK 必须由同一 PR 源码构建。部署不轮换凭据、不改 Caddy；
先保留一致性备份，再切换独立 release。构建的提示词说明与静态说明页统一 LF；
受管运维文件和依赖元数据保持原字节，不借应用发布改变它们。
隔离 main 基线门禁：后端 757 项（755 通过、2 跳过），Even 106/106；
两端类型检查、构建、381 文件公开扫描及 diff-check 通过。测试零真实 API。

真机待测（不是离线 PASS）：手机／锁屏眼镜冷启动首轮自动开麦；第一轮结束 OFF；
长按出现 MIC 后说话，停顿后仍按住不发送，松手后 OFF 并只提交一次；
重复长按、重复松手、断网、漏松手 60 秒上限；定位授权／拒绝；手动翻页保持不变。
镜腿先验收，戒指设备可用后再单独验收；原生长按判定前的声音不在录音范围内。

## 7. 上传前安全复核

```powershell
git status --short
npm run build
Get-FileHash .\glass-assistant-0.2.0.ehpk -Algorithm SHA256
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
