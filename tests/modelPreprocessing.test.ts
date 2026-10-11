import assert from 'node:assert/strict';
import test from 'node:test';
import { rgbaToNormalizedNchw, softmaxClassScore } from '../src/utils/modelPreprocessing';

test('converts RGBA pixels into RGB planar values normalized to [-1, 1]', () => {
  const pixels = new Uint8ClampedArray([
    0, 127, 255, 0,
    255, 0, 127, 255,
  ]);

  const result = rgbaToNormalizedNchw(pixels, 2, 1);
  assert.deepEqual(Array.from(result), [
    -1, 1,
    Math.fround(127 / 127.5 - 1), -1,
    1, Math.fround(127 / 127.5 - 1),
  ]);
});

test('rejects malformed frame dimensions and channel lengths', () => {
  assert.throws(() => rgbaToNormalizedNchw(new Uint8ClampedArray(3), 1, 1), /RGBA channel values/);
  assert.throws(() => rgbaToNormalizedNchw(new Uint8ClampedArray(4), 0, 1), /positive integers/);
});

test('maps finite logits to a stable selected-class softmax score', () => {
  assert.equal(softmaxClassScore([2, 2], 1), 0.5);
  assert.equal(softmaxClassScore([-10000, 10000], 1), 1);
  assert.throws(() => softmaxClassScore([1, Number.NaN], 1), /finite logits/);
  assert.throws(() => softmaxClassScore([1, 2], 2), /valid class index/);
});
