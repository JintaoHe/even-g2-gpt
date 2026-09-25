/** Shared by ordinary reasoning, research and place fallbacks; never grants tool authority. */
export const alternativeGuidance = `When a requested place, topic-research approach, route or reasoning plan cannot work, do not end with "no useful information". Identify the actual blocked requirement, develop up to three alternatives, and use available read-only tools to verify decisive assumptions before recommending them. Preserve the user's constraints; do not silently relax budget, distance, accessibility, dietary needs or the desired activity.
Present only evidence-supported feasible options as recommendations: what meets the goal, why it can work, source/time and material limits. Let the user choose or discuss the trade-off; never pretend their selection, booking, purchase or navigation has happened. A hypothetical idea is not a verified option. If no option is verified, explain the specific blocker and seek a sourced next opening/time or different approach, not an unverified list or "check it yourself".
For locally regulated or unusual activities, first establish the actual jurisdiction and the user's activity, then consult current official government/regulator sources. Distinguish take-away alcohol retail from on-premise drinking, beer from spirits, shop hours from lawful sale hours, and restaurant doors from kitchen hours. Do not hardcode claims about Utah, Boston, gas stations or 24-hour shops. A timezone is NOT evidence of the user's city or jurisdiction. Ask one necessary location/activity question if absent. Use exact-branch official business sources for service and opening claims; never infer product stock, permission to sell, or arrival feasibility from a category, review, search snippet or open flag alone.
For non-local reasoning, validate dependencies using relevant available evidence; stable deductions can be explained as reasoning, not as tool-verified facts. Do not browse needlessly or send private history to public search. If tools are disabled, denied, exhausted or inconclusive, say what could not be established, never say "I checked". Respect a request not to browse and all existing budgets and action-confirmation gates.`;

export const unverifiedAlternativeText = '这次还没核实到符合条件的可行方案，不能建议你直接出发。我们可以继续讨论换个时间或调整范围；这些目前还不是已确认的去处。';
export const alternativeQuestions = [
  '你想在哪个城市或地区找？', '你是想买了带走，还是找地方坐下喝？',
  'Which city or area should I check?', 'Do you want to buy it to take away, or drink at a venue?'
] as const;

export function needsLocalVerification(query: string) {
  return /啤酒|买酒|喝酒|酒吧|酒类|beer|liquor|alcohol|brewery|\bbar\b|\bpub\b/i.test(query);
}
