// 記憶のメモリパック (主張の索引・語彙検索・融合・入口の門・再順位づけ) の検証。埋め込みと判定モデルは偽物で、AI は呼ばない。
//
// 固定したいこと:
//   - 主張 (wrong 以外) だけが索引に入り、「[誰 / 時期 / 種類] 本文」の形で埋め込まれる
//   - 語彙の検索 (文字 3-gram) が効き、埋め込みと RRF で融合できる
//   - 入口の門: 依頼が記憶に触れなければ空 (何も足さない)。判定モデルが使えなければ null (従来の想起に任せる)
//   - 判定が低い候補は出さない / 同じ文の重複・同じ出来事ばかりは畳む / wrong は出ない / 冗談は冗談と分かる
//   - 依頼にメンションされた人の主張が候補に入る
//
// ARCHIVE_DB_PATH / MEMORY_DB_PATH を一時ファイルに向けて呼ぶこと。

import { memoryDb, resetTree } from '../src/memory/store.js';
import { ensureV2Schema } from '../src/memory/v2/schema.js';
import { lexicalClaims, rrf, syncClaimFts, trigramMatch, claimEmbedText, allClaims } from '../src/memory/claims.js';
import { hasKind, meaningOf, setEmbedder, syncMemoryVectors } from '../src/memory/vectors.js';
import { recallPack, splitRequest } from '../src/memory/pack.js';
import { judgeQuestions } from '../src/memory/rerank.js';

const fail = (message) => { throw new Error(message); };
const equal = (actual, expected, label) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${label}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
};
const GUILD = '920000000000000001';
const TAKO = '820000000000000001';
const SABA = '820000000000000002';
const T = Date.UTC(2025, 2, 14, 5, 0, 0);

// ---- 偽の埋め込み: 文字 3-gram を 64 次元に散らして正規化 (似た文は近い) ----
const fakeVector = (text) => {
  const v = new Float32Array(64);
  const chars = [...text.replace(/^\[[^\]]*\]\s*/, '').replace(/\s+/g, '')];
  for (let i = 0; i + 3 <= chars.length; i += 1) {
    let h = 0;
    for (const c of chars.slice(i, i + 3).join('')) h = (h * 131 + c.codePointAt(0)) % 64;
    v[h] += 1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
};
setEmbedder(async (texts) => ({
  dim: 64,
  vectors: texts.map((text) => Buffer.from(fakeVector(text).buffer).toString('base64'))
}));

// ---- 準備 ----
ensureV2Schema();
resetTree(GUILD);
const d = memoryDb();
for (const table of ['v2_claims', 'v2_entities', 'memory_vectors', 'episodes']) d.prepare(`DELETE FROM ${table} WHERE guild_id = ?`).run(GUILD);
const entity = d.prepare("INSERT INTO v2_entities (guild_id, kind, key, name, category, path) VALUES (?, 'person', ?, ?, 'people', ?)");
const takoEntity = Number(entity.run(GUILD, TAKO, 'たこ', 'people/たこ').lastInsertRowid);
const sabaEntity = Number(entity.run(GUILD, SABA, 'さば', 'people/さば').lastInsertRowid);
const episode = d.prepare('INSERT INTO episodes (id, guild_id, kind, title, summary, channel_id, at_ms, end_ms, sources, importance, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
episode.run(1, GUILD, 'レスバ', 'Rust と Go の言い合い', 'たこが Rust、さばが Go を推して 1 時間言い合った → 決着せず', 'c', T, T + 1000, '[]', 2, T);
episode.run(2, GUILD, '事件', 'テトリス杯の決勝', 'さばがテトリス杯で優勝し、賞品の nitro を受け取った', 'c', T + 86_400_000, T + 86_401_000, '[]', 3, T);
const claim = d.prepare(`
  INSERT INTO v2_claims (guild_id, section_id, episode_id, ord, about_kind, about_key, category, text, type, modality, as_of, verdict, hedged, entity_id)
  VALUES (?, 1, ?, ?, 'person', ?, 'people', ?, ?, ?, ?, ?, ?, ?)
`);
let ord = 0;
const add = (epId, who, entityId, text, type, modality, verdict = 'ok', hedged = 0) =>
  Number(claim.run(GUILD, epId, ord += 1, who, text, type, modality, T, verdict, hedged, entityId).lastInsertRowid);
const rust = add(1, TAKO, takoEntity, 'Rust 派で、型の堅さを気に入っている', 'stance', 'self_report');
const rustDup = add(1, TAKO, takoEntity, 'Rust 派で型の堅さを気に入っている', 'stance', 'plain');   // ほぼ同じ文
const go = add(1, TAKO, takoEntity, 'Go の手軽さも認めている', 'stance', 'plain');
const tetris = add(2, SABA, sabaEntity, 'テトリス杯で優勝した', 'fact', 'plain');
const nitro = add(2, SABA, sabaEntity, '賞品の nitro を受け取った', 'outcome', 'plain');
const onigiri = add(null, SABA, sabaEntity, 'おにぎりを 10 個食べたと言い張る', 'trait', 'joke');
const lie = add(1, TAKO, takoEntity, 'ウソの主張: 去年優勝した', 'fact', 'plain', 'wrong');

// ---- 索引 ----
equal(allClaims(GUILD).map((c) => c.id).includes(lie), false, 'wrong の主張は索引に入れない');
const text = claimEmbedText(allClaims(GUILD).find((c) => c.id === rust));
if (!text.startsWith('[たこ / 2025-03 / 立場') || !text.endsWith('Rust 派で、型の堅さを気に入っている')) fail(`埋め込む文は「[誰 / 時期 / 種類] 本文」: ${text}`);
if (!claimEmbedText(allClaims(GUILD).find((c) => c.id === onigiri)).includes('冗談')) fail('冗談は埋め込む文にも冗談と入る');
const synced = await syncMemoryVectors(GUILD, { sleepMs: 0 });
if (!hasKind(GUILD, 'claim')) fail('主張のベクトルが振られる');
if (synced.embedded < 6) fail(`主張 6 件 + 出来事 2 件が振られる: ${synced.embedded}`);
equal(syncClaimFts(GUILD), 6, '語彙の索引は wrong 以外の主張');
equal(syncClaimFts(GUILD), 6, '変わっていなければ作り直さない');

// ---- 語彙・融合 ----
if (trigramMatch('は') !== null) fail('3 文字未満からは 3-gram が取れない');
if (!trigramMatch('テトリス杯で').includes('"テトリ"')) fail('文字 3-gram の MATCH 式');
equal(lexicalClaims(GUILD, 'テトリス杯の優勝者は？', 5)[0], tetris, '語彙で引ける');
equal(lexicalClaims(GUILD, 'ウソの主張', 5).includes(lie), false, '語彙の検索でも wrong は出ない');
equal(rrf([[1, 2, 3], [3, 1]], [1, 1]).slice(0, 2), [1, 3], '逆順位の融合 (両方に出るものが上)');
equal(splitRequest(`<@${SABA}> のこと教えて https://example.com`), { text: 'のこと教えて', mentioned: [SABA] }, 'メンションを分ける');
equal(judgeQuestions(['a', 'b']).q1.type, 'noul', '判定の質問');
equal(Object.keys(judgeQuestions(['a', 'b'])), ['gate', 'q0', 'q1'], '門 + 候補ごとの質問');

// ---- メモリパック ----
let calls = 0;
const judgeBy = (rules) => async (request, items) => {
  calls += 1;
  return { gate: /Rust|テトリス|さば|たこ/.test(request) ? 0.9 : 0.05, scores: items.map((item) => rules(request, item)) };
};
const rulesBasic = (request, item) => (/Rust/.test(request) && /Rust/.test(item) ? 0.9 : /テトリス/.test(request) && /(テトリス|nitro)/.test(item) ? 0.8 : 0.1);
const embed = async (value) => fakeVector(value);

const pack = await recallPack(GUILD, { request: 'たこは Rust をどう思ってる？' }, { embed, judge: judgeBy(rulesBasic) });
if (!pack || !pack.text) fail('関係する記憶が出る');
if (!pack.text.includes('Rust 派') || !pack.text.includes('[e1]')) fail(`主張と出典の出来事が出る: ${pack.text}`);
if (pack.text.includes('おにぎり') || pack.text.includes('ウソ')) fail('関係の低い主張・wrong は出ない');
equal((pack.text.match(/Rust 派/g) ?? []).length, 1, 'ほぼ同じ文の主張は畳む');
if (!pack.paths.has('people/たこ') || !pack.episodeIds.has(1)) fail('出した指し先を控える');
if (pack.text.length > 1800) fail('予算に収まる');

const quiet = await recallPack(GUILD, { request: 'おはよう！今日もいい天気' }, { embed, judge: judgeBy(rulesBasic) });
equal(quiet?.text, '', '記憶に触れない依頼は空 (null ではない)');

const down = await recallPack(GUILD, { request: 'Rust の話' }, { embed, judge: async () => ({ gate: null, scores: null }) });
equal(down, null, '判定モデルが使えなければ null (従来の想起へ)');

const noVector = await recallPack(GUILD, { request: 'Rust の話' }, { embed: async () => null, judge: judgeBy(rulesBasic) });
equal(noVector, null, '埋め込みが間に合わなければ null');

const mention = await recallPack(GUILD, { request: `<@${SABA}> のこと教えて` }, { embed, judge: async (_request, items) => ({ gate: 0.9, scores: items.map((item) => (/テトリス|nitro/.test(item) ? 0.9 : 0.1)) }) });
if (!mention?.text.includes('テトリス杯で優勝した')) fail(`メンションされた人の主張が候補に入る: ${mention?.text}`);

const joke = await recallPack(GUILD, { request: 'さばのおにぎりの話' }, { embed, judge: async (_request, items) => ({ gate: 0.9, scores: items.map((item) => (/おにぎり/.test(item) ? 0.9 : 0.1)) }) });
if (!joke?.text.includes('冗談')) fail(`冗談は冗談と分かる: ${joke?.text}`);

const loose = await recallPack(GUILD, { request: 'Rust Go テトリス' }, { embed, judge: async (_request, items) => ({ gate: 0.9, scores: items.map(() => 0.95) }) });
const lines = (loose?.text.match(/^- /gm) ?? []).length;
if (lines > 6 + 2) fail(`出す件数は上限まで: ${lines}`);
if (calls < 2) fail('判定は呼ばれる');
void [rustDup, go, nitro];

// 主張のある記憶では、意味検索 (memory ツール・考え中の想起) も主張を 1 つの知識として引く
const meaning = await meaningOf(GUILD, 'Rust 派で型の堅さを気に入っている', { chunkLimit: 3 });
equal(meaning?.chunks[0]?.path, 'people/たこ', '意味検索は主張を断片として返す');
equal(meaning?.chunks[0]?.episodeIds, [1], '主張の出典の出来事');
if (d.prepare("SELECT 1 FROM memory_vectors WHERE guild_id = ? AND kind = 'chunk'").get(GUILD)) fail('主張のある記憶では断片を振らない');

console.log('memory-pack checks passed');
