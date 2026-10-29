import { copiedRatio } from '../build.js';
import { memoryDb } from '../store.js';
import { arrayOf, isRecord, type JsonRecord } from '../types.js';
import {
  CATEGORIES, CLAIM_TYPES, EPISODE_KINDS, MODALITIES,
  type Category, type ClaimDraft, type ClaimType, type EpisodeDraft, type ExtractResult, type Modality, type RenderedSection
} from './types.js';
import { messageIdsOf } from './prepare.js';

// S1 抽出。1 区間を 1 回読み、出来事 (episodes) と主張 (claims) を返させる。
//
// 機械が決めるもの: 話者 (行 → author_id)・時刻・原文 (行番号 → message_id)。モデルは行番号とコードを指すだけ。
// 機械が確かめるもの: 行番号が区間内 / コードが凡例にある / ログの丸写しでない / 種類が決まった語 /
//   自己申告の根拠に本人の行がある / 発言 8 件以上の会話単位は出来事か skip がある。
// 件数の上限は置かない (出力が長さで切れたら、区間を割って読み直す)。

export const MIN_COVER_MESSAGES = Number(process.env.MEMORY_V2_COVER_MESSAGES || 8);

export const extractSystem = (known: readonly string[] = []): string => `あなたは Discord サーバーの「記憶」を書く記録係です。会話ログの 1 区間を読み、後で誰かが「あの時さ」と話題にできること、誰がどういう人かが分かることを、出来事 (episodes) と主張 (claims) として残します。ログを写すのではなく、読み取って整理します。**細かく・正確に・漏らさず**書くのが仕事です。短くまとめすぎないこと。数字・版・日付・固有名・結末・但し書き・「誰が何を言ったか」は必ず残します。

## 台本の読み方
- 先頭の [凡例] は「発言者コード=名前」。同じコードは同じアカウントの人。名前は途中で変わることがあるので、人は必ずコードで指す。
- \`### c3 (12発言)\` は会話単位 (20 分以内の連なり)。行頭の \`12|\` が行番号。\`A2→A1\` は A1 への返信、\`→[bot]「…」\` は bot への返信。
- 「(前の区間の続き)」と、番号の無い行は読むだけの文脈。根拠にしない。
- 台本に無いことは書かない。推測しない。

## 出来事 (episodes)
- 決定・作ったもの・事件・告知・企画に限らない。レスバ・議論・揉め事 (誰と誰が何で揉め、それぞれ何を主張し、どう終わったか・誰が折れたか)、ネタ・ミーム、名言・迷言、質問と回答、相談、近況、盛り上がった雑談、人間関係の変化、賭けや予言とその結末も出来事にする。
- 細かく分ける。1 つの会話単位に話題が複数あれば話題ごとに別の出来事にする。目安は発言 10〜15 件に 1 件以上。件数の上限は無い。
- kind は次から 1 つ: ${EPISODE_KINDS.join(' / ')}
- title は 30 字以内。summary は 2〜5 文で「誰が・何を・なぜ・どうなったか」。レスバなら双方の言い分と結末まで。発言の引用を並べない。
- outcome は結末・結論・決まったこと・数字 (無ければ空文字)。
- lines は根拠の行番号 (要所を 1〜8 個)。quotes は残したい決め台詞・名言・迷言・失言の行番号 (0〜3 個。原文はこちらで残すので summary に写さない)。
- entities は関わった人 (発言者コード) と、人でないもの (プロジェクト・話題・ネタ・用語。短い名前) を 1〜8 個。
- summary と outcome の中で人に触れるときは <A2> のようにコードを山括弧で囲む (名前はこちらで直す)。
- importance: 1=小ネタ 2=普通 3=重要 (決定・大きな変化・事件・大きく揉めた)。
- 発言 8 件以上の会話単位は、出来事を最低 1 件出すか、skip に理由 (挨拶のみ・コマンドだけ・スパム・意味の無い連投 など) を書く。

## 主張 (claims)
出来事から分かる「ページに書くべき 1 つのこと」。人物ページ・もののページの材料になる。
- 1 主張 = 1 つの命題。複数のことを 1 つに詰めない。細かく多く出す (上限は無い)。
- about: 主張の主体。人なら発言者コード (A3)。人でなければ短い名前 (プロジェクト・話題・ネタ・用語・出来事)。同じものは同じ名前で書く。${known.length ? '下の「既知のページ名」にあるものは、その名前を使う。' : ''}
- cat: about が人でないときの分類。${CATEGORIES.join(' / ')} から 1 つ (projects=作っているもの / topics=話題・知見 / events=大きな出来事 / debates=レスバ・揉め事 / culture=ネタ・ミーム・名言 / server=ルール・用語 / others)。
- type: stance=立場・意見・好み / trait=性格・口癖・傾向 / skill=得意・できること・作った・持っているもの / relation=人との関係 (仲が良い・よく揉める) / fact=事実・状況・経緯 / definition=用語・ネタ・ものの説明や由来 / outcome=結末・決定・結果
- modality (話の種類。迷ったら下のほうを選ぶ): plain=ログから確かな事実・本人の立場 / self_report=本人が自分について言った (本人の行が根拠) / hearsay=他人が言った・伝聞 / joke=冗談・皮肉・煽り・ネタ / hypothetical=仮定・予想・推測・「もし〜」 / roleplay=キャラを演じている・ごっこ遊び。**冗談や仮定を事実・性格にしない**。
- text に書く固有名・数字・理由・場所は、lines にあるものだけ。lines に無いことで補わない (名前の漢字・正式名称を推測しない)。
- 「よく・いつも・口癖・癖・常連・定番・〜しがち」は、複数回の根拠 (lines が別々の発言) があるときだけ使う。1 回なら「〜と言った」「〜していた」。
- 仮定・提案・予定 (〜したい・〜しよう・〜するつもり) は、した・している と書かない。「〜したいと言った」「〜する予定」と書く。
- 主体は、その行を書いた人。別の人が書いた行を、主体の発言にしない (返信の相手と取り違えない)。
- text: 時期は書かない (時刻は機械が付ける)。「〜派」「〜が口癖」「〜を作った」「〜と〜は仲が良い」のように、ページの説明として書く。ログの写し (「〜と言った」の羅列) にしない。hearsay / joke は「〜と言っていた」「冗談で〜」と明示する。他の人に触れるときは <A2> のようにコードを山括弧で囲む。
- attrs: 主張に出てくる数値・版・日付・固有名・URL のうち重要なものを {"数":"3台","版":"v2.1"} のように (任意)。
- lines: 根拠の行番号 (1〜4 個)。self_report は本人の行を含める。
- episode: この主張が属する episodes の番号 (0 始まり)。
- 立場が変わったと読めるときは、その時点の立場をそれぞれ別の主張にする。
${known.length ? `\n## 既知のページ名 (同じものを指すときはこの名前を使う。無ければ新しい名前を付けてよい)\n${known.join(' / ')}\n` : ''}
## 書かないもの
パスワード・連絡先・住所。ログに無い推測。

出力は JSON だけ:
{"episodes":[{"conv":"c2","kind":"レスバ","title":"Go と Rust どっちが上か","summary":"<A1> が Go の手軽さを推し、<A2> が Rust の型安全を譲らず 1 時間言い合った。最後は <A2> の「ビルド待ちも思考時間」で笑って終わった。","outcome":"決着せず、<A1> がコンパイル時間の短さだけ認めた","lines":[3,8,15],"quotes":[15],"entities":["A1","A2","Go vs Rust"],"importance":2}],
 "claims":[{"about":"A2","text":"Rust 派で、型安全の話になると引かない","type":"stance","modality":"plain","attrs":{},"lines":[8,15],"episode":0},{"about":"Go vs Rust","cat":"debates","text":"<A1> と <A2> がたびたび蒸し返す言語論争","type":"fact","modality":"plain","attrs":{},"lines":[3,8],"episode":0}],
 "skip":[{"conv":"c4","reason":"挨拶のみ"}]}
書くことが無ければ {"episodes":[],"claims":[],"skip":[{"conv":"c1","reason":"…"}]}。`;

const flatText = (text: string): string => text.replace(/^\d+\|/gm, '').replace(/\s+/g, '');

export function extractUser(section: RenderedSection, { more }: { more?: readonly string[] } = {}): string {
  const big = section.units.filter((unit) => unit.messages >= MIN_COVER_MESSAGES).map((unit) => `${unit.conv}(${unit.messages})`);
  return [
    `区間: ${section.label} / 行 1〜${section.lineEnd - 1} / 会話単位 ${section.units.length} 個`,
    section.text,
    '---',
    more?.length
      ? `前回の出力で次の会話単位が抜けていました: ${more.join(', ')}。台本にはその会話単位だけを載せています。それぞれ出来事 (と主張) を出すか、skip に理由を書いてください。`
      : big.length ? `発言 ${MIN_COVER_MESSAGES} 件以上の会話単位: ${big.join(', ')} (それぞれ出来事を出すか skip に理由を書く)` : ''
  ].filter(Boolean).join('\n');
}

// ---- 検査 ------------------------------------------------------------------

const str = (value: unknown, max: number): string => String(value ?? '').replace(/\s*\n\s*/g, ' ').trim().slice(0, max);
const ints = (value: unknown): number[] => (Array.isArray(value) ? arrayOf(value) : [value])
  .map((item) => (typeof item === 'string' && /^\d+$/.test(item.trim()) ? Number(item) : item))
  .filter((item): item is number => typeof item === 'number' && Number.isInteger(item));

/** 「なし」「特になし」など、結末が無いという意味だけの文。 */
const emptyOutcome = (text: string): boolean => /^(特に)?(なし|無し|不明|未定|-|ー|—|n\/a)[。.]?$/i.test(text.trim());

const asKind = (raw: unknown): string => {
  const text = str(raw, 16);
  if ((EPISODE_KINDS as readonly string[]).includes(text)) return text;
  return EPISODE_KINDS.find((kind) => kind !== 'その他' && text.includes(kind)) ?? 'その他';
};

const asCategory = (raw: unknown): Category => (CATEGORIES as readonly string[]).includes(String(raw)) ? raw as Category : 'others';

/** 名前 → コード (凡例の名前が一意のとき)。モデルがコードでなく名前で書いたときの救済。 */
function nameIndex(section: RenderedSection): Map<string, string> {
  const seen = new Map<string, string | null>();
  for (const [code, label] of section.labels) {
    const key = label.toLowerCase();
    seen.set(key, seen.has(key) ? null : code);
  }
  return new Map([...seen].filter((entry): entry is [string, string] => entry[1] !== null));
}

const CODE = /^A\d+$/;

export interface ExtractDropped extends Record<string, number> {
  noSource: number;
  copied: number;
  badShape: number;
  duplicate: number;
  noEpisode: number;
}

/** モデルの出力を検査して、使える形にする。形が違えば投げる。 */
export function normalizeExtract(section: RenderedSection, json: unknown): ExtractResult {
  if (!isRecord(json) || (!Array.isArray(json.episodes) && !Array.isArray(json.claims))) {
    throw Object.assign(new Error('extract output has neither episodes nor claims'), { code: 'BAD_OUTPUT' });
  }
  const dropped: ExtractDropped = { noSource: 0, copied: 0, badShape: 0, duplicate: 0, noEpisode: 0 };
  const flat = flatText(section.text);
  const byName = nameIndex(section);
  const validLines = (value: unknown): number[] => [...new Set(ints(value).filter((n) => section.lines.has(n)))].sort((a, b) => a - b);
  const personCode = (raw: string): string | null => (CODE.test(raw) && section.authors.has(raw) ? raw : byName.get(raw.toLowerCase()) ?? null);

  const episodes: EpisodeDraft[] = [];
  const kept = new Map<number, number>();   // 出力の添字 → episodes の添字
  const titles = new Set<string>();
  arrayOf(json.episodes).forEach((raw, index) => {
    if (!isRecord(raw)) { dropped.badShape += 1; return; }
    const lines = validLines(raw.lines);
    const title = str(raw.title, 60);
    const summary = str(raw.summary, 900);
    if (!title || !summary) { dropped.badShape += 1; return; }
    if (lines.length === 0) { dropped.noSource += 1; return; }
    if (copiedRatio(summary, flat) > 0.8) { dropped.copied += 1; return; }
    const key = `${title}|${lines[0]}`;
    if (titles.has(key)) { dropped.duplicate += 1; return; }
    titles.add(key);
    const entities = [...new Set(arrayOf(raw.entities).map((item) => str(item, 48).replace(/^\[\[|\]\]$/g, '')).filter(Boolean)
      .map((item) => personCode(item) ?? item))].slice(0, 8);
    kept.set(index, episodes.length);
    episodes.push({
      conv: section.lines.get(lines[0] as number)?.conv ?? null,
      kind: asKind(raw.kind), title: title.slice(0, 40), summary, outcome: emptyOutcome(str(raw.outcome, 400)) ? '' : str(raw.outcome, 400), lines,
      quotes: validLines(raw.quotes).slice(0, 3), entities, related: [],
      importance: Math.min(3, Math.max(1, ints(raw.importance)[0] ?? 2))
    });
  });

  const claims: ClaimDraft[] = [];
  const seen = new Set<string>();
  arrayOf(json.claims).forEach((raw) => {
    if (!isRecord(raw)) { dropped.badShape += 1; return; }
    const text = str(raw.text, 500).replace(/^[-・*\s]+/, '');
    const aboutRaw = str(raw.about, 60).replace(/^\[\[|\]\]$/g, '');
    if (text.length < 4 || !aboutRaw) { dropped.badShape += 1; return; }
    const lines = validLines(raw.lines);
    if (lines.length === 0) { dropped.noSource += 1; return; }
    if (copiedRatio(text, flat) > 0.8) { dropped.copied += 1; return; }
    const code = personCode(aboutRaw);
    const type = (CLAIM_TYPES as readonly string[]).includes(String(raw.type)) ? raw.type as ClaimType : 'fact';
    let modality = (MODALITIES as readonly string[]).includes(String(raw.modality)) ? raw.modality as Modality : 'plain';
    // 自己申告の根拠に本人の行が無ければ、伝聞として扱う
    if (modality === 'self_report' && code && !lines.some((n) => section.lines.get(n)?.code === code)) modality = 'hearsay';
    const about = code ?? aboutRaw;
    const key = `${about}|${text.replace(/\s+/g, '')}`;
    if (seen.has(key)) { dropped.duplicate += 1; return; }
    seen.add(key);
    const attrs: Record<string, string> = {};
    if (isRecord(raw.attrs)) for (const [name, value] of Object.entries(raw.attrs).slice(0, 6)) {
      const v = str(value, 80);
      if (v) attrs[str(name, 16)] = v;
    }
    let episode: number | null = null;
    const given = ints(raw.episode)[0];
    if (given !== undefined && kept.has(given)) episode = kept.get(given) as number;
    if (episode === null) {
      // 出来事の番号が無い・消えたとき: 根拠の行がいちばん重なる出来事へ
      let best = 0;
      episodes.forEach((ep, i) => {
        const overlap = lines.filter((n) => ep.lines.includes(n)).length;
        if (overlap > best) { best = overlap; episode = i; }
      });
    }
    if (episode === null) { dropped.noEpisode += 1; return; }
    claims.push({
      about, aboutKind: code ? 'person' : 'thing', category: asCategory(raw.cat), text, type, modality, attrs, lines, episode
    });
  });

  const skips = arrayOf(json.skip).filter(isRecord)
    .map((item: JsonRecord) => ({ conv: str(item.conv, 12), reason: str(item.reason, 80) }))
    .filter((item) => item.conv && item.reason);
  return { episodes, claims, skips, dropped };
}

/** 発言 MIN_COVER_MESSAGES 件以上の会話単位で、出来事も skip も無いもの。 */
export function uncoveredConvs(section: RenderedSection, results: readonly ExtractResult[]): string[] {
  const covered = new Set<string>();
  for (const result of results) {
    for (const ep of result.episodes) for (const n of ep.lines) { const conv = section.lines.get(n)?.conv; if (conv) covered.add(conv); }
    for (const skip of result.skips) covered.add(skip.conv);
  }
  return section.units.filter((unit) => unit.messages >= MIN_COVER_MESSAGES && !covered.has(unit.conv)).map((unit) => unit.conv);
}

/** 長い区間なのに何も返ってこなければ、読めていない (空の JSON を返す provider の対策)。 */
export function checkExtract(section: RenderedSection, json: unknown): void {
  const result = normalizeExtract(section, json);
  if (result.episodes.length === 0 && result.claims.length === 0 && result.skips.length === 0 && section.range.chars >= 3000) {
    throw Object.assign(new Error('empty extract output for a long section'), { code: 'BAD_OUTPUT' });
  }
}

// ---- 反映 ------------------------------------------------------------------

/** 出力の中の発言者コード (<A2> でも A2 でも) を凡例の名前に直す。凡例に無いコードはそのまま。 */
const nameCodes = (text: string, section: RenderedSection): string =>
  text.replace(/<(A\d{1,3})>|(?<![A-Za-z0-9_])(A\d{1,3})(?![A-Za-z0-9_])/g, (match, bracketed: string | undefined, bare: string | undefined) =>
    section.labels.get(bracketed ?? bare ?? '') ?? match);

/** 区間の抽出結果を消す (読み直すとき)。 */
export function clearSection(sectionId: number): void {
  const d = memoryDb();
  d.transaction(() => {
    d.prepare('DELETE FROM v2_claim_evidence WHERE claim_id IN (SELECT id FROM v2_claims WHERE section_id = ?)').run(sectionId);
    d.prepare('DELETE FROM v2_episode_messages WHERE episode_id IN (SELECT id FROM v2_episodes WHERE section_id = ?)').run(sectionId);
    d.prepare('DELETE FROM v2_claims WHERE section_id = ?').run(sectionId);
    d.prepare('DELETE FROM v2_episodes WHERE section_id = ?').run(sectionId);
  })();
}

export interface ApplyStats { episodes: number; claims: number }

/**
 * 検査済みの結果 (1 つ以上の呼び出し分) を、区間の出来事・主張として保存する。
 * 時刻・原文は行番号から機械が決める。1 トランザクション。
 */
export function applyExtract(guildId: string, sectionId: number, section: RenderedSection, results: readonly ExtractResult[]): ApplyStats {
  const d = memoryDb();
  const insertEpisode = d.prepare(`
    INSERT INTO v2_episodes (guild_id, section_id, ord, conv, kind, title, summary, outcome, importance, channel_id, at_ms, end_ms, entities)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMessage = d.prepare('INSERT OR IGNORE INTO v2_episode_messages (episode_id, message_id, role) VALUES (?, ?, ?)');
  const insertClaim = d.prepare(`
    INSERT INTO v2_claims (guild_id, section_id, episode_id, ord, about_kind, about_key, category, text, type, modality, attrs, as_of)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertEvidence = d.prepare('INSERT OR IGNORE INTO v2_claim_evidence (claim_id, message_id) VALUES (?, ?)');
  const stats: ApplyStats = { episodes: 0, claims: 0 };
  let episodeOrd = 0;
  let claimOrd = 0;
  d.transaction(() => {
    clearSection(sectionId);
    for (const result of results) {
      const ids: number[] = [];
      for (const ep of result.episodes) {
        const infos = ep.lines.map((n) => section.lines.get(n)).filter((info): info is NonNullable<typeof info> => Boolean(info));
        const atMs = Math.min(...infos.map((info) => info.firstMs));
        const endMs = Math.max(...infos.map((info) => info.lastMs));
        const entities = ep.entities.map((value) => (CODE.test(value) && section.authors.has(value)
          ? { k: 'person', v: section.authors.get(value) as string } : { k: 'thing', v: value }));
        const id = Number(insertEpisode.run(guildId, sectionId, episodeOrd, ep.conv, ep.kind, nameCodes(ep.title, section),
          nameCodes(ep.summary, section), nameCodes(ep.outcome, section), ep.importance, section.range.channelId, atMs, endMs,
          JSON.stringify(entities)).lastInsertRowid);
        episodeOrd += 1;
        ids.push(id);
        for (const messageId of messageIdsOf(section, ep.lines)) insertMessage.run(id, messageId, 'core');
        for (const messageId of messageIdsOf(section, ep.quotes)) insertMessage.run(id, messageId, 'quote');
        stats.episodes += 1;
      }
      for (const claim of result.claims) {
        const infos = claim.lines.map((n) => section.lines.get(n)).filter((info): info is NonNullable<typeof info> => Boolean(info));
        const asOf = Math.max(...infos.map((info) => info.lastMs));
        const aboutKey = claim.aboutKind === 'person' ? section.authors.get(claim.about) as string : claim.about;
        const id = Number(insertClaim.run(guildId, sectionId, claim.episode === null ? null : ids[claim.episode] ?? null, claimOrd,
          claim.aboutKind, aboutKey, claim.category, nameCodes(claim.text, section), claim.type, claim.modality,
          JSON.stringify(claim.attrs), asOf).lastInsertRowid);
        claimOrd += 1;
        for (const messageId of messageIdsOf(section, claim.lines)) insertEvidence.run(id, messageId);
        stats.claims += 1;
      }
    }
  })();
  return stats;
}
