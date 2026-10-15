import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { requestModel } from '../ai/provider.js';
import { db as archive } from '../archive/db.js';
import { ensureModelBudget } from '../ai/cost.js';
import {
  MAX_DEPTH, TOP_LEVEL, addAliases, addPending, depthOf, ensureNode, ensureSeeds, flushPendingRaw, getNode, getState,
  insertEpisode, linkEpisodeNodes, linkEpisodes, linkPageMentions, listChildren, loadPublicChannels, memoryDb, nameOf,
  normalizePath, pendingNodes, recordSegment, resolveExisting, setCursor, setState, treeIndex, writePage
} from './store.js';
import { forgetNames, knownPagesFor } from './recall.js';
import { cursorBefore, packOf, planPack, renderSegment } from './transcript.js';

// 区切りごとに会話ログを AI へ渡して、記憶の本を育てる。
//
// 呼び出しは3種類だけ。どれも1回で完結し、tool の往復はしない (無料枠は回数で数える)。
//   segment:   区切り (複数チャンネルを詰めた約4万字) → 出来事 (根拠の行番号つき) と、
//              そこから分かった知識 (どのページに足すか)
//   integrate: 知識が溜まったページを数件まとめて書き直す。ログの写しではなく説明に統合し、
//              主張ごとに [e12] で出来事を引き、[[path]] で他のページへリンクする
//   root:      根 (サーバーの概要) の書き直し
//
// 書く前に「この区切りに出てくる既知のページ」(説明・本文の冒頭・最近の出来事) を渡す。
// 知っていることを繰り返さず、変化として書かせ、続きの出来事を前の出来事と結ばせる。
// 出力は機械的に検査する: ログの丸写し・根拠の無い知識・存在しない行番号は捨てて数える。
//
// 既定は安い有料モデル (2026-10 に実データの区切りで比べて glm-5.3-flash が最良: 1回約 $0.003)。
// 無料モデル (:free) も使えるが、1分20回・1日50回 (購入累計10ドル以上で1000回) で、
// 混雑の 429 や思考で出力枠を使い切るものが多かった。日の上限に当たったら止めて、次の起動で続きから読む。

const REASONING = {
  low: { effort: 'low', exclude: true },   // 考えすぎて出力枠を使い切るモデルがあった (deepseek-v4-flash・gpt-oss)
  off: { enabled: false },
  default: undefined
};

const list = (value, fallback) => (value || fallback).split(',').map((item) => item.trim()).filter(Boolean);

export const treeConfig = {
  models: list(process.env.MEMORY_TREE_MODELS, 'z-ai/glm-5.3-flash,inclusionai/ling-3.0-flash'),
  // 有料の route を使うには累計の上限 (USD) が要る。0 なら :free しか使わない。
  budgetUsd: Number(process.env.MEMORY_TREE_BUDGET_USD || 0),
  reasoning: REASONING[process.env.MEMORY_TREE_REASONING || 'low'] ?? REASONING.low,
  segmentChars: Number(process.env.MEMORY_TREE_SEGMENT_CHARS || 40000),
  // 新着の尻尾がこれ未満で、まだ会話が続いていそうなら次の起動まで貯める
  minChars: Number(process.env.MEMORY_TREE_MIN_CHARS || 6000),
  idleMs: Number(process.env.MEMORY_TREE_IDLE_MS || 12 * 3_600_000),
  // ページの統合待ちがこれだけ溜まったら書き直す。読み終えたら残りも書き直す
  integrateChars: Number(process.env.MEMORY_TREE_INTEGRATE_CHARS || 3000),
  integrateBatchChars: 30000,
  integratePages: 8,
  // ページ本文の上限。超えたら子ページへ分けさせる
  nodeChars: Number(process.env.MEMORY_TREE_NODE_CHARS || 6000),
  bodyChars: 3000,
  rootChars: 1500,
  indexChars: 6000,
  knownChars: 6000,
  timeoutMs: Number(process.env.MEMORY_TREE_TIMEOUT_MS || 300_000),
  // 同時に投げる呼び出しの数。区切りはチャンネルが、統合はページが重ならないように組む
  concurrency: Math.max(1, Number(process.env.MEMORY_TREE_CONCURRENCY || 4)),
  outputTokens: Number(process.env.MEMORY_TREE_OUTPUT_TOKENS || 16000),
  // これ以上待たされる 429 は日の上限とみなして止める
  maxWaitMs: 10 * 60_000,
  failuresBeforeSkip: 3,
  rootEverySegments: 30,
  // 知識の文のうち、ログと10字以上一致する部分がこの割合を超えたら丸写しとして捨てる
  copyRatio: 0.8
};

const TOPS = TOP_LEVEL.map(([name]) => name).join(' / ');

export const SEGMENT_SYSTEM = `あなたは Discord サーバーの「記憶の本」を書く記録係です。会話ログの区切りを読み、(1) 出来事 と (2) そこから分かった長く役立つ知識 を書きます。ログを写すのではなく、後で「何があったか」「あの人・あのものは何か」に答えられるように整理します。

## 出来事 (episodes)
- 1つの出来事 = 同じ話題の一連のやりとり。決定、議論の結論、作ったもの・変えたもの、トラブルと解決、告知、企画、人の近況など。
- 挨拶・相槌・中身の無い雑談だけの部分は出来事にしない。
- title は30字以内。summary は1〜3文で「誰が・何を・なぜ・どうなったか」。発言の引用を並べない。
- lines は根拠の行番号 (行頭の数字)。要所を1〜6個。
- nodes は関わった人物・もの・話題のページ (2〜6個)。既知のページ・索引から選び、無ければ新しいパスを作って new に書く。
- related は「既知のページ」に出ている過去の出来事 (e12 など) の続き・原因・結果なら、その番号。
- importance: 1=小ネタ 2=普通 3=重要 (決定・大きな変化・事件)。

## 知識 (facts)
- 出来事から分かる、そのページの説明に足すべきこと。性質・役割・状態・関係・決まったこと・好み。
- ページの説明として書く (「〜の作者」「〜を担当している」「〜が好き」)。「〜と言った」の形にしない。日付は変化を表すときだけ。
- 既知のページに既に書いてあることは繰り返さない。変わったなら「〜から〜に変わった」と書く。
- 意見・冗談・推測は事実と区別する (「〜と考えている」「冗談で〜」)。
- episode はこの出力の episodes の番号 (0始まり)。根拠の無い知識は書かない。

## ページのパス
- 最上位は ${TOPS} のどれか。深さは3まで。人物は people/<ログ中の名前>。
- 同じものに別の名前が付いていたら、既存のページを使い new の aliases に別名を書く。

## 書かないもの
連絡先・パスワード・本名などの機微情報、ログに無い推測。

出力は JSON だけ:
{"episodes":[{"title":"統治機能の実装を始めた","summary":"たこが sakana bot に国会と裁判所の仕組みを入れ始め、さばが賛成した。国会は72時間ごとに開く設計。","lines":[1,2],"nodes":["people/たこ","people/さば","projects/sakana-bot"],"related":[],"importance":2}],
 "facts":[{"path":"projects/sakana-bot","text":"国会を72時間ごとに開く統治の仕組みを持つ","episode":0},{"path":"people/たこ","text":"sakana bot の作者で、統治機能を実装している","episode":0}],
 "new":[{"path":"projects/sakana-bot","summary":"たこが作っている Discord の統治 bot","aliases":["sakana","さかな"]}]}
書くことが無ければ {"episodes":[],"facts":[],"new":[]}。`;

const INTEGRATE_SYSTEM = `あなたは Discord サーバーの「記憶の本」の編集者です。各ページに新しく分かった知識を統合して、ページを書き直します。

## ページの書き方
- ページはその人・もの・話題の説明。ログの写しや日記にしない。「何者か / 何をしているか / 今どうなっているか / 誰・何とどう関わるか」を現在形でまとめる。
- 先頭に1〜2文の概要。必要なら「## 現在」「## 経緯」「## 関わり」「## 未解決」の見出しを使う (無理に全部書かない)。
- 経緯は出来事を日付順に並べず、流れを短く語る。個々の出来事は [e12] で指せば足りる。
- 変化は上書きせず「以前は〜、YYYY-MM から〜」と書く。食い違う情報は両方を日付つきで残す。
- 各主張の終わりに根拠の出来事 [e12] を残す (新しい知識に付いているもの・本文に元からあるもの)。根拠の無い主張を足さない。
- 意見・冗談・推測は事実と分けて書く (「〜と考えている」「冗談で〜」)。
- 他のページに触れるときは索引にあるパスで [[people/さば]] とリンクする。
- body は ${treeConfig.bodyChars}字以内。収まらないときは、まとまりごとに子ページ (children) へ分け、body には概要と [[子のパス]] へのリンクを残す。子を作れないと書かれたページは要約して収める。
- summary はページの1行説明 (40字以内)。aliases はこのページの別名・表記ゆれ (あれば)。

出力は JSON だけ (渡したページすべてについて書く):
{"pages":[{"path":"…","summary":"…","aliases":["…"],"body":"…","children":[{"name":"…","summary":"…","body":"…"}]}]}`;

const ROOT_SYSTEM = `あなたは Discord サーバーの「記憶の本」の編集者です。根のページ (サーバー全体の概要) を書きます。bot が毎回の会話で最初に読む、唯一の常駐する記憶です。

- このサーバーが何の場所か、主な人物と役割、主なプロジェクト、よく出る話題、文化や用語を ${treeConfig.rootChars}字以内で。
- 主なページには [[projects/sakana-bot]] の形でリンクする (渡したパスだけ)。
- 渡したページの内容だけを根拠にする。推測しない。箇条書きでよい。

出力は JSON だけ: {"body":"…"}`;

// ---- モデル呼び出し ----------------------------------------------------------

export class StopRun extends Error {
  constructor(message, reason) {
    super(message);
    this.reason = reason;
  }
}

const badOutput = (message, cause) => Object.assign(new Error(message), { code: 'BAD_OUTPUT', cause });

/** 推論モデルの <think> やコードフェンスを剥がして、最初の JSON オブジェクトを読む。 */
export function parseModelJson(content) {
  let text = String(content ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw badOutput('model output had no JSON object');
  const body = text.slice(start, end + 1);
  try {
    return JSON.parse(body);
  } catch (cause) {
    // よくある崩れ (末尾のカンマ・文字列中の生の改行) だけは直して読む
    try {
      return JSON.parse(body.replace(/,\s*([}\]])/g, '$1').replace(/[\u0000-\u001f]+/g, ' '));
    } catch {
      throw badOutput('model output was not valid JSON', cause);
    }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function budgetFor(guildId, models) {
  const paid = models.filter((model) => !model.endsWith(':free'));
  if (paid.length === 0) return null;
  if (!(treeConfig.budgetUsd > 0)) {
    // stealth (stealth/xxx-alpha) は :free が付かないが 0 円。期間が終わると有料の別名になったり
    // 消えたりするので、値段が変わったときの上限としてここで止める
    throw new StopRun(`:free でないモデル (${paid.join(', ')}) を使うには MEMORY_TREE_BUDGET_USD に上限を置いてください`
      + ' (stealth など 0 円のモデルでも、値段が変わったときの安全装置として 1 などを置く)', 'config');
  }
  const id = `memory-tree:${guildId}:${treeConfig.budgetUsd}`;
  ensureModelBudget({ id, guildId, limitUsd: treeConfig.budgetUsd });
  return id;
}

/**
 * 1回の呼び出し。待てば済む 429 は待って同じ入力を送り直し、日の上限・認証・
 * 残高は StopRun にする。出力が読めないものはそのまま投げる (呼び出し側が数える)。
 */
export function openRouterCaller({ guildId, models = treeConfig.models, runId = randomUUID() } = {}) {
  const budgetId = budgetFor(guildId, models);
  return async function call({ kind, system, user }) {
    for (let transient = 0; ; transient += 1) {
      try {
        const data = await requestModel({
          model: models[0], fallbackModels: models.slice(1),
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          maxOutputTokens: treeConfig.outputTokens, timeoutMs: treeConfig.timeoutMs,
          guildId, role: `memory-${kind}`, runId, budgetId, temperature: 0.2, reasoning: treeConfig.reasoning,
          // JSON 専用モード。glm-5.3-flash で約20回に1回 JSON が壊れていた
          jsonOnly: true
        });
        const message = data.choices[0].message;
        return { json: parseModelJson(message.content), model: data.model ?? models[0], usage: data.usage };
      } catch (error) {
        if (error.code === 'BAD_OUTPUT' || /truncated/.test(error.message)) throw error;
        if ([401, 402, 403].includes(error.status)) throw new StopRun(`OpenRouter HTTP ${error.status}`, 'auth');
        if (/BUDGET/.test(error.code ?? '')) throw new StopRun(error.message, 'budget');
        const wait = Number.isFinite(error.retryAt) ? error.retryAt - Date.now() : null;
        if (wait !== null && wait > treeConfig.maxWaitMs) {
          throw new StopRun(`無料枠の上限 (再開 ${new Date(error.retryAt).toISOString()})`, 'quota');
        }
        if (!error.retryable || transient >= 5) throw error;
        await sleep(Math.max(wait ?? 0, 5000 * (transient + 1)));
      }
    }
  };
}

// ---- 出力の検査 -------------------------------------------------------------

const flat = (text) => String(text ?? '').replace(/\[e\d+\]|\[\[[^\]]*\]\]/g, '').replace(/^\d+\|/gm, '').replace(/\s+/g, '');

/** 文のうち、ログと10字以上そのまま一致する部分の割合 (丸写しの検出)。 */
export function copiedRatio(text, flatTranscript) {
  const chars = [...flat(text)];
  if (chars.length < 16) return 0;
  let hit = 0;
  let total = 0;
  for (let i = 0; i + 10 <= chars.length; i += 3) {
    total += 1;
    if (flatTranscript.includes(chars.slice(i, i + 10).join(''))) hit += 1;
  }
  return total ? hit / total : 0;
}

const linesOf = (value) => (Array.isArray(value) ? value : [value]).filter((item) => typeof item === 'string' && item.trim());
const pathOf = (guildId, raw) => {
  const normalized = normalizePath(raw);
  return normalized ? resolveExisting(guildId, normalized) : null;
};

/**
 * 区切りの結果を、区切りの記録・cursor と同じトランザクションで入れる。
 * 出来事は根拠の行が1つも実在しなければ捨てる (たどれない出来事を作らない)。
 */
export function applySegmentResult(guildId, pack, result, { model, now = Date.now(), advance = true } = {}) {
  if (!result || typeof result !== 'object') throw badOutput('segment output is not an object');
  if (!Array.isArray(result.episodes) && !Array.isArray(result.facts)) throw badOutput('segment output has no episodes/facts');
  const episodes = Array.isArray(result.episodes) ? result.episodes : [];
  const facts = Array.isArray(result.facts) ? result.facts : [];
  const created = Array.isArray(result.new) ? result.new : [];

  const flatTranscript = flat(pack.text);
  const report = { episodes: 0, facts: 0, related: 0, dropped: { noSource: 0, copied: 0, unsourced: 0 }, pages: new Set() };
  memoryDb().transaction(() => {
    // 新しいページの説明と別名 (出来事より先に作る)
    for (const entry of created.slice(0, 60)) {
      const path = pathOf(guildId, entry?.path);
      if (!path || depthOf(path) < 2) continue;
      ensureNode(guildId, path, { summary: String(entry.summary ?? '').trim().slice(0, 80), now });
      addAliases(guildId, path, linesOf(entry.aliases ?? []));
    }

    const ids = [];
    for (const episode of episodes.slice(0, 60)) {
      const cited = (Array.isArray(episode?.lines) ? episode.lines : [])
        .map((n) => pack.lineMap.get(Number(n))).filter(Boolean).slice(0, 8);
      const title = String(episode?.title ?? '').trim().slice(0, 60);
      const summary = String(episode?.summary ?? '').trim().slice(0, 400);
      if (cited.length === 0 || !title || !summary) { ids.push(null); report.dropped.noSource += 1; continue; }
      const at = Math.min(...cited.map((line) => line.firstMs));
      const end = Math.max(...cited.map((line) => line.lastMs));
      const id = insertEpisode(guildId, {
        title, summary, channelId: cited[0].channelId, atMs: at, endMs: end,
        sources: [...new Set(cited.flatMap((line) => line.ids.slice(0, 2)))].slice(0, 10),
        importance: [1, 2, 3].includes(Number(episode.importance)) ? Number(episode.importance) : 2, now
      });
      ids.push({ id, at, end });
      const paths = linesOf(episode.nodes ?? []).map((raw) => pathOf(guildId, raw)).filter((path) => path && depthOf(path) >= 2);
      for (const path of paths) ensureNode(guildId, path, { now });
      linkEpisodeNodes(guildId, id, paths, now);
      const related = (Array.isArray(episode.related) ? episode.related : [])
        .map((value) => Number(String(value).replace(/^e/i, ''))).filter(Number.isInteger);
      report.related += linkEpisodes(guildId, id, related);
      report.episodes += 1;
    }

    for (const fact of facts.slice(0, 200)) {
      const path = pathOf(guildId, fact?.path);
      const text = String(fact?.text ?? '').trim();
      const source = ids[Number(fact?.episode)];
      if (!path || !text || depthOf(path) < 2) continue;
      if (!source) { report.dropped.unsourced += 1; continue; }
      if (copiedRatio(text, flatTranscript) >= treeConfig.copyRatio) { report.dropped.copied += 1; continue; }
      ensureNode(guildId, path, { now });
      // 知識のページは出来事にも結ぶ (ページ → 出来事 → 元の発言 とたどれるように)
      linkEpisodeNodes(guildId, source.id, [path], now);
      const added = addPending(guildId, path, [`${text} [e${source.id}]`], { firstAt: source.at, lastAt: source.end, now });
      if (added) { report.facts += 1; report.pages.add(path); }
    }

    for (const segment of pack.segments) {
      recordSegment(guildId, segment, { status: 'done', model, now });
      if (advance) setCursor(guildId, segment.channelId, segment.toId, segment.toMs);
    }
  })();
  forgetNames(guildId);
  return { ...report, pages: [...report.pages] };
}

/** 読めない出力が続いた区切りは failed として記録し、先へ進む (止まり続けない)。 */
function skipPack(guildId, pack, error, now = Date.now()) {
  memoryDb().transaction(() => {
    for (const segment of pack.segments) {
      recordSegment(guildId, segment, { status: 'failed', error: String(error?.message ?? error).slice(0, 300), now });
      setCursor(guildId, segment.channelId, segment.toId, segment.toMs);
    }
  })();
}

const childName = (name) => String(name ?? '').replace(/[/\\[\]]/g, ' ').replace(/[\s　]+/g, ' ').trim().slice(0, 48);
const refsIn = (text) => new Set([...String(text ?? '').matchAll(/\[e(\d+)\]/g)].map((m) => m[1]));

/**
 * 統合の結果を入れる。batch は { path, consumed } (渡した統合待ちの部分) の配列。
 * 渡したのに書かれなかったページ・検査に落ちたページは統合待ちのまま残して数える。
 */
export function applyIntegrateResult(guildId, batch, result, { now = Date.now() } = {}) {
  const pages = Array.isArray(result?.pages) ? result.pages : null;
  if (!pages) throw badOutput('integrate output has no pages');
  const byPath = new Map();
  for (const page of pages) {
    const path = normalizePath(page?.path);
    if (path) byPath.set(path, page);
  }
  const done = [];
  const failed = [];
  memoryDb().transaction(() => {
    for (const item of batch) {
      const page = byPath.get(item.path);
      const node = getNode(guildId, item.path);
      const body = typeof page?.body === 'string' ? page.body.trim() : '';
      const children = Array.isArray(page?.children) ? page.children : [];
      const deepest = depthOf(item.path) >= MAX_DEPTH;
      const before = `${node.body}\n${item.consumed}`.trim();
      const kept = body.length + children.reduce((sum, child) => sum + String(child?.body ?? '').length, 0);
      const floor = deepest ? 0.15 : 0.3;
      const problem = !page ? 'not returned'
        : !body ? 'empty body'
        : body.length > treeConfig.nodeChars ? 'body too long'
        : kept < before.length * floor ? `dropped too much (${kept}/${before.length})`
        : refsIn(before).size > 0 && refsIn(body).size === 0 && children.every((child) => refsIn(child?.body).size === 0)
          ? 'lost every [e] reference'
        : deepest && children.length > 0 ? 'children at max depth'
        : null;
      if (problem) { failed.push({ path: item.path, problem }); continue; }

      // 統合待ちは渡したぶんだけ消す (渡した後に足されたぶんは残す)
      const rest = node.pending.startsWith(item.consumed) ? node.pending.slice(item.consumed.length) : '';
      writePage(guildId, item.path, { summary: String(page.summary ?? '').trim().slice(0, 80), body,
        aliases: linesOf(page.aliases ?? []), now });
      if (rest.trim()) {
        memoryDb().prepare('UPDATE nodes SET pending = ?, pending_count = ? WHERE guild_id = ? AND path = ?')
          .run(rest, rest.split('\n').filter(Boolean).length, guildId, item.path);
      }
      linkPageMentions(guildId, item.path, body, now);

      for (const child of children.slice(0, 20)) {
        const name = childName(child?.name);
        const childBody = String(child?.body ?? '').trim();
        if (!name || !childBody) continue;
        const target = resolveExisting(guildId, `${item.path}/${name}`);
        ensureNode(guildId, target, { summary: String(child.summary ?? '').trim().slice(0, 80), now });
        const existing = getNode(guildId, target);
        if (existing.body) {
          // 既にある子は、移された内容を統合待ちに回す (次の統合で既存の本文と混ぜる)
          addPending(guildId, target, childBody.split('\n'), { firstAt: node.first_at ?? now, lastAt: node.last_at ?? now, now });
        } else {
          writePage(guildId, target, { summary: String(child.summary ?? '').trim().slice(0, 80), body: childBody, now });
          memoryDb().prepare('UPDATE nodes SET weight = weight + ?, first_at = ?, last_at = ? WHERE guild_id = ? AND path = ?')
            .run(Math.max(1, refsIn(childBody).size), node.first_at, node.last_at, guildId, target);
          linkPageMentions(guildId, target, childBody, now);
        }
      }
      done.push(item.path);
    }
  })();
  forgetNames(guildId);
  return { done, failed };
}

// ---- プロンプト ---------------------------------------------------------------

export function segmentPrompt(guildId, pack) {
  const index = treeIndex(guildId, treeConfig.indexChars);
  const known = knownPagesFor(guildId, pack.text, { maxChars: treeConfig.knownChars });
  return [
    `木の索引 (パス — 説明。全${index.total}件中${index.shown}件):`,
    index.text || '(まだ空)',
    '',
    '既知のページ (このログに出てくる名前のもの。既に書いてあることは繰り返さない):',
    known || '(なし)',
    '',
    '会話ログ (行頭の数字が行番号):',
    pack.text,
    '',
    '上の会話ログから、出来事と知識を JSON だけで出力してください。'
  ].join('\n');
}

function integratePrompt(guildId, batch) {
  const index = treeIndex(guildId, 4000);
  const blocks = batch.map((item) => {
    const node = getNode(guildId, item.path);
    const children = listChildren(guildId, item.path, 30).map((child) => `${nameOf(child.path)} — ${child.summary || ''}`);
    return [
      `### ${item.path}`,
      `説明: ${node.summary || '(なし)'}`,
      ...(node.aliases.length ? [`別名: ${node.aliases.join(', ')}`] : []),
      depthOf(item.path) >= MAX_DEPTH ? '(深さの上限なので子ページは作れない)' : `子ページ: ${children.join(' / ') || '(なし)'}`,
      '現在の本文:',
      node.body || '(まだ無い)',
      '新しい知識:',
      item.consumed.trim()
    ].join('\n');
  });
  return [`木の索引 (リンクに使えるパス):\n${index.text}`, ...blocks, '各ページを書き直して JSON だけで出力してください。'].join('\n\n');
}

function rootPrompt(guildId) {
  const parts = [];
  let used = 0;
  for (const [top] of TOP_LEVEL) {
    const node = getNode(guildId, top);
    if (!node) continue;
    const lines = [`## ${top} — ${node.summary}`];
    for (const child of listChildren(guildId, top, 25)) {
      const page = getNode(guildId, child.path);
      const head = (page?.body || page?.pending || '').split('\n').filter(Boolean).slice(0, 2).join(' ').slice(0, 200);
      lines.push(`- ${child.path} (${child.weight}): ${child.summary}${head ? ` | ${head}` : ''}`);
    }
    const block = lines.join('\n');
    if (used + block.length > 24000) break;
    parts.push(block);
    used += block.length;
  }
  const current = getNode(guildId, '')?.body;
  return `${current ? `現在の根:\n${current}\n\n` : ''}${parts.join('\n\n')}`;
}

// ---- ロック ----------------------------------------------------------------

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

export function acquireLock(guildId, now = Date.now()) {
  const key = `lock:${guildId}`;
  return memoryDb().transaction(() => {
    const held = getState(key);
    const live = held && held.pid !== process.pid
      && (held.host === hostname() ? alive(held.pid) && now - held.at < 6 * 3_600_000 : now - held.at < 30 * 60_000);
    if (live) throw new StopRun(`別の builder (pid ${held.pid}) が実行中です`, 'locked');
    setState(key, { pid: process.pid, host: hostname(), at: now });
    return () => { if (getState(key)?.pid === process.pid) setState(key, null); };
  }).immediate();
}

// ---- 一時停止と進捗の分母 ---------------------------------------------------

/** Discord の /memory pause が書く。builder は区切りの境目で止まる (読みかけは失わない)。 */
export function setPaused(guildId, by, now = Date.now()) {
  setState(`pause:${guildId}`, by ? { by, at: now } : null);
}

export function pausedBy(guildId) {
  return getState(`pause:${guildId}`);
}

/**
 * 読む対象 (公開チャンネルの人間の発言) の総数。/memory status の分母。
 * 全件を数えるので bot ではなく builder が6時間に1回だけ数えて控える。
 */
export function refreshTotals(guildId, channelIds, now = Date.now()) {
  const key = `totals:${guildId}`;
  const held = getState(key);
  if (held && now - held.at < 6 * 3_600_000 && held.channels === channelIds.length) return held;
  const count = archive.prepare('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ? AND deleted = 0 AND is_bot = 0');
  let messages = 0;
  for (const channelId of channelIds) messages += count.get(channelId).n;
  const totals = { messages, channels: channelIds.length, at: now };
  setState(key, totals);
  return totals;
}

// ---- 実行 ------------------------------------------------------------------

/**
 * 統合する組。統合待ちの多いページから、合計の文字数上限まで。
 * 1ページの統合待ちが大きすぎるときは先頭から渡せるぶんだけ渡す (残りは次)。
 */
function integrationBatch(guildId, { minChars, skip }) {
  const batch = [];
  let used = 0;
  for (const row of pendingNodes(guildId, { minChars, limit: 60 })) {
    if (skip.has(row.path)) continue;
    const failures = getState(`integrate-fail:${guildId}:${row.path}`)?.count ?? 0;
    if (failures >= treeConfig.failuresBeforeSkip) {
      // 統合できないページでも知識は落とさない (本文の末尾へそのまま移す)
      flushPendingRaw(guildId, row.path);
      setState(`integrate-fail:${guildId}:${row.path}`, null);
      continue;
    }
    const node = getNode(guildId, row.path);
    const room = Math.max(1500, treeConfig.integrateBatchChars - used - node.body.length - 400);
    if (batch.length > 0 && treeConfig.integrateBatchChars - used - node.body.length - 400 < 1500) break;
    let consumed = node.pending;
    if (consumed.length > room) {
      const cut = consumed.lastIndexOf('\n', room);
      consumed = consumed.slice(0, cut > 0 ? cut + 1 : consumed.length);
    }
    batch.push({ path: row.path, consumed });
    used += node.body.length + consumed.length + 400;
    if (batch.length >= treeConfig.integratePages || used >= treeConfig.integrateBatchChars) break;
  }
  return batch.length ? batch : null;
}

/**
 * 記憶を育てる。上限 (回数・時間) に達するか、読むものが無くなるか、無料枠が尽きたら止まる。
 * 何度止めても cursor と統合待ちの続きから再開できる。
 */
export async function runBuild({
  guildId, call, maxCalls = Infinity, maxMs = Infinity, retryFailed = false,
  now = () => Date.now(), log = () => {}
}) {
  const started = now();
  const release = acquireLock(guildId, started);
  ensureSeeds(guildId, started);
  const stats = {
    calls: 0, segments: 0, messages: 0, episodes: 0, facts: 0, related: 0, integrated: 0,
    dropped: { noSource: 0, copied: 0, unsourced: 0 }, failed: 0, root: false, stopped: 'done'
  };
  const spent = () => stats.calls >= maxCalls || now() - started >= maxMs;
  const skip = new Set();   // この実行で統合に失敗したページ (同じ実行では繰り返さない)

  const segment = async (pack, { advance = true } = {}) => {
    const key = `pack-fail:${guildId}:${pack.segments[0].channelId}:${pack.segments[0].fromId}`;
    stats.calls += 1;
    try {
      const result = await call({ kind: 'segment', system: SEGMENT_SYSTEM, user: segmentPrompt(guildId, pack) });
      const applied = applySegmentResult(guildId, pack, result.json, { model: result.model, now: now(), advance });
      setState(key, null);
      stats.segments += pack.segments.length;
      stats.messages += pack.segments.reduce((sum, s) => sum + s.messages, 0);
      stats.episodes += applied.episodes;
      stats.facts += applied.facts;
      stats.related += applied.related;
      for (const k of Object.keys(stats.dropped)) stats.dropped[k] += applied.dropped[k];
      log(`segment ${pack.segments.map((s) => `${s.label}(${s.messages})`).join(' ')} → 出来事 ${applied.episodes} / 知識 ${applied.facts}`
        + ` / つながり ${applied.related} / 捨てた ${JSON.stringify(applied.dropped)} [${result.model}]`);
      return true;
    } catch (error) {
      if (error instanceof StopRun) throw error;
      const count = (getState(key)?.count ?? 0) + 1;
      setState(key, { count, error: String(error.message).slice(0, 200) });
      log(`segment failed (${count}/${treeConfig.failuresBeforeSkip}): ${error.message}`);
      if (count >= treeConfig.failuresBeforeSkip && advance) {
        skipPack(guildId, pack, error, now());
        setState(key, null);
        stats.failed += pack.segments.length;
      }
      return false;
    }
  };

  const integrate = async (batch) => {
    stats.calls += 1;
    const fail = (path, problem) => {
      skip.add(path);
      const count = (getState(`integrate-fail:${guildId}:${path}`)?.count ?? 0) + 1;
      setState(`integrate-fail:${guildId}:${path}`, { count, problem });
    };
    try {
      const result = await call({ kind: 'integrate', system: INTEGRATE_SYSTEM, user: integratePrompt(guildId, batch) });
      const { done, failed } = applyIntegrateResult(guildId, batch, result.json, { now: now() });
      for (const path of done) setState(`integrate-fail:${guildId}:${path}`, null);
      for (const { path, problem } of failed) fail(path, problem);
      stats.integrated += done.length;
      log(`integrate ${done.join(', ') || '-'}${failed.length ? ` / 失敗 ${failed.map((f) => `${f.path}(${f.problem})`).join(', ')}` : ''}`);
    } catch (error) {
      if (error instanceof StopRun) throw error;
      for (const item of batch) fail(item.path, String(error.message).slice(0, 120));
      log(`integrate failed: ${error.message}`);
    }
  };

  try {
    const publicChannels = loadPublicChannels(guildId);
    if (!publicChannels || publicChannels.channelIds.length === 0) {
      throw new StopRun('公開チャンネルの控えがありません (bot を起動すると書かれます)', 'no-channels');
    }
    const channelIds = publicChannels.channelIds;
    const paused = () => {
      const by = pausedBy(guildId);
      if (by) throw new StopRun(`一時停止中 (${by.by})`, 'paused');
    };
    paused();
    refreshTotals(guildId, channelIds, now());
    if (retryFailed) await retryFailedSegments(guildId, channelIds, segment, spent, log);

    let sinceRoot = getState(`root:${guildId}`)?.segments ?? 0;
    const width = treeConfig.concurrency;
    while (!spent()) {
      paused();
      setState(`lock:${guildId}`, { pid: process.pid, host: hostname(), at: now() });

      // 1回の波で、ページが重ならない統合 (波の半分まで) と、チャンネルが重ならない区切りを
      // 同時に投げる。結果の反映はそれぞれのトランザクションで1つずつ (統合待ちは末尾に
      // 足すだけなので、統合と区切りが同じページに触っても食い違わない)。
      const tasks = [];
      const room = () => tasks.length < width && stats.calls + tasks.length < maxCalls;
      const pagesTaken = new Set(skip);
      while (room() && tasks.length < Math.max(1, Math.floor(width / 2))) {
        // 知識が溜まったページを先に書き直す (既知のページとして次の区切りに渡すため)
        const batch = integrationBatch(guildId, { minChars: treeConfig.integrateChars, skip: pagesTaken });
        if (!batch) break;
        for (const item of batch) pagesTaken.add(item.path);
        tasks.push(() => integrate(batch));
      }
      const channelsTaken = new Set();
      while (room()) {
        const pack = planPack({ guildId, channelIds, targetChars: treeConfig.segmentChars,
          minChars: treeConfig.minChars, idleMs: treeConfig.idleMs, now: now(), exclude: channelsTaken });
        if (!pack) break;
        for (const s of pack.segments) channelsTaken.add(s.channelId);
        tasks.push(async () => { if (await segment(pack)) sinceRoot += 1; });
      }
      // 読み終えたら、少ない統合待ちも書き直す
      while (tasks.length === 0 || (channelsTaken.size === 0 && room())) {
        const batch = integrationBatch(guildId, { minChars: 1, skip: pagesTaken });
        if (!batch) break;
        for (const item of batch) pagesTaken.add(item.path);
        tasks.push(() => integrate(batch));
      }
      if (tasks.length === 0) break;

      await Promise.all(tasks.map((task) => task()));
      setState(`root:${guildId}`, { ...(getState(`root:${guildId}`) ?? {}), segments: sinceRoot });
      if (sinceRoot >= treeConfig.rootEverySegments && !spent()) {
        await rebuildRoot(guildId, call, stats, log);
        sinceRoot = 0;
      }
    }

    if (spent()) stats.stopped = 'limit';
    const grown = memoryDb().prepare('SELECT 1 FROM nodes WHERE guild_id = ? AND weight > 0 LIMIT 1').get(guildId);
    if (!spent() && grown && (!getNode(guildId, '')?.body || (getState(`root:${guildId}`)?.segments ?? 0) > 0)) {
      await rebuildRoot(guildId, call, stats, log);
    }
  } catch (error) {
    if (!(error instanceof StopRun)) throw error;
    stats.stopped = error.reason;
    stats.message = error.message;
    log(`stopped: ${error.message}`);
  } finally {
    release();
  }
  return stats;
}

async function rebuildRoot(guildId, call, stats, log) {
  stats.calls += 1;
  try {
    const result = await call({ kind: 'root', system: ROOT_SYSTEM, user: rootPrompt(guildId) });
    const body = typeof result.json?.body === 'string' ? result.json.body.trim() : '';
    if (!body) throw new Error('root body was empty');
    writePage(guildId, '', { body: body.slice(0, Math.round(treeConfig.rootChars * 1.5)) });
    linkPageMentions(guildId, '', body);
    setState(`root:${guildId}`, { at: Date.now(), segments: 0 });
    stats.root = true;
    log(`root: ${body.length} 字`);
  } catch (error) {
    if (error instanceof StopRun) throw error;
    log(`root failed: ${error.message}`);
  }
}

async function retryFailedSegments(guildId, channelIds, segment, spent, log) {
  const allowed = new Set(channelIds);
  const rows = memoryDb().prepare("SELECT * FROM segments WHERE guild_id = ? AND status = 'failed' ORDER BY from_ms").all(guildId);
  for (const row of rows) {
    if (spent()) return;
    if (!allowed.has(row.channel_id)) continue;   // 非公開になったチャンネルは読み直さない
    // 内容ごと拒否される区切りを毎回読み直して払い続けない (3回までで諦め、failed のまま残す)
    const key = `retry:${guildId}:${row.channel_id}:${row.from_id}`;
    const tried = getState(key)?.count ?? 0;
    if (tried >= treeConfig.failuresBeforeSkip) continue;
    const rendered = renderSegment({ guildId, channelId: row.channel_id, cursor: cursorBefore(row.from_id, row.from_ms),
      maxChars: Infinity, until: { id: row.to_id, ms: row.to_ms } });
    if (!rendered) continue;
    // 元の区切りの記録 (from_id) を上書きする。cursor はとっくに先へ進んでいるので戻さない
    const pack = packOf([{ ...rendered, fromId: row.from_id }]);
    if (await segment(pack, { advance: false })) {
      setState(key, null);
      log(`retried ${rendered.label} ${row.from_id}`);
    } else {
      setState(key, { count: tried + 1 });
    }
  }
}
