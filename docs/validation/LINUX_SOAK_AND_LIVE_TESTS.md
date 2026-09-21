# Linux soak 与剩余 live-test 验收

这份清单区分三件不同的事：确定性回归测试、真实 API 行为验收、连续稳定性 soak。只有三者分别通过，才可以描述为“后端长时间运行已验证”。13 个一次性脚本或一次顺畅的日常工作流不等于 12／24 小时 soak。

## 自动回归（不消耗真实额度）

| 能力 | 自动证据 | 安全边界 |
| --- | --- | --- |
| MD + ICS 附件与认证下载 | `tests/calendar.test.ts`、`tests/mail.test.ts` | fixture；不发真实邮件 |
| 最多 6 个行程事件逐项预览／逐项确认 | `tests/calendar-itinerary-planner.test.ts`、`tests/calendar-dialogue.test.ts` | 六次授权相互独立；不批量授权 |
| 搜索额度耗尽 | `tests/search-quota.test.ts`、Even client lifecycle test | 注入已耗尽 ledger；不故意烧真实 quota |
| Google Time Zone 失败后 Luna fallback | `tests/timezone.test.ts`、`tests/calendar-dialogue.test.ts` | Luna 不接收坐标；含糊时只问一个问题 |
| 60-message 生产摘要边界 | `tests/session-summary.test.ts` | 58 条不提前摘要；60 条保留最近 24 条 |
| 跨 session 边界 | reconnect／session tests | 当前只承诺同一 durable session；新 session 不伪装拥有 profile memory |

回归语料不能只反复运行曾经暴露 bug 的原句。每次改动应同时保留固定 regression case，并另外创建不含私人数据的新自然口语场景，例如：不同月份／时段的显式日程、3–4 个事件的混合“删除＋保留”、以及退出同音词在“继续推进／页面向下／明确退出／引用讨论”里的正反例。新的 Calendar 场景必须使用合成标题和未来日期，不得读取、修改或删除用户真实事件。

## 真实 API 验收（逐项、可清理）

在独立测试内容上执行；每项完成后删除测试 Calendar event 和临时生成文件。不要借此消耗到真实搜索配额上限。

1. 生成一份含可识别标题的 Markdown + ICS，检查预览后确认一次；验证邮件有两份附件、ICS 可下载且未经认证返回 `401`。
2. 给出 2–6 段明确行程；每次只确认当前一项，拒绝其中一项时不得影响其余草稿，最终核对 Google 上只有已确认事件。
3. 使用注入的 quota-exhausted fixture 验证眼镜显示“联网额度已用完，仍可聊天”；普通对话继续，时效事实不得编造。
4. 在测试 transport 令 Google Time Zone 返回 unavailable；确认 Luna 只收到 session context 与设备 timezone hint。明确地点可回退，含糊地点必须追问。
5. 在同一 session 完成 10 轮以上跨 topic 对话，断线恢复后回指较早事实；结束 session 后新 session 应明确没有旧 session 的最终结论。

Calendar／Email 是不可由 Luna 替代的写操作：任何真实写入仍须 fresh preview + fresh confirmation。provider 失败、断线或重启都不能自动重放写入。

## 12／24 小时 Linux soak

安装与启动命令见 [生产监控、日志与恢复](../setup/MONITORING_BACKUP_RECOVERY.md)。正式记录至少包含：

- 起止 commit SHA、服务器 release path、Node 版本和测试时长；
- RSS/heap/CPU、全部 SQLite sidecar 大小、socket 最大值；
- first-visible 与 complete p50/p95；
- OpenAI／Soniox／Google attempts、failure rate、p50/p95；
- provider 总成本起止与 delta；
- document attempts/completed/failed/retry-failed 与生成延迟；
- process restart、采样失败、storage warning；
- 测试期间是否使用 simulator、Even Hub Beta 或真机。

运行期间至少覆盖普通闲置、连续多轮、一次断网／恢复、一次客户端关闭／冷启动、一次长文生成、一次只读 Calendar 查询。邮件和 Calendar 写入不需要反复压力执行；幂等性已有独立 crash tests，soak 中各做一次受控验收即可。

## 暂缓到真机

以下项目不能用 simulator 宣布完成：iPhone 锁屏收音、memory pressure/jetsam 白屏频率、BLE 断线、真实 audio wedge、Ring 与镜腿来源、原生菜单、长按、IMU、耗电。它们继续使用 `v1.3-real-g2.md` 的真机 gate，不进入本 PR。
