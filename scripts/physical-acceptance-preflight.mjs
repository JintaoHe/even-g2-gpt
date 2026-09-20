import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const git = process.platform === 'win32' ? 'git.exe' : 'git';
const npmCli = process.env.npm_execpath;
const npmCommand = npmCli ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm');
const npmArgs = args => npmCli ? [npmCli, ...args] : args;

const major = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10);
if (!Number.isInteger(major) || major < 24) {
  throw new Error(`Physical acceptance preflight requires Node 24+; found ${process.versions.node}`);
}

const env = { ...process.env };
delete env.NODE_OPTIONS;

const steps = [
  ['Root automated tests', npmCommand, npmArgs(['test'])],
  ['Root TypeScript', npmCommand, npmArgs(['run', 'typecheck'])],
  ['Even client tests', npmCommand, npmArgs(['--prefix', 'clients/even', 'test'])],
  ['Even production client build', npmCommand, npmArgs(['--prefix', 'clients/even', 'run', 'build'])],
  ['Server-only production build', npmCommand, npmArgs(['run', 'build:server'])],
  ['Public worktree audit', npmCommand, npmArgs(['run', 'audit:public', '--', '--worktree'])],
  ['Whitespace/error diff check', git, ['diff', '--check']]
];

console.log('Physical acceptance preflight is offline and non-mutating with respect to providers.');
console.log('It does not deploy Linux, call OpenAI/Soniox/Google/SMTP, pack an EHPK, or upload to Even Hub.');

for (const [label, command, args] of steps) {
  console.log(`\n=== ${label} ===`);
  execFileSync(command, args, { cwd: root, env, stdio: 'inherit' });
}

console.log('\nPASS: automated physical-acceptance preflight completed.');
console.log('This is not physical-device evidence. Continue with docs/validation/v1.3-real-g2.md on a real phone, G2, and R1.');
