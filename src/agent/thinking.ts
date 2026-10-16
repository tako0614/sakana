// 実行中の経過表示。
//
//   -# thinking 3 秒前
//   -# thinking 12 秒前 · 検索
//
// 経過は `<t:秒:R>` で出す。Discord のクライアントが勝手に進めるので、
// 秒を進めるための編集が1回も要らない (以前は毎秒 edit していて、
// 1回の回答でチャンネル単位の編集レートを食い潰していた)。
// 編集が走るのはツールが切り替わったときだけ。
//
// `-#` は Discord の小文字表示 (subtext)。会話の邪魔にならないようにこれで出す。
// 答えができたらこのメッセージは削除し、回答は新しいメッセージとして送り直す。
// 編集で置き換えると、待っている間に他の人が喋った場合に回答が過去の位置に埋まってしまう。

import type { Message, MessageCreateOptions, MessageEditOptions } from 'discord.js';
import { agentConfig } from './config.js';
import { forgetIndicator, rememberIndicator } from './indicators.js';
import { errorCode, errorStatus, stringField } from './types.js';

const NO_MENTIONS = { parse: [], repliedUser: false } satisfies MessageCreateOptions['allowedMentions'];

/**
 * ツール名をそのまま出すと `· search` のような英語が会話に流れる。
 * ここは人が読む場所なので日本語にする。mode まで見て何をしているか出す。
 */
export function toolLabel(name: string, args: unknown = {}): string {
  if (name === 'search') {
    const mode = String(stringField(args, 'mode') ?? '').trim().toLowerCase();
    if (mode === 'count') return '集計';
    if (mode === 'meaning') return '意味検索';
    return '検索';
  }

  if (name === 'read') return stringField(args, 'direction') === 'replies' ? '返信をたどる' : '読み込み';
  if (name === 'channels') return 'チャンネル一覧';
  if (name === 'governance') return '統治記録';
  if (name === 'browser') return stringField(args, 'action') === 'search' ? 'web 検索' : 'ブラウザ';

  return name;
}

/**
 * 経過は Discord の相対タイムスタンプに任せる。
 *
 * `<t:秒:R>` はクライアント側が勝手に進めるので、秒を出すための編集が
 * 1回も要らない。以前は毎秒 edit していて、1回の回答でチャンネル単位の
 * 編集レート (5回/5秒あたり) を食い潰していた。
 * 結果、編集が走るのは「ツールが切り替わったとき」だけになる。
 */
// 経過表示の本文の頭。これで「自分の経過表示」を見分ける。
// 落ちた実行が消し損ねたぶんはチャンネルに残り続けるので、ID だけでは足りない。
export const INDICATOR_PREFIX = '-# thinking ';

/** その発言が経過表示かどうか。直近の会話に混ぜないために使う。 */
export function isIndicatorMessage(message: { authorId?: string; content?: string } | null | undefined, selfId: string | null | undefined): boolean {
  if (!selfId || message?.authorId !== selfId) return false;
  return String(message?.content ?? '').startsWith(INDICATOR_PREFIX);
}

/** 経過表示を出す先。送れて、id を持っていればいい。 */
export interface IndicatorChannel {
  id: string;
  send(options: MessageCreateOptions): Promise<Message>;
}

export class ThinkingIndicator {
  channel: IndicatorChannel;
  startedAt: number;
  message: Message | null;
  timer: ReturnType<typeof setTimeout> | null;
  status: string | null;
  lastRendered: string | null;
  lastEditAt: number;
  busy: boolean;
  stopped: boolean;
  editable: boolean;
  editFailures: number;

  constructor(channel: IndicatorChannel) {
    this.channel = channel;
    this.startedAt = Date.now();
    this.message = null;
    // status の変化をまとめるための遅延タイマー (setInterval ではない)
    this.timer = null;
    this.status = null;
    this.lastRendered = null;
    this.lastEditAt = 0;
    // 前回の編集がまだ終わっていないときは重ねない
    this.busy = false;
    this.stopped = false;
    // 更新を諦めたあとでも削除はできるように、編集可否と message を別に持つ。
    this.editable = true;
    this.editFailures = 0;
  }

  render(): string {
    const suffix = this.status ? ` · ${this.status}` : '';
    return `${INDICATOR_PREFIX}<t:${Math.floor(this.startedAt / 1000)}:R>${suffix}`;
  }

  /** 直近の会話から自分の経過表示を外すのに使う (start に失敗していたら null)。 */
  get messageId(): string | null {
    return this.message?.id ?? null;
  }

  async start(): Promise<void> {
    try {
      const content = this.render();
      this.message = await this.channel.send({ content, allowedMentions: NO_MENTIONS });
      this.lastRendered = content;
      this.lastEditAt = Date.now();
      // 出した瞬間に控える。ここで落ちても次の起動で消せるようにするため。
      rememberIndicator(this.message.id, this.channel.id);
    } catch (error) {
      // 送信できない (権限が無いなど) 場合は経過表示なしで続行する。
      console.error('Failed to post thinking indicator:', error);
    }
  }

  /**
   * いま何をしているか (ツール名) を出す。
   * ここでしか編集は起きない。1ラウンドで複数のツールが呼ばれると連続で
   * 来るので、少し待ってまとめる。
   */
  setStatus(status: string): void {
    if (this.stopped || status === this.status) return;

    this.status = status;
    if (this.timer) return;

    // 直前に編集していたら間隔を空ける (バーストでレート制限を削らない)
    const wait = Math.max(
      agentConfig.progressIntervalMs,
      agentConfig.progressIntervalMs - (Date.now() - this.lastEditAt)
    );

    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch(() => {});
    }, wait);
    this.timer.unref?.();
  }

  async flush(): Promise<void> {
    if (this.stopped || this.busy || !this.message || !this.editable) return;

    const content = this.render();
    if (content === this.lastRendered) return;

    this.busy = true;
    try {
      const edit: MessageEditOptions = { content, allowedMentions: NO_MENTIONS };
      await this.message.edit(edit);
      this.lastRendered = content;
      this.lastEditAt = Date.now();
      this.editFailures = 0;
    } catch (error) {
      // メッセージ自体が消えているときだけ本当に諦める (10008 = Unknown Message)。
      if (errorCode(error) === 10008 || errorStatus(error) === 404) {
        // もう無いものを次の起動で消しに行かせない
        forgetIndicator(this.message?.id);
        this.editable = false;
        this.message = null;
        this.stopTimer();
        return;
      }

      // レート制限などの一時的な失敗で諦めてはいけない。ここで message を捨てると
      // stop() が削除できなくなり、「thinking」が残り続ける。
      this.editFailures += 1;
      if (this.editFailures >= 5) {
        // 何度も失敗するなら更新だけ止める。message は消さないので削除はできる。
        this.editable = false;
        this.stopTimer();
      }
    } finally {
      this.busy = false;
    }
  }

  stopTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** 経過表示を消す。何度呼んでも安全。 */
  async stop(): Promise<void> {
    this.stopped = true;
    this.stopTimer();

    const message = this.message;
    this.message = null;
    if (!message) return;

    forgetIndicator(message.id);
    await message.delete().catch(() => {});
  }
}
