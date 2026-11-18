/** Inclusive bounds of the pixels with any alpha in an RGBA buffer, or null when it is empty. */
export const findContentBounds = (px: Uint8Array | Uint8ClampedArray, w: number, h: number) => {
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      if (px[row + x * 4 + 3] === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      maxY = y;
    }
  }
  return maxX < 0 ? null : { minX, minY, maxX, maxY };
};
