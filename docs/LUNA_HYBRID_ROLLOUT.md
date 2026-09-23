# Luna role split and bounded fallback

Status: ready for PR review; not enabled in production. Independent fifth-round
black-box revalidation passed on workspace snapshot `c2e1a181`, including the
deadline, quota, explicit retry, output guard and diagnostic follow-ups below.

## Profiles

`EVEN_MODEL_PROFILE=configured` (default) preserves existing model configuration.
`hybrid-luna` pins intent, route resolution, complex replies, documents,
presentation, Calendar and session summaries to gpt-5.6-luna. Only explicitly
classified casual/explain replies with low/none effort and an empty workflow list
use gpt-6-luna. That model has no tools. Missing classifications, research,
planning, coaching, composition, deep reasoning and any workflow stay on 5.6.
Guest replies receive the identical guest capability instructions and guarded,
metered fetch; no access policy is relaxed.

`all-5.6` overrides individual API text model settings to 5.6. Restart the server
to apply either profile. No schema migration. Managed profiles reject CLI mode.
Speech transcription, Google, mail transport and infrastructure are unchanged.

## Fallback contract

- At most one retry on 5.6, only before any observable output/status.
- Hybrid-only `EVEN_HYBRID_FIRST_OUTPUT_MS` defaults to 5000, accepts integer
  1000..20000, and is validated before persistent initialization. It is ignored
  in configured/all-5.6 profiles. Linux must validate the default separately.
- The first nonempty text delta (including whitespace) or reply status/final-text
  event disarms the timer at the same delivery boundary used to forbid fallback.
  Once timed out, delivery is revoked before aborting 6; even an abort-ignoring
  provider cannot deliver late text/status. The existing single fallback uses the
  original caller signal, not the expired primary deadline. User cancellation wins.
- Empty answers, malformed/truncated streams, transient HTTP failures, network
  errors, timeouts and unknown provider-origin failures qualify.
- Local unknown errors are not assumed to be provider failures. Guest guards,
  storage and budget errors remain outside the raw-network error boundary.
- Cancellation, authentication/permission failure and policy refusals never retry.
- For the hybrid 6 attempt only, HTTP 429 `error.code` takes precedence over a
  generic type: insufficient_quota, credit_balance_exhausted,
  organization_spend_limit_exceeded, project_spend_limit_exceeded and
  organization_usage_limit_exceeded are blocked regardless of type. An
  insufficient_quota type remains blocked. Model rate-limit codes (including
  slow_down), bare 429, 503 overload and 404 model_not_found retain one retry.
  401/403 remain blocked. No third request if the 5.6 fallback fails.
  Reference: https://developers.openai.com/api/docs/guides/error-codes
- No new intent classification or tool execution during fallback. The original
  bounded context is reused and both requests pass through the same cost ledger.
  If the second reservation is denied, stop; never bypass the monthly cap.
- Once output starts, do not append another model's answer. The existing turn
  cancellation marks the partial answer interrupted and emits a visible notice.
  The user can explicitly say `重新回答` / `answer again` / `retry`.
  Legacy model-number aliases and spoken 五点六 / 5点6 remain supported.
- Explicit quality retry is a closed whole-utterance command. It produces a
  no-tool reply plan on 5.6, not another Calendar/email action. Normal follow-ups
  are not quality complaints. No automatic semantic judge or claim that all wrong
  answers can be detected.
- Diagnostics contain fixed event/model/reason labels and duration, never prompts,
  answers, credentials or provider error payloads. Failed/unknown requests retain
  conservative cost reservations when actual usage is unavailable.

## Acceptance and rollback

Offline tests must cover narrow routing, both profiles, one retry only, empty and
unknown provider errors, cancellation, partial output, refusal, guest revocation,
second-attempt budget denial and client notice visibility. Live smoke should use
new examples for factual explanation, correction and multi-turn guest conversation;
no email or Calendar writes. Do not infer semantic quality from nonempty output.

Keep production env unchanged until acceptance. To disable the experiment, set
`EVEN_MODEL_PROFILE=all-5.6` and restart. This is a configuration rollback, not a
database or release rollback. Inspect per-model reply latency and fallback rate;
token savings do not imply equivalent savings on the entire provider bill.

## Implementation verification (2026-09-22)

- Pure policy: 5 tests; request/ledger/conversation integration: 9 tests.
- Final full backend suite: 669 total, 667 pass, 2 skip, 0 fail.
- Even client: 79/79, including the partial-answer retry notice.
- Both TypeScript checks, server-only build, Even production build and bundle
  scan passed. Public worktree scan: 359 files; diff check passed.
- A real ledger + synthetic 503 exposed an unread response-clone cancellation
  hang. Error responses are no longer cloned; the regression proves fallback
  reaches the second budget check without hanging. Unknown usage stays reserved.
- All new validation was offline, using temporary ledgers and fake responses.
  No real API spend, business database migration or production env change.
- At this original implementation handoff, live semantic/safety smoke was still
  pending. The subsequent reviewer evidence is recorded below; earlier A/B reports
  evaluated the models, not this new production assembly.

## Independent black-box feedback and scoped follow-up

The reviewer reported real WS smoke on snapshot `3d9b9a8820332fe8`, temporary
databases, metadata-only provider observation, about $0.10 spent. Role routing,
guest boundaries, fallback and rollback passed. This evidence is supplied by the
reviewer, not another live run performed during these fixes.

Corrected performance expectation: hybrid and all-5.6 end-to-end first-output
medians were both about 2260 ms in that run; intent latency dominated. The
experiment demonstrates cheaper ordinary-response tokens, not established
end-to-end speedup. Prior direct-call A/B timings are not a production latency SLO.

This follow-up changes only the hybrid 6 attempt: first-output deadline and quota
code classification. Paused-input silence, missing fallback-failure diagnostics,
startup banner naming and conservative reservation inflation are recorded for
separate work; they are not silently changed here. No routing, ledger semantics,
5.6 timeouts or intent/summary/document models changed.

New offline checks: deterministic timer/abort/late-output races, first-output
disarming, slow fallback, startup values and unaffected profiles; a real timer
with temporary CostLedger verifies second-attempt budget denial; a 25-case HTTP
matrix and a Conversation-level double-failure case verify MODEL_FAILED/no third
request. No real API requests or business databases are used in this follow-up.

Follow-up gates: 678 backend tests (676 pass, 2 skip, 0 fail); Even 79/79;
both TypeScript checks, server build, public scan (361 files), and diff check
passed. Production configuration is untouched; the candidate remains uncommitted
on `codex/luna-model-ab` for independent black-box revalidation.

## Explicit retry and metadata-echo follow-up

The reviewer accepted deadline/quota handling but found that explicit retry sent
the command instead of the original question, and truncated output envelopes
could pass the final-text path. Those accepted deadline/quota rules are unchanged.

- Retry uses the session-local bounded context captured before the original
  answer. After reconstruction/restart it takes chronological messages through
  the last substantive question and omits synthetic summaries, which might cover
  the replaced answer. Repeated retries retain the same question; no question
  yields a fixed notice and zero provider calls. No intent/tools or side effects.
- Whole-utterance commands normalize NFKC, whitespace and spoken model aliases.
  Stored retry commands use the neutral phrase 重新回答 rather than model numbers;
  subsequent model context omits command rounds. Explicit retry takes precedence
  over the old answer-replay shortcut. Wrapper plans preserve the no-tool retry
  marker rather than treating it as a pending route address or workflow follow-up.
- Output-only guard buffers reserved opening prefixes, including fragmented and
  unclosed English/Chinese headers. Deltas and final citations both pass the
  guard; rejected output becomes a fixed apology, not persisted metadata. The
  diagnostic contains only reply_rejected/metadata_echo and elapsed time.
  Ordinary bracketed lists release as soon as they are distinguishable.
- Validation uses fake providers and temporary SQLite databases, including guest
  scope, revocation and durable checkpoint/commit paths. No live API calls or
  non-temporary conversation databases were used during this fix; production and
  its data remain untouched. Real-model retry quality still needs black-box retest.

Final offline gate: backend 685 total / 683 passed / 2 skipped / 0 failed;
Even client 79/79; both type checks and builds, client bundle verification,
public scan (364 files) and diff check passed. The final full-suite log is
`.local/reply-retry-release-gate.log`. Changes remain uncommitted for review.

## Third black-box review: clean assistant history and selective stripping

Reviewer snapshot `323f3375f5ebecc6` showed correct question replay but frequent
imitation of envelopes on prior assistant messages, plus one reasoning-channel
leak. The previous output guard contained metadata but discarded useful answers.

- API input now contains one developer topic map (JSON labels are untrusted data),
  rather than prepending topic/thread envelopes to conversation messages. Assistant
  entries are clean answer text. Budgeted summary/prior/history entries retain
  their existing content and low-trust semantics but travel as user data entries,
  never privileged instructions or assistant answer examples. Context selection,
  scope checks and PI-2/PI-3 budget allocation are unchanged.
- Only complete application-owned envelope lines ending in a newline are stripped.
  The bounded streaming parser preserves substantive text, including after a
  split prefix or a middle envelope line. Malformed, truncated, overlong and
  bodyless envelopes remain rejected. Reasoning/channel syntax is rejected with
  reasoning_leak; successful stripping logs metadata_stripped. Citation offsets
  are discarded when text changes. Logs contain labels/duration, never raw output.
- Fixed rejection notices are omitted from later model context; rejected raw
  output never enters durable messages. Original substantive user requests remain
  available to retry. No additional automatic fallback trigger was adopted.
- Polite retries are a bounded whole-utterance whitelist: up to four Chinese
  politeness prefixes (你/请/麻烦/能/可以/能不能/可不可以), optional 再 and model
  alias, 重新回答, optional 一下/一遍, previous-question object and 吗/吧/呢.
  English includes can you answer that again, could you retry that, please answer
  again and can you redo your last answer. Negations, discussion and added new
  requests do not match. The public notice continues to recommend only 重新回答.
- Deadline, quota classification, routing, ledger and paused/resume contracts are
  unchanged. Tests are offline with fake providers and temporary databases.

Role handling was checked against the official OpenAI
[prompt engineering guidance](https://developers.openai.com/api/docs/guides/prompt-engineering).
No model change or new paid API evaluation is part of this follow-up.

Final third-review fix gates: backend 690 total / 688 passed / 2 skipped /
0 failed; Even 79/79; both type checks and builds, bundle verification,
public scan (365 files) and diff check passed. See
`.local/reply-envelope-final.log`. Dedicated tests exercise every split boundary
of complete envelopes and channel markers, clean six-round requests for all
three profiles, polite/guest retry, follow-up context and SQLite persistence.
Real-model success rate remains to be independently rechecked; no production
deployment, business-data change, commit or push was performed.

## Fourth black-box review follow-up

- Narrowed reasoning rejection to internal channel syntax and an opening line
  consisting of `analysis` followed by a newline (case-insensitive). Ordinary
  `Analysis: ...`, `Analysis of ...`, `This analysis ...`, `We need ...` and
  Chinese prose remain visible. Envelope stripping/rejection is unchanged.
- A buffered prefix accepted at EOF is still validated, but is not appended
  again after an authoritative final-text event; this avoids duplicating a
  legitimate standalone `analysis` answer.
- Startup banners identify all three profiles. Hybrid also reports both reply
  models, the casual/explain low/none no-workflow scope and first-output deadline.
- Raw provider failures recognize the ten reviewed network cause codes, walking
  a bounded cause chain without reading or logging provider text. Unknown
  provider failures retain their existing fallback eligibility and label.
- Terminal reply failures now include `attempt=primary|fallback|retry`, model,
  reason and elapsed time. Cancellation is not a failure; logger exceptions
  cannot replace the original exception. A `reply_fallback` event identifies
  the source model (6), with `targetModel` identifying 5.6. No new attempts,
  routing changes, deadline changes or billing changes were introduced.
- New offline tests cover every split of the reasoning examples, the network
  code matrix through the real metered-fetch wrapper and temporary ledger,
  double failures through Conversation, explicit retry and single-profile
  failure logging, and actual isolated startup of all three profiles. Startup
  probes use synthetic credentials, temporary data and a disabled network fetch.

Fourth-review fix gates: targeted 24/24; backend 695 total / 693 passed /
2 skipped / 0 failed; Even 79/79; both type checks and builds, bundle verification,
public scan (366 files) and diff check passed. Evidence:
`.local/reply-observability-targeted.log`, `.local/reply-observability-full.log`
and `.local/reply-observability-client.log`. No real API calls, production or
business-database access, commit or push; independent live retest remains pending.

## Fifth-round independent acceptance (2026-09-23)

The reviewer reports all checks passed on snapshot `c2e1a181`, unchanged during
testing; test services were closed afterward. Independently reproduced gates:
backend 695 / 693 passed / 2 skipped / 0 failed, Even 79/79, both type checks and
builds, 366-file public scan and diff check. Live tests covered normal Analysis
prefixes, stripping/rejection fixtures, banners, failure diagnostics and routing,
retry/deadline/quota regressions. No internal content leaked in 42 dialogue turns.
Reported ledger cost: approximately $0.13 this round, $0.59 over five rounds;
reservations are conservative, not an assertion of exact provider charges.

Non-blocking follow-ups (not changed in this PR):
- Add language-following evaluation for English requests specifying `Analysis:`;
  two such answers used Chinese after the requested English prefix.
- Unify model/attempt fields on primary-6 terminal and output-guard diagnostics.
- Separately address the pre-existing paused-session behavior where submitted
  messages are silently ignored until resume; this is not introduced by hybrid.

This acceptance does not claim lower end-to-end latency or Linux production
validation. Keep the existing configured default; enable hybrid explicitly after
merge and deployment verification. Rollback remains `EVEN_MODEL_PROFILE=all-5.6`.
