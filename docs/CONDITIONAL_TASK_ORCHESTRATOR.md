# Conditional Task Orchestrator

Status: retired from the runtime on 2026-09-18. This file is retained as a
historical design and test reference. Outdoor, itinerary and multi-stop work
now routes to Luna's general `planning` mode. Maps/Routes and environmental
reads are optional evidence sources with quota-bounded research fallbacks;
Calendar and Email remain dedicated, confirmation-bound services and never use
a speculative model fallback.

The previous local end-to-end implementation included the
bounded LLM planner, production tool registry, live conversation router, HUD
progress, Calendar confirmation flow, one-shot location, environmental
adapters, Places/Routes comparison, and decision layer are connected behind an
opt-in feature flag. Weather, Air Quality, and Pollen have all passed
restricted-key live requests; a successful request with omitted regional
Pollen indexes remains `available:false`, not an error or a zero-risk claim. No
Linux deployment or Even Hub package is authorized by this status.

This document is the product and security reference for multi-step conditional
assistant tasks. The goal is not to return more data. The goal is to make a
useful recommendation, explain the decision briefly, and perform a requested
action only after the correct confirmation.

## 1. Product principle

This project is intended to become a real personal assistant, not a data bot.
When an answer depends on several facts, the assistant should:

1. understand the user's actual outcome rather than match isolated keywords;
2. create a structured plan and gather the evidence needed for that plan;
3. spend additional read-only calls or reasoning budget when they materially
   improve the decision;
4. combine facts into one recommendation instead of reading raw fields aloud;
5. state uncertainty and ask one useful clarification only when the missing
   preference could change the recommendation;
6. preserve the user's final choice even when it differs from the assistant's
   recommendation; and
7. keep privacy, confirmation, and write-safety boundaries fixed regardless of
   the available budget.

Cost and latency are constraints, not the objective. “Use more budget” may mean
more relevant evidence, a higher reasoning level, or another bounded fallback.
It never means speculative data collection, unlimited tool loops, sending raw
GPS to a model, or bypassing confirmation.

### Default outdoor evidence policy

The customer describes the goal, not the provider checklist. For a usable,
time-bounded outdoor decision, the backend automatically runs the current
evidence pack—Weather, Air Quality, Pollen, and relevant Places/Routes—even when
the user names none of those services. Adding another reviewed environmental
signal later must not require customers to learn a longer invocation phrase.

The default is selective rather than keyword-wide:

- parks, playgrounds, walking, running, cycling, hiking, outdoor events and
  similar exposure-sensitive plans use the outdoor evidence pack;
- an ordinary drive to an indoor store, office or airport remains a route/ETA
  request and does not spend an irrelevant Pollen call;
- a drive whose purpose is a time-specific outdoor activity may use the pack;
- a private Calendar read occurs only when the user asks about availability or
  makes the plan conditional on being free; and
- when date/time is too vague for forecast evidence, ask one short time question
  before requesting location or calling Google services.

## 2. Reference scenario

> 帮我看看今天下午有什么安排。如果没有安排，我想下班后四点半或五点带孩子
> 去公园，你帮我安排一下。

The user did not need to say “check weather, AQI, and pollen”; those branches are
system-owned defaults for this outdoor decision.

The intended execution is a dependency graph:

```text
one-shot location
     ↓
Weather ─┐
AQI ─────┼─ concurrent evidence wave
Pollen ──┤
Parks ───┘
     ↓
initial recommendation and proposed time
     ↓
Calendar overlap check (only when availability or scheduling was requested)
  ├─ free ───────────────────────────────┐
  ├─ conflict + explicit hard stop → stop│
  └─ conflict → find verified nearby slot│
                    ↓                    │
         Weather/AQI/Pollen recheck      │
                    └────────────────────┘
                             ↓
                    final recommendation
                             ↓
                     Calendar preview
                             ↓
                    explicit confirmation
                             ↓
                  Calendar write + receipt
```

The assistant plans before it commits the user's time. A conflict is therefore
checked against the proposed final slot, not used as a reason to abandon the
whole planning task prematurely. By default, the backend finds one verified
nearby slot and re-runs time-sensitive environmental evidence for that slot.
Only an explicit instruction such as “if it conflicts, do not reschedule” makes
the conflict a hard stop. A Calendar write still requires a separate preview and
user confirmation.

## 3. Architecture

### 3.1 Planner

The LLM produces a declarative `TaskPlan`, never executable code. A node names
an allowlisted tool, dependencies, a restricted equality condition, and bounded
JSON input. The plan is untrusted data.

The planner may decide that the request needs more evidence. It cannot add a
new tool, change tool risk, choose retry rules, authorize a write, access a
secret, or supply an arbitrary condition expression.

`task_action` is reclassified for every utterance; it is not a sticky property
of a conversation topic. Once an outdoor recommendation has been returned,
questions about why it was recommended, what is available there, facilities,
tickets, reviews, opening hours, or other candidates return to ordinary
research/conversation. A route-time question uses the route workflow. A
business or technical detour uses planning mode, and a conceptual argument may
use deep reasoning. The conditional workflow runs again only when the current
turn asks to re-evaluate conditions, change the decision time, compare a new
option under those conditions, or arrange the result.

### 3.2 Policy validator

The backend validates every plan before execution:

- allowlisted tool name;
- bounded node and payload size;
- unique safe identifiers;
- existing dependencies and no cycles;
- conditions may only compare one declared dependency's normalized field with
  a scalar value—no code or expression evaluation;
- timeout and retry policy come from the backend registry, not the LLM;
- every write directly depends on a successful preview tool;
- write tools have one attempt only.

The local POC currently allows at most 16 nodes and 4 concurrent nodes. These
are safety ceilings, not a product commitment to minimal reasoning. Later evals
may raise them deliberately.

### 3.3 DAG scheduler

The scheduler executes only nodes whose dependencies and conditions are
satisfied. Independent read-only nodes may run concurrently. A dependency
guard remains sequential.

Concurrency is therefore semantic, not merely technical:

- Weather, AQI, Pollen, and Places can run together after the one-shot location
  is available.
- Calendar fit waits for an initially viable recommendation.
- A changed time causes Weather, AQI, and Pollen to run concurrently again;
  current route/place evidence is retained because the POC does not claim
  future traffic prediction.
- Calendar preview waits for the final time and environmental decision.
- Calendar commit waits for preview and explicit confirmation.

Writes are serialized. A timeout or ambiguous response from a write is reported
as unknown and is never automatically replayed.

### 3.4 Tool adapters and normalization

Adapters return small normalized objects rather than provider payloads. Missing
data must be `unknown` or `available:false`, never silently converted to zero or
“good”. Provider HTML, instructions, verbose reviews, coordinates, credentials,
and raw errors do not reach the answer model.

Suggested environmental evidence shape:

```ts
type OutdoorEvidence = {
  weather: { available: boolean; summary?: string; precipitationPercent?: number;
    feelsLikeF?: number; thunderstormPercent?: number };
  airQuality: { available: boolean; category?: string; aqi?: number;
    dominantPollutant?: string };
  pollen: { available: boolean; overall?: string;
    tree?: string; grass?: string; weed?: string };
  places: { available: boolean; candidates?: Array<{
    id: string; name: string; rating?: number; reviewCount?: number }> };
};
```

### 3.5 Decision and synthesis

Hard safety facts are evaluated in backend code: severe alerts, unavailable
evidence, write authorization, provider freshness, and configured allergy or
air-quality boundaries. The LLM handles the human tradeoff and explanation.

The assistant should not reduce every choice to a hidden weighted score. A
score may shortlist candidates, but the final recommendation should explain the
decisive tradeoff in one or two sentences. Examples:

- “The closer park saves 8 minutes, but tree pollen is high and it has little
  shade; the indoor play area is the safer choice today.”
- “This store is 4 minutes farther but has much stronger ratings from many more
  reviews; I recommend it unless speed is your only priority.”

The model must distinguish fact, inference, and preference. It must not provide
medical diagnosis. Allergy preferences are user-controlled assistant settings,
not inferred health records.

## 4. Environmental services

- Google Weather hourly forecasts provide up to 240 hours and include apparent
  temperature, precipitation/thunderstorm probability, humidity, UV, wind,
  visibility, and cloud cover.
- Google Air Quality supports current, forecast, and historical conditions,
  including indexes, pollutants, and health recommendations.
- Google Pollen provides daily forecasts for up to 5 days with tree, grass, and
  weed information. It is daily—not an exact 5:00 PM pollen reading—and data or
  index fields may be absent.

Initial policy:

- use hourly Weather and forecast AQI for the proposed activity interval;
- label Pollen as a daily risk;
- treat missing environmental evidence as unknown;
- never claim that unknown pollen/AQI means safe;
- prefer structured APIs over web search for the decision gate;
- if a structured service remains unavailable after its bounded read retry,
  give a partial recommendation and identify the missing evidence. Web search
  may provide labelled context but cannot silently satisfy a safety gate.

Official references:

- [OpenAI Responses tools and parallel tool calls](https://developers.openai.com/api/reference/cli/resources/beta/subresources/responses/methods/retrieve)
- [Google Weather hourly forecast](https://developers.google.com/maps/documentation/weather/hourly-forecast)
- [Google Air Quality API](https://developers.google.com/maps/documentation/air-quality/reference/rpc/google.maps.airquality.v1)
- [Google Pollen forecast](https://developers.google.com/maps/documentation/pollen/forecast)

## 5. State, pause, correction, and resumption

Each task has a stable ID, version, node states, attempts, normalized outputs,
and timestamps. A task can be paused while waiting for clarification,
confirmation, a temporary provider recovery, or a user-requested topic switch.

User corrections create a new plan version. Old authorization cannot approve a
new version. Reusable evidence is retained only when its location, time range,
freshness, and meaning still match; otherwise it is discarded and recollected.

Exact location is session-scoped sensitive state. The POC keeps only the newest
fix in volatile runtime memory, refreshes it at most every 10 seconds, rejects it
as current after two minutes, and clears it on explicit stop, disconnect or session
exit. It is removed from audit snapshots and never enters model context. Durable resumption and its
data-retention format remain a later gate; callers must not persist the live
state object as an audit record.

## 6. Confirmation and side effects

Read-only evidence collection does not require a separate confirmation when it
is necessary for the user's explicit request and within the configured privacy
policy. First-use OS location permission is still controlled by the phone.

Every write requires:

1. a successful preview node;
2. a short user-visible preview;
3. fresh explicit confirmation;
4. authorization bound to task ID, plan version, node ID, preview fingerprint,
   and expiry;
5. one write attempt; and
6. a provider receipt or an explicit unknown/failure result.

Confirmation for one write never authorizes another write. A model cannot
construct authorization. Uncertain writes are checked before any new attempt.

## 7. Failure and fallback policy

- Read calls: bounded timeout and up to three attempts according to the
  backend-owned per-tool policy.
- Location: retain the existing three-attempt flow, then ask for a typed or
  spoken starting place.
- Unsupported Pollen region or omitted index: report unavailable, not zero.
- One failed evidence branch: synthesize a labelled partial answer when safe;
  do not dump provider errors.
- Safety-critical missing evidence: do not declare conditions good.
- Write timeout/network ambiguity: mark unknown, do not retry automatically,
  and ask the user to verify the destination system.
- User cancellation: abort pending reads, revoke authorization, and never run
  future nodes.

## 8. Decision budget

The planner may use a larger budget when multiple constraints can change the
recommendation. A practical initial policy is:

- routine action: low reasoning and the minimum relevant tools;
- multi-source recommendation: medium reasoning and concurrent structured
  evidence;
- consequential or unusually ambiguous tradeoff: high reasoning when the
  extra analysis is expected to change or materially justify the decision.

Budgets remain bounded per task, session, day, and month. Tool count alone is
not an intelligence metric. Repeating equivalent searches or collecting facts
that cannot affect the decision is waste, not better assistance.

## 9. Implementation order and gates

1. **Plan/state types and policy validator** — local only. Reject unknown tools,
   cycles, arbitrary expressions, invalid policies, and unpreviewed writes.
2. **Fake-tool scheduler POC** — prove conditional skip, safe concurrency,
   pause/resume, redaction, retries, confirmation binding, and no write replay.
3. **Weather adapter** — local smoke with restricted key; normalize hourly data.
4. **Air Quality adapter** — normalize forecast interval and local AQI.
5. **Pollen adapter** — normalize daily availability and missing fields.
6. **Decision layer** — outdoor suitability, confidence, user preferences, and
   concise assistant synthesis.
7. **Read-tool integration** — Calendar, location, Places, reviews, and Routes.
8. **Conversation integration** — planner, progress messages, correction,
   pause/resume, and compact glasses UI.
9. **Local user acceptance** — browser/simulator scenarios and failure cases.
10. **Linux deployment** — server-only build, restricted credentials, live
    provider smoke, logs, recovery, and security review.
11. **Even Hub build** — only after local/Linux gates pass.

Every stage must pass tests and a security checklist before the next external
service is connected. No stage authorizes GitHub publication, Linux deployment,
or Even Hub packaging by itself.

## 10. Current POC evidence

Implemented locally:

- `src/task-orchestrator.ts`: untrusted plan validation, DAG execution,
  conditional branches, bounded concurrency, pause/wait states, read retry,
  preview-bound write authorization, write fail-closed behavior, and sensitive
  output redaction for snapshots.
- `tests/task-orchestrator.test.ts`: Fake Calendar/location/environment/Places,
  actual concurrent evidence execution, false-condition skip, plan attacks,
  confirmation gating, no replay, read retries, and uncertain-write behavior.
- `src/environment.ts`: bounded and sanitized Google Weather, Air Quality, and
  Pollen HTTP adapters. They return decision-oriented evidence, never provider
  payloads, URLs, keys, or precise location.
- `tests/environment.test.ts`: request-shape, interval filtering, worst-AQI
  selection, unavailable-pollen handling, input rejection, and sanitized error
  contract tests using a local mock transport only.
- `src/outdoor-decision.ts`: deterministic safety floor for temperature,
  precipitation, thunderstorms, wind, UV, AQI, pollen, missing evidence, and
  declared pollen sensitivity. It supplies issues and confidence for later LLM
  synthesis; it does not diagnose health conditions.
- `tests/outdoor-decision.test.ts`: verifies that high or unknown risk cannot
  be turned into a falsely safe recommendation.

Implemented in the current local stage:

- a bounded LLM planner that may only produce the supported outdoor conditional
  scenario and must clarify missing date/time or activity details;
- production registry wiring for Calendar, one-shot location, Weather, AQI,
  Pollen, Places/Routes, deterministic decision, Calendar preview and commit;
- plan-first Calendar fitting: an overlap normally produces one verified nearby
  slot, refreshes Weather/AQI/Pollen for the new interval, and suppresses the
  preview if the refreshed conditions are no longer suitable;
- live conversation routing and concise simulator/HUD progress states;
- current-turn workflow isolation, with real-model regression coverage proving
  that detail, business, philosophy, route, and conditional follow-ups select
  different modes/actions inside one outdoor-topic context;
- preview-bound second-turn confirmation with no automatic replay of an
  uncertain Calendar write; and
- restricted-key live smoke coverage for Weather, AQI, and Pollen. The local
  simulator still requires user acceptance before this stage is complete.

Still later-gated:

- persistent resumable task storage across process restarts;
- production budget ledger and provider observability;
- Linux deployment/security review; and
- physical phone/G2 permission and lifecycle acceptance.

Before simulator acceptance, `npm run conditional:planner:check` performs two
live, read-only OpenAI calls: one intent classification and one bounded task
plan. It disables web search and does not read Calendar, request location,
create a preview, or execute a write. Its output contains only sanitized plan
metadata. Never run it in CI because it consumes API allowance.
