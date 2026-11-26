import { clampUnit, D50_WHITE, deltaE2000, labToXyz, srgb8ToXyzD50, xyzToLab, type Vec3 } from './colorMath';

export type BuiltinProofProfileId = 'japan-color-2001-coated' | 'fogra39' | 'us-web-coated-swop';

export interface PrintConditionPreset {
  id: BuiltinProofProfileId;
  label: string;
  paper: Vec3;
  solids: { c: Vec3; m: Vec3; y: Vec3; k: Vec3; cm: Vec3; cy: Vec3; my: Vec3; cmy: Vec3 };
  tvi50: { c: number; m: number; y: number; k: number };
  tac: number;
}

// Approximate characterization aims based on JPIMA Japan Color 2001 (type 1),
// FOGRA39 and CGATS TR 001, respectively. Three-ink neutrals are estimates.
export const PRINT_CONDITION_PRESETS: readonly PrintConditionPreset[] = [
  {
    id: 'japan-color-2001-coated', label: 'Japan Color 2001 Coated', paper: [93, 0, -3],
    solids: { c: [54, -36, -49], m: [45, 72, -5], y: [86, -7, 92], k: [13, 1, 3],
      cm: [24, 16, -49], cy: [49, -70, 26], my: [45, 66, 49], cmy: [21, 1, 1] },
    tvi50: { c: 0.18, m: 0.15, y: 0.15, k: 0.16 }, tac: 3.5,
  },
  {
    id: 'fogra39', label: 'Coated FOGRA39', paper: [95, 0, -2],
    solids: { c: [55, -37, -50], m: [48, 74, -3], y: [89, -5, 93], k: [16, 0, 0],
      cm: [24, 16, -45], cy: [50, -67, 27], my: [47, 68, 48], cmy: [22, 1, 1] },
    tvi50: { c: 0.15, m: 0.137, y: 0.144, k: 0.172 }, tac: 3.3,
  },
  {
    id: 'us-web-coated-swop', label: 'U.S. Web Coated (SWOP)', paper: [93, 0, -1],
    solids: { c: [55, -36, -46], m: [49, 70, -2], y: [87, -6, 85], k: [18, 0, 0],
      cm: [25, 17, -43], cy: [50, -61, 25], my: [47, 63, 44], cmy: [23, 1, 2] },
    tvi50: { c: 0.20, m: 0.176, y: 0.168, k: 0.216 }, tac: 3,
  },
];

export function getPrintConditionPreset(id: BuiltinProofProfileId): PrintConditionPreset {
  const preset = PRINT_CONDITION_PRESETS.find(condition => condition.id === id);
  if (!preset) throw new Error('unknown_print_condition');
  return preset;
}

type Cmyk = [number, number, number, number];
const MIN_REFLECTANCE = 0.008;
const LAB_EPSILON = 216 / 24389;
const LAB_SLOPE = 841 / 108;
const INK_EPSILON = 1e-7;
const SRGB_WHITE = srgb8ToXyzD50(255, 255, 255);

function sameWhite(xyz: Vec3, white: Vec3): boolean {
  return Math.abs(xyz[0] - white[0]) < 1e-9 && Math.abs(xyz[1] - white[1]) < 1e-9 && Math.abs(xyz[2] - white[2]) < 1e-9;
}

function coverage(ink: number, gain: number): number {
  return clampUnit(ink + gain * ink * (1 - ink));
}

function constrain(ink: Cmyk, channels: number, limit: number): void {
  for (let i = 0; i < channels; i++) ink[i] = clampUnit(ink[i]);
  let excess = ink[0] + ink[1] + ink[2] + ink[3] - limit;
  // Project onto the ink limit by subtracting a common offset from positive inks.
  for (let pass = 0; pass < channels && excess > 1e-12; pass++) {
    let active = 0;
    for (let i = 0; i < channels; i++) if (ink[i] > 0) active++;
    const offset = excess / active;
    excess = 0;
    for (let i = 0; i < channels; i++) {
      if (ink[i] <= 0) continue;
      if (ink[i] < offset) excess += offset - ink[i];
      ink[i] = Math.max(0, ink[i] - offset);
    }
  }
}

/** Local lightness and chroma weights for the least-squares separation. */
function labWeights(target: Vec3, out: Vec3): void {
  const lightness = (target[0] - 50) ** 2;
  const chroma = Math.sqrt(target[1] ** 2 + target[2] ** 2);
  const chroma7 = chroma ** 7;
  const scaleA = 1.5 - 0.5 * Math.sqrt(chroma7 / (chroma7 + 25 ** 7));
  out[0] = 1 / (1 + 0.015 * lightness / Math.sqrt(20 + lightness));
  out[1] = scaleA / (1 + 0.026 * chroma);
  out[2] = 1 / (1 + 0.026 * chroma);
}

/** Solve the damped normal equations in the three-dimensional residual space. */
function dampedStep(j: Float64Array, residual: Vec3, free: number, tangent: boolean, damping: number, out: Cmyk): void {
  let meanX = 0;
  let meanY = 0;
  let meanZ = 0;
  if (tangent) {
    let count = 0;
    for (let i = 0; i < 4; i++) {
      if (!(free & (1 << i))) continue;
      count++;
      meanX += j[i];
      meanY += j[i + 4];
      meanZ += j[i + 8];
    }
    meanX /= count;
    meanY /= count;
    meanZ /= count;
  }
  let xx = damping;
  let yy = damping;
  let zz = damping;
  let xy = 0;
  let xz = 0;
  let yz = 0;
  for (let i = 0; i < 4; i++) {
    if (!(free & (1 << i))) continue;
    const x = j[i] - meanX;
    const y = j[i + 4] - meanY;
    const z = j[i + 8] - meanZ;
    xx += x * x;
    yy += y * y;
    zz += z * z;
    xy += x * y;
    xz += x * z;
    yz += y * z;
  }
  const a = yy * zz - yz * yz;
  const b = xz * yz - xy * zz;
  const c = xy * yz - xz * yy;
  const d = xx * zz - xz * xz;
  const e = xy * xz - xx * yz;
  const f = xx * yy - xy * xy;
  const det = xx * a + xy * b + xz * c;
  const [rx, ry, rz] = residual;
  const x = (a * rx + b * ry + c * rz) / det;
  const y = (b * rx + d * ry + e * rz) / det;
  const z = (c * rx + e * ry + f * rz) / det;
  for (let i = 0; i < 4; i++) {
    out[i] = free & (1 << i) ? (j[i] - meanX) * x + (j[i + 4] - meanY) * y + (j[i + 8] - meanZ) * z : 0;
  }
}

export class CmykPrintModel {
  readonly blackPoint: Vec3;
  private readonly paperXyz: Vec3;
  private readonly gain: Cmyk;
  private readonly primary = new Float64Array(48);
  private readonly roots: Vec3 = [0, 0, 0];
  private readonly jacobian = new Float64Array(12);
  private readonly weights: Vec3 = [0, 0, 0];
  private readonly currentLab: Vec3 = [0, 0, 0];
  private readonly targetLab: Vec3 = [0, 0, 0];
  private readonly residual: Vec3 = [0, 0, 0];
  private readonly trial: Cmyk = [0, 0, 0, 0];
  private readonly step: Cmyk = [0, 0, 0, 0];

  constructor(readonly preset: PrintConditionPreset) {
    this.paperXyz = labToXyz(preset.paper);
    const { c, m, y, k } = preset.tvi50;
    this.gain = [4 * c, 4 * m, 4 * y, 4 * k];
    const { solids } = preset;
    const black = labToXyz(solids.k);
    const primaries = [preset.paper, solids.c, solids.m, solids.cm, solids.y, solids.cy, solids.my, solids.cmy];
    primaries.forEach((lab, i) => {
      const xyz = labToXyz(lab);
      const overprintY = xyz[1] * black[1] / this.paperXyz[1] ** 2;
      const floor = Math.max(1, MIN_REFLECTANCE / overprintY);
      for (let j = 0; j < 3; j++) {
        const relative = xyz[j] / this.paperXyz[j];
        const base = Math.sqrt(relative);
        this.primary[j * 16 + i] = base;
        this.primary[j * 16 + i + 8] = Math.sqrt(relative * black[j] / this.paperXyz[j] * floor) - base;
      }
    });
    // Convert the eight Demichel weights into equivalent trilinear coefficients.
    for (let axis = 0; axis < 3; axis++) {
      for (let i = 0; i < 48; i++) if (i & (1 << axis)) this.primary[i] -= this.primary[i ^ (1 << axis)];
    }
    this.blackPoint = this.findBlackPoint();
  }

  private mix(c: number, m: number, y: number, k: number, derivatives: boolean): void {
    const a = coverage(c, this.gain[0]);
    const b = coverage(m, this.gain[1]);
    const d = coverage(y, this.gain[2]);
    const t = coverage(k, this.gain[3]);
    const p = this.primary;
    for (let j = 0; j < 3; j++) {
      const o = j * 16;
      const v1 = p[o + 1] + t * p[o + 9];
      const v2 = p[o + 2] + t * p[o + 10];
      const v3 = p[o + 3] + t * p[o + 11];
      const v4 = p[o + 4] + t * p[o + 12];
      const v5 = p[o + 5] + t * p[o + 13];
      const v6 = p[o + 6] + t * p[o + 14];
      const v7 = p[o + 7] + t * p[o + 15];
      this.roots[j] = p[o] + t * p[o + 8] + a * (v1 + b * v3) + b * v2
        + d * (v4 + a * v5 + b * (v6 + a * v7));
      if (derivatives) {
        const base = j * 4;
        this.jacobian[base] = (v1 + b * v3 + d * (v5 + b * v7)) * (1 + this.gain[0] * (1 - 2 * c));
        this.jacobian[base + 1] = (v2 + a * v3 + d * (v6 + a * v7)) * (1 + this.gain[1] * (1 - 2 * m));
        this.jacobian[base + 2] = (v4 + a * v5 + b * (v6 + a * v7)) * (1 + this.gain[2] * (1 - 2 * y));
        this.jacobian[base + 3] = (p[o + 8] + a * (p[o + 9] + b * p[o + 11]) + b * p[o + 10]
          + d * (p[o + 12] + a * p[o + 13] + b * (p[o + 14] + a * p[o + 15]))) * (1 + this.gain[3] * (1 - 2 * k));
      }
    }
  }

  cmykToLab(c: number, m: number, y: number, k: number, out: Vec3 = [0, 0, 0]): Vec3 {
    this.mix(clampUnit(c), clampUnit(m), clampUnit(y), clampUnit(k), false);
    for (let i = 0; i < 3; i++) out[i] = this.roots[i] ** 2 * this.paperXyz[i];
    return xyzToLab(out, D50_WHITE, out);
  }

  cmykToRelativeXyz(c: number, m: number, y: number, k: number, out: Vec3 = [0, 0, 0]): Vec3 {
    this.mix(clampUnit(c), clampUnit(m), clampUnit(y), clampUnit(k), false);
    for (let i = 0; i < 3; i++) out[i] = this.roots[i] ** 2 * D50_WHITE[i];
    return out;
  }

  private evaluate(ink: Cmyk, derivatives: boolean, perceptual: boolean): number {
    this.mix(ink[0], ink[1], ink[2], ink[3], derivatives);
    const j = this.jacobian;
    for (let i = 0; i < 3; i++) {
      const root = this.roots[i];
      const value = root * root;
      const nonlinear = value > LAB_EPSILON;
      const f = nonlinear ? Math.cbrt(value) : LAB_SLOPE * value + 4 / 29;
      this.currentLab[i] = f;
      if (derivatives) {
        const slope = 2 * root * (nonlinear ? 1 / (3 * f * f) : LAB_SLOPE);
        for (let channel = 0; channel < 4; channel++) j[i * 4 + channel] *= slope;
      }
    }
    const [x, y, z] = this.currentLab;
    this.currentLab[0] = 116 * y - 16;
    this.currentLab[1] = 500 * (x - y);
    this.currentLab[2] = 200 * (y - z);
    const [wl, wa, wb] = this.weights;
    if (derivatives) {
      for (let i = 0; i < 4; i++) {
        const dy = j[i + 4];
        j[i + 4] = 500 * wa * (j[i] - dy);
        j[i + 8] = 200 * wb * (dy - j[i + 8]);
        j[i] = 116 * wl * dy;
      }
    }
    if (perceptual) return deltaE2000(this.targetLab, this.currentLab) ** 2;
    return ((this.targetLab[0] - this.currentLab[0]) * wl) ** 2
      + ((this.targetLab[1] - this.currentLab[1]) * wa) ** 2
      + ((this.targetLab[2] - this.currentLab[2]) * wb) ** 2;
  }

  private solve(ink: Cmyk, channels: number, iterations: number, perceptual = false): number {
    const limit = this.preset.tac;
    const { residual, jacobian, trial, step } = this;
    constrain(ink, channels, limit);
    let damping = 0.03;
    let score = this.evaluate(ink, true, perceptual);
    for (let iteration = 0; iteration < iterations && score > 0.0001; iteration++) {
      for (let i = 0; i < 3; i++) {
        const value = this.currentLab[i];
        if (perceptual) {
          // Use the actual CIEDE2000 gradient with the weighted Lab Jacobian as its curvature model.
          const epsilon = 0.001;
          this.currentLab[i] = value + epsilon;
          const hi = deltaE2000(this.targetLab, this.currentLab) ** 2;
          this.currentLab[i] = value - epsilon;
          const lo = deltaE2000(this.targetLab, this.currentLab) ** 2;
          this.currentLab[i] = value;
          residual[i] = (lo - hi) / (4 * epsilon * this.weights[i]);
        } else {
          residual[i] = (this.targetLab[i] - value) * this.weights[i];
        }
      }
      const total = ink[0] + ink[1] + ink[2] + ink[3];
      let free = (1 << channels) - 1;
      let tangent = false;
      while (free) {
        dampedStep(jacobian, residual, free, tangent, damping, step);
        if (!tangent && total >= limit - INK_EPSILON && step[0] + step[1] + step[2] + step[3] > 0) {
          tangent = true;
          continue;
        }
        let worst = INK_EPSILON;
        let blocked = 0;
        for (let i = 0; i < channels; i++) {
          const violation = ink[i] <= INK_EPSILON ? -step[i] : ink[i] >= 1 - INK_EPSILON ? step[i] : 0;
          if (violation > worst) {
            worst = violation;
            blocked = 1 << i;
          }
        }
        if (!blocked) break;
        free &= ~blocked;
      }
      if (!free || Math.abs(step[0]) + Math.abs(step[1]) + Math.abs(step[2]) + Math.abs(step[3]) < INK_EPSILON) break;

      let accepted = false;
      let scale = 1;
      for (let attempt = 0; attempt < 5; attempt++, scale *= 0.5) {
        for (let i = 0; i < 4; i++) trial[i] = ink[i] + scale * step[i];
        constrain(trial, channels, limit);
        if (this.evaluate(trial, false, perceptual) >= score - 1e-8) continue;
        for (let i = 0; i < 4; i++) ink[i] = trial[i];
        accepted = true;
        break;
      }
      const oldScore = score;
      score = this.evaluate(ink, true, perceptual);
      if (accepted && oldScore - score < 1e-5) break;
      damping = accepted ? Math.max(0.03, damping * 0.3) : damping * 20;
    }
    return score;
  }

  private findBlackPoint(): Vec3 {
    const { cmyk } = this.relativeXyzToCmyk([0, 0, 0]);
    this.weights[0] = 1;
    this.weights[1] = this.weights[2] = 0;
    this.solve(cmyk, 4, 18);
    let darkest = this.cmykToRelativeXyz(...cmyk);
    const [, a, b] = xyzToLab(darkest);
    let chroma = Math.hypot(a, b);
    for (let i = 0; i < 8; i++) {
      const ink: Cmyk = [i & 1, (i >> 1) & 1, (i >> 2) & 1, 1];
      if (ink[0] + ink[1] + ink[2] + ink[3] > this.preset.tac) continue;
      const candidate = this.cmykToRelativeXyz(...ink);
      const [, a, b] = xyzToLab(candidate);
      const saturation = Math.hypot(a, b);
      if (candidate[1] < darkest[1] - 1e-12 || (Math.abs(candidate[1] - darkest[1]) <= 1e-12 && saturation < chroma)) {
        darkest = candidate;
        chroma = saturation;
      }
    }
    return darkest;
  }

  relativeXyzToCmyk(xyz: Vec3, warm?: Cmyk): { cmyk: Cmyk; xyz: Vec3; deltaE: number } {
    xyzToLab(xyz, D50_WHITE, this.targetLab);
    if (sameWhite(xyz, D50_WHITE) || sameWhite(xyz, SRGB_WHITE)) {
      return { cmyk: [0, 0, 0, 0], xyz: [...D50_WHITE], deltaE: deltaE2000(this.targetLab, [100, 0, 0]) };
    }
    labWeights(this.targetLab, this.weights);
    const cmy: Cmyk = [0, 0, 0, 0];
    const cmyScore = this.solve(cmy, 3, 8);
    const gray = Math.min(cmy[0], cmy[1], cmy[2]);
    const k = clampUnit(gray * (0.55 + 0.45 * gray));
    const initial: Cmyk = [Math.max(0, cmy[0] - k * 0.8), Math.max(0, cmy[1] - k * 0.8), Math.max(0, cmy[2] - k * 0.8), k];
    let cmyk = initial;
    let score: number | undefined;
    if (warm && Math.abs(warm[3] - k) < 0.05) {
      const nearby: Cmyk = [warm[0], warm[1], warm[2], k];
      if (this.evaluate(nearby, false, false) < this.evaluate(initial, false, false)) {
        const warmScore = this.solve(nearby, 3, 5);
        // Keep gamut clipping independent of the LUT traversal order.
        if (warmScore <= 0.0001) {
          cmyk = nearby;
          score = warmScore;
        }
      }
    }
    score ??= this.solve(cmyk, 3, 8);
    if (score > 0.0001) {
      if (cmyScore < score) {
        for (let i = 0; i < 4; i++) cmyk[i] = cmy[i];
        score = cmyScore;
      }
      // The fixed-K result can be on a boundary even when another K is printable.
      if (score > 0.0001) score = this.solve(cmyk, 4, 18);
      if (score > 0.0004) this.solve(cmyk, 4, 12, true);
    }
    const printed = this.cmykToRelativeXyz(...cmyk);
    return { cmyk, xyz: printed, deltaE: deltaE2000(this.targetLab, xyzToLab(printed, D50_WHITE, this.currentLab)) };
  }
}
