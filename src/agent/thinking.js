// 実行中の経過表示。
//
//   -# thinking (10s)
//   -# thinking (12s) · 検索
//
// `-#` は Discord の小文字表示 (subtext)。会話の邪魔にならないようにこれで出す。
// 答えができたらこのメッセージは削除し、回答は新しいメッセージとして送り直す。
// 編集で置き換えると、待っている間に他の人が喋った場合に回答が過去の位置に埋まってしまう。

import { agentConfig } from './config.js';

const NO_MENTIONS = { parse: [], repliedUser: false };

/**
 * ツール名をそのまま出すと `· search` のような英語が会話に流れる。
 * ここは人が読む場所なので日本語にする。mode まで見て何をしているか出す。
 */
export function toolLabel(name, args = {}) {
  if (name === 'search') {
    const mode = String(args.mode ?? '').trim().toLowerCase();
    if (mode === 'count') return '集計';
    if (mode === 'meaning') return '意味検索';
    return '検索';
  }

  if (name === 'read') return args.direction === 'replies' ? '返信をたどる' : '読み込み';
  if (name === 'channels') return 'チャンネル一覧';
  if (name === 'browser') return 'ブラウザ';

  return name;
}

/**
 * 経過が長くなるほど編集の間隔を空ける。
 *
 * 待つ人がいちばん気にするのは最初の数秒で、そこを過ぎたら「生きているか」しか
 * 見ていない。ずっと毎秒編集すると、チャンネル単位の編集レート (5回/5秒あたり)
 * を1つの回答で食い潰して、他の編集まで詰まる。
 */
function editDelay(elapsedMs) {
  if (elapsedMs < 10_000) return agentConfig.progressIntervalMs;
  if (elapsedMs < 30_000) return Math.max(3000, agentConfig.progressIntervalMs);
  return Math.max(5000, agentConfig.progressIntervalMs);
}

/**
 * 15秒を過ぎたら5秒刻みに丸める。
 * 秒が毎回変わると「表示が変わらないなら編集しない」の判定が永久に効かないので、
 * 表示そのものを粗くして自然に止める。
 */
function renderSeconds(elapsedMs) {
  const seconds = Math.max(1, Math.round(elapsedMs / 1000));
  return seconds < 15 ? seconds : Math.round(seconds / 5) * 5;
}

export class ThinkingIndicator {
  constructor(channel) {
    this.channel = channel;
    this.startedAt = Date.now();
    this.message = null;
    this.timer = null;
    this.status = null;
    this.lastRendered = null;
    this.lastEditAt = 0;
    // ツールが切り替わった瞬間だけは間隔を待たずに出す (情報が増える唯一の瞬間)
    this.statusDirty = false;
    // 前回の編集がまだ終わっていないときは次のティックを飛ばす。
    // Discord のメッセージ編集はチャンネル単位で絞られるので、詰まらせない。
    this.busy = false;
    this.stopped = false;
    // 更新を諦めたあとでも削除はできるように、編集可否と message を別に持つ。
    this.editable = true;
    this.editFailures = 0;
  }

  render() {
    const suffix = this.status ? ` · ${this.status}` : '';
    return `-# thinking (${renderSeconds(Date.now() - this.startedAt)}s)${suffix}`;
  }

  async start() {
    try {
      const content = this.render();
      this.message = await this.channel.send({ content, allowedMentions: NO_MENTIONS });
      this.lastRendered = content;
      this.lastEditAt = Date.now();
    } catch (error) {
      // 送信できない (権限が無いなど) 場合は経過表示なしで続行する。
      console.error('Failed to post thinking indicator:', error);
      return;
    }

    this.timer = setInterval(() => {
      this.tick().catch(() => {});
    }, agentConfig.progressIntervalMs);
  }

  /** いま何をしているか (ツール名) を次のティックから出す。 */
  setStatus(status) {
    if (status !== this.status) this.statusDirty = true;
    this.status = status;
  }

  async tick() {
    if (this.stopped || this.busy || !this.message || !this.editable) return;

    // 表示が変わらないなら編集しない。無駄な API 呼び出しでレート制限を削らないため。
    const content = this.render();
    if (content === this.lastRendered) return;

    // 経過が長いほど間隔を空ける。ツールが切り替わったときだけ待たない。
    const now = Date.now();
    if (!this.statusDirty && now - this.lastEditAt < editDelay(now - this.startedAt)) return;

    this.busy = true;
    try {
      await this.message.edit({ content, allowedMentions: NO_MENTIONS });
      this.lastRendered = content;
      this.lastEditAt = Date.now();
      this.statusDirty = false;
      this.editFailures = 0;
    } catch (error) {
      // メッセージ自体が消えているときだけ本当に諦める (10008 = Unknown Message)。
      if (error?.code === 10008 || error?.status === 404) {
        this.editable = false;
        this.message = null;
        this.stopTimer();
        return;
      }

      // レート制限などの一時的な失敗で諦めてはいけない。ここで message を捨てると
      // stop() が削除できなくなり、「thinking」が残り続ける。次のティックで復帰する。
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

  stopTimer() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 経過表示を消す。何度呼んでも安全。 */
  async stop() {
    this.stopped = true;
    this.stopTimer();

    const message = this.message;
    this.message = null;
    if (!message) return;

    await message.delete().catch(() => {});
  }
}
