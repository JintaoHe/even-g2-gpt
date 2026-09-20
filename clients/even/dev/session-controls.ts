export function isLoopbackWebSocket(url: string) {
  try {
    const value = new URL(url);
    return value.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]'].includes(value.hostname);
  } catch { return false; }
}

export function storageReportText(event: any) {
  const bytes = (value: unknown) => typeof value === 'number' && Number.isFinite(value)
    ? `${(value / 1024 / 1024).toFixed(2)} MB` : '未知';
  const actions: Record<string, string> = {
    inspect: 'SQLite 状态', seed_expired: '已写入三年前测试记录',
    cleanup_preview: '三年清理预览', cleanup_apply: '三年测试记录清理结果',
  };
  const lines = [actions[event?.action] ?? 'SQLite 测试结果'];
  if (event?.sqlite) lines.push(`Schema v${event.sqlite.schema_version} · ${event.sqlite.journal_mode} · 外键${event.sqlite.foreign_keys ? '开启' : '关闭'}`);
  if (event?.storage) lines.push(`会话 ${event.storage.sessions} · 消息 ${event.storage.messages} · 数据库 ${bytes(event.storage.database_bytes)}`,
    `可用磁盘 ${bytes(event.storage.available_disk_bytes)} · 警告 ${event.storage.warnings?.length ? event.storage.warnings.join('、') : '无'}`);
  if (event?.current_session) lines.push(`当前会话 ${event.current_session.status} · 最新序号 ${event.current_session.latest_sequence}`);
  if (event?.retention) lines.push(`测试范围：可清理 ${event.retention.test_eligible_sessions} 个会话／${event.retention.test_eligible_messages} 条消息`,
    `本次删除 ${event.retention.deleted_sessions} 个会话／${event.retention.deleted_messages} 条消息`);
  lines.push('安全边界：未读取或显示对话正文。');
  return lines.join('\n');
}

type StorageCommand = 'test.storage.inspect' | 'test.storage.seed_expired'
  | 'test.storage.cleanup_preview' | 'test.storage.cleanup_apply';

export function installSessionControls(options: {
  backendUrl: string;
  resume: () => boolean;
  expire: () => boolean;
  command: (type: StorageCommand) => boolean;
}) {
  if (!isLoopbackWebSocket(options.backendUrl)) return undefined;
  const section = document.createElement('section');
  section.id = 'session-storage-controls';
  const title = document.createElement('strong');
  title.textContent = '本地会话与 SQLite 实验台';
  const controls = document.createElement('div');
  const report = document.createElement('pre');
  report.id = 'session-storage-report';
  report.textContent = '尚未读取 SQLite 状态。';
  const hint = document.createElement('small');
  hint.textContent = '只在 loopback 开发版显示；不读取对话正文，三年清理只删除固定测试记录。';
  const add = (id: string, label: string, action: () => boolean, failure: string, danger = false) => {
    const button = document.createElement('button');
    button.id = id; button.type = 'button'; button.textContent = label;
    if (danger) button.style.background = '#ffd6c9';
    button.onclick = () => { if (!action()) report.textContent = failure; };
    controls.append(button);
  };
  add('resume-session-now', '一键模拟 session resume', options.resume, '当前未连接，无法模拟恢复。');
  add('expire-session-now', '立即模拟恢复窗口过期', options.expire, '当前未连接，无法模拟过期。', true);
  add('inspect-sqlite-now', '查看 SQLite 状态', () => options.command('test.storage.inspect'), '当前未连接，无法读取状态。');
  add('seed-expired-record', '写入 3 年前测试记录', () => options.command('test.storage.seed_expired'), '当前未连接，无法写入测试记录。');
  add('preview-retention', '预览测试记录清理（固定三年）', () => options.command('test.storage.cleanup_preview'), '当前未连接，无法预览。');
  add('apply-retention', '清理 3 年前测试记录', () => options.command('test.storage.cleanup_apply'), '当前未连接，无法清理。', true);
  section.append(title, controls, report, hint);
  document.body.append(section);
  return { element: section, handleEvent(event: any) {
    if (event?.type !== 'test.storage.report') return false;
    report.textContent = storageReportText(event); return true;
  } };
}
