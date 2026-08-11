// 埋め込みのバックフィル。runIndexJob の作りをそのまま踏襲する。
//
// 単一フライトを indexer と共有するので、10万件のフェッチと埋め込みが同時に
// 走らない (7.8GiB のコンテナで両方走らせたくない)。/index cancel と
// /index status も無改造で効く。
//
// 2段構え: ①会話のまとまりを作る ②まとまりのベクトルを作る。
// 単位が発言ではなくまとまりなのは chunks.js に書いた理由から。
//
// cursor_rowid はバッチごとに永続化するので、落ちても1バッチ分しか戻らない
// (まとまりに移ったあとは chunk_id を入れている。AUTOINCREMENT なので単調)。

import { embedConfig } from '../embed/config.js';
import { embedTexts, prewarm } from '../embed/worker.js';
import {
  buildGuildChunks,
  chunkCoverage,
  chunkMessages,
  chunkText,
  clearGuildChunks,
  maxChunkIdFor,
  nextChunkBatch,
  refreshStale,
  saveChunkVectors
} from './chunks.js';
import { getEmbedState, listEmbedGuilds, setEmbedState } from './db.js';
import { claimJob, getRunningJob, releaseJob } from './indexer.js';
import { ensureModelId } from './vectors.js';

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
 * まとまりはまだ作っていないことがあるので、その場合は発言数から概算する。
 */
export async function embedPreflight(guildId) {
  const { modelId, dim } = await resolveModel();
  const stats = chunkCoverage(guildId, modelId);
  const remaining = Math.max(0, stats.total - stats.done);

  // int8 + 行のオーバーヘッドで概ね dim + 76 バイト
  const bytes = remaining * (dim + 76);

  return {
    ...stats,
    remaining,
    modelId,
    dim,
    estimatedBytes: bytes,
    // まとまりは1件が長いので発言1件より遅い。実測前の見込みで 60 件/秒。
    estimatedMs: remaining > 0
      ? Math.round((remaining / embedConfig.batchSize) * (embedConfig.batchSize / 60 * 1000 + embedConfig.sleepMs))
      : 0
  };
}

/**
 * バッチが失敗したときに1件ずつ埋め直す。
 * 埋め込めない1件は印を残して飛ばす。印を残さないと次回も同じ行で止まり、
 * バックフィルが永久に先へ進まない。
 */
async function embedOneByOne(prepared, modelId, job) {
  for (const row of prepared) {
    try {
      const single = await embedTexts([row.text], { kind: 'passage', encode: 'int8' });
      saveChunkVectors([{
        chunkId: row.chunkId,
        modelId,
        scale: single.scales[0],
        vec: Buffer.from(single.vectors[0], 'base64')
      }]);
      job.embedded += 1;
    } catch (error) {
      saveChunkVectors([{ chunkId: row.chunkId, modelId, scale: 0, vec: Buffer.alloc(0) }]);
      job.skipped += 1;
      job.failed += 1;
      console.error(`Skipping chunk ${row.chunkId}: ${String(error.message ?? error).slice(0, 160)}`);
    }
  }
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
    rate: 0,
    batchFailures: 0,
    failed: 0
  };

  claimJob(guild.id, job);

  try {
    const { modelId } = await resolveModel();

    if (rebuild) {
      clearGuildChunks(guild.id);
      setEmbedState(guild.id, { cursor_rowid: 0, embedded: 0, skipped: 0 });
    }

    setEmbedState(guild.id, {
      model_id: modelId,
      status: 'running',
      started_at: job.startedAt,
      finished_at: null,
      last_error: null,
      enabled: 1
    });

    // --- ① 会話のまとまりを作る ---
    job.currentChannel = '会話のまとまりを作成中';
    onProgress(job);

    if (mode === 'sweep') {
      // 編集された発言を含むまとまりを作り直す
      const { stale } = refreshStale(guild.id);
      if (stale > 0) console.log(`Refreshed ${stale} stale chunk(s) in ${guild.name}.`);
    } else {
      buildGuildChunks(guild.id, {
        onProgress: ({ channelsDone, channelsTotal }) => {
          job.channelsDone = channelsDone;
          job.channelsTotal = channelsTotal;
          onProgress(job);
        }
      });
    }

    // --- ② まとまりを埋め込む ---
    const state = getEmbedState(guild.id) ?? {};
    let cursor = mode === 'sweep' ? 0 : (state.cursor_rowid ?? 0);

    // カーソルの意味が messages.rowid から chunk_id に変わったので、
    // 発言単位だった頃の値が残っていると chunk_id > 93万 で永久に0件になり、
    // 「ベクトル0件のまま正常終了」する。実在する最大より大きければ巻き戻す。
    const maxChunkId = maxChunkIdFor(guild.id);
    if (cursor > maxChunkId) {
      console.warn(`Embed cursor ${cursor} is past the last chunk ${maxChunkId}. Restarting from the beginning.`);
      cursor = 0;
      setEmbedState(guild.id, { cursor_rowid: 0, embedded: 0, skipped: 0 });
    }

    const stats = chunkCoverage(guild.id, modelId);
    job.channelsTotal = Math.max(0, stats.total - stats.done);
    job.channelsDone = 0;
    job.currentChannel = null;

    for (;;) {
      if (job.cancelled) break;

      const chunks = nextChunkBatch({
        guildId: guild.id,
        modelId,
        cursor,
        limit: embedConfig.batchSize
      });

      if (chunks.length === 0) break;

      const prepared = chunks
        .map((chunk) => ({ chunkId: chunk.chunk_id, text: chunkText(chunkMessages(chunk)) }))
        .filter((row) => row.text.length > 0);

      if (prepared.length > 0) {
        const started = Date.now();
        let result = null;

        try {
          result = await embedTexts(prepared.map((row) => row.text), { kind: 'passage', encode: 'int8' });
        } catch (error) {
          // バッチ内の1件が悪いだけで全体を止めない。1件ずつ試して犯人を隔離する。
          console.error('Embed batch failed, retrying one by one:', String(error.message ?? error).slice(0, 200));
          job.batchFailures += 1;
          await embedOneByOne(prepared, modelId, job);
        }

        if (result) {
          const elapsed = Math.max(1, Date.now() - started);
          job.rate = Math.round(prepared.length / (elapsed / 1000));

          saveChunkVectors(prepared.map((row, index) => ({
            chunkId: row.chunkId,
            modelId,
            scale: result.scales[index],
            vec: Buffer.from(result.vectors[index], 'base64')
          })));

          job.embedded += prepared.length;
        }
      }

      job.messagesIndexed = job.embedded + job.skipped;
      job.channelsDone = job.messagesIndexed;

      cursor = chunks[chunks.length - 1].chunk_id;
      if (mode !== 'sweep') {
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

/** 夜間スイープ。有効にしたギルドだけ、新規分と編集で崩れた分を拾う。 */
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
      if (total > 0) console.log(`Embedded ${total} new chunk(s) in ${guild.name}.`);
    } catch (error) {
      console.error(`Embed sweep failed for ${row.guild_id}:`, error);
    }
  }
}

export { prewarm };
