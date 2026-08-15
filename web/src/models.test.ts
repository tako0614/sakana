import { describe, expect, it } from 'vitest';

import { MODEL_LIST } from './models';

describe('model registry', () => {
  it('pins every public model to an immutable Hugging Face revision', () => {
    for (const model of MODEL_LIST) {
      expect(model.revision).toMatch(/^[0-9a-f]{40}$/);
      expect(model.repo).toMatch(/^tako080614\/evex/);
    }
  });

  it('keeps the large fine-tune WebGPU-only', () => {
    const fineTune = MODEL_LIST.find((model) => model.id === 'evex-ft-1');
    expect(fineTune?.backends).toEqual(['webgpu']);
    expect(fineTune?.downloadBytes).toBeGreaterThan(1024 ** 3);
  });

  it('only exposes persona controls for models with speaker metadata', () => {
    for (const model of MODEL_LIST) expect(model.supportsPersonas).toBe(true);
  });
});
