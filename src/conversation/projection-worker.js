import 'dotenv/config';
import { parentPort } from 'node:worker_threads';
import { setTimeout } from 'node:timers/promises';
import { syncConversationMemory } from './memory.js';

// SQLite ingestion runs outside Discord's event loop. Source changes remain
// queued, and readers exclude pending documents until their projection commits.
let lastLog = 0, lastPending;
for (;;) {
  const status = await syncConversationMemory({ limit: 200 });
  if (Date.now() - lastLog >= 60000 || (!status.pending && lastPending !== 0)) {
    parentPort?.postMessage(status);
    lastLog = Date.now();
  }
  lastPending = status.pending;
  await setTimeout(status.pending ? 25 : 5000);
}
