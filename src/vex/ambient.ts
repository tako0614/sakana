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
  /**
   * agent に渡して入る。自発参加 (join あり) は誰にも呼ばれていない場面、
   * 名前が出た発言 (join が null) は呼ばれた場面として、普通の依頼と同じに答える。
   */
  join(message: VexMessage, join: AmbientJoin | null): Promise<void>;
  now?: () => number;
}

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
  private readonly config: VexConfig;
  private readonly now: () => number;
  private readonly decide: (state: string) => Promise<Decision | null>;

  constructor(private readonly deps: AmbientDeps) {
    this.config = deps.config ?? vexConfig;
    this.now = deps.now ?? Date.now;
    this.decide = deps.decide ?? ((state) => decideDefault(state, { config: this.config }));
  }

  get enabled(): boolean {
    return this.config.ambient && this.config.channels.size > 0;
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
  worthJudging(message: VexMessage, named = false): boolean {
    if (message.author.bot || message.webhookId) return false;
    if (message.channel.nsfw || /nsfw/i.test(message.channel.name ?? '')) return false;
    // 名前が出ていれば、短くても (vex だけ)・返信でも・他の人へのメンションつきでも判定する
    if (named) return true;
    const text = String(message.content ?? '').trim();
    // 画像だけ・スタンプだけ・極端に短い発言には入らない
    if (text.length < 6) return false;
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

  async judge(message: VexMessage, { named = false }: { named?: boolean } = {}): Promise<void> {
    const channelId = message.channelId;
    // 自発参加はチャンネルごとに 1 つ。名前が出た発言は発言ごと (別々の人が続けて呼んでも落とさない)
    const key = named ? `named:${message.id}` : channelId;
    if (this.running.has(key)) return;
    this.running.add(key);
    try {
      const me = await this.deps.canSpeak(message);
      if (!me) return this.record(message, { action: 'skipped', note: 'cannot_speak' });

      const closed = this.gate(channelId, named);
      if (closed) return this.record(message, { action: 'skipped', note: closed });

      // 名前が出た発言は、その発言までを見せる (後から来た発言は判定の材料にしない)。
      // 自発参加は、最後の発言のままであることを確かめる
      const recent = named
        ? [...asArray(await message.channel.messages.fetch({ limit: Math.max(1, this.config.contextMessages - 1), before: message.id })), message]
        : asArray(await message.channel.messages.fetch({ limit: this.config.contextMessages }));
      const latest = recent.at(-1);
      if (!latest || latest.id !== message.id) return this.record(message, { action: 'moved_on', note: 'before_decision' });

      const now = this.now();
      const self = this.deps.selfId();
      const names = new Map<string, string>();
      for (const entry of recent) names.set(entry.author.id, entry.member?.displayName ?? entry.author.displayName ?? entry.author.username);
      const lines: VexLine[] = recent.map((entry) => ({
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

      // 判定のあいだに会話が進んでいたら入らない
      const after = asArray(await message.channel.messages.fetch({ limit: 1 })).at(-1);
      if (after && after.id !== message.id) return this.record(message, { ...common, action: 'moved_on', note: 'after_decision' });

      // 入ると決めた時点で数える (agent が (skip) と答えても冷却は掛かる。同じ場面で何度も払わない)
      this.record(message, { ...common, action: 'joined' });
      await this.deps.join(message, {
        // 考えている間に会話が少し進むのは普通。入ってよいのは、後から来た発言が少なく、
        // その発言への返信 (= 答えが付いた) が無いとき
        stillLatest: async () => {
          const later = asArray(await message.channel.messages.fetch({ limit: LATER_LIMIT + 2 }))
            .filter((entry) => BigInt(entry.id) > BigInt(message.id));
          return later.length <= LATER_LIMIT && !later.some((entry) => entry.reference?.messageId === message.id);
        },
        report: (outcome) => this.record(message, { ...common, action: outcome === 'sent' ? 'sent' : outcome === 'passed' ? 'passed' : outcome === 'moved_on' ? 'moved_on' : 'error', note: outcome === 'moved_on' ? 'before_send' : outcome === 'failed' ? 'agent_failed' : null })
      });
    } finally {
      this.running.delete(key);
    }
  }
}
