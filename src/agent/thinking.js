// 実行中の経過表示。
//
//   -# thinking (10s)
//   -# thinking (12s) · search_messages
//
// `-#` は Discord の小文字表示 (subtext)。会話の邪魔にならないようにこれで出す。
// 答えができたらこのメッセージは削除し、回答は新しいメッセージとして送り直す。
// 編集で置き換えると、待っている間に他の人が喋った場合に回答が過去の位置に埋まってしまう。

import { agentConfig } from './config.js';

const NO_MENTIONS = { parse: [], repliedUser: false };

export class ThinkingIndicator {
  constructor(channel) {
    this.channel = channel;
    this.startedAt = Date.now();
    this.message = null;
    this.timer = null;
    this.status = null;
    this.lastRendered = null;
    // 前回の編集がまだ終わっていないときは次のティックを飛ばす。
    // Discord のメッセージ編集はチャンネル単位で絞られるので、詰まらせない。
    this.busy = false;
    this.stopped = false;
    // 更新を諦めたあとでも削除はできるように、編集可否と message を別に持つ。
    this.editable = true;
    this.editFailures = 0;
  }

  render() {
    const seconds = Math.max(1, Math.round((Date.now() - this.startedAt) / 1000));
    const suffix = this.status ? ` · ${this.status}` : '';
    return `-# thinking (${seconds}s)${suffix}`;
  }

  async start() {
    try {
      const content = this.render();
      this.message = await this.channel.send({ content, allowedMentions: NO_MENTIONS });
      this.lastRendered = content;
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
    this.status = status;
  }

  async tick() {
    if (this.stopped || this.busy || !this.message || !this.editable) return;

    // 表示が変わらないなら編集しない。無駄な API 呼び出しでレート制限を削らないため。
    const content = this.render();
    if (content === this.lastRendered) return;

    this.busy = true;
    try {
      await this.message.edit({ content, allowedMentions: NO_MENTIONS });
      this.lastRendered = content;
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
