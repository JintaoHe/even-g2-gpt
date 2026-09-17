// Audit exactly the staged blobs, not just the working tree. Never print secret values.
import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync } from 'node:fs';
const git = (...args) => execFileSync('git', args, { maxBuffer: 20 * 1024 * 1024 });
const working = process.argv.includes('--worktree');
const history = process.argv.includes('--history');
if (working && history) throw Error('Choose worktree or history audit');
const entries = history
  ? [...new Set(git('rev-list', '--all').toString().trim().split('\n').filter(Boolean)
    .flatMap(commit => git('ls-tree', '-r', '-z', commit).toString().split('\0').filter(Boolean)
      .map(entry => entry.replace(' blob ', ' ').replace('\t', ' 0\t'))))]
  : working
  ? [...new Set(git('ls-files', '--cached', '--others', '--exclude-standard', '-z').toString().split('\0').filter(Boolean))]
    .map(path => `100644 ${'0'.repeat(40)} 0\t${path}`)
  : git('ls-files', '--stage', '-z').toString().split('\0').filter(Boolean);
const findings = [];
const secrets = [];
try {
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS)[A-Z_]*|SMTP_USER|EMAIL_FROM|EMAIL_TO)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) {
      const value = match[2].replace(/^['"]|['"]$/g, '');
      if (value.length >= 12) secrets.push(value);
      if (match[1] === 'SMTP_PASS' && value.replace(/ /g, '').length >= 12) secrets.push(value.replace(/ /g, ''));
    }
  }
} catch (error) { if (error.code !== 'ENOENT') throw error; }
// OAuth JSON is private even when it is outside .env; compare exact values without printing them.
for (const [file, fields] of [
  ['.local/google-oauth-client.json', value => [value.web?.client_secret]],
  ['.local/google-calendar-auth.json', value => [value.refreshToken]]
]) {
  try { secrets.push(...fields(JSON.parse(readFileSync(file, 'utf8'))).filter(value => typeof value === 'string' && value.length >= 12)); }
  catch (error) { if (error.code !== 'ENOENT') throw Error('Private OAuth audit input invalid'); }
}
for (const entry of entries) {
  const match = /^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(entry);
  if (!match) throw Error('Invalid git index entry');
  const [, mode, hash, stage, path] = match;
  const report = reason => findings.push({ path, reason });
  if (stage !== '0' || !['100644', '100755'].includes(mode)) report('Non-regular or conflicted file');
  if (/(^|\/)(node_modules|dist|\.local|\.tools|\.codex|\.agents|coverage)(\/|$)/i.test(path)
    || /(^|\/)(auth|credentials|secrets)\.json$/i.test(path)
    || /(^|\/)(google-oauth-client|google-calendar-auth|client_secret[^/]*)\.json$/i.test(path)
    || /(^|\/)\.env(?:\.|$)/.test(path) && path !== '.env.example'
    || path === 'tests/recording-regression.md') report('Private/generated path');
  if (!/\.(?:ts|js|mjs|json|md|html|css|service|yml|yaml)$/.test(path) && !['.gitignore', '.env.example', '.github/CODEOWNERS'].includes(path)) report('Not an allowed source/document file');
  if (working) {
    let stat;
    try { stat = lstatSync(path); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink()) { report('Non-regular working file'); continue; }
  }
  const bytes = working ? readFileSync(path) : git('cat-file', 'blob', hash);
  if (bytes.length > 1024 * 1024 || bytes.includes(0)) report('Oversized/binary content');
  const original = bytes.toString('utf8');
  if (secrets.some(secret => original.includes(secret))) report('Contains local credential value');
  // Exact, reviewed negative-test fixture; do not allow arbitrary credential URLs.
  const fixtureUrl = ['https://user', 'pass@example.com'].join(':');
  const text = path === 'tests/search.test.ts' ? original.replaceAll(fixtureUrl, 'https://example.com') : original;
  for (const [name, pattern] of [
    ['Provider credential', /\b(?:sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/],
    ['Private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ['Google OAuth credential', /\b(?:GOCSPX-[A-Za-z0-9_-]{15,}|1\/\/[A-Za-z0-9_-]{25,})/],
    ['Personal email address', /\b[A-Za-z0-9._%+-]+@(?:gmail|icloud|outlook|hotmail|yahoo)\.com\b/i],
    ['JWT credential', /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\b/],
    ['Personal Windows path', /[A-Za-z]:[\\/]Users[\\/](?!<|YOUR|example|Public|user[\\/])[A-Za-z0-9_.-]+[\\/]/i],
    ['Credential in URL', /https?:\/\/[^\s/"'<>]+:[^\s/"'<>]+@/]
  ]) if (pattern.test(text)) report(name);
}
if (findings.length) { console.error(JSON.stringify(findings, null, 2)); process.exitCode = 1; }
else console.log(`PASS: ${entries.length} ${history ? 'historical' : working ? 'working-tree' : 'staged'} source/document files; no prohibited paths or detected credentials. Automated scanning is not a security guarantee.`);
