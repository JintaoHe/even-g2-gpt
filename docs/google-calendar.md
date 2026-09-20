# Google Calendar setup (operator only)

## 重复会议

- 单次事件流程保持不变。重复会议支持定时的按天／按周，每隔1–12天／周、2–366次，总跨度不超过366天；首次日期决定星期几。每月、多星期几、全天重复暂不支持，不能静默降级为单次。
- 未给结束条件或说“持续／不设结束日期”，默认从首次会议日期起三个自然月，区间为 `[首次日期, 三个月后的同日)`；月底缺少同日时夹到目标月最后一天。后端计算有限 COUNT，备注追加“默认3个月，截至具体日期；延长需确认”，预览展示后仍需确认。不会实际创建无限 RRULE，也不会到期自动续期。比如10月3日起的周六课程，期限至次年1月2日。
- 明确给次数的优先遵从次数；明确结束日期通过本地日期包含截止当天的方式计算有限次数。模型只提取 DAILY／WEEKLY、间隔和结束条件，不自行猜三个月的次数。修改时间／次数后，系统期限备注同步更新为实际末次日期；延长需整组修改预览和确认，沿用原系列 ID。Google 返回的不受支持的无期限规则仍只读，不会因读取而被自动截短。
- 创建仍须预览、确认；仅 POST 一个系列父事件，原生 Google 邀请固定 EMAIL_TO。修改／取消使用原 ID、ETag 和 `sendUpdates=all`，不会重新创建独立邀请。
- 修改／取消前必须区分“仅这一次”与“整个系列（含过去）”；未指定则追问。“此次及以后”需要拆分系列，当前明确拒绝，不猜范围。选择整组改时间时，须明确首次日期与时间，不能把后续一次的日期误当系列起点。
- 冲突检查覆盖所有计划中的次数，按最多31天的查询窗口合并请求；确认前再查，失败或不完整不提交。整组检查按父规则计算，已有例外／取消实例可能造成保守的额外冲突提示，不宣称检查全部个人日历。
- 本次修改在确认前也核对父系列 ETag；父系列已变更则重新预览。未知写入结果不会自动重试，相关系列和实例需先核对，防止重复操作。
- 重复会议采用用户明确指定的事件时区；未指定时采用一次性当前位置解析出的 IANA 时区。夏令时切换维持本地开始时间。不存在／重复的开始时刻拒绝并要求换时间。单次时长保持经过的分钟数。
- 重复会议使用 Google 原生邀请；自制重复 ICS 附件暂不支持，会明确报错，不能发送看似成功但实际为单次的附件。现有单次 ICS 不变。也不提供接受第三方邀请或任意增加受邀邮箱功能。
- 本地模拟验收：`node --import tsx --test tests/calendar-recurrence.test.ts`。模型解析验收：`node --import tsx scripts/calendar-recurrence-plan-smoke.ts`（消耗模型额度，仅虚拟内容，不访问 Google／不发邮件）。真实系列邀请收件与同步仍待用户批准测试。

## 账号配置

下一次查询若没有精确名称匹配，会从已成功读取的未来93天定时日程中，以拼写相似度及有限英文读音归一化找至多两个候选。重复会议按系列合并，其余同名同地点条目只保留最近一条。这里只是候选建议，不是自动认定，也不宣称覆盖所有同音／跨语言识别错误。无可信候选时询问其他名称，不倾倒全部日程。

“对，就是那个”／“第二个”可确认候选；更长的指代交给现有规划器，但只接受候选范围内的只读选择，不接受写入输出。候选确认保留5分钟，暂停、退出、换话题或超时后失效。确认后按 Google 实例／系列 ID 重新查询；已删除／改变或读取失败不得回放旧时间。候选确认与事件创建、修改、取消及邮件授权完全分开。

“下一次某课程／会议是什么时候”采用后端当前时刻构造只读查询，逐个31天窗口向后查，最多93天，按名称去空格／标点匹配，只返回尚未开始的最近定时事件。无结果只表示该窗口未匹配，不能声称永远没有；API失败不能当作空结果。显式指定日期范围仍使用普通查询。读范围接受合法 RFC3339 秒／毫秒及 UTC，写入的时区与分钟校验保持严格。

多站行程不会再以编号表格一次索要全部时间与地址。已在当前话题确认的出发时间、
公共地点、路线时长和活动时长会被复用；用户明确要求助手安排时，可加入 5–10 分钟
衔接缓冲，并在备注中写明重要假设。只有无法安全推断、且会实质改变计划的一项信息
才会单独追问；一次只收集一个信息槽，不能把出发地与返回地等两个问题合并成一句。
若用户要求分别创建多个事件，或确认已有分点行程后要求写入 Calendar，系统先生成
最多 6 项的有序草案，然后逐项显示预览、逐项确认和写入；前一项成功不代表后续项
获得授权。过长备注只在眼镜预览中明确缩写，完整备注仍保留在待确认 payload 中；
不再以“超过两页”为理由要求用户重新缩短整份行程。

The authorization utility binds an existing, owned, non-primary calendar without
writing events. The backend now also has opt-in create/update/cancel operations and
a separate browser-lab test panel. API dialogue now supports natural-language
query/create/update/cancel with explicit confirmation and conflict protection.
Explicit requests for MD/ICS export still use the existing document/email flow.
Never describe an emailed ICS as a Google Calendar event that was actually saved.

1. Enable Google Calendar API in your Google Cloud project.
2. Configure an External OAuth consent screen; while Testing, add the assistant
   Google account as a test user. Do not authorize your personal account.
3. Create a Web application OAuth client. Add this exact Authorized redirect URI:
   `http://127.0.0.1:3002/oauth/google/callback` (not a JavaScript origin).
4. Download its JSON to `EVEN_DATA_DIR/google-oauth-client.json` (default `.local/`).
5. Create a separate calendar named `Even Assistant` in the assistant account.
6. Set `GOOGLE_CALENDAR_ACCOUNT` in private `.env`, or use the existing `SMTP_USER`.
   Optionally set `GOOGLE_CALENDAR_NAME` if different.
7. Run `npm run calendar:authorize` with Node 24. Open the printed Google URL,
   verify the account and grant the two calendar scopes. The callback listener is
   loopback-only, expires after ten minutes, validates state and uses PKCE.
8. Success saves `.local/google-calendar-auth.json`. This is a credential, not a
   document: never email it, upload it, or commit it. OAuth client secret and refresh
   token must remain server-side; Windows permissions rely on the user's directory
   ACLs, Linux files use mode 0600. Git ignore is not encryption or access control.

Scopes: calendar list read-only, and events on calendars owned by the authorized
account. Google's scope is broader than one calendar; binding the dedicated ID in
the application will enforce the narrower operational boundary. No Gmail,
contacts, sharing/ACL or calendar-deletion permissions are requested. Setup verifies
the primary calendar matches the configured account and rejects duplicate names.

External apps in Testing generally receive refresh tokens expiring after seven
days for these scopes. Production deployment needs an appropriate publishing /
verification setup and explicit reauthorization handling; do not promise permanent
access. Revocation, expiration or policy changes must stop writes, not fall back to
another account. The conversation must not report a calendar as connected until
the actual event integration is complete.

Linux: this is an operator-run provisioning utility, not a public login service.
Use an SSH local forward for port 3002 if running it remotely, so the browser's
127.0.0.1 callback reaches the remote loopback listener. Do not expose port 3002
publicly. Keep the data directory outside release artifacts with restrictive owner
permissions. The long-running backend will refresh access tokens server-side;
this initial setup command does not need to remain running.

Official references:
- https://developers.google.com/identity/protocols/oauth2/web-server
- https://developers.google.com/identity/protocols/oauth2
- https://developers.google.com/workspace/calendar/api/auth

## 中文运维手册：下次从哪里开始

### 邮件邀请 smoke test 记录（2026-09-16）

已按用户确认的时间测试：2026-10-01 America/Chicago 18:00–18:15，
America/Los_Angeles 16:00–16:15，America/New_York 19:00–19:15。
三封邮件分别为 MD、MD＋正式 REQUEST 邀请、纯 REQUEST 邀请；均收到 SMTP accepted。
两个不同的 Google 真实测试事件均创建后 GET 核实；无闹钟，受邀人保持 needsAction，暂时保留。
这仅证明后端保存和邮件服务器接受，不等于客户端已显示 RSVP 按钮、用户已收到／接受，
也不证明跨平台 RSVP 回传或后续更新已经通过验收。

脚本：`scripts/calendar-mail-smoke.ts`，需显式 `--send --confirm-chicago-test-time --recipient <固定收件人>`。
私密账本：`EVEN_DATA_DIR/calendar-mail-smoke-v1/ledger.sqlite`。accepted 不会重发；sending／unknown
不得盲目重跑。creating 仅在人工检查后可用 `--reconcile-create`：先 GET 原 ID，再决定是否用原 ID
重新创建，绝不生成新 ID 替代。不要删除账本来重测，也不要把它提交到仓库。

真实测试发现：业务层使用分钟精度 `YYYY-MM-DDTHH:mm±HH:mm`，但 Google 写入要求完整 RFC3339
时间。首次 POST 返回 HTTP 400，随后 GET 原 ID 为 404。修复为输出 `:00` 秒数、补回归测试后，
使用原持久化 event ID 成功，已接受的 MD 邮件没有重复发送。

此测试由 SMTP 发送带 `METHOD:REQUEST` 的邀请，用 Google 返回的 iCalUID、organizer、sequence，
而不是 `.invalid` 的本地导出 UID。为减少重复通知，创建时 `sendUpdates=none`；Google 官方指出
这不保证没有任何通知，也不建议把它直接当作生产环境跨平台同步方案。
MD＋邀请混合 MIME 的 RSVP 识别因客户端而异，必须人工查看。纯邀请测试用于区分混合附件问题。
后续自然语言版本支持更新助手创建的事件，包括受邀人全部等于固定 EMAIL_TO 的事件：确认预览
明确提示将由 Google 通知已有受邀人，提交使用 sendUpdates=all。不能新增受邀人；其他地址、
重复事件的支持范围见文末“重复会议”。邀请创建和三封邮件测试账本仍独立保存，查询通过 Google 列表可发现这些事件。
本次对话改期实测使用无受邀人的独立虚拟事件，不额外发邮件；跨客户端回复／更新通知仍需收件人验收。

### 1. 这不是一个普通的 API key

| 项目 | 用途 | 保存／查找位置 |
| --- | --- | --- |
| Google Cloud 项目 | 容纳 API 开关、OAuth 应用和客户端 | Cloud Console 顶部项目选择器 |
| OAuth Client ID | 标识我们的应用 | Google Auth Platform → Clients |
| OAuth Client Secret | 后端兑换授权码、刷新访问凭据 | 私密 `google-oauth-client.json` 的 `web.client_secret` |
| refresh token | 用户批准后允许后台续期访问 | 私密 `google-calendar-auth.json`；不是 Cloud Console 里的 API key |
| access token | 短期调用 Google API | 后端内存中，过期前自动刷新，不写日志 |
| Calendar ID | 精确指定日历，不依赖名称反复搜索 | 授权文件 `calendarId`；Google Calendar 设置 → 集成日历 |
| Gmail App Password | SMTP 发邮件 | 私密 `.env`；与日历 OAuth 无关 |

不要把任何真实 Secret、token、授权链接、回调 URL 或私密配置内容抄进这个公共文档。
Cloud 项目 ID、客户端名称和助手账号可记录到个人密码管理器的备注中，方便找回正确项目。
授权会涉及 Google 日历权限，但不需要 iCloud 密码，也不需要 Gmail 收件箱读取权限。

### 2. 从零配置顺序

1. 使用专用助手 Google 账号。在 Google Cloud 创建／选中项目，并在密码管理器记录项目标识。
2. **在同一项目启用 Google Calendar API**：APIs & Services → Library → Google Calendar API → Enable。
   创建 OAuth Client 不会自动启用 API。
3. Google Auth Platform → Branding：配置应用名称和联系信息。
4. Audience：个人 Gmail 使用 External；Testing 阶段把助手邮箱加入 Test users。
   创建者身份不等于已进入测试用户名单。
5. Clients：创建 Web application 类型。Authorized redirect URIs 必须包含
   `http://127.0.0.1:3002/oauth/google/callback`。不是 JavaScript origins；localhost 与 127.0.0.1 不可混填。
6. 下载 JSON 到私密数据目录，命名 `google-oauth-client.json`。不要存放到源码、tests 或公共云盘。
7. 登录助手账号的 Google Calendar，**另外创建一个非主日历**，名称 `Even Assistant`。
   只把主日历改名不符合我们的隔离规则；个人账号建好再共享也不符合 owner 校验。
8. `.env` 可配置 `GOOGLE_CALENDAR_ACCOUNT`；未设置时使用 `SMTP_USER`。
   日历名默认 `Even Assistant`，可用 `GOOGLE_CALENDAR_NAME` 修改，大小写／空格需准确。
9. 运行 `npm run calendar:authorize`，打开它本次打印的链接，选择助手账号并同意日历权限。
10. 回调提示成功后，检查进程正常结束。凭据会保存为 `google-calendar-auth.json`。
11. 运行 `npm run calendar:check`。这个检查会刷新 token 并读取绑定日历的元数据，**不读取或修改事件**。

授权监听只持续十分钟、只绑定本机 3002；一次成功或失败后结束。旧链接不能反复使用，重新运行生成新链接。
不用把网页回调地址发给别人，它包含一次性授权码。代码不会记录原始错误响应、密钥或回调 URL。

Windows PowerShell（先进入仓库根目录；使用系统 Node 24 或安装好的可信 Node 24 runtime）：

```powershell
Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
node --use-system-ca --import tsx scripts/google-calendar-auth.ts
node --use-system-ca --import tsx scripts/google-calendar-check.ts
```

如果 Node 路径存放在变量 `$calendarNode`，调用语法必须是 `& $calendarNode ...`。
不要通过关闭 TLS 验证解决证书错误。旧 Node 不支持相关参数时，应使用已验证的 Node 24 runtime。

### 3. 本次实测排错记录（2026-09-16）

| 现象 | 已确认事实／可能原因 | 处理 |
| --- | --- | --- |
| “应用正在测试中，仅供已获批准的测试人员”，403 access_denied | 授权页面的测试用户门槛 | 在正确项目 Audience → Test users 添加助手账号，再开新授权链接 |
| 回调 `GOOGLE_HTTP_403` | 旧版只输出 HTTP 状态，**仅凭此码不能断言原因**；本次在启用 Calendar API 后通过接口步骤 | 先核对同项目 API 开关，再检查授权 scopes 和账号；不要更换 Secret 碰运气 |
| `GOOGLE_CALENDAR_MISSING_OR_AMBIGUOUS` | 已兑换 token、读取列表、通过账号校验；没有唯一的匹配日历 | 新建 owner 为助手的独立非主日历；核对精确名称，检查重复同名；不要盲删日历 |
| 授权成功，找到专用日历 | 配置与授权文件保存成功 | 运行只读 check；这**不等于**事件创建／修改／取消已经真实验收 |

其他常见问题：

- `redirect_uri_mismatch`：检查客户端类型、正确项目和完全一致的回调地址；更新后重新下载 JSON。
- `GOOGLE_WRONG_ACCOUNT`：登录了个人账号，或 `.env` 助手账号配置错误。不要放宽账号校验来绕过。
- `GOOGLE_PERMISSION_OR_REFRESH_TOKEN_MISSING`：没有完整授权两项 scope，或 Google 未返回离线凭据；检查同意页面后重新授权。
- `GOOGLE_CALLBACK_PORT_UNAVAILABLE`：3002 被占用；先查进程归属，不要杀掉未知进程，也不要随意修改回调端口。
- `GOOGLE_AUTH_TIMEOUT`：十分钟过期，重新运行；不要复制以前的链接。
- `CALENDAR_REAUTHORIZE`：刷新授权失败，可能撤销、过期、Secret 变更或账户策略变化。先恢复配置再重新授权，禁止自动切换其他账号。
- `CALENDAR_CHANGED_REVIEW_AGAIN`／`conflict`：Google 返回 412，事件在预览后发生变化。重新读取、预览，再确认。
- `CALENDAR_BINDING_CHANGED`：授权换到了另一个日历，但本地事件账本属于旧日历。不要删除账本绕过；先人工制定迁移方案。
- `unknown`：请求可能已经在 Google 执行，但本地没收到结果。停止重试，人工核对相同 event ID；不要新建另一条当作补偿。

### 4. 忘记／丢失凭据怎么办

1. **先找密码管理器和私密数据目录**。默认是仓库下 `.local/`；Linux 以 `EVEN_DATA_DIR` 为准。
   不要打印文件内容到共享终端记录或发到聊天。
2. 找 Client ID／客户端：Google Cloud 选择正确项目 → Google Auth Platform → Clients。
   旧界面也可能位于 APIs & Services → Credentials。
3. Secret 并不保证以后还能从控制台完整查看／重新下载。Google 要求创建时妥善保存。
   如控制台不能找回，走官方新增／轮换 Secret 流程，安全更新私密配置；不要删除整个项目。
4. 如果 Client ID 也换了，旧 refresh token 不能当作新客户端的授权：重新走浏览器同意流程。
5. refresh token 丢失或失效：它不在 Cloud Console 中供你找回；重新运行本项目授权工具获取新授权。
6. 轮换后运行只读 check 验证，再重启后端。不要在未核实前删除旧的可恢复备份。
7. 怀疑泄漏：暂停日历写入，在 Google 账号撤销应用访问并轮换泄漏的客户端 Secret；重新授权。
   仅删除 Git 文件或改 `.gitignore` 不能消除已经泄漏的 Secret。

建议密码管理器备份 OAuth 客户端文件；含 refresh token 的授权文件及 SQLite 账本用加密备份。
源码仓库不能充当凭据备份。

### 5. 启用真实事件测试

设置私密 `.env` 的 `GOOGLE_CALENDAR_ENABLED=true` 后重启后端。默认 false，授权成功本身不会启用写入。
网页实验室会出现独立的 Google Calendar 面板，用 JSON 填写事件并点击预览；输入服务器提供的完整
确认短语后才会操作。示例字段与既有 ICS 表单一致，日期必须明确，时间偏移必须与 IANA 时区和 DST 匹配。

- 创建：服务器生成固定 event ID，先持久化操作再请求 Google；新建事件不发送邀请／邮件，不使用默认闹钟。
- 修改：只接受本应用账本中的事件，并读取最新 Google 版本；展示修改前后内容，使用 `If-Match` 防覆盖。
- 取消：取消的是 Google 上的指定事件，不只是本地草稿；独立确认后才执行 DELETE。
- 正常后端配置必须有有效的固定 `EMAIL_TO`。确认创建即表示创建并邀请该固定邮箱：预览显示“将邀请你的固定邮箱”，Google insert 使用 attendees 和 sendUpdates=all，无需另说“发送”。邀请由 Google 原生发送，不再额外 SMTP 重复邀请。后续对同一事件修改／取消继续通知原受邀人。API 成功只代表保存且通知已请求，不代表已送达或接受；不自动重试不确定结果。
  仅底层无收件人测试服务可创建不带邀请的内部事件。旧的无受邀人事件不自动补发，避免未经确认的历史通知；需要另行明确处理。
- 可以查询专用日历中的所有可见事件；只能修改带有本助手私有管理标记、仍由当前专用账号组织、未锁定且格式受支持的单次或重复事件，不支持删日历。受邀人的 RSVP 变化或后来增加 guest 不改变 Even 创建事件的所有权；修改／取消仍重新读取最新 ETag、显示通知受邀人的预览并要求确认。Google 对旧事件返回的显式 offset 若与 IANA 时区不一致，读取层按实际 instant 和该 IANA 时区规范化后再预览，不因此误标只读。用户对当前完整列表明确说“这两个／这些全部取消”时，可建立最多 10 项的取消批次，但仍逐项读取最新事件、逐项显示不可变预览、逐项确认；一次确认永远只取消当前一项，成功后自动展示下一项。真正只读的外部事件或未说明处理范围的重复会议不能混入批次，任何一项写入结果不确定时停止后续操作。重复会议的整组取消需单独明确范围。
- 待确认操作五分钟有效，确认不能重放；断开、退出、暂停或新预览会作废对应连接的旧确认。
- 草稿内容与提交授权分离：当前连接/session 内保留一份当前草稿，闲聊、噪音、查询其他日程、暂停或候选上下文过期不删除它。明确放弃或成功保存后清除；明确生成另一份草稿会替换当前草稿。关闭 session／断开连接时清除会话内草稿，不承诺跨连接恢复。
  “继续刚才的日历草稿”可恢复。旧授权失效后不能直接写入：先读回目标事件、保留最新未修改字段、复查冲突并展示新的预览，再等一次明确确认。五分钟期限不因识别重试顺延。转移话题后的泛泛确认不能直接提交旧草稿。
  写入结果不确定时保留但锁定草稿，要求先核对 Google 日历，不自动生成新 ID 重试，以免重复创建。
- 疑似识别错误的确认（例如“可以，确认上线”）不会写入，也不立即作废草稿：简短提示重新确认，仍绑定原操作与原五分钟期限。“确认创建／修改／取消”“确认”“确定”最明确；紧跟正式、不可变预览时，“好，可以”“可以”“没问题”也可提交。没有当前预览与服务端 approval ID 时，这些自然确认一律不能写入。更改内容、转移话题、退出等仍使旧确认失效。不能从错误动词或普通 Luna 回复推测写入授权。
- 查询列表会先提示已展示的定时事件中发现的时间重叠（含只读事件）。这不是全部日历的完整冲突审计，不把未展示事件或全天条目当作已检查。
- 询问备注、议程、参会状态或准备建议时，不再只展示日程列表：先明确唯一会议，重新 GET 该事件的备注和受邀回应，再由无工具权限的模型简短回答（最多两页）。备注中的“计划邀请”不等于已邀请，更不等于接受；accepted 只表示接受邀请，不保证实际出席。不能从不相关姓名或邮箱推断 sales 等部门，缺失信息必须说无法确认，建议另行标注且不能声称已执行。
- 邮件确认先由语义路由判断是否明确同意发送当前预览，再校验固定收件人、五分钟有效期、版本和一次性发送状态。支持“可以，发给我吧”等自然表达，不再只接受固定口令；含日期／时区变更、否定、条件、疑问或收件人变更不得借此授权。ICS 邮件仍先展示日期与主时区供核对，明确同意当前展示内容可发送；提出其他时区需重新核对。
- 查询每次都重新读取 Google，包括追问和候选事件查询，不直接返回旧候选缓存。日历读请求和日期纠正增加只读路由兜底；模型只负责提取请求，列表由后端根据 API 结果渲染。查询失败不能被解释成零事件。
  读取遇到网络错误、缺失／异常响应、HTTP 408/429/500/502/503/504、限流型403时最多重试一次（约1–1.5秒随机退避）；Google GET 的401清除旧token后可再读一次。参数错误、权限不足、404、412、需重新授权等不盲目重试。若 Retry-After 超过3秒则直接报告限流，避免长时间阻塞；短 Retry-After 会遵守。有效的空列表（包括 Google events 对象省略 items）是成功，不重试。POST/PATCH/DELETE不会自动重试。
  网页测试版 Google Calendar 面板显示最近读取健康状态、检查时间、耗时、尝试次数、返回条数及脱敏错误码／HTTP错误状态，可手动点击“检查 Google Calendar 连接”。该按钮只读专用日历元信息；快照不额外调用API。健康信息仅经已认证连接推送，重启后从“尚未检查”开始，不代表持续可用性或邮件已送达。重试时对话收到简短提示。
  读查询的标题匹配忽略空格、大小写和标点，“会议／meeting／event”等类别词不作为标题过滤。筛选未命中但 Google 返回了事件时明确显示筛选未匹配，并列出该范围的事件，不说当天没有会议。写操作的目标匹配保持原有严格规则。
  私有 `google-calendar.sqlite` 的 `query_audit` 保存最近 200 条成功查询的范围、时区、标题过滤、Google 返回数量、匹配数量及分页完整性；不记录凭据或完整事件内容。历史版本没有这些参数日志，不能从旧对话准确还原一次零结果的具体过滤条件。
- 自然语言创建／修改定时事件时，预览前查询目标时段的重叠；发现冲突后额外读取未来 48 小时，给出一个已核查的替代时间。优先当天稍晚的空档，再选第二天接近原时间的空档，保持原时长；当前建议窗口为当地 08:00–22:00、半小时步长，不跨午夜。全天占用也阻止建议。该窗口是初始产品默认，不是用户工作时间偏好。
  只核查专用日历，不能保证其他日历、地点或受邀人空闲。查询失败／不完整时不声称空闲，也不捏造建议。选择替代时间后重新预览和确认；直接确认原预览仍表示保留原时间（允许用户知情接受重叠）。提交前继续复查重叠，建议不构成预约或锁定。
- 后端只有一个工作进程；共用现有 JobStore 的实例所有权保护。不要另起第二个实例共享数据目录。
- 本地事件列表是缓存，不是完整双向同步；修改前会从 Google 读取最新值。
- API 模式已接入自然语言查询／创建／修改／取消。“给我发个 calendar reminder／日历邀请／提醒我出发”默认创建真实 Google Calendar 事件；只有显式要求“ICS／日历文件／附件／导出”才走邮件文件流程。已经讨论好的多段行程可跨同一话题内的少量追问恢复为逐项预览、逐项确认，不能把整份长计划塞进一个事件，也不能因为眼镜超过两页而拒绝提交。普通 Luna 回答不得自行问“要不要设提醒”并冒充正式预览。CLI 模式未接入自然语言日历路由。
- 暂未实现 unknown 状态自动对账。出现不确定结果需人工核对 Google 及保留账本，不能自动重发。

账本 `google-calendar.sqlite` 保存事件 ID、预览和结果，不保存 OAuth token。pending 在重启后过期，sending
在重启后变 unknown；不会重启就执行旧操作。修改使用 PATCH，避免把非修改字段整体清空。
如果你在预览中确认的是一整份新内容，以预览的前后对比为准，不会根据缓存静默覆盖。

### 6. Linux 部署与授权寿命

- 发布目录只含后端代码；`web/`、模拟器、测试、OAuth JSON、数据库不进入 `build:server` 产物。
- OAuth 初始化脚本放在开发／运维源码中，不进入当前后端发布包。可在可信本机授权后通过加密通道
  配置服务器私密文件，或在服务器单独的受限运维 checkout 中运行工具。
- 在服务器运行授权时，用 SSH `-L 3002:127.0.0.1:3002` 转发。浏览器打开的 127.0.0.1 指本机，
  所以没有隧道时不会自动连接远程服务器。不要把 3002 开放到公网。
- 系统服务账号独占数据目录；Linux 目录 0700、Secret/token 文件 0600。Windows chmod 不能代替 NTFS ACL。
- 后端运行不需要浏览器保持打开：按需刷新 access token。刷新失败必须显式报错，不应继续声称写入成功。
- **External + Testing 状态的这类授权 refresh token 通常七天过期**。正式长期部署前处理发布状态和
  适用验证要求；发布状态改变后建议重新授权并验证。Production 也不保证 token 永久有效。
- 目前没有定时健康监控；`calendar:check` 是手动只读检查。不要把自动续期理解成永不过期。

### 7. 安全与验收清单

- [ ] API、OAuth Client、测试用户位于同一 Cloud 项目。
- [ ] 使用专用账号、非主日历；没有授权个人邮箱的收件箱。
- [ ] OAuth 文件在 `.local/`／受限数据目录，`git check-ignore` 验证忽略生效。
- [ ] 真实凭据没有出现在日志、截图、PR、邮件或文档中。
- [ ] 私密配置只给后端；浏览器／SDK／模型不接触 Secret 或 refresh token。
- [ ] `npm run calendar:check` 通过；完整 mock 测试通过。
- [ ] 经用户批准后测试虚拟事件创建、修改、取消；确认同一 event ID，无重复记录。
- [ ] 在 Apple Calendar 启用该 Google 日历并验证同步；Google 保存成功不等于手机即时同步。
- [ ] 验证账号撤销、网络超时、重启与冲突的失败反馈。

补充官方参考（查阅于 2026-09-16）：

- [启用 API](https://developers.google.com/workspace/guides/enable-apis)
- [同意屏幕和测试用户](https://developers.google.com/workspace/guides/configure-oauth-consent)
- [客户端和 Secret 管理](https://support.google.com/cloud/answer/15549257)
- [OAuth token 生命周期与 Testing 限制](https://developers.google.com/identity/protocols/oauth2)
- [ETag 与条件修改](https://developers.google.com/workspace/calendar/api/guides/version-resources)
- [创建事件及自定义 ID](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert)

## 自然语言日历验收与使用

范围：**只查询授权绑定的 Even Assistant 专用日历，不是用户个人账号的所有日历、全部 iCloud 或邮箱中的所有邀请。**
本日历以外的事件不会被纳入计数或冲突检查。Apple Calendar 统一显示多个账号不代表助手能访问它们。

示例：

1. “我今天有多少 event？”——后端调用 Google events.list，返回实际计数、标题、时间、地点。
2. “查一下 10 月 1 日的日程。”——按用户时区解析日期，查询范围最多 31 天。
   列表统一标注一次显示时区（相对日期默认使用一次性当前位置解析出的时区）；每项显示标题、日期、分钟精度时间、已填写的地点和备注，例如“2026-09-16 下午6:30–7:30”。空备注不显示占位行；只读事件也显示备注。备注转为眼镜纯文本显示，后台原文不变；超过6000字符会截断并明确提示。日常列表不再重复专用日历范围免责声明，但查询范围仍仅为 Even Assistant 专用日历，不代表用户全部日历。不显示 RFC3339 的 T、秒、偏移和逐项 IANA 时区代码。跨日保留两端日期，跨中午标明上午／下午；全天事件将 Google 排他的结束日期换成实际最后一天。后台时间精度不变，修改确认仍使用现有简短预览。
3. “把晚上的 event 改到七点。”——多条匹配时列出候选／追问；用户选择编号或名称，不能猜一个直接改。
4. “选测试 A，改到今天20:00到21:00，地点测试公园，其他不变。”——读取当前 Google 版本，保留未要求改的字段。
5. 眼镜默认使用一次性当前位置经 Google Time Zone API 解析出的 IANA 时区并自动处理夏令时，不再固定芝加哥，也不同时列出其他时区；用户明确指定的事件时区优先。Google 在可重试错误下最多尝试三次；仍失败时，Luna 只接收本 session 的有界最近对话和手机提供的、仅作提示的 IANA 时区，不接收经纬度，也不能在该 fallback 中使用工具或联网搜索。当前所在地的明确陈述优先于已建立的路线起点和设备提示；行程目的地、酒店或未来要去的城市不能被误当成当前位置。证据一致时返回结构化 IANA 时区；证据不足或冲突时只问一个城市／地区问题，不静默猜测。Luna fallback 不绕过日历的预览、冲突检查和确认门槛。预览仅列重要变更的原值和新值，未改内容用“其余不变”概括。常见时间、地点修改占一页，最多两页；超长修改要求拆分，不截掉重要改动后提交。
6. 用户单独说“确认修改”“确认”或“确定”即可提交当前预览。创建、取消分别提示“确认创建”“确认取消”，也接受“确认／确定”。时间重叠会简短提醒；不再要求冗长的含时区口令。泛泛的“好”、否定、引用、问句或一句里同时纠正和确认不会提交。没有当前有效预览时，短确认不能写入。此规则针对真实 Google 日历操作，不改变邮件发送确认。
7. 保存使用原 event ID 和 If-Match；Google 返回成功后才报告已保存，不声称手机已即时同步。

Calendar 的模型边界采用严格 JSON Schema（作用等同于 Pydantic 风格的固定结构），随后再做后端语义校验，包括日期、递增时间、IANA 时区／DST 偏移、候选编号、重复规则、行程顺序与重叠。若模型输出结构正确但语义不合法，后端会把一条受控的修复提示返回给 Luna，最多进行三次规划尝试；修复仍不安全时，Luna 应只追问一个关键信息。模型输出、内部 `CALENDAR_*` 错误码和 provider 原始错误不会直接显示在眼镜上。

这个自修复只适用于尚未产生副作用的规划／预览阶段。Google 写入超时、结果未知、ETag 冲突或已经发出的写请求绝不由 for-loop 自动重放，以免重复创建或覆盖事件。用户在待确认预览后补充 notes、时间、地点或标题时，系统修改同一份草稿并重新预览；“刚才是不是已经创建了”会明确区分“预览”与“Google 已保存”。

待确认草稿与 Calendar operation ledger 均可跨服务重启恢复，但授权不可恢复。会话 SQLite 只保存草稿内容、批次进度及对应 operation ID；不保存用户说出口的确认、approval、短期查询候选、路线或位置。冷启动时先用 operation ledger 做只读 reconcile：能证明 Google 已完成就结束该项并推进批次，`sending`／`unknown` 无法证明时保持阻塞且绝不重放，expired／dismissed／failed／conflict 则去掉旧 operation 并在用户要求继续时重新读取 Google、生成新预览。即使用户冷启动后第一句话就是“确认创建／修改／取消”，该轮也只能得到新预览，必须下一轮再次确认。

两类冲突：

- 时间重叠：检查专用日历中目标时间段的其他事件。Google 本身允许重叠，助手负责提醒并要求明确确认。
  确认前再检查重叠事件集合；变化时需重新预览。此检查不是事务锁，Google 不提供跨事件原子冲突锁定。
  本版不自动检查全天目标事件的时间重叠。
- 版本冲突：被修改的事件在预览后被外部编辑，ETag 不匹配返回 412，拒绝覆盖，重新查询再确认。

查询最多获取 500 条；不完整时显示“至少”，禁止据此选择单一事件或做完整的冲突判断。
展示和传入模型的候选最多 20 条，超出会提示缩小范围。候选上下文十分钟过期，写入确认五分钟过期。
Google 的非标准事件可显示，但不支持编辑时会明确标注。受支持的重复会议须明确操作范围；事件描述是数据，不能授权写入。
模型只返回结构化请求，无法指定账户、发送任意请求或访问凭据；写入由后端确定性确认门槛控制。
查询／保存时网页和眼镜显示真实进度，不显示误导性的“正在发邮件”。

真实模型＋Google 验收脚本：`node --use-system-ca --import tsx scripts/calendar-dialogue-live.ts --real-google`。
只操作脚本创建且标注“非真实安排”的 A/B 两条事件；不新增受邀人或发邮件。
固定按测试当天生成 ID，重跑会核对标签并重置同一组测试事件，不批量清空日历。
涵盖：今天查询、多匹配消歧、重叠预览、模拟外部备注编辑造成 412、重新预览后改期和改地点，核对原 ID 和最新备注保留。
私密报告与对话位于 `.local/calendar-dialogue-smoke/`，不要提交 Git。

OpenAI 实现参考：[Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)。

### 2026-09-16 真实验收结果

真实 OpenAI 意图／结构化规划 + Google API 已验证：当天列表、两个匹配事件时追问、时间重叠预览、
外部备注修改产生 ETag 冲突并拒绝覆盖、重新查询后用户确认改期和地点、GET 回读同一 event ID 及最新备注保留。
留存两条无受邀人／无闹钟测试事件：测试 A 当天芝加哥 20:00–21:00（测试公园），测试 B 18:30–19:30（测试地点）。
先前两条 10 月 1 日邮件邀请事件未被此脚本修改。

实测修复：模型有时返回等价的零秒 RFC3339 时间 `18:45:00-05:00`，业务层要求分钟格式。
现在仅规范化 `:00` 秒数，不舍入非零秒数、不改变日期或偏移，Google 写入时仍输出完整秒数。
测试断言不依赖消歧问题的固定措辞，但必须追问目标且检查 Google 未提前发生修改。
