export type Vec3 = [number, number, number];

export const D50_WHITE: Vec3 = [0.9642, 1, 0.8249];
export const SRGB_D50_MATRIX = [
  0.4360747, 0.3850649, 0.1430804,
  0.2225045, 0.7168786, 0.0606169,
  0.0139322, 0.0971045, 0.7141733,
] as const;

const EPSILON = 216 / 24389;
const KAPPA = 24389 / 27;
const TAU = 2 * Math.PI;
const DEG = Math.PI / 180;
const C25_7 = 25 ** 7;

export function clampUnit(v: number): number {
  return Math.max(0, Math.min(1, v));
}

export function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

export function linearToSrgb(v: number): number {
  return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
}

export function invertMatrix3(m: ArrayLike<number>): number[] | null {
  const [a, b, c, d, e, f, g, h, i] = Array.from(m);
  const adjugate = [
    e * i - f * h, c * h - b * i, b * f - c * e,
    f * g - d * i, a * i - c * g, c * d - a * f,
    d * h - e * g, b * g - a * h, a * e - b * d,
  ];
  const determinant = a * adjugate[0] + b * adjugate[3] + c * adjugate[6];
  return Math.abs(determinant) > 1e-12 ? adjugate.map(value => value / determinant) : null;
}

const XYZ_TO_SRGB = invertMatrix3(SRGB_D50_MATRIX)!;

export function srgb8ToXyzD50(r: number, g: number, b: number, out: Vec3 = [0, 0, 0]): Vec3 {
  const red = srgbToLinear(r / 255);
  const green = srgbToLinear(g / 255);
  const blue = srgbToLinear(b / 255);
  for (let i = 0; i < 3; i++) {
    out[i] = SRGB_D50_MATRIX[i * 3] * red + SRGB_D50_MATRIX[i * 3 + 1] * green + SRGB_D50_MATRIX[i * 3 + 2] * blue;
  }
  return out;
}

export function xyzD50ToLinearSrgb(xyz: Vec3, out: Vec3 = [0, 0, 0]): Vec3 {
  const [x, y, z] = xyz;
  for (let i = 0; i < 3; i++) {
    out[i] = XYZ_TO_SRGB[i * 3] * x + XYZ_TO_SRGB[i * 3 + 1] * y + XYZ_TO_SRGB[i * 3 + 2] * z;
  }
  return out;
}

function labForward(t: number): number {
  return t > EPSILON ? Math.cbrt(t) : (KAPPA * t + 16) / 116;
}

function labInverse(t: number): number {
  return t > 6 / 29 ? t * t * t : (116 * t - 16) / KAPPA;
}

export function xyzToLab(xyz: Vec3, white: Vec3 = D50_WHITE, out: Vec3 = [0, 0, 0]): Vec3 {
  const x = labForward(xyz[0] / white[0]);
  const y = labForward(xyz[1] / white[1]);
  const z = labForward(xyz[2] / white[2]);
  out[0] = 116 * y - 16;
  out[1] = 500 * (x - y);
  out[2] = 200 * (y - z);
  return out;
}

export function labToXyz(lab: Vec3, white: Vec3 = D50_WHITE, out: Vec3 = [0, 0, 0]): Vec3 {
  const [l, a, b] = lab;
  const y = (l + 16) / 116;
  out[0] = white[0] * labInverse(y + a / 500);
  out[1] = white[1] * labInverse(y);
  out[2] = white[2] * labInverse(y - b / 200);
  return out;
}

export function deltaE76(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function hue(a: number, b: number): number {
  const angle = Math.atan2(b, a);
  return angle < 0 ? angle + TAU : angle;
}

export function deltaE2000(a: Vec3, b: Vec3): number {
  const [l1, a1, b1] = a;
  const [l2, a2, b2] = b;
  const meanC7 = ((Math.sqrt(a1 * a1 + b1 * b1) + Math.sqrt(a2 * a2 + b2 * b2)) / 2) ** 7;
  const scaleA = 1.5 - 0.5 * Math.sqrt(meanC7 / (meanC7 + C25_7));
  const c1 = Math.sqrt((scaleA * a1) ** 2 + b1 ** 2);
  const c2 = Math.sqrt((scaleA * a2) ** 2 + b2 ** 2);
  const h1 = hue(scaleA * a1, b1);
  const h2 = hue(scaleA * a2, b2);
  let dh = 0;
  let meanH = h1 + h2;
  if (c1 * c2 !== 0) {
    dh = h2 - h1;
    if (dh > Math.PI + 1e-14) dh -= TAU;
    if (dh < -Math.PI - 1e-14) dh += TAU;
    if (Math.abs(h2 - h1) > Math.PI + 1e-14) meanH += meanH < TAU ? TAU : -TAU;
    meanH /= 2;
  }

  const meanL50Squared = ((l1 + l2) / 2 - 50) ** 2;
  const meanC = (c1 + c2) / 2;
  const t = 1 - 0.17 * Math.cos(meanH - 30 * DEG) + 0.24 * Math.cos(2 * meanH)
    + 0.32 * Math.cos(3 * meanH + 6 * DEG) - 0.20 * Math.cos(4 * meanH - 63 * DEG);
  const lightness = (l2 - l1) / (1 + 0.015 * meanL50Squared / Math.sqrt(20 + meanL50Squared));
  const chroma = (c2 - c1) / (1 + 0.045 * meanC);
  const hueTerm = 2 * Math.sqrt(c1 * c2) * Math.sin(dh / 2) / (1 + 0.015 * meanC * t);
  const meanAdjustedC7 = meanC ** 7;
  const rotation = -2 * Math.sqrt(meanAdjustedC7 / (meanAdjustedC7 + C25_7))
    * Math.sin(60 * DEG * Math.exp(-(((meanH / DEG - 275) / 25) ** 2)));
  return Math.sqrt(Math.max(0, lightness ** 2 + chroma ** 2 + hueTerm ** 2 + rotation * chroma * hueTerm));
}
