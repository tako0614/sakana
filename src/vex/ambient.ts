// 自発参加: だれにも呼ばれていない会話に、役に立つときだけ自分から入る。
//
// 流れ
//   人の発言 → チャンネルごとのタイマーを張り直す (会話が続いている間は判定しない)
//   QUIET_MS のあいだ静かだった → 門 (許可・冷却・上限・予算) → 判定モデル → 閾値
//   → 入る前にもう一度、最後の発言が自分の見ているものか確かめる → agent に渡す
//
// 外へ出る口は join だけ。bot の発言・別の bot の発言が来たらタイマーを捨てる (輪を作らない)。
// 判定が壊れても入らないだけで、明示的に「vex」と呼ばれたときの動きには関わらない。
import { isBareAck } from '../agent/ack.js';
import { nameHandling } from './call.js';
import { vexConfig, type VexConfig } from './config.js';
import { decide as decideDefault, type Decision } from './decide.js';
import { decisionSpend, joinedInChannel, recordVex, type VexRecord } from './ledger.js';
import { arbitrate as arbitrateDefault, type ArbiterInput, type Verdict } from './arbiter.js';
import { buildVexState, cleanLine, type VexLine } from './questions.js';

/** 判定に必要なぶんだけの Discord の発言。discord.js の Message はこれを満たす。 */
export interface VexMessage {
  id: string;
  guildId: string | null;
  channelId: string;
  content: string;
  createdTimestamp: number;
  author: { id: string; bot: boolean; username: string; displayName?: string };
  member?: { displayName?: string } | null;
  webhookId?: string | null;
  reference?: { messageId?: string | null } | null;
  mentions: { users: { size: number; has(id: string): boolean } };
  attachments?: { size: number };
  channel: VexChannel;
}

export interface VexChannel {
  id: string;
  name?: string;
  nsfw?: boolean;
  messages: { fetch(options: { limit: number; before?: string }): Promise<Iterable<VexMessage> | { values(): Iterable<VexMessage> }> };
}

export type AmbientOutcome = 'sent' | 'passed' | 'moved_on' | 'failed';

export interface AmbientJoin {
  /** 直前に自分が答えた相手の続きの発言への返事 (判定モデルは通っていない)。前置きが変わる。 */
  continuation?: boolean;
  /** 送る直前に呼ぶ。false なら会話が進んだので送らない。 */
  stillLatest(): Promise<boolean>;
  /** どうなったか (記録用)。 */
  report(outcome: AmbientOutcome): void;
}

export interface AmbientDeps {
  config?: VexConfig;
  selfId(): string | null;
  /** その場所で話せるか (権限)。 */
  canSpeak(message: VexMessage): boolean | Promise<boolean>;
  decide?: (state: string) => Promise<Decision | null>;
  /** 審判 (LLM)。省略すると本物。失敗は null (入らない)。 */
  arbitrate?: (input: ArbiterInput) => Promise<Verdict | null>;
  /**
   * agent に渡して入る。自発参加 (join あり) は誰にも呼ばれていない場面、
   * 名前が出た発言 (join が null) は呼ばれた場面として、普通の依頼と同じに答える。
   */
  join(message: VexMessage, join: AmbientJoin | null): Promise<void>;
  now?: () => number;
}

/** 自分が答えてから、これ以内なら相手の次の発言は「続き」。 */
const CONTINUE_MS = 150_000;
/** 10 分の間に自分が出せる発言の数がこれに届いたら、続きとしては入らない (輪にならないように)。 */
const CONTINUE_MAX = 4;
/** 審判に見せる直近の発言の数 (判定モデルは contextMessages 件。審判は会話の流れを読むので多め)。 */
const ARBITER_LINES = 10;
/** 入る直前に、後から来てよい発言の数。 */
const LATER_LIMIT = 2;
const HOUR = 3_600_000;
const DAY = 86_400_000;

function asArray(found: Awaited<ReturnType<VexChannel['messages']['fetch']>>): VexMessage[] {
  const values = 'values' in found && typeof found.values === 'function' ? [...found.values()] : [...(found as Iterable<VexMessage>)];
  return values.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

export class AmbientJudge {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly running = new Set<string>();
  /** チャンネルごとに、最後に発言した人 (自分が答える相手の目安)。 */
  private readonly lastHuman = new Map<string, string>();
  /** チャンネルごとに、自分が最近発言した時刻と、そのとき話していた相手。 */
  private readonly own = new Map<string, { times: number[]; target: string | null }>();
  private readonly config: VexConfig;
  private readonly now: () => number;
  private readonly decide: (state: string) => Promise<Decision | null>;
  private readonly arbitrate: (input: ArbiterInput) => Promise<Verdict | null>;

  constructor(private readonly deps: AmbientDeps) {
    this.config = deps.config ?? vexConfig;
    this.now = deps.now ?? Date.now;
    this.decide = deps.decide ?? ((state) => decideDefault(state, { config: this.config }));
    this.arbitrate = deps.arbitrate ?? ((input) => arbitrateDefault(input));
  }

  get enabled(): boolean {
    return this.config.ambient && this.config.channels.size > 0;
  }

  /**
   * 自分が発言した。直前に発言していた人を「いま話している相手」として覚える
   * (メンションでも名前でも自発でも同じ。経過表示の `-# thinking` は答えではないので数えない)。
   */
  noteOwn(channelId: string, content = '', at = this.now()): void {
    if (/^\s*-#\s/.test(content)) return;
    const entry = this.own.get(channelId) ?? { times: [], target: null };
    entry.times = [...entry.times.filter((time) => at - time < 10 * 60_000), at];
    entry.target = this.lastHuman.get(channelId) ?? null;
    this.own.set(channelId, entry);
  }

  /**
   * 直前に自分が答えた相手の、続きの発言か。名前もメンションも無い「は？」「自我を君に与えた」のような発言を、
   * 冷却や静かさの待ちで逃さないための判定 (実際の履歴で、答えた直後の続きが冷却で止まっていた)。
   */
  isContinuation(message: VexMessage): boolean {
    const own = this.own.get(message.channelId);
    const last = own?.times.at(-1);
    if (!own || last === undefined) return false;
    const now = message.createdTimestamp;
    if (own.target !== message.author.id || now - last > CONTINUE_MS || now < last) return false;
    return own.times.filter((time) => now - time < 10 * 60_000).length < CONTINUE_MAX;
  }

  /** 会話が動いた (bot の発言・呼ばれた・上限に届いた)。待っている判定は捨てる。 */
  cancel(channelId: string): void {
    const timer = this.timers.get(channelId);
    if (timer) clearTimeout(timer);
    this.timers.delete(channelId);
  }

  /**
   * 人の発言を見た。
   *   - 名前 (vex) が出ていれば、確定では答えず、短い待ちのあと判定モデルに文脈で決めさせる (どのチャンネルでも)
   *   - それ以外は、許可チャンネルで静かになったら判定する
   */
  observe(message: VexMessage): void {
    if (!message.guildId) return;
    const continuation = this.config.ambient && !message.author.bot && this.isContinuation(message);
    if (!message.author.bot) this.lastHuman.set(message.channelId, message.author.id);
    const named = nameHandling(message.content, this.config) === 'judge';
    if (named && this.worthJudging(message, true)) {
      // 続く発言や bot の発言では捨てない: 呼ばれた発言は、会話が進んでも判定する。
      // 自発参加の判定とは重ねない (同じ発言に 2 回入らない)
      this.cancel(message.channelId);
      const timer = setTimeout(() => {
        this.judge(message, { named: true }).catch((error: unknown) => {
          console.error('vex: name judgement failed:', error);
        });
      }, this.config.nameDelayMs);
      timer.unref?.();
      return;
    }
    // 自分が答えた相手の続きは、許可チャンネルでなくても・静かになるのを待たずに、短い待ちのあとで見る
    if (continuation) {
      this.cancel(message.channelId);
      if (!this.worthJudging(message, false, true)) return;
      const timer = setTimeout(() => {
        this.timers.delete(message.channelId);
        this.judge(message, { continuation: true }).catch((error: unknown) => {
          console.error('vex: continuation failed:', error);
        });
      }, this.config.nameDelayMs);  // 続けて書き込む人の最後の発言に答える (名前が出たときと同じ短い待ち)
      timer.unref?.();
      this.timers.set(message.channelId, timer);
      return;
    }
    if (!this.enabled || !this.config.channels.has(message.channelId)) return;
    this.cancel(message.channelId);
    if (!this.worthJudging(message)) return;

    const timer = setTimeout(() => {
      this.timers.delete(message.channelId);
      this.judge(message).catch((error: unknown) => {
        console.error('vex: ambient judgement failed:', error);
      });
    }, this.config.quietMs);
    timer.unref?.();
    this.timers.set(message.channelId, timer);
  }

  /** 判定に回す価値がある発言か (安い門。ここで落とせば API も呼ばない)。 */
  worthJudging(message: VexMessage, named = false, continuation = false): boolean {
    if (message.author.bot || message.webhookId) return false;
    if (message.channel.nsfw || /nsfw/i.test(message.channel.name ?? '')) return false;
    // 名前が出ていれば、短くても (vex だけ)・返信でも・他の人へのメンションつきでも判定する
    if (named) return true;
    const text = String(message.content ?? '').trim();
    // URL・カスタム絵文字・メンションを除いた、本当の文字で見る。リンクを貼っただけの発言には入らない
    // (YouTube の URL だけの発言に入って、見ていない動画の的外れな返事をした)。続きの発言は「は？」のように短い
    const plain = text.replace(/https?:\/\/\S+/g, '').replace(/<a?:\w+:\d+>/g, '').replace(/<[@#&][!&]?\d+>/g, '').trim();
    if (plain.length < (continuation ? 2 : 6)) return false;
    if (isBareAck(text)) return false;
    // メンションは別の人宛て。返信 (Discord の返信機能) は除かない: 雑談では発言の半分近くが返信で、
    // 除くと会話の流れに入れなくなる (入るときは、その発言への返信として送るので宛先は分かる)
    const self = this.deps.selfId();
    if (message.mentions.users.size > 0 && !(self && message.mentions.users.size === 1 && message.mentions.users.has(self))) return false;
    return true;
  }

  private record(message: VexMessage, record: Omit<VexRecord, 'guildId' | 'channelId' | 'messageId'>): void {
    try {
      recordVex({ guildId: message.guildId ?? '', channelId: message.channelId, messageId: message.id, ...record }, this.now());
    } catch (error) {
      console.error('vex: could not write the ledger:', error);
    }
  }

  /**
   * 台帳から見た門。通れなければ理由を返す。
   * 名前が出た発言には冷却と 1 時間の上限は掛けない (呼ばれて続けて話すのを止めない)。判定費用の上限だけは掛ける。
   */
  gate(channelId: string, named = false): string | null {
    const now = this.now();
    if (!named) {
      const lastDay = joinedInChannel(channelId, now - DAY);
      const hour = joinedInChannel(channelId, now - HOUR);
      if (lastDay.last !== null && now - lastDay.last < this.config.cooldownMs) return 'cooldown';
      if (hour.count >= this.config.maxPerHour) return 'hourly_cap';
    }
    if (decisionSpend(now - DAY) >= this.config.dailyDecisionUsd) return 'daily_budget';
    return null;
  }

  async judge(message: VexMessage, { named = false, continuation = false }: { named?: boolean; continuation?: boolean } = {}): Promise<void> {
    const channelId = message.channelId;
    // 自発参加はチャンネルごとに 1 つ。名前が出た発言は発言ごと (別々の人が続けて呼んでも落とさない)
    const key = named ? `named:${message.id}` : channelId;
    if (this.running.has(key)) return;
    this.running.add(key);
    try {
      const me = await this.deps.canSpeak(message);
      if (!me) return this.record(message, { action: 'skipped', note: 'cannot_speak' });

      // 名前が出た・続きの発言には、冷却と 1 時間の上限は掛けない (判定費用の上限だけ)
      const closed = this.gate(channelId, named || continuation);
      if (closed) return this.record(message, { action: 'skipped', note: closed });

      // 名前が出た発言は、その発言までを見せる (後から来た発言は判定の材料にしない)。
      // 自発参加は、最後の発言のままであることを確かめる
      const recent = named
        ? [...asArray(await message.channel.messages.fetch({ limit: Math.max(1, this.config.contextMessages - 1), before: message.id })), message]
        : asArray(await message.channel.messages.fetch({ limit: Math.max(this.config.contextMessages, ARBITER_LINES) }));
      const latest = recent.at(-1);
      if (!latest || latest.id !== message.id) return this.record(message, { action: 'moved_on', note: 'before_decision' });

      const self = this.deps.selfId();
      const names = new Map<string, string>();
      for (const entry of recent) names.set(entry.author.id, entry.member?.displayName ?? entry.author.displayName ?? entry.author.username);
      const who = (entry: VexMessage): string => (entry.author.id === self ? 'vex' : (entry.member?.displayName ?? entry.author.displayName ?? entry.author.username));
      // 審判に見せる、会話の流れ (直近の ARBITER_LINES 件)
      const arbiterLines = recent.slice(-ARBITER_LINES).map((entry) => `${who(entry)}: ${cleanLine(entry.content, { botId: self, names })}`).filter((line) => !/: $/.test(line));

      if (continuation) {
        // 判定モデルは通さない: 質問の基準に「vex が直前に話したばかり → いいえ」があり、続きの発言は必ず落ちる。
        // 続きかどうかは履歴 (直前に答えた相手の、時間内の発言) で絞ってあり、審判がその発言が自分に向いているかを決める。
        // 審判を切ってあれば、そのまま入り、言うことが無ければ agent が (skip) で黙る
        if (!this.config.arbiter) return this.enter(message, { action: 'joined', note: 'continuation' }, true);
        const verdict = await this.arbitrate({ guildId: message.guildId ?? '', kind: 'continuation', lines: arbiterLines, speaker: who(message) });
        if (!verdict) return this.record(message, { action: 'error', note: 'arbiter_failed' });
        const arb = { model: verdict.model, costUsd: verdict.costUsd, latencyMs: verdict.latencyMs };
        if (!verdict.join) return this.record(message, { ...arb, action: 'below', note: `arbiter:continuation: ${verdict.reason}`.slice(0, 120) });
        return this.enter(message, { ...arb, action: 'joined', note: 'continuation' }, true);
      }

      const now = this.now();
      const lines: VexLine[] = recent.slice(-this.config.contextMessages).map((entry) => ({
        author: entry.author.id === self ? 'vex' : (entry.member?.displayName ?? entry.author.displayName ?? entry.author.username),
        bot: entry.author.bot && entry.author.id !== self,
        minutesAgo: Math.max(0, (now - entry.createdTimestamp) / 60_000),
        text: cleanLine(entry.content, { botId: self, names })
      })).filter((line) => line.text);
      const lastOwn = [...recent].reverse().find((entry) => entry.author.id === self);
      const state = buildVexState(lines, {
        idleMinutes: named ? 0 : Math.max(0, (now - message.createdTimestamp) / 60_000),
        sinceVexMinutes: lastOwn ? (now - lastOwn.createdTimestamp) / 60_000 : null
      });

      const decision = await this.decide(state);
      if (!decision) return this.record(message, { action: 'error', note: 'no_decision' });
      const common = { model: decision.model, p: decision.p, costUsd: decision.costUsd, latencyMs: decision.latencyMs };
      if (decision.p < (named ? this.config.nameThreshold : this.config.threshold)) {
        return this.record(message, { ...common, action: 'below', note: named ? 'named' : null });
      }

      if (named) {
        // 呼ばれた発言には、そのまま答える (普通の依頼と同じ: 呼んだ人の枠で数え、失敗も伝える)
        this.record(message, { ...common, action: 'joined', note: 'named' });
        await this.deps.join(message, null);
        return;
      }

      // 判定モデル (安い一次ふるい) を通った。最後に、会話の履歴と記憶の概要を読む審判が、入る根拠 (答えを求める発言など) があるかを決める
      if (this.config.arbiter) {
        const verdict = await this.arbitrate({ guildId: message.guildId ?? '', kind: 'ambient', lines: arbiterLines });
        if (!verdict) return this.record(message, { ...common, action: 'error', note: 'arbiter_failed' });
        const withArbiter = { ...common, costUsd: common.costUsd + verdict.costUsd, latencyMs: common.latencyMs + verdict.latencyMs };
        if (!verdict.join) return this.record(message, { ...withArbiter, action: 'below', note: `arbiter: ${verdict.reason}`.slice(0, 120) });
        return this.enter(message, { ...withArbiter, action: 'joined', note: `arbiter: ${verdict.reason}`.slice(0, 120) }, false);
      }
      return this.enter(message, { ...common, action: 'joined' }, false);
    } finally {
      this.running.delete(key);
    }
  }
  /** 入る。判定のあいだ・考えているあいだに会話が進んでいたら入らない。 */
  private async enter(message: VexMessage, common: Omit<VexRecord, 'guildId' | 'channelId' | 'messageId'>, continuation: boolean): Promise<void> {
    const after = asArray(await message.channel.messages.fetch({ limit: 1 })).at(-1);
    if (after && after.id !== message.id) return this.record(message, { ...common, action: 'moved_on', note: 'after_decision' });

    // 入ると決めた時点で数える (agent が (skip) と答えても冷却は掛かる。同じ場面で何度も払わない)
    this.record(message, common);
    await this.deps.join(message, {
      ...(continuation ? { continuation: true } : {}),
      // 考えている間に会話が少し進むのは普通。入ってよいのは、後から来た発言が少なく、
      // その発言への返信 (= 答えが付いた) が無いとき
      stillLatest: async () => {
        const later = asArray(await message.channel.messages.fetch({ limit: LATER_LIMIT + 2 }))
          .filter((entry) => BigInt(entry.id) > BigInt(message.id));
        return later.length <= LATER_LIMIT && !later.some((entry) => entry.reference?.messageId === message.id);
      },
      report: (outcome) => this.record(message, {
        ...common,
        action: outcome === 'sent' ? 'sent' : outcome === 'passed' ? 'passed' : outcome === 'moved_on' ? 'moved_on' : 'error',
        note: outcome === 'failed' ? 'agent_failed' : outcome === 'moved_on' ? 'before_send' : common.note ?? null
      })
    });
  }
}
