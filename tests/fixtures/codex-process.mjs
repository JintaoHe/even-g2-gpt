// Local fake JSONL producer, not a model and not a network client.
let input = '';
for await (const chunk of process.stdin) input += chunk;
if (input.startsWith('search')) {
  const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
  emit({ type: 'item.started', item: { id: 's1', type: 'web_search', query: 'PRIVATE_QUERY_NOT_FOR_UI' } });
  emit({ type: 'item.updated', item: { id: 's1', type: 'web_search' } });
  if (input === 'search-hang') {
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  }
  emit({ type: 'item.started', item: { id: 's2', type: 'web_search' } });
  emit({ type: 'item.completed', item: { id: 's1', type: 'web_search' } });
  emit({ type: 'item.completed', item: { id: 's2', type: 'web_search', status: input === 'search-failed' ? 'failed' : 'completed' } });
}
if (input === 'hang') {
  setInterval(() => {}, 1000);
} else if (input === 'malformed') {
  process.stdout.write('not json\n');
} else if (input === 'failed') {
  process.stdout.write(JSON.stringify({ type: 'turn.failed', error: { message: 'SECRET_NOT_FOR_CLIENT' } }) + '\n');
} else if (input === 'tool') {
  process.stdout.write(JSON.stringify({ type: 'item.started', item: { type: 'command_execution' } }) + '\n');
} else if (input === 'large') {
  process.stdout.write('x'.repeat(2000001));
} else {
  const event = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '你好 Even' } });
  // Deliberately split a multibyte character across pipe chunks.
  const bytes = Buffer.from(event + '\n');
  const split = bytes.indexOf(Buffer.from('你')) + 1;
  process.stdout.write(bytes.subarray(0, split));
  setTimeout(() => {
    process.stdout.write(bytes.subarray(split));
    if (input !== 'truncated') process.stdout.write('{"type":"turn.completed"}\n');
    if (input === 'nonzero') process.exitCode = 1;
  }, 10);
}
