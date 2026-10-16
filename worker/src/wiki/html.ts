// HTML を組み立てる道具。埋め込んだ値は必ず escape され、escape 済みの断片 (SafeHtml) だけがそのまま通る。
// 文字列連結で HTML を作ると escape 漏れが XSS になるので、型で「escape 済み」を区別する。

const ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character);
}

/** escape 済み (または自分で組んだ安全な) HTML。外から来た文字列をここへ直接入れない。 */
export class SafeHtml {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
  toString(): string {
    return this.value;
  }
}

export type Part = SafeHtml | string | number | boolean | null | undefined | readonly Part[];

function render(part: Part): string {
  if (part === null || part === undefined || part === false || part === true) return '';
  if (part instanceof SafeHtml) return part.value;
  if (Array.isArray(part)) return part.map(render).join('');
  return esc(part);
}

/** テンプレートの固定部分はそのまま、`${}` に入れた値は escape する。SafeHtml と配列はそのまま (配列は中身ごとに判定)。 */
export function html(strings: TemplateStringsArray, ...values: Part[]): SafeHtml {
  let out = strings[0] ?? '';
  values.forEach((value, index) => {
    out += render(value) + (strings[index + 1] ?? '');
  });
  return new SafeHtml(out);
}

/** 信頼できる断片 (CSS・自分で組んだ HTML) をそのまま通す。ユーザー入力に使わない。 */
export function raw(value: string): SafeHtml {
  return new SafeHtml(value);
}

export const joinHtml = (parts: readonly SafeHtml[], separator = ''): SafeHtml => new SafeHtml(parts.map((part) => part.value).join(separator));
