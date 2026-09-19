# Cognitive mode, workflow, task kind, and tools

This is the current routing contract for the personal assistant. The four axes are intentionally separate and are re-evaluated on every turn.

## 1. Cognitive mode: how to think and answer

Exactly one primary cognitive mode is selected for the current goal:

| Mode | Purpose | Typical reasoning floor |
| --- | --- | --- |
| `casual` | greetings, humour, praise, celebration, open-ended conversation, and lightweight companionship | low |
| `explain` | teach or clarify stable facts and causes | low |
| `research` | verify fresh public or external evidence | low/medium |
| `brainstorm` | generate meaningfully different ideas | medium |
| `decision_support` | compare options and recommend | medium |
| `planning` | turn an objective into ordered actions or a design | medium |
| `deep_reasoning` | examine assumptions, causal models, counterarguments, and synthesis, including rigorous business analysis | medium/high |
| `compose` | create, rewrite, summarize, or structure content | low/medium |
| `coaching` | supportive reflection, encouragement, practice, habits, or accountability | low/medium |

`navigation` is deliberately **not** a cognitive mode. A route can be an explanation, a comparison/decision, part of a plan, or a fresh-information research question.

The mapping is intentionally flexible rather than keyword-fixed. A single business idea can move from `brainstorm` to `deep_reasoning`, then `decision_support`, `planning`, and `compose` as the user's goal changes. The model chooses from current meaning and topic context. The backend constrains reasoning floors and tool safety, but does not overwrite a valid cognitive choice merely because a Calendar, route, or document workflow is present.

### Companion stance

Companionship is an interaction stance, not another tool workflow or a permanent
persona mode. In any session the assistant may move among:

- **doing**: execute a validated route, Calendar, document, email, or research
  workflow;
- **thinking together**: explain, compare, brainstorm, plan, or reason deeply;
- **being present**: talk casually, share humour or celebration, acknowledge an
  emotion, or listen without manufacturing a task.

`casual` normally carries the third stance; `coaching` is used when the user is
reflecting, seeking encouragement, practising, or working through a concern.
The assistant responds to emotional meaning before offering an optional next
step. Praise for a completed operation should therefore sound like “谢谢你这么
说！这两个日程已经创建好了。能帮你把安排真正落下来，我也很开心；之后
想调整，随时告诉我。”, not like a fresh intake form. An explicit “nothing
else” is a warm conversational close, not a reason to repeat the completion
template or ask another question. It should infer from context whether the user
wants listening, reflection, analysis, action, or closure, and avoid reflexively
turning every exchange into a question or checklist.

Warmth does not permit deceptive human claims, dependency-seeking language, or
medical/mental-health diagnosis. The assistant remains clear that it is an AI
when that distinction matters, without reciting a disclaimer during normal
friendly conversation.

Topic/thread labels and model reasoning markers are private control data. The
backend strips current and legacy metadata variants while streaming and again
before persistence. A response that begins with an internal analysis marker is
rejected rather than shown on the glasses.

## 2. Workflow: which application capability is selected

Workflows are orthogonal to cognitive mode. The current allowlist is:

- `search`
- `navigation`
- `environment`
- `calendar`
- `document`
- `email`

`memory` and `list` are reserved vocabulary only; they are not executable until their backend adapters and authorization rules exist. An empty workflow list means ordinary model conversation.

The model emits typed action fields such as `search_action`, `location_action`, and `calendar_action`. The backend validates those fields and then builds the normalized workflow list. The model cannot add a new tool or workflow name.

Examples:

| Request | Cognitive mode | Workflow |
| --- | --- | --- |
| “Why did you recommend this park?” | `explain` | none or `search`, depending on freshness needed |
| “Compare the two nearby Target stores using traffic and ratings.” | `decision_support` | `navigation` |
| “What happened to Coinbase today and why?” | `research` | `search` |
| “Turn this business discussion into an MD and email it.” | `compose` | `document` + `email` |
| “Create this meeting next Wednesday.” | `planning` or `compose` | `calendar` |

## 3. General planning and read-tool fallback

The former `conditional_task + outdoor_activity` runtime is retired. Outdoor,
trip, itinerary and other multi-step requests now stay in the general
`planning` cognitive mode so Luna can preserve the whole conversational goal
instead of compressing it into one place query.

Fresh public evidence uses a bounded read fallback chain:

1. use a dedicated structured Google read when its explicit workflow applies;
2. if Maps/Routes fails, let Luna use quota-bounded web research for public
   venue context, while forbidding claims of exact live ETA, distance, traffic
   or current position;
3. for a time-bounded outdoor plan, use the newest fresh-enough session location
   (or acquire a bounded fix when stale) and run
   Weather, Air Quality and Pollen concurrently; retry only retryable reads once;
4. if one of those environment reads remains unavailable, keep that field
   unknown and let Luna use quota-bounded public research as supporting evidence;
5. disclose missing evidence instead of treating it as safe or zero.

Calendar and Email are deliberately outside this fallback. A model or web
search cannot replace their private state, confirmation, idempotency or
delivery receipt.

Clarification is progressive rather than form-like across ordinary conversation
and every workflow. The assistant asks for one **atomic information slot or
decision** per turn; one sentence may not combine an origin and return place,
date and time, ticket status and departure time, or any other two missing facts.
Alternative choices are permitted only when they answer that one decision.

Calendar additionally reuses facts already established in the active topic,
applies reversible planning defaults and small transition buffers when the user
asks it to arrange the day. An explicit
multi-stop request for separate Calendar events is planned once, then each
event is previewed and confirmed individually. One confirmation never
authorizes the remaining events.

Adding another task kind requires all of the following before it is placed on the allowlist:

1. a typed task specification;
2. a backend compiler and tool registry;
3. read/write risk classification;
4. bounded retries, cancellation, and timeouts;
5. preview-bound authorization for every side effect;
6. offline tests and a simulator acceptance scenario.

## 4. Tool and skill execution

Tools never execute merely because a cognitive label suggests them. Execution still follows the validated action and the existing wrapper:

- search is exposed to the answer model only when the `search` workflow is selected;
- location actions route through the Maps/location wrapper;
- time-bounded outdoor planning may use the session-location environment wrapper;
- Calendar actions route through the dedicated-calendar wrapper;
- document/email actions route through the persistent draft and fixed-recipient delivery wrapper;
- planning may use quota-bounded public research after a read-only provider failure.

Read-only tool use and write authorization remain different states. A reasoning level, cognitive mode, workflow classification, or previous confirmation never authorizes a new write.

## Per-turn and topic behavior

The classifier evaluates the current utterance rather than pinning a whole conversation to one mode. During one connected session, the answer model receives the complete bounded session history as short-term memory, with backend-owned current/earlier topic annotations. It can therefore resolve references such as “你之前提到的 idea”, “前面第2点”, or “刚才推荐的那家”. This is session context, not durable personal memory: disconnecting starts a new session, and saved transcripts are not automatically restored into a later conversation.

Topic IDs still isolate outputs that must have a clear scope. Mode and workflow can change inside a topic, and an explicit reference can resume an earlier topic. In particular, MD/Email generation is filtered by the backend to the active topic, so a trip-planning thread may move through research, decision support, route lookup, document composition, and Calendar creation without merging the trip MD into an unrelated business-plan MD. Recent structured place facts may be supplied to Luna as hidden read-only context for follow-up questions; raw GPS coordinates remain excluded.

The server emits canonical `cognitiveMode`, `workflows`, and `taskKind` diagnostics in `answer.start`. It temporarily mirrors `cognitiveMode` as `assistantMode` for older clients and saved sessions. That compatibility field does not restore the old five-scene taxonomy.

## Security invariants

- Classification never grants write permission.
- Unsupported task kinds fail closed.
- Exact GPS coordinates remain inside volatile session location adapters and are not sent to Luna, search, history, logs, artifacts or the display. They are refreshed at most every 10 seconds, rejected as current after two minutes, and cleared on stop/disconnect/session exit.
- Whole-session context is sent only to the configured conversation model with `store:false`; it is not automatically placed in web-search queries. Artifact generation receives only the active topic.
- Web search receives only relevant public query context, not unrelated private history.
- Calendar, email, and conditional writes retain preview, explicit confirmation, idempotency, and unknown-result handling.
- Cancellation invalidates the active plan; a late result cannot act on the next turn.

## Verification

Offline coverage includes `tests/assistant-mode.test.ts`, `tests/adaptive-reasoning.test.ts`, `tests/topic-threading.test.ts`, `tests/dialogue-location-intent.test.ts`, `tests/planning-evidence-dialogue.test.ts`, and the retained historical `tests/conditional-task-dialogue.test.ts`. `npm run scene:eval` is the opt-in paid semantic smoke for real-model classification.
