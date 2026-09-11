import 'dotenv/config';
import { parentPort, workerData } from 'node:worker_threads';
import { setTimeout } from 'node:timers/promises';
import { syncConversationMemory } from './memory.js';
import { runConversationWriter, writerStatus } from './writer.js';

// SQLite ingestion runs outside Discord's event loop. Source changes remain
// queued, and readers exclude pending documents until their projection commits.
let lastLog = 0, lastPending;
const guildIds = [...(workerData?.guildIds ?? [])];
parentPort?.on('message', (message) => {
  if (Array.isArray(message.guildIds)) guildIds.splice(0, guildIds.length, ...message.guildIds);
});
for (;;) {
  // One Atom writer owns both source ingestion and AI organization. Prioritize
  // the sources needed by the next conversation batch, while draining other edits.
  const status = await syncConversationMemory({ limit: 20 });
  try {
    const organized = await runConversationWriter({ guildIds });
    if (organized.completedBatch) parentPort?.postMessage({ writer: organized });
  } catch (error) {
    parentPort?.postMessage({ writerError: String(error.message ?? error), writer: writerStatus(guildIds) });
  }
  if (Date.now() - lastLog >= 60000 || (!status.pending && lastPending !== 0)) {
    parentPort?.postMessage(status);
    lastLog = Date.now();
  }
  lastPending = status.pending;
  await setTimeout(status.pending ? 25 : 5000);
}
