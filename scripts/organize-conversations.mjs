// Same Writer as the background worker. No Discord gateway or message sends.
import 'dotenv/config';
import { parseArgs } from 'node:util';
import { estimateMemoryBackfill } from '../src/conversation/cost.js';
import {
  dreamJobStatus,
  pauseDreamJob,
  resumeDreamJob,
  startDreamJob
} from '../src/conversation/dream-jobs.js';
import { runConversationWriter, writerStatus } from '../src/conversation/writer.js';
const { values } = parseArgs({ options: {
  estimate: { type: 'boolean', default: false },
  guild: { type: 'string', multiple: true }, status: { type: 'boolean', default: false },
  start: { type: 'boolean', default: false }, pause: { type: 'boolean', default: false },
  resume: { type: 'boolean', default: false },
  batches: { type: 'string', default: '1' }
} });
const mutations = ['start', 'pause', 'resume'].filter((name) => values[name]);
if (mutations.length > 1) throw new Error('Choose only one of --start, --pause, or --resume');
if (mutations.length && !values.guild?.length) throw new Error(`--${mutations[0]} requires --guild`);
if (values.start) {
  console.log(JSON.stringify(values.guild.map((guildId) => startDreamJob({ guildId }))));
} else if (values.pause) {
  console.log(JSON.stringify(values.guild.map((guildId) => pauseDreamJob(guildId))));
} else if (values.resume) {
  console.log(JSON.stringify(values.guild.map((guildId) => resumeDreamJob(guildId))));
} else if (values.estimate) {
  const status = writerStatus(values.guild);
  console.log(JSON.stringify({ ...estimateMemoryBackfill(status.model, status.pending, values.guild), today: status.cost }));
} else if (values.status) {
  console.log(JSON.stringify({ writer: writerStatus(values.guild),
    dream: (values.guild ?? []).map((guildId) => dreamJobStatus(guildId)) }));
}
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
