import { rename } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';

/** Never unlink the destination: a failed replacement must retain the last durable ledger. */
export async function replaceLedgerFile(source: string, target: string,
  move: typeof rename = rename, delay: (ms: number) => Promise<unknown> = setTimeout) {
  for (let attempt = 0; ; attempt++) {
    try { await move(source, target); return; }
    catch (error: any) {
      if (!['EPERM', 'EBUSY'].includes(error?.code) || attempt >= 3) throw error;
      await delay(50 * 2 ** attempt);
    }
  }
}
