# Automatic reasoning for Luna

The default Luna/Luna conversation now classifies turn intent and answer effort in the same structured-output request. No extra classifier call is introduced. The classifier itself stays at `none`.

- `none`: greetings, simple facts, single-step requests.
- `low`: ordinary explanations, comparisons, analysis; fallback for missing/invalid effort in an otherwise valid decision.
- `medium`: complex tradeoffs/arguments or direct requests such as “深入想一下”.

Classification uses conversation context, not keyword matching. Quoted/negated requests should not raise effort; short answers need not imply shallow reasoning. Each turn is assessed afresh. Selection is probabilistic, not a guarantee of quality or latency.

The plan travels with the turn, never in shared mutable model state. Cancelled plans cannot change another turn. Invalid decisions, malformed JSON, provider failures still pause safely; effort fallback does not turn an unknown intent into an action. Exit/wait/clarification do not invoke an answer model (except forced submission overriding wait, as before).

Answer output caps (including reasoning) are 1,400 / 4,096 / 8,192 tokens for none / low / medium. These are ceilings, not target consumption. Answers remain concise unless detail is requested. Higher effort can increase cost and time; search count caps are unchanged and are not a total dollar budget.

The browser displays the selected effort next to each answer. Selecting both roles as GPT-4.1 mini disables adaptive effort and sends no reasoning parameter; other explicit model configurations retain their previous fixed profiles. Direct low-level `reply()` calls without a plan keep their fixed default; use `Conversation` to evaluate adaptive routing.

Source: https://developers.openai.com/api/docs/models/gpt-5.6-luna

Offline tests: `tests/adaptive-reasoning.test.ts` covers all three levels, invalid/missing effort, request counts, control decisions, rollback and late cancelled plans. Live semantic quality and latency require separate evaluation.

Initial validation: TypeScript and all 29 offline tests passed. `tests/live-adaptive-reasoning.ts` (paid, search disabled) passed 7/7 semantic routing cases, including quoted/negated deep-thinking requests, contextual follow-up and exit. Three end-to-end streaming replies selected none/low/medium successfully, with first text including classification at 1.652 / 1.647 / 1.658 seconds in this single run. These are smoke-test observations, not a latency guarantee or proof of broad routing accuracy. No search quota was consumed.
