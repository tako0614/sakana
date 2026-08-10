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
    if (this.stopped || this.busy || !this.message) return;

    // 表示が変わらないなら編集しない。無駄な API 呼び出しでレート制限を削らないため。
    const content = this.render();
    if (content === this.lastRendered) return;

    this.busy = true;
    try {
      await this.message.edit({ content, allowedMentions: NO_MENTIONS });
      this.lastRendered = content;
    } catch {
      // 消されていたら経過表示は諦める (本体の処理は続ける)
      this.stopTimer();
      this.message = null;
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
