# Cognitive-aware reasoning and topic threads

The default Luna/Luna conversation classifies control intent, cognitive mode, workflow actions, topic-thread movement and answer effort in the same structured-output request. No extra classifier call is introduced. The classifier uses `medium`; answers use only `low`, `medium`, or `high`.

## Cognitive modes and workflows

| Cognitive mode | Typical request | Default policy |
| --- | --- | --- |
| `casual` | greetings, simple chat, acknowledgements | `low` |
| `explain` | stable explanations, details, and causes | `low` or `medium` |
| `research` | current facts, public events, recommendations | `low` or `medium` |
| `brainstorm` | divergent ideas and alternatives | at least `medium` |
| `decision_support` | comparison and recommendation | at least `medium` |
| `planning` | technical, product, engineering or business plan | at least `medium`; identify constraints, tradeoffs and a next step |
| `deep_reasoning` | rigorous philosophical, academic, technical, or business analysis | at least `medium`; use `high` only for genuinely difficult or explicitly strongest analysis |
| `compose` | writing, rewriting, summarizing, or structuring content | `low` or `medium` |
| `coaching` | reflection, practice, habits, or accountability | `low` or `medium` |

The cognitive mode is re-evaluated on every turn and changes response strategy only. Search, navigation, Calendar, document and email workflows are classified independently. Web search is exposed only when the normalized `search` workflow is selected, not merely because a mode sounds complex. Calendar, email, document and location actions retain their backend authorization rules. `navigation` is a workflow rather than a cognitive mode. The former conditional-outdoor runtime is retired; outdoor and itinerary work remains general `planning` with bounded read-tool fallbacks.

The full routing contract and examples are in [COGNITIVE_WORKFLOW_ROUTING.md](COGNITIVE_WORKFLOW_ROUTING.md).

## Topic threads inside one session

A session may contain several paused threads, such as `Chicago trip` and `Retail business idea`. Every committed user/assistant message receives an application-owned topic ID and short label. The classifier may continue the active thread, start a new one, or resume only an ID that the application supplied; it cannot invent an authoritative ID.

The intent classifier sees the full tagged session so it can understand “hold that thought” and “return to the earlier route.” The answer/tool stage receives only the active topic slice. Consequently, a requested business-plan MD does not receive trip-planning messages, and a later trip-plan MD does not receive the business discussion. Topic metadata is persisted with the private conversation record and is never treated as user instructions.

The current implementation keeps topic threads only for the lifetime of one connected conversation. It does not restore them after reconnecting and does not yet maintain automatic summaries for very long threads. Route candidates/pending route context live for the 30-minute session window; a fresh phone location is still requested when a resumed route needs current position.

A single utterance asking for both an MD/email and a real Calendar write represents two write operations. The document is handled first. Calendar preview and confirmation must occur in a later turn; one spoken confirmation never authorizes both.

## Reasoning levels

- `low`: greetings, simple facts, routine tool actions, single-step requests, concise acknowledgements, and fallback for missing/invalid effort in an otherwise valid decision.
- `medium`: ordinary explanations, comparisons, causal analysis, multi-constraint tradeoffs, complex arguments, or direct requests such as “深入想一下”.
- `high`: exceptionally difficult multi-stage analysis with many interacting constraints, rigorous critique under uncertainty, or an explicit request for the strongest reasoning.

`high` is deliberately conservative. Length, philosophical subject matter, current information, or use of a tool is not sufficient by itself. Routine calendar, location, delivery, search and confirmation turns normally stay at `low`; when the boundary is uncertain, the router selects the lower adjacent level.

Classification uses conversation context, not keyword matching. Quoted/negated requests should not raise effort; short answers need not imply shallow reasoning. Each turn is assessed afresh. Mode policy then bounds the model's requested effort: casual stays low; brainstorm, decision support, planning and deep reasoning use at least medium; high remains conservative. Selection is probabilistic, not a guarantee of quality or latency.

The plan travels with the turn, never in shared mutable model state. Cancelled plans cannot change another turn. Invalid decisions, malformed JSON, provider failures still pause safely; effort fallback does not turn an unknown intent into an action. Exit/wait/clarification do not invoke an answer model (except forced submission overriding wait, as before).

Answer output caps (including reasoning) are 4,096 / 8,192 / 16,384 tokens for low / medium / high. The medium classifier has a 1,024-token cap. These are ceilings, not target consumption. Answers remain concise unless detail is requested. Higher effort can increase cost and time; search count caps are unchanged and are not a total dollar budget.

The browser displays cognitive mode, selected capabilities and effort next to each answer. These diagnostics are not added to the constrained glasses body. Selecting both roles as GPT-4.1 mini disables adaptive effort and sends no reasoning parameter; other explicit model configurations retain their previous fixed profiles. Direct low-level `reply()` calls without a plan keep their fixed default; use `Conversation` to evaluate adaptive routing.

Sources: https://developers.openai.com/api/docs/guides/reasoning and https://developers.openai.com/api/docs/guides/tools

Offline tests: `tests/adaptive-reasoning.test.ts`, `tests/assistant-mode.test.ts`, and `tests/topic-threading.test.ts` cover effort bounds, scene-specific web exposure, topic switching/resumption, scoped answer history, rollback and late cancelled plans. Live semantic quality and latency still require separate evaluation.

`npm run scene:eval` is an explicit opt-in paid smoke that sends five synthetic classifier turns to the configured API. It checks route → business → resumed route → deep reasoning → casual switching without invoking Maps, Calendar, email, or answer generation.

The original historical evaluation is preserved in [DYNAMIC_REASONING_EVAL.md](DYNAMIC_REASONING_EVAL.md). The current low-versus-medium intent comparison is recorded in [INTENT_REASONING_AB.md](INTENT_REASONING_AB.md). The selected cases were equally accurate; medium added 280 ms at the median and 842 ms at p90 in that run. This is a small smoke evaluation, not a general accuracy or latency guarantee.
