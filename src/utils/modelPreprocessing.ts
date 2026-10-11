export function rgbaToNormalizedNchw(
  pixels: Uint8ClampedArray,
  width: number,
  height: number
): Float32Array {
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
    throw new RangeError('Frame dimensions must be positive integers.');
  }
  if (pixels.length !== width * height * 4) {
    throw new RangeError(`Expected ${width * height * 4} RGBA channel values.`);
  }

  const planeLength = width * height;
  const planar = new Float32Array(planeLength * 3);
  for (let pixel = 0; pixel < planeLength; pixel += 1) {
    const offset = pixel * 4;
    planar[pixel] = pixels[offset] / 127.5 - 1;
    planar[planeLength + pixel] = pixels[offset + 1] / 127.5 - 1;
    planar[planeLength * 2 + pixel] = pixels[offset + 2] / 127.5 - 1;
  }
  return planar;
}

export function softmaxClassScore(logits: readonly number[], classIndex: number): number {
  if (
    logits.length < 2 ||
    logits.some((value) => !Number.isFinite(value)) ||
    !Number.isSafeInteger(classIndex) ||
    classIndex < 0 ||
    classIndex >= logits.length
  ) {
    throw new RangeError('Model output must contain finite logits and a valid class index.');
  }

  const maximum = Math.max(...logits);
  const exponentials = logits.map((value) => Math.exp(value - maximum));
  const denominator = exponentials.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(denominator) || denominator <= 0) {
    throw new RangeError('Model output cannot be normalized.');
  }
  return exponentials[classIndex] / denominator;
}
