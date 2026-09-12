// Same Writer as the background worker. No Discord gateway or message sends.
import 'dotenv/config';
import { parseArgs } from 'node:util';
import { estimateMemoryBackfill } from '../src/conversation/cost.js';
import { runConversationWriter, writerStatus } from '../src/conversation/writer.js';
const { values } = parseArgs({ options: {
  estimate: { type: 'boolean', default: false },
  guild: { type: 'string', multiple: true }, status: { type: 'boolean', default: false },
  batches: { type: 'string', default: '1' }
} });
if (values.estimate) {
  const status = writerStatus(values.guild);
  console.log(JSON.stringify({ ...estimateMemoryBackfill(status.model, status.pending, values.guild), today: status.cost }));
} else if (values.status) console.log(JSON.stringify(writerStatus(values.guild)));
else {
  const count = Number(values.batches);
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('--batches must be a positive integer');
  for (let index = 0; index < count; index++) {
    const status = await runConversationWriter({ guildIds: values.guild });
    console.log(JSON.stringify(status));
    if (status.paused) { process.exitCode = 2; break; }
    if (status.idle || !status.pending) break;
  }
}
