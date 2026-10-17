import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { requestModel, type MaxPrice, type ReasoningOptions } from '../ai/provider.js';
import { db as archive } from '../archive/db.js';
import { ensureModelBudget } from '../ai/cost.js';
import {
  MAX_DEPTH, addAliases, placeTopLevel, topLevels, addPending, depthOf, ensureNode, ensureSeeds, flushPendingRaw, getNode, getState,
  parentOf,
  insertEpisode, linkEpisodeNodes, linkEpisodes, linkPageMentions, listChildren, loadPublicChannels, memoryDb, nameOf,
  normalizePath, pendingNodes, recordSegment, resolveExisting, setCursor, setState, treeIndex, writePage, type SegmentRow
} from './store.js';
import { forgetNames, knownPagesFor } from './recall.js';
import { cursorBefore, packOf, planPack, renderSegment } from './transcript.js';
import {
  arrayOf, countOf, detailsOf, errorMessage, isLockState, isPauseState, isRecord, isTotals,
  type JsonRecord, type LineEntry, type Pack, type PauseState, type Totals
} from './types.js';

// 区切りごとに会話ログを AI へ渡して、記憶を育てる。
//
// 呼び出しは3種類だけ。どれも1回で完結し、tool の往復はしない (無料枠は回数で数える)。
//   segment:   区切り (複数チャンネルを詰めた約4万字) → 出来事 (根拠の行番号つき) と、
//              そこから分かった知識 (どのページに足すか)
//   integrate: 知識が溜まったページを数件まとめて書き直す。ログの写しではなく説明に統合し、
//              主張ごとに [e12] で出来事を引き、[[path]] で他のページへリンクする
//   sort:      知識が溜まりすぎたページ (たこ・あかりの人のページは数万字になった) の統合待ちを、
//              番号で子ページへ仕分ける。書き直さないので1行も落ちない。仕分けた先で普通に統合する
//   root:      根 (サーバーの概要) の書き直し
//
// 書く前に「この区切りに出てくる既知のページ」(説明・本文の冒頭・最近の出来事) を渡す。
// 知っていることを繰り返さず、変化として書かせ、続きの出来事を前の出来事と結ばせる。
// 出力は機械的に検査する: ログの丸写し・根拠の無い知識・存在しない行番号は捨てて数える。
//
// 既定は安い有料モデル (2026-10 に実データの区切りで比べて glm-5.3-flash が最良: 1回約 $0.003)。
// 無料モデル (:free) も使えるが、1分20回・1日50回 (購入累計10ドル以上で1000回) で、
// 混雑の 429 や思考で出力枠を使い切るものが多かった。日の上限に当たったら止めて、次の起動で続きから読む。

const REASONING: Record<string, ReasoningOptions | undefined> = {
  low: { effort: 'low', exclude: true },   // 考えすぎて出力枠を使い切るモデルがあった (deepseek-v4-flash・gpt-oss)
  off: { enabled: false },
  default: undefined
};

const list = (value: string | undefined, fallback: string): string[] => (value || fallback).split(',').map((item) => item.trim()).filter(Boolean);
function priceOf(value: string | undefined): Required<MaxPrice> | null {
  const [prompt, completion] = list(value, '').map(Number);
  if (prompt === undefined || completion === undefined) return null;
  return Number.isFinite(prompt) && Number.isFinite(completion) && prompt > 0 && completion > 0 ? { prompt, completion } : null;
}

export const treeConfig = {
  models: list(process.env.MEMORY_TREE_MODELS, 'z-ai/glm-5.3-flash,inclusionai/ling-3.0-flash'),
  // 有料の route を使うには月の上限 (USD、UTC の暦月ごと) が要る。0 なら :free しか使わない。
  // 読み終えた後も新着を読み続けるので、通算の上限だといずれ止まる
  budgetUsd: Number(process.env.MEMORY_TREE_BUDGET_USD || 0),
  reasoning: REASONING[process.env.MEMORY_TREE_REASONING || 'low'] ?? REASONING.low,
  segmentChars: Number(process.env.MEMORY_TREE_SEGMENT_CHARS || 40000),
  // 新着の尻尾がこれ未満で、まだ会話が続いていそうなら次の起動まで貯める。
  // 1時間止まったら読む。timer は2日おきで、その回に溜まっている新着をまとめて読む
  minChars: Number(process.env.MEMORY_TREE_MIN_CHARS || 6000),
  idleMs: Number(process.env.MEMORY_TREE_IDLE_MS || 3_600_000),
  // ページの統合待ちがこれだけ溜まったら書き直す。読み終えたら残りも書き直す
  // (3000 だと人のページの 149 件中 1 件しか本文にならず、ほとんど「まとめ中」のままだった)
  integrateChars: Number(process.env.MEMORY_TREE_INTEGRATE_CHARS || 1200),
  // 1回の統合は小さめに (8ページ・3万字だと出力が長く、1回2〜3分かかった)
  integrateBatchChars: 15000,
  // 1回に書き直すページ数の上限。本文の無い新しいページは小さいので10件まとめる
  // (本文のあるページを10件束ねると、一部を書かずに返した)
  integratePages: 4,
  newPages: 10,
  // 統合待ちがこれだけ溜まったページは、書き直す前に子ページへ仕分ける。
  // 1万字を超える知識を本文3000字へ書き直させると、モデルは千字ほどに縮めて「削りすぎ」で却下され続けた
  sortChars: Number(process.env.MEMORY_TREE_SORT_CHARS || 6000),
  sortBatchChars: 12000,
  // ページ本文の上限。超えたら子ページへ分けさせる
  nodeChars: Number(process.env.MEMORY_TREE_NODE_CHARS || 6000),
  bodyChars: 3000,
  rootChars: 1500,
  indexChars: 6000,
  knownChars: 6000,
  timeoutMs: Number(process.env.MEMORY_TREE_TIMEOUT_MS || 300_000),
  // 同時に投げる呼び出しの数。区切りはチャンネルが、統合はページが重ならないように組む
  concurrency: Math.max(1, Number(process.env.MEMORY_TREE_CONCURRENCY || 8)),
  outputTokens: Number(process.env.MEMORY_TREE_OUTPUT_TOKENS || 16000),
  // 最初から外しておく provider (カンマ区切り)。壊れた出力を返したものは自動でも外す
  ignoreProviders: list(process.env.MEMORY_TREE_IGNORE_PROVIDERS, ''),
  // provider の単価の上限 "入力,出力" (100万トークンあたり USD)。区切りは入力3万・出力4千トークンほどなので
  // 出力の高い provider を避けたい (空なら予約の値段だけで縛る)
  maxPrice: priceOf(process.env.MEMORY_TREE_MAX_PRICE),
  // これより長い区切りで出来事も知識も1つも無ければ、読めていないとみなす
  emptyChars: Number(process.env.MEMORY_TREE_EMPTY_CHARS || 4000),
  // これ以上待たされる 429 は日の上限とみなして止める
  maxWaitMs: 10 * 60_000,
  failuresBeforeSkip: 3,
  rootEverySegments: 30,
  // 知識の文のうち、ログと10字以上一致する部分がこの割合を超えたら丸写しとして捨てる
  copyRatio: 0.8
};

const KIND_CHARS = 16;

export const SEGMENT_SYSTEM = `あなたは Discord サーバーの「記憶」を書く記録係です。会話ログの区切りを読み、後で誰かが「あの時さ」と話題にできること、bot が会話やジャッジで使えることを残します。決まった型に当てはめず、このサーバーらしいことを自由に拾ってください。ログを写すのではなく、何があったか・誰がどういう人かが後で分かるように整理します。

## 出来事 (episodes) — 種類は問わない
- 決定・作ったもの・事件・告知・企画に限らない。レスバや口論・議論 (誰と誰が何で揉め、それぞれ何を主張し、どう終わったか・誰が折れたか)、ネタ・ミーム、名言や迷言、盛り上がった雑談、人間関係の変化、炎上、賭けや予言とその結末なども出来事にする。
- kind は短い種類名 (例: レスバ / 議論 / ネタ / 名言 / 事件 / 決定 / 告知 / 近況 / 技術 / 企画)。合うものが無ければ自由に付ける。
- title は30字以内。summary は1〜4文で「誰が・何を・なぜ・どうなったか」。レスバなら双方の言い分と結末まで書く。発言の引用を並べない。
- lines は根拠の行番号 (行頭の数字)。要所を1〜6個。
- quotes は記録に残したい決め台詞・名言・迷言・失言の行番号 (0〜3個)。原文はこちらで残すので、summary に写さない。
- nodes は関わった人物・もの・話題のページ (1〜6個)。既知のページ・索引から選び、無ければ新しいパスを作って new に書く。
- related は「既知のページ」に出ている過去の出来事 (e12 など) の続き・原因・結果・蒸し返しなら、その番号。
- importance: 1=小ネタ 2=普通 3=重要 (決定・大きな変化・事件・大きく揉めた)。
- 挨拶だけ・相槌だけの部分は出来事にしなくてよい。

## 知識 (facts)
- 出来事から分かる、そのページの説明に足すべきこと。人物なら性格・立場や意見 (何について何派か)・口癖・得意不得意・作ったもの・誰と仲が良いか・誰とよく揉めるか。もの・話題・用語・ネタならその説明と由来。
- ページの説明として書く (「〜派」「〜の作者」「〜とよく言い合う」「〜が口癖」)。「〜と言った」の形にしない。
- 意見や立場には時期を付ける (「2025-03 時点で〜派」)。後で言っていることが変わったか比べられるように。
- 既知のページに既に書いてあることは繰り返さない。変わったなら「〜から〜に変わった」と書く。
- 冗談・皮肉・推測は事実と区別する (「冗談で〜」「〜と考えている」)。
- episode はこの出力の episodes の番号 (0始まり)。根拠の無い知識は書かない。

## ページのパス
- 最上位は「最上位の一覧」から必ず選ぶ。どれにも合わなければ others に入れる。最上位は増やさない。
- 最上位の下は自由に作ってよい (子・孫まで、名前も自由)。人物は people/<ログ中の名前>。
- 同じものに別の名前が付いていたら、既存のページを使い new の aliases に別名を書く。

## 書かないもの
連絡先・パスワード・本名・住所などの機微情報、ログに無い推測。

出力は JSON だけ:
{"episodes":[{"kind":"レスバ","title":"Go と Rust どっちが上か","summary":"たこが Go の手軽さを推し、さばが Rust の型安全を譲らず1時間言い合った。最後はさばの「ビルド待ちも思考時間」で笑って終わった。","lines":[3,8,15],"quotes":[15],"nodes":["people/たこ","people/さば","topics/Go vs Rust"],"related":[],"importance":2}],
 "facts":[{"path":"people/さば","text":"Rust 派で、型安全の話になると引かない (2025-03 時点)","episode":0},{"path":"people/たこ","text":"Go の手軽さを推す (2025-03 時点)","episode":0}],
 "new":[{"path":"topics/Go vs Rust","summary":"たびたび蒸し返される言語論争","aliases":["GoRust論争"]}]}
書くことが無ければ {"episodes":[],"facts":[],"new":[]}。`;

const INTEGRATE_SYSTEM = `あなたは Discord サーバーの「記憶」の編集者です。各ページに新しく分かった知識を統合して、ページを書き直します。

## ページの書き方
- ページはその人・もの・話題の説明。ログの写しや日記にしない。「何者か / 何をしているか / 今どうなっているか / 誰・何とどう関わるか」を現在形でまとめる。
- 先頭に1〜2文の概要。見出しはページに合わせて自由に付ける (例: 人物なら「## 立場と意見」「## よくやること」「## 関係」「## 名言」、レスバなら「## 争点」「## 双方の言い分」「## 結末」)。無理に埋めない。
- 人物の立場や意見は時期つきで残す。前と変わったなら両方を書く (後でダブスタかどうか比べるため)。
- 経緯は出来事を日付順に並べず、流れを短く語る。個々の出来事は [e12] で指せば足りる。
- 変化は上書きせず「以前は〜、YYYY-MM から〜」と書く。食い違う情報は両方を日付つきで残す。
- 各主張の終わりに根拠の出来事 [e12] を残す (新しい知識に付いているもの・本文に元からあるもの)。根拠の無い主張を足さない。
- 意見・冗談・推測は事実と分けて書く (「〜と考えている」「冗談で〜」)。
- 他のページに触れるときは索引にあるパスで [[people/さば]] とリンクする。
- body は ${treeConfig.bodyChars}字以内。収まらないときは、まとまりごとに子ページ (children) へ分け、body には概要と [[子のパス]] へのリンクを残す。子を作れないと書かれたページは要約して収める。
- summary はページの1行説明 (40字以内)。aliases はこのページの別名・表記ゆれ (あれば)。

出力は JSON だけ (渡したページすべてについて書く):
{"pages":[{"path":"…","summary":"…","aliases":["…"],"body":"…","children":[{"name":"…","summary":"…","body":"…"}]}]}`;

export const SORT_SYSTEM = `あなたは Discord サーバーの「記憶」の編集者です。知識が溜まりすぎた1つのページの「新しい知識」を、子ページに仕分けます。書き直しはしません (番号で振り分けるだけ)。

- 子ページはそのページの中のまとまり。中身に合わせて 3〜8 個 (人物のページなら、例えば技術の好み・作ったもの・人間関係・名言・経歴のように)。今ある子ページに合うものはその名前を使う。
- そのページ自体が大きなページの一部 (「親のページ」が書いてある) なら、その部分の中をさらに細かい話題で分ける。親や兄弟のページと同じ名前は使わない。
- 子の名前は短い日本語 (20字以内)。/ や [ ] は使わない。ページ自身の名前は付けない (「あかりの技術」ではなく「技術・言語観」)。
- そのページが何者か・何なのかを示す核になる知識 (概要に要るもの) だけ main に残す。main は全体の2割まで。
- すべての番号をどこか1つに入れる。

出力は JSON だけ:
{"children":[{"name":"…","summary":"… (40字以内)","lines":[1,2,5]}],"main":[3,4]}`;

const ROOT_SYSTEM = `あなたは Discord サーバーの「記憶」の編集者です。根のページ (サーバー全体の概要) を書きます。bot が毎回の会話で最初に読む、唯一の常駐する記憶です。

- このサーバーが何の場所か、主な人物と役割、主なプロジェクト、よく出る話題、文化や用語を ${treeConfig.rootChars}字以内で。
- 主なページには [[projects/sakana-bot]] の形でリンクする (渡したパスだけ)。
- 渡したページの内容だけを根拠にする。推測しない。箇条書きでよい。

出力は JSON だけ: {"body":"…"}`;

// ---- モデル呼び出し ----------------------------------------------------------

export class StopRun extends Error {
  readonly reason: string;
  constructor(message: string, reason: string) {
    super(message);
    this.reason = reason;
  }
}

const badOutput = (message: string, cause?: unknown): Error & { code: 'BAD_OUTPUT'; cause: unknown } =>
  Object.assign(new Error(message), { code: 'BAD_OUTPUT' as const, cause });

/** 推論モデルの <think> やコードフェンスを剥がして、最初の JSON オブジェクトを読む。中身はまだ確かめていない。 */
export function parseModelJson(content: unknown): unknown {
  let text = String(content ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1] !== undefined) text = fenced[1].trim();
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function budgetFor(guildId: string, models: readonly string[]): string | null {
  const paid = models.filter((model) => !model.endsWith(':free'));
  if (paid.length === 0) return null;
  if (!(treeConfig.budgetUsd > 0)) {
    // stealth (stealth/xxx-alpha) は :free が付かないが 0 円。期間が終わると有料の別名になったり
    // 消えたりするので、値段が変わったときの上限としてここで止める
    throw new StopRun(`:free でないモデル (${paid.join(', ')}) を使うには MEMORY_TREE_BUDGET_USD に月の上限を置いてください`
      + ' (stealth など 0 円のモデルでも、値段が変わったときの安全装置として 1 などを置く)', 'config');
  }
  const id = budgetIdFor(guildId);
  ensureModelBudget({ id, guildId, limitUsd: treeConfig.budgetUsd });
  return id;
}

/** 予算の台帳の id。月 (UTC) ごとに新しい枠になる。 */
export function budgetIdFor(guildId: string, now = Date.now()): string {
  return `memory-tree:${guildId}:${new Date(now).toISOString().slice(0, 7)}:${treeConfig.budgetUsd}`;
}

// 壊れた出力を返す provider をしばらく外す。
// 2026-10-15、OpenRouter が glm-5.3-flash を回す先のうち OpenInference は3万トークン読ませても
// {"episodes":[]} だけ (17トークン) を返し、Morph は半数が 16000 トークンまで暴走した。
// どちらも「完了」に見えるので、空の区切りが静かに積み上がっていた。
// builder は1時間ごとに起動し直すので、外した provider は記憶の DB に控える (プロセスの中だけだと毎回踏み直す)。
const BAD_PROVIDERS = 'bad-providers';
const BAD_PROVIDER_MS = 3_600_000;

// provider ごとの直近1時間の成績 (この実行の中だけ)。1回の暴走・空返しでは外さない。
// 2026-10-16、いちばん安くまともな StreamLake が出力の暴走3回 (25回中) で外れ、続いて Novita と
// GMICloud も外れて、単価の上限に残った DeepInfra が 429 を連発し読み込みがほぼ止まった。
// 出力の暴走はどの provider でも時々起きる。外すのは壊れている割合が高いものだけ
const providerRecord = new Map<string, { at: number; bad: boolean }[]>();
const RECORD_MS = 3_600_000;

/** 結果を記録し、外すべきなら true。直近1時間に3回以上、かつ4回に1回以上壊れていたら外す。 */
export function recordProvider(name: string | null | undefined, bad: boolean, now = Date.now()): boolean {
  if (!name) return false;
  const list = (providerRecord.get(name) ?? []).filter((entry) => entry.at > now - RECORD_MS);
  list.push({ at: now, bad });
  providerRecord.set(name, list);
  const bads = list.filter((entry) => entry.bad).length;
  return bad && bads >= 3 && bads * 4 >= list.length;
}

export function forgetProviderRecord(): void {
  providerRecord.clear();
}

/** 外した provider と、外す期限 (ms)。 */
function savedAvoided(): JsonRecord {
  const saved = getState(BAD_PROVIDERS);
  return isRecord(saved) ? saved : {};
}

export function avoidedProviders(now = Date.now()): string[] {
  const saved = savedAvoided();
  const live = Object.fromEntries(Object.entries(saved).filter(([, until]) => typeof until === 'number' && until > now));
  if (Object.keys(live).length !== Object.keys(saved).length) setState(BAD_PROVIDERS, Object.keys(live).length ? live : null);
  return [...new Set([...treeConfig.ignoreProviders, ...Object.keys(live)])];
}

export function avoidProvider(name: string | null | undefined, now = Date.now()): void {
  if (name) setState(BAD_PROVIDERS, { ...savedAvoided(), [name]: now + BAD_PROVIDER_MS });
}

export function forgetAvoidedProviders(): void {
  setState(BAD_PROVIDERS, null);
}

/** builder がモデルへ投げる1回。check は読めた JSON の検査 (落ちたら投げる)。 */
export interface CallInput {
  kind: string;
  system: string;
  user: string;
  check?: (json: unknown) => void;
}

/** json はモデルの出力 (まだ確かめていない)。差し替えた call (検査) は model を返さないことがある。 */
export interface CallResult {
  json: unknown;
  model?: string;
  provider?: string | null;
  usage?: unknown;
}

export type MemoryCaller = (input: CallInput) => Promise<CallResult>;

/**
 * 1回の呼び出し。待てば済む 429 は待って同じ入力を送り直し、日の上限・認証・
 * 残高は StopRun にする。出力が読めないものはそのまま投げる (呼び出し側が数える)。
 * check は読めた JSON の検査 (空の結果など)。落ちたら、または途中で切れたら、すぐ送り直す (2回まで)。
 * 壊れている割合が高い provider だけ1時間外す (recordProvider)。
 */
export function openRouterCaller({ guildId, models = treeConfig.models, runId = randomUUID() }:
  { guildId: string; models?: readonly string[]; runId?: string }): MemoryCaller {
  const budgetId = budgetFor(guildId, models);
  return async function call({ kind, system, user, check }: CallInput): Promise<CallResult> {
    for (let transient = 0, swapped = 0, cleared = false; ; transient += 1) {
      let provider: string | null = null;
      const ignored = avoidedProviders();
      try {
        const data = await requestModel({
          model: models[0], fallbackModels: models.slice(1),
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          maxOutputTokens: treeConfig.outputTokens, timeoutMs: treeConfig.timeoutMs,
          guildId, role: `memory-${kind}`, runId, budgetId, temperature: 0.2, reasoning: treeConfig.reasoning,
          // JSON 専用モード。glm-5.3-flash で約20回に1回 JSON が壊れていた
          jsonOnly: true, ignoreProviders: ignored, maxPrice: treeConfig.maxPrice
        });
        provider = data.provider ?? null;
        const message = data.choices[0].message;
        const json = parseModelJson(message.content);
        check?.(json);
        recordProvider(provider, false);
        return { json, model: data.model ?? models[0], provider, usage: data.usage };
      } catch (error) {
        const details = detailsOf(error);
        const message = errorMessage(error);
        const blame = provider ?? (typeof details.provider === 'string' ? details.provider : null);
        const broken = details.code === 'BAD_OUTPUT' || /truncated/.test(message);
        if (broken && recordProvider(blame, true)) {
          avoidProvider(blame);
          console.warn(`memory: ${blame} を ${BAD_PROVIDER_MS / 3_600_000} 時間外す (直近1時間に壊れた出力が続いた: ${message})`);
        }
        if (broken && swapped < 2) { swapped += 1; continue; }
        if (broken) throw error;
        const status = typeof details.status === 'number' ? details.status : null;
        // 外しすぎて回す先が無くなった (404) ら、外したものを忘れて1回だけ送り直す
        if (status === 404 && ignored.length > treeConfig.ignoreProviders.length && !cleared) {
          forgetAvoidedProviders();
          cleared = true;
          continue;
        }
        if (status !== null && [401, 402, 403].includes(status)) throw new StopRun(`OpenRouter HTTP ${status}`, 'auth');
        if (/BUDGET/.test(String(details.code ?? ''))) throw new StopRun(message, 'budget');
        const retryAt = typeof details.retryAt === 'number' && Number.isFinite(details.retryAt) ? details.retryAt : null;
        const wait = retryAt !== null ? retryAt - Date.now() : null;
        if (retryAt !== null && wait !== null && wait > treeConfig.maxWaitMs) {
          throw new StopRun(`無料枠の上限 (再開 ${new Date(retryAt).toISOString()})`, 'quota');
        }
        if (!details.retryable || transient >= 5) throw error;
        await sleep(Math.max(wait ?? 0, 5000 * (transient + 1)));
      }
    }
  };
}

// ---- 出力の検査 -------------------------------------------------------------

const flat = (text: unknown): string => String(text ?? '').replace(/\[e\d+\]|\[\[[^\]]*\]\]/g, '').replace(/^\d+\|/gm, '').replace(/\s+/g, '');

/** 文のうち、ログと10字以上そのまま一致する部分の割合 (丸写しの検出)。 */
export function copiedRatio(text: unknown, flatTranscript: string): number {
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

const linesOf = (value: unknown): string[] => (Array.isArray(value) ? arrayOf(value) : [value])
  .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()));
const pathOf = (guildId: string, raw: unknown): string | null => {
  const normalized = normalizePath(raw);
  return normalized ? resolveExisting(guildId, placeTopLevel(guildId, normalized)) : null;
};

/**
 * 長い区切りなのに、根拠の行が実在する出来事が1つも無ければ読めていない。
 * provider が空の JSON を返した、または実在しない行番号の出来事を1件だけ返した
 * (Morph がそうした。知識は出来事にぶら下がるので、出来事が無ければ全部捨てられる)。
 */
const rec = (value: unknown): JsonRecord => (isRecord(value) ? value : {});

export function checkSegmentOutput(pack: { text: string; lineMap?: ReadonlyMap<number, LineEntry> }, json: unknown): void {
  if (pack.text.length < treeConfig.emptyChars) return;
  const episodes = arrayOf(rec(json).episodes);
  const usable = episodes.map(rec).filter((episode) => String(episode.title ?? '').trim() && String(episode.summary ?? '').trim()
    && arrayOf(episode.lines).some((n) => pack.lineMap?.has(Number(n))));
  if (usable.length === 0) {
    throw badOutput(`segment output had no usable episode for ${pack.text.length} chars (${episodes.length} returned)`);
  }
}

/**
 * 区切りの結果を、区切りの記録・cursor と同じトランザクションで入れる。
 * 出来事は根拠の行が1つも実在しなければ捨てる (たどれない出来事を作らない)。
 */
export interface DroppedCounts {
  noSource: number;
  copied: number;
  unsourced: number;
}

export interface SegmentReport {
  episodes: number;
  facts: number;
  related: number;
  dropped: DroppedCounts;
  pages: string[];
}

const isLine = (line: LineEntry | undefined): line is LineEntry => Boolean(line);
const isId = (id: string | undefined): id is string => Boolean(id);

export function applySegmentResult(guildId: string, pack: Pack, output: unknown,
  { model, now = Date.now(), advance = true }: { model?: string | null; now?: number; advance?: boolean } = {}): SegmentReport {
  if (!isRecord(output)) throw badOutput('segment output is not an object');
  const result = output;
  if (!Array.isArray(result.episodes) && !Array.isArray(result.facts)) throw badOutput('segment output has no episodes/facts');
  const episodes = arrayOf(result.episodes);
  const facts = arrayOf(result.facts);
  const created = arrayOf(result.new);

  const flatTranscript = flat(pack.text);
  const report = { episodes: 0, facts: 0, related: 0, dropped: { noSource: 0, copied: 0, unsourced: 0 }, pages: new Set<string>() };
  memoryDb().transaction(() => {
    // 新しいページの説明と別名 (出来事より先に作る)
    for (const entry of created.slice(0, 60).map(rec)) {
      const path = pathOf(guildId, entry.path);
      if (!path || depthOf(path) < 2) continue;
      ensureNode(guildId, path, { summary: String(entry.summary ?? '').trim().slice(0, 80), now });
      addAliases(guildId, path, linesOf(entry.aliases ?? []));
    }

    const ids: ({ id: number; at: number; end: number } | null)[] = [];
    for (const episode of episodes.slice(0, 60).map(rec)) {
      const cited = arrayOf(episode.lines)
        .map((n) => pack.lineMap.get(Number(n))).filter(isLine).slice(0, 8);
      const title = String(episode.title ?? '').trim().slice(0, 60);
      const summary = String(episode.summary ?? '').trim().slice(0, 400);
      const [first] = cited;
      if (!first || !title || !summary) { ids.push(null); report.dropped.noSource += 1; continue; }
      const at = Math.min(...cited.map((line) => line.firstMs));
      const end = Math.max(...cited.map((line) => line.lastMs));
      // 決め台詞は行番号で指させて、原文はアーカイブの発言をそのまま使う (写させない)
      const highlights = [...new Set(arrayOf(episode.quotes)
        .map((n) => pack.lineMap.get(Number(n))?.ids[0]).filter(isId))].slice(0, 3);
      const id = insertEpisode(guildId, {
        kind: String(episode.kind ?? '').replace(/[\s\n]+/g, ' ').trim().slice(0, KIND_CHARS),
        title, summary, channelId: first.channelId, atMs: at, endMs: end,
        sources: [...new Set([...cited.flatMap((line) => line.ids.slice(0, 2)), ...highlights])].slice(0, 12),
        highlights,
        importance: [1, 2, 3].includes(Number(episode.importance)) ? Number(episode.importance) : 2, now
      });
      ids.push({ id, at, end });
      const paths = linesOf(episode.nodes ?? []).map((raw) => pathOf(guildId, raw))
        .filter((path): path is string => Boolean(path) && path !== null && depthOf(path) >= 2);
      for (const path of paths) ensureNode(guildId, path, { now });
      linkEpisodeNodes(guildId, id, paths, now);
      const related = arrayOf(episode.related)
        .map((value) => Number(String(value).replace(/^e/i, ''))).filter((value) => Number.isInteger(value));
      report.related += linkEpisodes(guildId, id, related);
      report.episodes += 1;
    }

    for (const fact of facts.slice(0, 200).map(rec)) {
      const path = pathOf(guildId, fact.path);
      const text = String(fact.text ?? '').trim();
      const source = ids[Number(fact.episode)];
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
function skipPack(guildId: string, pack: Pack, error: unknown, now = Date.now()): void {
  memoryDb().transaction(() => {
    for (const segment of pack.segments) {
      recordSegment(guildId, segment, { status: 'failed', error: String(detailsOf(error).message ?? error).slice(0, 300), now });
      setCursor(guildId, segment.channelId, segment.toId, segment.toMs);
    }
  })();
}

const childName = (name: unknown): string => String(name ?? '').replace(/[/\\[\]]/g, ' ').replace(/[\s　]+/g, ' ').trim().slice(0, 48);
const refsIn = (text: unknown): Set<string> => new Set([...String(text ?? '').matchAll(/\[e(\d+)\]/g)].map((m) => m[1] ?? ''));

/** 統合・仕分けに渡したページと、渡した統合待ちの部分。 */
export interface PendingJob {
  path: string;
  consumed: string;
}

/** 渡したはずのページが無い (管理者が途中で移した・消した)。元の挙動どおり組ごと失敗にする。 */
function nodeFor(guildId: string, path: string): NonNullable<ReturnType<typeof getNode>> {
  const node = getNode(guildId, path);
  if (!node) throw new Error(`node missing: ${path}`);
  return node;
}

/**
 * 統合の結果を入れる。batch は { path, consumed } (渡した統合待ちの部分) の配列。
 * 渡したのに書かれなかったページ・検査に落ちたページは統合待ちのまま残して数える。
 */
export function applyIntegrateResult(guildId: string, batch: readonly PendingJob[], result: unknown,
  { now = Date.now() }: { now?: number } = {}): { done: string[]; failed: { path: string; problem: string }[] } {
  const pages = isRecord(result) && Array.isArray(result.pages) ? arrayOf(result.pages) : null;
  if (!pages) throw badOutput('integrate output has no pages');
  const byPath = new Map<string, JsonRecord>();
  for (const page of pages) {
    if (!isRecord(page)) continue;
    const path = normalizePath(page.path);
    if (path) byPath.set(path, page);
  }
  const done: string[] = [];
  const failed: { path: string; problem: string }[] = [];
  memoryDb().transaction(() => {
    for (const item of batch) {
      const page = byPath.get(item.path);
      const node = nodeFor(guildId, item.path);
      const body = typeof page?.body === 'string' ? page.body.trim() : '';
      const children = arrayOf(page?.children).map(rec);
      const deepest = depthOf(item.path) >= MAX_DEPTH;
      const before = `${node.body}\n${item.consumed}`.trim();
      const kept = body.length + children.reduce((sum, child) => sum + String(child.body ?? '').length, 0);
      const floor = deepest ? 0.15 : 0.3;
      const problem = !page ? 'not returned'
        : !body ? 'empty body'
        : body.length > treeConfig.nodeChars ? 'body too long'
        : kept < before.length * floor ? `dropped too much (${kept}/${before.length})`
        : refsIn(before).size > 0 && refsIn(body).size === 0 && children.every((child) => refsIn(child.body).size === 0)
          ? 'lost every [e] reference'
        : deepest && children.length > 0 ? 'children at max depth'
        : null;
      if (problem || !page) { failed.push({ path: item.path, problem: problem ?? 'not returned' }); continue; }

      // 統合待ちは渡したぶんだけ消す (渡した後に足されたぶんは残す)
      const rest = node.pending.startsWith(item.consumed) ? node.pending.slice(item.consumed.length) : '';
      writePage(guildId, item.path, { summary: String(page.summary ?? '').trim().slice(0, 80), body,
        aliases: linesOf(page.aliases ?? []), now });
      if (rest.trim()) {
        memoryDb().prepare<[string, number, string, string]>('UPDATE nodes SET pending = ?, pending_count = ? WHERE guild_id = ? AND path = ?')
          .run(rest, rest.split('\n').filter(Boolean).length, guildId, item.path);
      }
      linkPageMentions(guildId, item.path, body, now);

      for (const child of children.slice(0, 20)) {
        const name = childName(child.name);
        const childBody = String(child.body ?? '').trim();
        if (!name || !childBody) continue;
        const target = resolveExisting(guildId, `${item.path}/${name}`);
        ensureNode(guildId, target, { summary: String(child.summary ?? '').trim().slice(0, 80), now });
        const existing = getNode(guildId, target);
        if (existing?.body) {
          // 既にある子は、移された内容を統合待ちに回す (次の統合で既存の本文と混ぜる)
          addPending(guildId, target, childBody.split('\n'), { firstAt: node.first_at ?? now, lastAt: node.last_at ?? now, now });
        } else {
          writePage(guildId, target, { summary: String(child.summary ?? '').trim().slice(0, 80), body: childBody, now });
          memoryDb().prepare<[number, number | null, number | null, string, string]>('UPDATE nodes SET weight = weight + ?, first_at = ?, last_at = ? WHERE guild_id = ? AND path = ?')
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

/**
 * 仕分けの結果を入れる。子ページへ回した知識は子の統合待ちへ (行はそのまま、[e12] も残る)。
 * 子ページからも出来事をたどれるように、行が引いている出来事を子にも結ぶ。
 * main と、どこにも入らなかった行は親の統合待ちの末尾へ戻す (次の仕分けで同じ行を先頭から読み直さない)。
 */
export function applySortResult(guildId: string, job: PendingJob, result: unknown,
  { now = Date.now() }: { now?: number } = {}): { moved: number; kept: number; children: string[] } {
  const children = isRecord(result) && Array.isArray(result.children) ? arrayOf(result.children) : null;
  if (!children) throw badOutput('sort output has no children');
  if (depthOf(job.path) >= MAX_DEPTH) throw badOutput('cannot sort at max depth');
  const lines = sortLines(job.consumed);
  const owner = new Map<number, number>();
  const groups: { name: string; summary: string; lines: number[] }[] = [];
  // 兄弟や祖先と同じ名前の子は作らない (people/あかり/Linux・環境 を「技術・言語観」1つへ丸ごと移した)
  // (兄弟を見るのは深いページだけ。people/あかり の兄弟は人の名前なので見ても意味がない)
  const siblings = depthOf(job.path) >= 3 ? listChildren(guildId, parentOf(job.path) ?? '', 200).map((row) => nameOf(row.path)) : [];
  const taken = new Set([...job.path.split('/'), ...siblings].map(nameKeyOf));
  const own = new Set(listChildren(guildId, job.path, 200).map((row) => nameKeyOf(nameOf(row.path))));
  for (const child of children.slice(0, 10).map(rec)) {
    const name = childName(child.name).slice(0, 24);
    if (!name || (taken.has(nameKeyOf(name)) && !own.has(nameKeyOf(name)))) continue;
    const picked = [...new Set(arrayOf(child.lines).map(Number))]
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= lines.length && !owner.has(n));
    if (picked.length === 0) continue;
    for (const n of picked) owner.set(n, groups.length);
    groups.push({ name, summary: String(child.summary ?? '').trim().slice(0, 80), lines: picked });
  }
  // 子へ4割も回さないなら仕分けになっていない (本文に戻すだけで終わる)。1つの子へ9割以上なら、名前を変えただけ
  if (groups.length === 0 || owner.size < lines.length * 0.4) {
    throw badOutput(`sort moved too little (${owner.size}/${lines.length})`);
  }
  if (groups.length < 2 || Math.max(...groups.map((group) => group.lines.length)) > owner.size * 0.9) {
    throw badOutput(`sort did not split (${groups.map((group) => `${group.name}:${group.lines.length}`).join(', ')})`);
  }
  const main = lines.filter((_, i) => !owner.has(i + 1));
  const known = memoryDb().prepare<[string, number]>('SELECT 1 FROM episodes WHERE guild_id = ? AND id = ?');
  const moved: string[] = [];
  memoryDb().transaction(() => {
    const node = getNode(guildId, job.path);
    // 仕分けている間に足された知識は末尾にある。渡した部分が先頭に無ければ、誰かが書き換えている
    if (!node || !node.pending.startsWith(job.consumed)) throw badOutput('pending changed during the sort');
    for (const group of groups) {
      const target = resolveExisting(guildId, `${job.path}/${group.name}`);
      ensureNode(guildId, target, { summary: group.summary, now });
      // 番号は 1〜lines.length に絞ってあるので、どの行もある
      const text = group.lines.map((n) => lines[n - 1]).filter((line): line is string => line !== undefined);
      addPending(guildId, target, text, { firstAt: node.first_at ?? now, lastAt: node.last_at ?? now, now });
      const refs = new Set(text.flatMap((line) => [...line.matchAll(/\[e(\d+)\]/g)].map((m) => Number(m[1]))));
      for (const id of refs) if (known.get(guildId, id)) linkEpisodeNodes(guildId, id, [target], now);
      moved.push(nameOf(target));
    }
    const rest = node.pending.slice(job.consumed.length);
    const pending = `${rest}${main.length ? `${main.join('\n')}\n` : ''}`;
    memoryDb().prepare<[string, number, number, string, string]>('UPDATE nodes SET pending = ?, pending_count = ?, updated_at = ? WHERE guild_id = ? AND path = ?')
      .run(pending, pending.split('\n').filter(Boolean).length, now, guildId, job.path);
  })();
  forgetNames(guildId);
  return { moved: owner.size, kept: main.length, children: moved };
}

// ---- プロンプト ---------------------------------------------------------------

export function segmentPrompt(guildId: string, pack: Pack): string {
  const index = treeIndex(guildId, treeConfig.indexChars);
  const known = knownPagesFor(guildId, pack.text, { maxChars: treeConfig.knownChars });
  const tops = topLevels(guildId).map((path) => `${path} — ${getNode(guildId, path)?.summary ?? ''}`);
  return [
    '最上位の一覧 (ここから必ず選ぶ。合わなければ others):',
    tops.join('\n'),
    '',
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

function integratePrompt(guildId: string, batch: readonly PendingJob[]): string {
  const index = treeIndex(guildId, 4000);
  const blocks = batch.map((item) => {
    const node = nodeFor(guildId, item.path);
    const children = listChildren(guildId, item.path, 30).map((child) => `${nameOf(child.path)} — ${child.summary || ''}`);
    return [
      `### ${item.path}`,
      `説明: ${node.summary || '(なし)'}`,
      ...(node.aliases.length ? [`別名: ${node.aliases.join(', ')}`] : []),
      depthOf(item.path) >= MAX_DEPTH ? '(深さの上限なので子ページは作れない)' : `子ページ: ${children.join(' / ') || '(なし)'}`,
      // 何字残せばよいかを数字で渡す (渡さないと、1万字を千字に縮めて却下されていた)
      // 何字かを数字で渡す。「何字以上残せ」と下限を渡すと本文を長くしすぎた (6000字を超えて却下)
      depthOf(item.path) >= MAX_DEPTH
        ? `(本文と新しい知識で約${node.body.length + item.consumed.length}字。本文は${treeConfig.bodyChars}字以内に要約する)`
        : `(本文と新しい知識で約${node.body.length + item.consumed.length}字。本文は${treeConfig.bodyChars}字以内。`
          + '収まらない分はまとまりごとに子ページへ移す (今ある子ページの名前を使ってよい)。捨てるのは重複だけ)',
      '現在の本文:',
      node.body || '(まだ無い)',
      '新しい知識:',
      item.consumed.trim()
    ].join('\n');
  });
  return [`木の索引 (リンクに使えるパス):\n${index.text}`, ...blocks, '各ページを書き直して JSON だけで出力してください。'].join('\n\n');
}

const sortLines = (consumed: string): string[] => consumed.split('\n').filter((line) => line.trim());
const nameKeyOf = (name: unknown): string => String(name ?? '').normalize('NFKC').toLowerCase().replace(/[\s・･_\-]/g, '');

export function sortPrompt(guildId: string, job: PendingJob): string {
  const node = nodeFor(guildId, job.path);
  const children = listChildren(guildId, job.path, 30).map((child) => `${nameOf(child.path)} — ${child.summary || ''}`);
  const lines = sortLines(job.consumed);
  const parent = parentOf(job.path) ?? '';
  const siblings = depthOf(job.path) >= 3
    ? listChildren(guildId, parent, 30).map((row) => nameOf(row.path)).filter((name) => name !== nameOf(job.path)) : [];
  return [
    `ページ: ${job.path}`,
    ...(depthOf(job.path) >= 3 ? [`親のページ: ${parent} (このページはその中の「${nameOf(job.path)}」の部分)`,
      `兄弟のページ (この名前は使わない): ${siblings.join(' / ') || '(なし)'}`] : []),
    `説明: ${node.summary || '(なし)'}`,
    `本文の冒頭: ${node.body.slice(0, 600) || '(まだ無い)'}`,
    `今ある子ページ: ${children.join(' / ') || '(なし)'}`,
    '',
    `新しい知識 (${lines.length} 件。行頭が番号):`,
    lines.map((line, i) => `${i + 1}| ${line.replace(/^-\s*/, '')}`).join('\n'),
    '',
    '番号を子ページに仕分けて JSON だけで出力してください。'
  ].join('\n');
}

function rootPrompt(guildId: string): string {
  const parts: string[] = [];
  let used = 0;
  for (const top of topLevels(guildId)) {
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

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return detailsOf(error).code === 'EPERM'; }
}

export function acquireLock(guildId: string, now = Date.now()): () => void {
  const key = `lock:${guildId}`;
  return memoryDb().transaction(() => {
    const held = getState(key);
    const live = isLockState(held) && held.pid !== process.pid
      && (held.host === hostname() ? alive(held.pid) && now - held.at < 6 * 3_600_000 : now - held.at < 30 * 60_000);
    if (live) throw new StopRun(`別の builder (pid ${held.pid}) が実行中です`, 'locked');
    setState(key, { pid: process.pid, host: hostname(), at: now });
    return () => { const current = getState(key); if (isRecord(current) && current.pid === process.pid) setState(key, null); };
  }).immediate();
}

// ---- 一時停止と進捗の分母 ---------------------------------------------------

/** Discord の /memory pause が書く。builder は区切りの境目で止まる (読みかけは失わない)。 */
export function setPaused(guildId: string, by: string | null, now = Date.now()): void {
  setState(`pause:${guildId}`, by ? { by, at: now } : null);
}

export function pausedBy(guildId: string): PauseState | null {
  const paused = getState(`pause:${guildId}`);
  return isPauseState(paused) ? paused : null;
}

/**
 * 読む対象 (公開チャンネルの人間の発言) の総数。/memory status の分母。
 * 全件を数えるので bot ではなく builder が6時間に1回だけ数えて控える。
 */
export function refreshTotals(guildId: string, channelIds: readonly string[], now = Date.now()): Totals {
  const key = `totals:${guildId}`;
  const held = getState(key);
  if (isTotals(held) && now - held.at < 6 * 3_600_000 && held.channels === channelIds.length) return held;
  const count = archive.prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ? AND deleted = 0 AND is_bot = 0');
  let messages = 0;
  for (const channelId of channelIds) messages += count.get(channelId)?.n ?? 0;
  const totals = { messages, channels: channelIds.length, at: now };
  setState(key, totals);
  return totals;
}

// ---- 実行 ------------------------------------------------------------------

/**
 * 統合する組。統合待ちの多いページから、合計の文字数上限まで。
 * 1ページの統合待ちが大きすぎるときは先頭から渡せるぶんだけ渡す (残りは次)。
 */
function integrationBatch(guildId: string,
  { minChars, skip, newOnly = false }: { minChars: number; skip: ReadonlySet<string>; newOnly?: boolean }): PendingJob[] | null {
  const batch: PendingJob[] = [];
  let used = 0;
  for (const row of pendingNodes(guildId, { minChars, limit: 60, newOnly })) {
    if (skip.has(row.path) || needsSort(guildId, row.path, row.pending_chars)) continue;
    const failures = countOf(getState(`integrate-fail:${guildId}:${row.path}`));
    if (failures >= treeConfig.failuresBeforeSkip) {
      // 統合できないページでも知識は落とさない (本文の末尾へそのまま移す)
      flushPendingRaw(guildId, row.path);
      setState(`integrate-fail:${guildId}:${row.path}`, null);
      continue;
    }
    const node = getNode(guildId, row.path);
    if (!node) continue;   // 今読んだ行なので必ずある
    const room = Math.max(1500, treeConfig.integrateBatchChars - used - node.body.length - 400);
    if (batch.length > 0 && treeConfig.integrateBatchChars - used - node.body.length - 400 < 1500) break;
    let consumed = node.pending;
    if (consumed.length > room) {
      const cut = consumed.lastIndexOf('\n', room);
      consumed = consumed.slice(0, cut > 0 ? cut + 1 : consumed.length);
    }
    batch.push({ path: row.path, consumed });
    used += node.body.length + consumed.length + 400;
    if (batch.length >= (newOnly ? treeConfig.newPages : treeConfig.integratePages) || used >= treeConfig.integrateBatchChars) break;
  }
  return batch.length ? batch : null;
}

/** 書き直す前に子ページへ仕分けるページか。仕分けに3回失敗したら普通の統合へ戻す。 */
function needsSort(guildId: string, path: string, pendingChars: number): boolean {
  return pendingChars >= treeConfig.sortChars && depthOf(path) < MAX_DEPTH
    && countOf(getState(`sort-fail:${guildId}:${path}`)) < treeConfig.failuresBeforeSkip;
}

/** 仕分けるページを1つ。統合待ちの多い順に、先頭から渡せるぶんだけ (残りは次の仕分けで)。 */
function sortJob(guildId: string, { skip }: { skip: ReadonlySet<string> }): PendingJob | null {
  for (const row of pendingNodes(guildId, { minChars: treeConfig.sortChars, limit: 30 })) {
    if (skip.has(row.path) || !needsSort(guildId, row.path, row.pending_chars)) continue;
    const node = getNode(guildId, row.path);
    if (!node) continue;   // 今読んだ行なので必ずある
    const { pending } = node;
    const cut = pending.lastIndexOf('\n', treeConfig.sortBatchChars);
    return { path: row.path, consumed: pending.length <= treeConfig.sortBatchChars ? pending : pending.slice(0, cut + 1) };
  }
  return null;
}

/**
 * 記憶を育てる。上限 (回数・時間) に達するか、読むものが無くなるか、無料枠が尽きたら止まる。
 * 何度止めても cursor と統合待ちの続きから再開できる。
 */
export interface BuildStats {
  calls: number;
  segments: number;
  messages: number;
  episodes: number;
  facts: number;
  related: number;
  integrated: number;
  sorted: number;
  dropped: DroppedCounts;
  failed: number;
  root: boolean;
  stopped: string;
  message?: string;
}

type Log = (line: string) => void;
type SegmentRunner = (pack: Pack, options?: { advance?: boolean }) => Promise<boolean>;

export interface RunBuildOptions {
  guildId: string;
  call: MemoryCaller;
  maxCalls?: number;
  maxMs?: number;
  retryFailed?: boolean;
  now?: () => number;
  log?: Log;
}

export async function runBuild({
  guildId, call, maxCalls = Infinity, maxMs = Infinity, retryFailed = false,
  now = () => Date.now(), log = () => {}
}: RunBuildOptions): Promise<BuildStats> {
  const started = now();
  const release = acquireLock(guildId, started);
  ensureSeeds(guildId, started);
  const stats: BuildStats = {
    calls: 0, segments: 0, messages: 0, episodes: 0, facts: 0, related: 0, integrated: 0, sorted: 0,
    dropped: { noSource: 0, copied: 0, unsourced: 0 }, failed: 0, root: false, stopped: 'done'
  };
  const spent = (): boolean => stats.calls >= maxCalls || now() - started >= maxMs;
  const skip = new Set<string>();   // この実行で統合に失敗したページ (同じ実行では繰り返さない)

  const segment: SegmentRunner = async (pack, { advance = true } = {}) => {
    const head = pack.segments[0];
    const key = `pack-fail:${guildId}:${head?.channelId}:${head?.fromId}`;
    stats.calls += 1;
    try {
      const result = await call({ kind: 'segment', system: SEGMENT_SYSTEM, user: segmentPrompt(guildId, pack),
        check: (json) => checkSegmentOutput(pack, json) });
      // 呼び出し側が check を使わない (差し替えた call) ときもここで止める。空を「完了」にしない
      checkSegmentOutput(pack, result.json);
      const applied = applySegmentResult(guildId, pack, result.json, { model: result.model, now: now(), advance });
      setState(key, null);
      stats.segments += pack.segments.length;
      stats.messages += pack.segments.reduce((sum, s) => sum + s.messages, 0);
      stats.episodes += applied.episodes;
      stats.facts += applied.facts;
      stats.related += applied.related;
      for (const k of ['noSource', 'copied', 'unsourced'] as const) stats.dropped[k] += applied.dropped[k];
      log(`segment ${pack.segments.map((s) => `${s.label}(${s.messages})`).join(' ')} → 出来事 ${applied.episodes} / 知識 ${applied.facts}`
        + ` / つながり ${applied.related} / 捨てた ${JSON.stringify(applied.dropped)} [${result.model}]`);
      return true;
    } catch (error) {
      if (error instanceof StopRun) throw error;
      const count = countOf(getState(key)) + 1;
      setState(key, { count, error: errorMessage(error).slice(0, 200) });
      log(`segment failed (${count}/${treeConfig.failuresBeforeSkip}): ${errorMessage(error)}`);
      if (count >= treeConfig.failuresBeforeSkip && advance) {
        skipPack(guildId, pack, error, now());
        setState(key, null);
        stats.failed += pack.segments.length;
      }
      return false;
    }
  };

  const sortPage = async (job: PendingJob): Promise<void> => {
    stats.calls += 1;
    const key = `sort-fail:${guildId}:${job.path}`;
    try {
      const result = await call({ kind: 'sort', system: SORT_SYSTEM, user: sortPrompt(guildId, job) });
      const applied = applySortResult(guildId, job, result.json, { now: now() });
      setState(key, null);
      // 仕分けで小さくなったので、書き直しの失敗 (削りすぎ) も数え直す
      setState(`integrate-fail:${guildId}:${job.path}`, null);
      stats.sorted += 1;
      log(`sort ${job.path} → ${applied.children.join(', ')} (${applied.moved} 件を子へ / ${applied.kept} 件は本文へ)`);
    } catch (error) {
      if (error instanceof StopRun) throw error;
      skip.add(job.path);
      setState(key, { count: countOf(getState(key)) + 1, problem: errorMessage(error).slice(0, 120) });
      log(`sort failed ${job.path}: ${errorMessage(error)}`);
    }
  };

  const integrate = async (batch: PendingJob[]): Promise<void> => {
    stats.calls += 1;
    const fail = (path: string, problem: string): void => {
      skip.add(path);
      const count = countOf(getState(`integrate-fail:${guildId}:${path}`)) + 1;
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
      for (const item of batch) fail(item.path, errorMessage(error).slice(0, 120));
      log(`integrate failed: ${errorMessage(error)}`);
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

    let sinceRoot = rootSegments(guildId);
    const width = treeConfig.concurrency;
    // 作業プール: 1本終わるたびに、空いているチャンネル・ページから次の仕事を組んで投げる。
    // (波ごとに全部の終わりを待つと、2〜3分かかる統合に速い区切りが待たされていた)
    // 区切りはチャンネルが、統合はページが重ならないようにする。結果の反映はそれぞれの
    // トランザクションで1つずつ (統合待ちは末尾に足すだけなので、統合と区切りが同じページに
    // 触っても食い違わない)。
    const inFlight = new Set<Promise<void>>();
    const busyChannels = new Set<string>();
    const busyPages = new Set(skip);
    let integrations = 0;
    let rootRunning = false;
    // 止める理由 (StopRun)。一時停止の確認が DB のエラーで落ちたときもここに入れ、走っている仕事を終えてから投げる
    let stopError: unknown = null;
    const room = (): boolean => !stopError && inFlight.size < width && !spent();
    const launch = (work: () => Promise<unknown>, release: () => void): void => {
      const run = async (): Promise<void> => {
        try {
          await work();
        } catch (error) {
          if (!(error instanceof StopRun)) throw error;
          stopError ??= error;
        } finally {
          release();
          inFlight.delete(task);
        }
      };
      const task = run();
      inFlight.add(task);
    };
    const integrateLater = (batch: PendingJob[], done: () => void = () => {}): void => {
      for (const item of batch) busyPages.add(item.path);
      integrations += 1;
      launch(() => integrate(batch), () => {
        integrations -= 1;
        done();
        // この実行で失敗したページ (skip) は外したままにする
        for (const item of batch) if (!skip.has(item.path)) busyPages.delete(item.path);
      });
    };
    const sortLater = (job: PendingJob): void => {
      busyPages.add(job.path);
      integrations += 1;
      launch(() => sortPage(job), () => {
        integrations -= 1;
        if (!skip.has(job.path)) busyPages.delete(job.path);
      });
    };
    let newPageBatches = 0;
    const fill = (): void => {
      const slots = Math.max(1, Math.floor(width / 2));
      // 溜まりすぎたページは書き直す前に子ページへ仕分ける (1ページ1本)
      while (room() && integrations < slots) {
        const job = sortJob(guildId, { skip: busyPages });
        if (!job) break;
        sortLater(job);
      }
      // 知識が溜まったページを先に書き直す (既知のページとして次の区切りに渡すため)。幅の半分まで
      while (room() && integrations < slots) {
        const batch = integrationBatch(guildId, { minChars: treeConfig.integrateChars, skip: busyPages });
        if (!batch) break;
        integrateLater(batch);
      }
      // 統合の枠が空いていれば、本文のまだ無い新しいページに最初の本文を書く (幅の4分の1まで)。
      // 読み終えるまで「まとめ中」のまま待たせない。本文のあるページは溜まるまで待つ (書き直しを繰り返さない)
      while (room() && integrations < slots && newPageBatches < Math.max(1, Math.floor(width / 4))) {
        const batch = integrationBatch(guildId, { minChars: 1, skip: busyPages, newOnly: true });
        if (!batch) break;
        newPageBatches += 1;
        integrateLater(batch, () => { newPageBatches -= 1; });
      }
      let planned = 0;
      while (room()) {
        const pack = planPack({ guildId, channelIds, targetChars: treeConfig.segmentChars,
          minChars: treeConfig.minChars, idleMs: treeConfig.idleMs, now: now(), exclude: busyChannels });
        if (!pack) break;
        for (const s of pack.segments) busyChannels.add(s.channelId);
        planned += 1;
        launch(async () => {
          if (await segment(pack)) {
            sinceRoot += 1;
            setState(`root:${guildId}`, { ...rootState(guildId), segments: sinceRoot });
          }
        }, () => { for (const s of pack.segments) busyChannels.delete(s.channelId); });
      }
      // 読むものが残っていなければ、少ない統合待ちも書き直す
      if (planned === 0 && busyChannels.size === 0) {
        while (room()) {
          const job = sortJob(guildId, { skip: busyPages });
          if (!job) break;
          sortLater(job);
        }
        while (room()) {
          const batch = integrationBatch(guildId, { minChars: 1, skip: busyPages });
          if (!batch) break;
          integrateLater(batch);
        }
      }
      // 根は区切りが溜まったら書き直す (1本だけ)
      if (sinceRoot >= treeConfig.rootEverySegments && !rootRunning && room()) {
        rootRunning = true;
        const counted = sinceRoot;
        launch(() => rebuildRoot(guildId, call, stats, log), () => {
          rootRunning = false;
          sinceRoot = Math.max(0, sinceRoot - counted);
          setState(`root:${guildId}`, { ...rootState(guildId), segments: sinceRoot });
        });
      }
    };

    for (;;) {
      try { paused(); } catch (error) { stopError ??= error; }
      setState(`lock:${guildId}`, { pid: process.pid, host: hostname(), at: now() });
      fill();
      if (inFlight.size === 0) break;
      await Promise.race(inFlight);
    }
    // 止める理由があっても、走っていた仕事は終わらせてから止める (上で待ち切っている)
    if (stopError) throw stopError;

    if (spent()) stats.stopped = 'limit';
    const grown = memoryDb().prepare<[string]>('SELECT 1 FROM nodes WHERE guild_id = ? AND weight > 0 LIMIT 1').get(guildId);
    if (!spent() && grown && (!getNode(guildId, '')?.body || rootSegments(guildId) > 0)) {
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

/** 根を書き直してから読んだ区切りの数 (state の root:<guild>)。 */
function rootState(guildId: string): JsonRecord {
  const saved = getState(`root:${guildId}`);
  return isRecord(saved) ? saved : {};
}

function rootSegments(guildId: string): number {
  const segments = rootState(guildId).segments;
  return typeof segments === 'number' ? segments : 0;
}

async function rebuildRoot(guildId: string, call: MemoryCaller, stats: BuildStats, log: Log): Promise<void> {
  stats.calls += 1;
  try {
    const result = await call({ kind: 'root', system: ROOT_SYSTEM, user: rootPrompt(guildId) });
    const json = rec(result.json);
    const body = typeof json.body === 'string' ? json.body.trim() : '';
    if (!body) throw new Error('root body was empty');
    writePage(guildId, '', { body: body.slice(0, Math.round(treeConfig.rootChars * 1.5)) });
    linkPageMentions(guildId, '', body);
    setState(`root:${guildId}`, { at: Date.now(), segments: 0 });
    stats.root = true;
    log(`root: ${body.length} 字`);
  } catch (error) {
    if (error instanceof StopRun) throw error;
    log(`root failed: ${errorMessage(error)}`);
  }
}

async function retryFailedSegments(guildId: string, channelIds: readonly string[], segment: SegmentRunner, spent: () => boolean, log: Log): Promise<void> {
  const allowed = new Set(channelIds);
  const rows = memoryDb().prepare<[string], SegmentRow>("SELECT * FROM segments WHERE guild_id = ? AND status = 'failed' ORDER BY from_ms").all(guildId)
    .filter((row) => allowed.has(row.channel_id));   // 非公開になったチャンネルは読み直さない
  // チャンネルごとに古い順、チャンネルどうしは並べて読む (1本ずつだと66区切りに2時間かかった)
  const byChannel = new Map<string, SegmentRow[]>();
  for (const row of rows) byChannel.set(row.channel_id, [...(byChannel.get(row.channel_id) ?? []), row]);
  const queues = [...byChannel.values()];
  const worker = async (): Promise<void> => {
    for (let queue = queues.shift(); queue; queue = queues.shift()) {
      for (const row of queue) {
        if (spent()) return;
        await retryOne(guildId, row, segment, log);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, treeConfig.concurrency) }, worker));
}

async function retryOne(guildId: string, row: SegmentRow, segment: SegmentRunner, log: Log): Promise<void> {
  // 内容ごと拒否される区切りを毎回読み直して払い続けない (3回までで諦め、failed のまま残す)
  const key = `retry:${guildId}:${row.channel_id}:${row.from_id}`;
  const tried = countOf(getState(key));
  if (tried >= treeConfig.failuresBeforeSkip) return;
  const rendered = renderSegment({ guildId, channelId: row.channel_id, cursor: cursorBefore(row.from_id, row.from_ms),
    maxChars: Infinity, until: { id: row.to_id, ms: row.to_ms } });
  if (!rendered) return;
  // 元の区切りの記録 (from_id) を上書きする。cursor はとっくに先へ進んでいるので戻さない
  const pack = packOf([{ ...rendered, fromId: row.from_id }]);
  if (await segment(pack, { advance: false })) {
    setState(key, null);
    log(`retried ${rendered.label} ${row.from_id}`);
  } else {
    setState(key, { count: tried + 1 });
  }
}
