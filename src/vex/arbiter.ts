// 自発参加の審判。判定モデル (安い一次ふるい) を通った場面を、小さな LLM が実際の会話の履歴と記憶の概要を読んで決める。
//
// 判定モデルは「入るべきか」の見分けが弱く (docs/vex.md: AUC 0.66、実際の履歴で入る場面の 4 分の 3 は的外れ)、
// 質問や文脈を足しても良くならなかった。そこで、ふるいを通った場面だけ、会話の流れを読める LLM に聞く。
// 費用は 1 回 $0.0003 ほどで、ふるいを通る分だけなので 1 日数円。agent を走らせる前に止めるので、的外れな返事も出ない。
//
// 2 つの場面:
//   ambient       誰にも呼ばれていない会話に、入ってよいか (役に立つ・本当に面白いときだけ)
//   continuation  直前に自分が答えた相手の、名前の無い続きの発言が、自分に向いているか
import { AGENT_ENGINES, DEFAULT_AGENT_ENGINE, agentFallbackModels, agentProviderPrefs } from '../agent/engines.js';
import { requestModel } from '../ai/provider.js';
import { getNode } from '../memory/store.js';

export type ArbiterKind = 'ambient' | 'continuation';

export interface Verdict {
  join: boolean;
  reason: string;
  costUsd: number;
  latencyMs: number;
  model: string;
}

export interface ArbiterInput {
  guildId: string;
  kind: ArbiterKind;
  /** 会話の古い順の行 (`名前: 本文`)。最後が判定する発言。 */
  lines: readonly string[];
  /** 判定する発言の持ち主 (continuation で、自分が答えた相手)。 */
  speaker?: string | null;
}

const RUBRIC_AMBIENT = [
  'あなたは Discord サーバーの常連 AI「vex」。いま、誰にも呼ばれていない会話に、自分から口を挟んでよいかを決める。',
  '口を挟むのは、最後の数件の発言の中に、次のどれかがあるときだけ:',
  '1. vex・bot・AI に向けた呼びかけ・質問・指示 (名前が無くても、AI に向けて言っているもの)。',
  '2. 誰かが答えを求めている質問・頼みごと (疑問形・「教えて」「知ってる？」など) で、まだ誰も答えておらず、vex の記憶か調べもので答えられる。',
  '3. 明らかな事実や技術の間違いがあり、訂正できる。',
  '',
  '次は入らない: 独り言・愚痴・状況の実況 (「PC が壊れた」「後で試す」)・感想・同意・笑い・挨拶・人どうしの議論の途中・',
  'すでに誰かが答えた・本人が助けを求めていない話・リンクの貼り付けだけ。',
  '「助言できる」「面白いことが言える」だけでは入らない (求められていない口出しは邪魔)。迷ったら入らない。',
  '',
  '出力は JSON 1 つだけ: {"ask": "入る根拠にした発言を 30 字以内で引用 (入らないなら空)", "join": true か false}',
  'join を true にするなら、ask に実際にある発言の引用が要る。引用できないなら false。'
].join('\n');

const RUBRIC_CONTINUATION = [
  'あなたは Discord サーバーの常連 AI「vex」。直前にあなたが答えた相手が、名前もメンションも付けずに発言を続けた。',
  'その発言が、あなたに向けた続き (返事・つっこみ・続きの質問・「は？」のような反応) かを決める。',
  '',
  '向いている: あなたの答えへの反応や、あなたに続けて聞いている内容。',
  '向いていない: 他の人への話しかけ・独り言・別の話題に移った・相槌だけ・人どうしの会話に戻った。迷ったら向いていない。',
  '',
  '出力は JSON 1 つだけ: {"ask": "向けられたと判断した根拠の発言を 30 字以内で引用 (向いていないなら空)", "join": true か false}'
].join('\n');

const OVERVIEW_TTL_MS = 10 * 60_000;
const overviews = new Map<string, { at: number; text: string }>();

/** 記憶の概要 (根のページの本文の頭)。毎回同じ文面なのでキャッシュする。記憶が無ければ空。 */
export function memoryOverview(guildId: string, now = Date.now()): string {
  const hit = overviews.get(guildId);
  if (hit && now - hit.at < OVERVIEW_TTL_MS) return hit.text;
  let text = '';
  try { text = (getNode(guildId, '')?.body ?? '').trim().slice(0, 1200); } catch { /* 記憶が読めなくても審判は動く */ }
  overviews.set(guildId, { at: now, text });
  return text;
}

/** 審判の答え (JSON) を読む。読めない・根拠 (ask) の引用が無い入るは、「入らない」。reason は根拠の引用。 */
export function parseVerdict(text: unknown): { join: boolean; reason: string } {
  const match = String(text ?? '').match(/\{[\s\S]*?\}/);
  if (!match) return { join: false, reason: '答えを読めない' };
  try {
    const value = JSON.parse(match[0]) as { join?: unknown; ask?: unknown };
    const ask = String(value.ask ?? '').trim().slice(0, 60);
    if (value.join === true && ask) return { join: true, reason: ask };
    return { join: false, reason: value.join === true ? '根拠の引用が無い' : ask };
  } catch {
    return { join: false, reason: '答えを読めない' };
  }
}

type Request = typeof requestModel;

/** 審判に聞く。失敗したら null (呼び出し側は入らない)。 */
export async function arbitrate(input: ArbiterInput, { request = requestModel, now = Date.now }: { request?: Request; now?: () => number } = {}): Promise<Verdict | null> {
  const started = now();
  const model = AGENT_ENGINES[DEFAULT_AGENT_ENGINE];
  const overview = memoryOverview(input.guildId, started);
  const user = [
    overview ? `## vex の記憶の概要 (vex が知っていること)\n${overview}\n` : '',
    '## 会話 (古い順。最後の行が判定する発言)',
    ...input.lines,
    input.kind === 'continuation' && input.speaker ? `\n(最後の発言は ${input.speaker}。直前に vex が答えた相手)` : ''
  ].filter(Boolean).join('\n');
  try {
    const response = await request({
      model, fallbackModels: agentFallbackModels(model), fallbackStatuses: [429], providerPrefs: agentProviderPrefs(model),
      messages: [{ role: 'system', content: input.kind === 'ambient' ? RUBRIC_AMBIENT : RUBRIC_CONTINUATION }, { role: 'user', content: user }],
      maxOutputTokens: 500, timeoutMs: 15_000, retries: 0, role: 'chat', guildId: input.guildId,
      reasoning: { effort: 'low' }
    });
    const content = response.choices[0]?.message.content;
    const verdict = parseVerdict(content);
    const cost = Number((response.usage as { cost?: unknown } | undefined)?.cost ?? 0);
    return { ...verdict, costUsd: Number.isFinite(cost) ? cost : 0, latencyMs: now() - started, model };
  } catch (error) {
    console.warn(`vex: arbiter failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
