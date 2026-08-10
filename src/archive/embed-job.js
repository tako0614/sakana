// 埋め込みのバックフィル。runIndexJob の作りをそのまま踏襲する。
//
// 単一フライトを indexer と共有するので、10万件のフェッチと埋め込みが同時に
// 走らない (7.8GiB のコンテナで両方走らせたくない)。/index cancel と
// /index status も無改造で効く。
//
// cursor_rowid はバッチごとに永続化するので、落ちても1バッチ分しか戻らない。

import { embedConfig } from '../embed/config.js';
import { embedTexts, prewarm } from '../embed/worker.js';
import { getEmbedState, listEmbedGuilds, setEmbedState } from './db.js';
import { claimJob, getRunningJob, releaseJob } from './indexer.js';
import {
  clearGuildVectors,
  coverage,
  ensureModelId,
  normalizeForEmbedding,
  nextBatch,
  saveVectors
} from './vectors.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let cachedModel = null;

/**
 * ワーカーに繋いでモデルの実際の次元を確かめ、embed_models に登録する。
 * 次元をここで確定させるのが要点 — 設定だけ信じると、モデルを差し替えたときに
 * 別の次元のベクトルが同じ model_id に混ざる。
 */
export async function resolveModel() {
  if (cachedModel) return cachedModel;

  // 1件だけ埋め込んで ready の情報を取る
  const probe = await embedTexts(['モデルの次元を確かめるための文'], { kind: 'passage' });
  const dim = probe.dim;

  const modelId = ensureModelId({
    name: embedConfig.modelName,
    dim,
    quant: 'int8',
    prefixQuery: 'query: ',
    prefixPassage: 'passage: ',
    maxLength: embedConfig.maxLength
  });

  cachedModel = { modelId, dim, name: embedConfig.modelName };
  return cachedModel;
}

export function resetModelCache() {
  cachedModel = null;
}

/**
 * 開始前の見積り。実際の件数を SQL で数えて出す (0.5 のような推定値を信じさせない)。
 */
export async function embedPreflight(guildId) {
  const { modelId, dim } = await resolveModel();
  const stats = coverage(guildId, modelId);
  const remaining = Math.max(0, stats.embeddable - stats.done);

  // int8 + 行のオーバーヘッドで概ね dim + 76 バイト
  const bytes = remaining * (dim + 76);

  return {
    ...stats,
    remaining,
    modelId,
    dim,
    estimatedBytes: bytes,
    // 実測 438 msg/s から、バッチ間の待ちを入れた実効値で見る
    estimatedMs: remaining > 0
      ? Math.round((remaining / embedConfig.batchSize) * (embedConfig.batchSize / 438 * 1000 + embedConfig.sleepMs))
      : 0
  };
}

export async function runEmbedJob(guild, { mode = 'forward', rebuild = false, onProgress = () => {} } = {}) {
  const job = {
    guildId: guild.id,
    mode: `embed:${mode}`,
    cancelled: false,
    startedAt: Date.now(),
    messagesIndexed: 0, // /index status の進捗表示と語彙をそろえる
    embedded: 0,
    skipped: 0,
    channelsDone: 0,
    channelsTotal: 0,
    currentChannel: null,
    rate: 0
  };

  claimJob(guild.id, job);

  try {
    const { modelId } = await resolveModel();

    if (rebuild) {
      clearGuildVectors(guild.id);
      setEmbedState(guild.id, { cursor_rowid: 0, embedded: 0, skipped: 0 });
    }

    const state = getEmbedState(guild.id) ?? {};
    let cursor = mode === 'sweep' ? 0 : (state.cursor_rowid ?? 0);

    const stats = coverage(guild.id, modelId);
    job.channelsTotal = Math.max(0, stats.embeddable - stats.done);

    setEmbedState(guild.id, {
      model_id: modelId,
      status: 'running',
      started_at: job.startedAt,
      finished_at: null,
      last_error: null,
      enabled: 1
    });

    const since = mode === 'sweep' ? Date.now() - embedConfig.sweepWindowMs : 0;

    for (;;) {
      if (job.cancelled) break;

      const rows = nextBatch({
        guildId: guild.id,
        modelId,
        cursor,
        limit: embedConfig.batchSize,
        mode,
        since
      });

      if (rows.length === 0) break;

      const prepared = rows.map((row) => ({ rid: row.rid, text: normalizeForEmbedding(row.content) }));
      const keep = prepared.filter((row) => row.text.length >= embedConfig.minChars);
      const drop = prepared.filter((row) => row.text.length < embedConfig.minChars);

      // 対象外にも印を残す。残さないとスイープが同じ行を毎回引き直す。
      if (drop.length > 0) {
        saveVectors(drop.map((row) => ({
          rowid: row.rid, modelId, scale: 0, vec: Buffer.alloc(0), textLen: 0
        })));
        job.skipped += drop.length;
      }

      if (keep.length > 0) {
        const started = Date.now();
        const result = await embedTexts(keep.map((row) => row.text), { kind: 'passage', encode: 'int8' });
        const elapsed = Math.max(1, Date.now() - started);
        job.rate = Math.round(keep.length / (elapsed / 1000));

        saveVectors(keep.map((row, index) => ({
          rowid: row.rid,
          modelId,
          scale: result.scales[index],
          vec: Buffer.from(result.vectors[index], 'base64'),
          textLen: row.text.length
        })));

        job.embedded += keep.length;
      }

      job.messagesIndexed = job.embedded + job.skipped;
      job.channelsDone = job.messagesIndexed;

      if (mode !== 'sweep') {
        cursor = rows[rows.length - 1].rid;
        setEmbedState(guild.id, { cursor_rowid: cursor, embedded: job.embedded, skipped: job.skipped });
      }

      onProgress(job);

      // CPU を明け渡す。bot と Chrome と同居しているので占有しない。
      if (embedConfig.sleepMs > 0) await sleep(embedConfig.sleepMs);
    }

    setEmbedState(guild.id, {
      status: job.cancelled ? 'cancelled' : 'idle',
      finished_at: Date.now(),
      embedded: job.embedded,
      skipped: job.skipped,
      swept_at: mode === 'sweep' ? Date.now() : (getEmbedState(guild.id)?.swept_at ?? null)
    });

    return job;
  } catch (error) {
    setEmbedState(guild.id, {
      status: 'error',
      finished_at: Date.now(),
      last_error: String(error.message ?? error).slice(0, 300)
    });
    throw error;
  } finally {
    releaseJob(guild.id);
  }
}

/** 夜間スイープ。有効にしたギルドだけ、新規分と穴を拾う。 */
export async function sweepEnabledGuilds(client) {
  if (!embedConfig.enabled) return;

  for (const row of listEmbedGuilds()) {
    const guild = client.guilds.cache.get(row.guild_id);
    if (!guild) continue;
    if (getRunningJob(guild.id)) continue;

    try {
      const forward = await runEmbedJob(guild, { mode: 'forward' });
      const swept = await runEmbedJob(guild, { mode: 'sweep' });
      const total = forward.embedded + swept.embedded;
      if (total > 0) console.log(`Embedded ${total} new message(s) in ${guild.name}.`);
    } catch (error) {
      console.error(`Embed sweep failed for ${row.guild_id}:`, error);
    }
  }
}

export { prewarm };
