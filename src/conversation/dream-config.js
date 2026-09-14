// Sakana owns when and where AI organization runs. Atom remains a library.
const enabled = /^(1|true|on)$/i.test(process.env.MEMORY_DREAMING_ENABLED ?? 'false');
const guildIds = [...new Set((process.env.MEMORY_DREAMING_GUILDS ?? '1255359848644608035')
  .split(/[\s,]+/).filter(Boolean))];
export const dreamConfig = Object.freeze({
  enabled, guildIds: Object.freeze(guildIds),
  model: 'inclusionai/ling-3.0-flash:free',
  fallbackModels: Object.freeze(['inclusionai/ling-3.0-flash']),
  maxUsd: 30, maximumRequests: 8, maximumSteps: 6,
  schedulerVersion: 2,
  reviewHourJst: 4,
  quietMs: 60000,
  leaseMs: 20 * 60 * 1000,
  heartbeatMs: 60 * 1000,
  maximumFailures: 3
});
export const isDreamGuild = (guildId) => enabled && guildIds.includes(String(guildId));
