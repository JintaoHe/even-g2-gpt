import 'dotenv/config';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, rename, chmod } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { GOOGLE_CALLBACK, parseGoogleClient, googleAuthorization, validOAuthState,
  exchangeGoogleCode, discoverAssistantCalendar } from '../src/google-calendar-auth.js';

// Operator-only setup utility. No public OAuth start endpoint, event writes or credential logging.
async function main() {
  const directory = resolve(process.env.EVEN_DATA_DIR || '.local');
  const client = parseGoogleClient(JSON.parse(await readFile(join(directory, 'google-oauth-client.json'), 'utf8')));
  const email = process.env.GOOGLE_CALENDAR_ACCOUNT || process.env.SMTP_USER || '';
  const name = process.env.GOOGLE_CALENDAR_NAME || 'Even Assistant';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('GOOGLE_CALENDAR_ACCOUNT_REQUIRED');
  if (!client.redirect_uris.includes(GOOGLE_CALLBACK)) {
    console.log(`Add this Authorized redirect URI to the Web OAuth client, then download its JSON again:\n${GOOGLE_CALLBACK}`);
    return;
  }
  const auth = googleAuthorization(client, email);
  let used = false;
  await new Promise<void>((done, reject) => {
    const server = createServer(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      const url = new URL(req.url ?? '/', GOOGLE_CALLBACK);
      if (req.method !== 'GET' || req.headers.host !== '127.0.0.1:3002' || url.pathname !== '/oauth/google/callback') {
        res.writeHead(404); res.end('Not found'); return;
      }
      if (used || !validOAuthState(url.searchParams.get('state'), auth.state)) {
        res.writeHead(400); res.end('Invalid or expired authorization.'); return;
      }
      used = true;
      try {
        const code = url.searchParams.get('code');
        if (url.searchParams.has('error') || !code) throw new Error('GOOGLE_AUTH_NOT_APPROVED');
        const token = await exchangeGoogleCode(client, code, auth.verifier);
        const calendar = await discoverAssistantCalendar(token.access_token, email, name);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const temporary = join(directory, `google-calendar-auth-${randomUUID()}.tmp`);
        const destination = join(directory, 'google-calendar-auth.json');
        await writeFile(temporary, JSON.stringify({ version: 1, account: email, calendarId: calendar.id,
          calendarName: calendar.summary, timezone: calendar.timeZone, refreshToken: token.refresh_token,
          scope: token.scope, authorizedAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        await rename(temporary, destination);
        await chmod(destination, 0o600);
        console.log('Google Calendar authorized. Dedicated calendar found; private token saved. No events changed.');
        res.end('授权成功，已找到专用日历。没有创建或修改任何事件。可以关闭此页面。');
        finish();
      } catch (error) {
        const message = safeError(error);
        res.writeHead(400); res.end(`授权未完成：${message}。请返回终端查看设置后重试。`);
        finish(new Error(message));
      }
    });
    const timer = setTimeout(() => finish(new Error('GOOGLE_AUTH_TIMEOUT')), 10 * 60_000);
    function finish(error?: Error) {
      clearTimeout(timer);
      server.close();
      if (error) reject(error); else done();
    }
    server.once('error', () => finish(new Error('GOOGLE_CALLBACK_PORT_UNAVAILABLE')));
    server.listen(3002, '127.0.0.1', () => console.log(`Open this URL in your browser and authorize the dedicated assistant account:\n${auth.url}\nWaiting up to 10 minutes. No calendar events will be changed.`));
  });
}
function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  return /^GOOGLE_[A-Z0-9_]+$/.test(message) ? message : 'GOOGLE_SETUP_FAILED';
}
main().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
