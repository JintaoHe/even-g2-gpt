// Deterministic visual fixture, loaded only in development mode.
export function installReadingDemo(replay: (events: { type: string; [key: string]: unknown }[]) => void) {
  const examples = [
    { label: '实时识别样例（非 AI）', events: [
      { type: 'speech.started', segment_id: 1 },
      { type: 'transcript.delta', segment_id: 1, text: 'Hi Even，把 deployment date 改到 next Friday，不要删除原来的备注。' }
    ] },
    { label: '历史与隐藏链接样例（非 AI）', events: [
      { type: 'turn.committed', text: 'Hi Even，请解释 API 和 CLI 的区别，保留来源。' },
      { type: 'answer.start', id: 1 },
      { type: 'answer.delta', id: 1, text: 'API 适合连续对话和流式显示。CLI 适合用户选择自己的订阅通道。\n' + '阅读位置由你控制，新内容不会自动翻页。'.repeat(10) + '\n来源：[OpenAI](https://openai.com/)。数据和具体能力仍需核实。' },
      { type: 'answer.done', id: 1 }
    ] }
  ];
  for (const example of examples) {
    const button = document.createElement('button'); button.textContent = example.label;
    button.onclick = () => replay(example.events); document.body.append(button);
  }
  if (new URLSearchParams(location.search).get('reading-test') === '1') replay(examples[1].events);
}
