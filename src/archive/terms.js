// 話題 (特徴語) の抽出。
//
// 「この人が偏って話している題材は何か」に答えるためのもの。ダブスタ探しは
// 探す語が事前に分からないので、まずここで題材を出してから search_messages で
// 立場の変遷を追う、という流れを想定している。
//
// 設計の要点は2つ。
//   1. 形態素解析器を入れない。辞書が重く依存も増えるので、文字種の連続を
//      語の代わりに使う。日本語では動詞・形容詞が「漢字1+かな」になるため、
//      漢字2文字以上を要求するとほぼ名詞だけが残る。これが辞書無しで成立する理由。
//   2. 並べるのは頻度ではなく「偏り」。生の頻度では「する」「です」しか出ない。
//      ギルド全体の出現率を事前分布にした log-odds で並べる。

import { guildTimeRange, sampleMessages } from './search.js';

const SCAN_CAP = Number(process.env.ARCHIVE_TERM_SCAN_CAP ?? 4000);
const BASELINE_SAMPLE = Number(process.env.ARCHIVE_TERM_BASELINE_SAMPLE ?? 20_000);
const BASELINE_TTL_MS = Number(process.env.ARCHIVE_TERM_BASELINE_TTL_MS ?? 21_600_000); // 6h
const PRIOR_STRENGTH = Number(process.env.ARCHIVE_TERM_PRIOR ?? 400);
const MIN_DF = Number(process.env.ARCHIVE_TERM_MIN_DF ?? 3);
const MIN_RATE = Number(process.env.ARCHIVE_TERM_MIN_RATE ?? 0.002);
const MIN_RATIO = Number(process.env.ARCHIVE_TERM_MIN_RATIO ?? 1.5);

const BASELINE_MIN_DF = 3;
const BASELINE_MAX_TERMS = 40_000;
const BASELINE_MIN_MESSAGES = 300;
const BASELINE_CACHE_GUILDS = 3;
const MAX_TERMS_PER_MESSAGE = 40;

const CODE_BLOCK = /```[\s\S]*?```|`[^`]*`/g;
const QUOTE_LINE = /^>\s?.*$/gm; // 引用は他人の発言なので数えない
const URL_PATTERN = /https?:\/\/\S+/gi;
const DISCORD_TOKEN = /<a?:\w+:\d+>|<[@#][!&]?\d+>|<t:\d+(?::[a-zA-Z])?>/g;

const HAN_RUN = /[\p{Script=Han}々]{2,8}/gu;
const KATAKANA_RUN = /[\p{Script=Katakana}][\p{Script=Katakana}ー]{2,15}/gu;
const LATIN_RUN = /[A-Za-z][A-Za-z0-9_'-]{1,23}/g;

// スコアで落とせない構造的なゴミだけを列挙する。
// 一般語 (する / です / 自分) はベースラインとの比で自然に沈むのでここに書かない。
const TERM_STOPLIST = new Set([
  'http', 'https', 'www', 'com', 'net', 'org', 'jpg', 'jpeg', 'png', 'gif',
  'webp', 'mp4', 'cdn', 'discordapp', 'gyazo', 'imgur', 'tenor'
]);

/**
 * メッセージ1件から話題になりうる語を取り出す。
 *
 *   ・漢字2文字以上 … ほぼ名詞 (動詞・形容詞は「漢字1+かな」なので自然に落ちる)
 *   ・カタカナ3文字以上 … 外来語・固有名詞
 *   ・ラテン3文字以上 … 英単語・製品名 (AI / PC のような大文字2字だけ例外)
 *   ・ひらがなだけの連続 … 助詞と活用ばかりなので捨てる
 *
 * 長い漢字ランをスライディング n-gram で刻むことはしない。「消費税増税」を
 * 消費/費税/税増/増税 に割ると、費税のような偽語が本物と完全に共起し、
 * ベースラインでも同じくらい稀なのでスコアで分離できなくなる。
 */
export function extractTerms(raw) {
  if (!raw) return [];

  const text = String(raw)
    .normalize('NFKC') // 半角カナ・全角英数をそろえる
    .replace(CODE_BLOCK, ' ')
    .replace(QUOTE_LINE, ' ')
    .replace(URL_PATTERN, ' ')
    .replace(DISCORD_TOKEN, ' ');

  const terms = new Set();

  for (const match of text.matchAll(HAN_RUN)) terms.add(match[0]);

  // 末尾の長音符は落とさない。落とすと「レビュー」が「レビュ」、
  // 「ユーザー」が「ユーザ」になり、存在しない語をモデルに見せることになる。
  // 表記ゆれ (サーバ / サーバー) は trigram FTS がどちらでも部分一致するので、
  // この語をそのまま search_messages に渡せば両方引ける。
  for (const match of text.matchAll(KATAKANA_RUN)) {
    terms.add(match[0]);
  }

  for (const match of text.matchAll(LATIN_RUN)) {
    const word = match[0];
    // AI / PC / EV のような大文字2字だけ2文字を許す (to / is を拾わないため)
    if (word.length < 3 && !/^[A-Z]{2}$/.test(word)) continue;
    const lower = word.toLowerCase();
    if (!TERM_STOPLIST.has(lower)) terms.add(lower);
  }

  const list = [...terms];
  return list.length > MAX_TERMS_PER_MESSAGE ? list.slice(0, MAX_TERMS_PER_MESSAGE) : list;
}

/**
 * 「その語を含む発言が何件あったか」を数える。
 * 1発言で同じ語が何回出ても1回 (連投で順位が壊れるのを防ぐ)。
 */
function countDocumentFrequencies(rows, { skipBots = true } = {}) {
  const df = new Map();
  let messages = 0;

  for (const row of rows) {
    if (skipBots && row.is_bot) continue;

    const terms = extractTerms(row.content);
    if (terms.length === 0) continue; // 分母は「語が1つ以上あった発言」にそろえる

    messages += 1;
    for (const term of terms) df.set(term, (df.get(term) ?? 0) + 1);
  }

  return { df, messages };
}

const baselineCache = new Map(); // guildId -> { df, messages, builtAt }

/**
 * 比較用のギルド全体の出現率。派生データなのでテーブルにせずメモリに置く。
 *
 * channelScope は掛けない。ここは分母にしか使わず、出力するのは検索条件側
 * (権限で絞った側) に出た語だけ。topReactionEmojis / topDomains と同じ扱い。
 */
function guildBaseline(guildId) {
  const cached = baselineCache.get(guildId);
  if (cached && Date.now() - cached.builtAt < BASELINE_TTL_MS) return cached;

  const range = guildTimeRange(guildId);
  const sample = sampleMessages(
    { guildId, query: '', extra: [] },
    { cap: BASELINE_SAMPLE, range }
  );

  const counted = countDocumentFrequencies(sample.rows);

  // 1〜2回しか出ない語は捨てる。メモリと、偶然の語で分母が歪むのを防ぐため。
  for (const [term, df] of counted.df) {
    if (df < BASELINE_MIN_DF) counted.df.delete(term);
  }

  if (counted.df.size > BASELINE_MAX_TERMS) {
    const kept = [...counted.df.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, BASELINE_MAX_TERMS);
    counted.df = new Map(kept);
  }

  const entry = { df: counted.df, messages: counted.messages, builtAt: Date.now() };
  baselineCache.set(guildId, entry);

  if (baselineCache.size > BASELINE_CACHE_GUILDS) {
    const oldest = [...baselineCache.entries()].sort((a, b) => a[1].builtAt - b[1].builtAt)[0];
    baselineCache.delete(oldest[0]);
  }

  return entry;
}

export function resetTermBaseline(guildId) {
  if (guildId) baselineCache.delete(guildId);
  else baselineCache.clear();
}

/**
 * ギルド全体の出現率を事前分布にした log-odds (z 値)。
 *
 * prior に 0.5 の下駄を履かせるのが要点。ベースラインの標本に一度も出ない語
 * (身内ネタ・その人固有の話題) は分散だけが膨らんで沈んでしまうので、
 * 下限を入れて拾えるようにする。
 */
function distinctiveness(dfTarget, nTarget, dfBase, nBase) {
  const baseRate = (dfBase + 0.5) / (nBase + 1);
  const prior = Math.max(0.5, PRIOR_STRENGTH * baseRate);

  const yTarget = dfTarget + prior;
  const yBase = dfBase + prior;
  const totalTarget = nTarget + PRIOR_STRENGTH;
  const totalBase = nBase + PRIOR_STRENGTH;

  if (totalTarget <= yTarget || totalBase <= yBase) return 0;

  const delta = Math.log(yTarget / (totalTarget - yTarget))
    - Math.log(yBase / (totalBase - yBase));

  return delta / Math.sqrt(1 / yTarget + 1 / yBase);
}

/**
 * 同じ話題の部分文字列は上位だけ残す。
 * 「消費税増税」と「消費税」、漢字が隣接してできた偽語などを畳む。
 */
function dedupeSubstrings(ranked, limit) {
  const kept = [];

  for (const entry of ranked) {
    const covered = kept.some((other) => (
      (other.term.includes(entry.term) || entry.term.includes(other.term))
      && Math.min(entry.count, other.count) >= Math.max(entry.count, other.count) * 0.6
    ));

    if (covered) continue;
    kept.push(entry);
    if (kept.length >= limit) break;
  }

  return kept;
}

export function topTerms(options, { limit = 20, cap = SCAN_CAP, range = null } = {}) {
  const sample = sampleMessages(options, { cap, range });
  const target = countDocumentFrequencies(sample.rows);
  const baseline = guildBaseline(options.guildId);
  const weakBaseline = baseline.messages < BASELINE_MIN_MESSAGES;

  const minDf = Math.max(MIN_DF, Math.ceil(target.messages * MIN_RATE));
  const ranked = [];

  for (const [term, count] of target.df) {
    if (count < minDf) continue;

    const dfBase = baseline.df.get(term) ?? 0;
    const baseRate = (dfBase + 0.5) / (baseline.messages + 1);
    const rate = count / target.messages;

    // 全体より少ない語は「その人の話題」ではない
    if (!weakBaseline && rate < baseRate * MIN_RATIO) continue;

    const score = weakBaseline
      ? count
      : distinctiveness(count, target.messages, dfBase, baseline.messages);

    if (score <= 0) continue;

    ranked.push({ term, count, ratio: Math.min(99, rate / baseRate), score });
  }

  ranked.sort((a, b) => b.score - a.score || b.count - a.count);

  return {
    rows: dedupeSubstrings(ranked, limit),
    scanned: sample.rows.length,
    messages: target.messages,
    mode: sample.mode,
    weakBaseline,
    baseline: { messages: baseline.messages, terms: baseline.df.size, builtAt: baseline.builtAt }
  };
}
