// エージェントが落ちたとき、聞いた人に見せる理由。
//
// 以前は「失敗しました。しばらくしてから」だけで、混んでいる (429) のか、枠が尽きたのか、
// 通信が切れたのかが分からなかった。status と code だけから文を作る。provider 名や本文は
// 運営の診断用 (ProviderError.detail・ログ) で、チャンネルには出さない。
import { detailsOf, finiteNumber } from '../ai/types.js';

export interface FailureReason {
  /** 「429: AI が混み合っていて…」のような短い説明。 */
  text: string;
  /** 時間を置けば通るか。false なら運営に伝える案内にする。 */
  retry: boolean;
}

export function failureReason(error: unknown): FailureReason | null {
  const details = detailsOf(error);
  const status = finiteNumber(details.status);
  const code = typeof details.code === 'string' ? details.code : '';
  const name = typeof details.name === 'string' ? details.name : '';
  const message = typeof details.message === 'string' ? details.message : '';

  if (code.startsWith('MODEL_BUDGET_')) return { text: 'AI の予算の上限に達しています', retry: false };
  if (code === 'AGENT_REQUEST_LIMIT') return { text: '1回の依頼で AI を呼べる回数の上限に達しました', retry: false };
  if (name === 'TimeoutError' || name === 'AbortError' || /deadline exceeded/i.test(message)) {
    return { text: '時間切れ: AI の応答が間に合いませんでした', retry: true };
  }
  if (/truncated/i.test(message)) return { text: '回答が長すぎて途中で切れました', retry: true };
  if (status === undefined) return null;

  if (status === 0) return { text: '通信エラー: AI につながりませんでした', retry: true };
  if (status === 429) return { text: '429: AI が混み合っていて断られました', retry: true };
  if (status === 402) return { text: '402: AI の利用枠が尽きています', retry: false };
  if (status === 401 || status === 403) return { text: `${status}: AI の認証に失敗しました`, retry: false };
  if (status >= 500) return { text: `${status}: AI 側の障害です`, retry: true };
  if (status >= 400) return { text: `${status}: AI がこの依頼を受け付けませんでした`, retry: true };
  return null;
}

/** 本文に添える後半。理由が分からなければ従来の案内だけ。 */
export function failureNotice(head: string, error: unknown): string {
  const reason = failureReason(error);
  if (!reason) return `${head}。しばらくしてからもう一度試してください。`;
  return reason.retry
    ? `${head} (${reason.text})。しばらくしてからもう一度試してください。`
    : `${head} (${reason.text})。管理者に伝えてください。`;
}
