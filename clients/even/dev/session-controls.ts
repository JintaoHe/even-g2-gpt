export function isLoopbackWebSocket(url: string) {
  try {
    const value = new URL(url);
    return value.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]'].includes(value.hostname);
  } catch { return false; }
}

export function installSessionControls(options: { backendUrl: string; expire: () => boolean }) {
  if (!isLoopbackWebSocket(options.backendUrl)) return undefined;
  const button = document.createElement('button');
  button.id = 'expire-session-now';
  button.type = 'button';
  button.textContent = '立即模拟会话恢复窗口过期';
  button.onclick = () => {
    button.textContent = options.expire() ? '已触发过期；正在建立新会话' : '当前未连接，无法模拟过期';
  };
  document.body.append(button);
  return button;
}
