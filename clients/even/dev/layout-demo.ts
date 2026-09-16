// Vite dev only: never included in the client production build.
export function installLayoutDemo(show: (text: string) => void) {
  const button = document.createElement('button');
  button.textContent = '本地分页样例（不调用模型）';
  button.onclick = () => show('这是第一页：Hi Even，中英文混合显示测试。\n' +
    '我们保留当前阅读位置，不随新的回答自动跳页。'.repeat(8) + '\n' +
    'This is a long English reply for pagination and stable reading. '.repeat(12));
  document.body.append(button);
}
