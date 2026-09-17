import 'dotenv/config';
import { resolve } from 'node:path';
import { loadCalendarTransport, calendarError } from '../src/google-calendar.js';

try {
  const { transport, calendarId } = await loadCalendarTransport(resolve(process.env.EVEN_DATA_DIR || '.local'));
  const calendar = await transport('GET', '');
  if (calendar.id !== calendarId) throw Error('Binding mismatch');
  console.log('PASS: refresh token accepted and bound calendar readable. No events read or modified.');
} catch (error) { console.error(calendarError(error)); process.exitCode = 1; }
