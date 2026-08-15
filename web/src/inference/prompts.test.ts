import { describe, expect, it } from 'vitest';

import {
  buildEvexPrompt,
  buildFtPrompt,
  cleanEvexReply,
  cleanFtReply,
  isUsableReply,
  normalizeEvex,
} from './prompts';

describe('evex prompt parity', () => {
  const persona = { id: 'tako', label: 'たこ', prompt: '<|s3|>' };

  it('normalizes the same structural values as training', () => {
    expect(normalizeEvex('見て https://example.com\n次')).toBe('見て <url><nl>次');
    expect(normalizeEvex('```js\nconst x = 1\n```')).toBe('<code>const x = 1<nl></code>');
  });

  it('serializes user, assistant, and trailing persona tokens', () => {
    expect(
      buildEvexPrompt(
        [
          { role: 'user', content: 'こんにちは' },
          { role: 'assistant', content: 'やあ' },
          { role: 'user', content: '元気？' },
        ],
        persona,
      ),
    ).toBe('<|conv|><|other|>こんにちは<|s3|>やあ<|other|>元気？<|s3|>');
  });

  it('keeps only consecutive turns from the selected persona', () => {
    expect(cleanEvexReply('一つ<|s3|>二つ<|s7|>他人', '<|s3|>')).toBe('一つ\n二つ');
    expect(cleanEvexReply('本文<|end|>次の会話', '<|s3|>')).toBe('本文');
  });
});

describe('fine-tune prompt parity', () => {
  const persona = { id: 'tako', label: 'たこ', prompt: 'たこ' };

  it('uses the training line format', () => {
    expect(
      buildFtPrompt(
        [
          { role: 'user', content: 'こんにちは' },
          { role: 'assistant', content: 'やあ' },
          { role: 'user', content: '元気？' },
        ],
        persona,
      ),
    ).toBe('#other\nA: こんにちは\nたこ: やあ\nA: 元気？\nたこ:');
  });

  it('cuts when another label starts speaking', () => {
    expect(cleanFtReply('一つ\nたこ: 二つ\nA: 他人', 'たこ')).toBe('一つ\n二つ');
  });
});

describe('reply quality gate', () => {
  it('retries empty, attachment-only, URL-only, and mention-only replies', () => {
    for (const value of ['', 'a', '[画像]', 'https://example.com', '@someone']) {
      expect(isUsableReply(value)).toBe(false);
    }
    expect(isUsableReply('それでいいと思う')).toBe(true);
  });
});
