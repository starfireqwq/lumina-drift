export type PuppetMeshDensity = 'coarse' | 'normal' | 'dense';

export interface PuppetPin {
  id: string;
  x: number;
  y: number;
  restX: number;
  restY: number;
  rotation: number;
  weight: number;
  triangleIndex: number;
  barycentric: [number, number, number];
}

export interface PuppetMesh {
  width: number;
  height: number;
  cellSize: number;
  vertices: Float32Array;
  triangles: Uint32Array;
  neighbors: number[][];
  edgeWeights: Float32Array[];
  vertexCount: number;
  triangleCount: number;
}

export interface PuppetMeshOptions {
  density?: PuppetMeshDensity;
  expansionPx?: number;
  alphaThreshold?: number;
}

interface Bounds {
  minX: number;
  minY: number;
  width: number;
  height: number;
}

const GRID_DIVISIONS: Record<PuppetMeshDensity, number> = { coarse: 12, normal: 18, dense: 22 };
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const finite = (value: number, fallback: number) => Number.isFinite(value) ? value : fallback;
const pinWeight = (weight: number) => clamp(finite(weight, 1), 0.1, 5);

export function buildPuppetMeshFromAlpha(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  options: PuppetMeshOptions = {},
): PuppetMesh {
  width = Math.max(1, Math.floor(finite(width, 1)));
  height = Math.max(1, Math.floor(finite(height, 1)));
  const threshold = clamp(finite(options.alphaThreshold ?? 12, 12), 1, 255);
  const defaultExpansion = Math.max(4, Math.round(Math.min(width, height) * 0.02));
  const expansion = clamp(Math.ceil(finite(options.expansionPx ?? defaultExpansion, defaultExpansion)), 0, Math.max(width, height));
  let left = width;
  let top = height;
  let right = 0;
  let bottom = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!(rgba[(y * width + x) * 4 + 3] > 0)) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x + 1);
      bottom = y + 1;
    }
  }
  const fallback = right <= left || bottom <= top || Math.max(right - left, bottom - top) <= 2;
  // One texel of support also covers bilinear sampling of the faintest alpha pixels.
  const reach = expansion + 1;
  // A tight layer crop can end on a painted pixel. Include its half-texel filter
  // footprint outside the crop, where the source sampler treats pixels as transparent.
  const minX = left === 0 ? -0.5 : 0;
  const minY = top === 0 ? -0.5 : 0;
  const maxX = right === width ? width + 0.5 : width;
  const maxY = bottom === height ? height + 0.5 : height;
  left = fallback ? minX : Math.max(minX, left - reach);
  top = fallback ? minY : Math.max(minY, top - reach);
  right = fallback ? maxX : Math.min(maxX, right + reach);
  bottom = fallback ? maxY : Math.min(maxY, bottom + reach);
  const divisions = GRID_DIVISIONS[options.density ?? 'normal'];
  const cellSize = Math.max(right - left, bottom - top) / (fallback ? 2 : divisions);
  const cols = fallback ? 2 : Math.max(1, Math.ceil((right - left) / cellSize - 1e-9));
  const rows = fallback ? 2 : Math.max(1, Math.ceil((bottom - top) / cellSize - 1e-9));
  const stepX = (right - left) / cols;
  const stepY = (bottom - top) / rows;
  const stride = cols + 1;
  const used = new Uint8Array(stride * (rows + 1));
  const faces: number[] = [];

  // Test the dilated mask at cell granularity without allocating a second full-resolution image.
  const coversForeground = (x0: number, y0: number, x1: number, y1: number) => {
    const startX = Math.max(0, Math.floor(x0 - reach));
    const endX = Math.min(width, Math.ceil(x1 + reach));
    const endY = Math.min(height, Math.ceil(y1 + reach));
    for (let y = Math.max(0, Math.floor(y0 - reach)); y < endY; y++) {
      for (let x = startX; x < endX; x++) {
        const alpha = rgba[(y * width + x) * 4 + 3];
        if (alpha >= threshold) return true;
        if (alpha > 0 && x + 1 > x0 - 1 && x < x1 + 1 && y + 1 > y0 - 1 && y < y1 + 1) return true;
      }
    }
    return false;
  };

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = left + col * stepX;
      const y = top + row * stepY;
      if (!fallback && !coversForeground(x, y, x + stepX, y + stepY)) continue;
      const a = row * stride + col;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;
      used[a] = used[b] = used[c] = used[d] = 1;
      if ((row + col) % 2 === 0) faces.push(a, b, d, a, d, c);
      else faces.push(a, b, c, b, d, c);
    }
  }

  const points: number[] = [];
  const indices = new Uint32Array(used.length);
  used.forEach((present, index) => {
    if (!present) return;
    indices[index] = points.length / 2;
    points.push(left + (index % stride) * stepX, top + Math.floor(index / stride) * stepY);
  });
  const vertices = Float32Array.from(points);
  const triangles = Uint32Array.from(faces, (index) => indices[index]);
  const vertexCount = vertices.length / 2;
  const adjacency = Array.from({ length: vertexCount }, () => new Set<number>());
  for (let i = 0; i < triangles.length; i += 3) {
    const a = triangles[i];
    const b = triangles[i + 1];
    const c = triangles[i + 2];
    adjacency[a].add(b).add(c);
    adjacency[b].add(a).add(c);
    adjacency[c].add(a).add(b);
  }
  const neighbors = adjacency.map((edges) => [...edges]);
  const edgeWeights = neighbors.map((edges) => new Float32Array(edges.length).fill(1));
  return { width, height, cellSize, vertices, triangles, neighbors, edgeWeights, vertexCount, triangleCount: triangles.length / 3 };
}

const cross = (ax: number, ay: number, bx: number, by: number) => ax * by - ay * bx;

let nextPinId = 0;

export function attachPinToMesh(mesh: PuppetMesh, x: number, y: number, id?: string, weight = 1): PuppetPin {
  const { vertices, triangles } = mesh;
  x = finite(x, mesh.width / 2);
  y = finite(y, mesh.height / 2);
  let closestX = vertices[0];
  let closestY = vertices[1];
  let closestDistance = Infinity;
  let triangleIndex = 0;
  let barycentric: PuppetPin['barycentric'] = [1, 0, 0];

  for (let i = 0; i < triangles.length; i += 3) {
    const a = 2 * triangles[i];
    const b = 2 * triangles[i + 1];
    const c = 2 * triangles[i + 2];
    const ax = vertices[a];
    const ay = vertices[a + 1];
    const bx = vertices[b] - ax;
    const by = vertices[b + 1] - ay;
    const cx = vertices[c] - ax;
    const cy = vertices[c + 1] - ay;
    const area = cross(bx, by, cx, cy);
    if (area !== 0) {
      const v = cross(x - ax, y - ay, cx, cy) / area;
      const w = cross(bx, by, x - ax, y - ay) / area;
      if (v >= 0 && w >= 0 && v + w <= 1) {
        triangleIndex = i / 3;
        barycentric = [1 - (v + w), v, w];
        closestX = x;
        closestY = y;
        break;
      }
    }
    for (let edge = 0; edge < 3; edge++) {
      const end = (edge + 1) % 3;
      const startIndex = 2 * triangles[i + edge];
      const endIndex = 2 * triangles[i + end];
      const startX = vertices[startIndex];
      const startY = vertices[startIndex + 1];
      const dx = vertices[endIndex] - startX;
      const dy = vertices[endIndex + 1] - startY;
      const lengthSq = dx * dx + dy * dy;
      const t = lengthSq ? clamp(((x - startX) * dx + (y - startY) * dy) / lengthSq, 0, 1) : 0;
      const px = startX + t * dx;
      const py = startY + t * dy;
      const distance = Math.hypot(px - x, py - y);
      if (distance >= closestDistance) continue;
      closestDistance = distance;
      closestX = px;
      closestY = py;
      triangleIndex = i / 3;
      barycentric = [0, 0, 0];
      barycentric[edge] = 1 - t;
      barycentric[end] = t;
    }
  }

  return {
    id: id ?? `puppet-pin-${++nextPinId}`,
    x: closestX, y: closestY, restX: closestX, restY: closestY,
    rotation: 0, weight: pinWeight(weight), triangleIndex, barycentric,
  };
}

interface Constraint {
  pin: PuppetPin;
  indices: [number, number, number];
  strength: number;
  rotationStrength: number;
  cos: number;
  sin: number;
}

interface Component {
  vertices: number[];
  faces: number[];
  pins: Constraint[];
}

function findComponents(mesh: PuppetMesh, pins: readonly PuppetPin[]): Component[] {
  const labels = new Int32Array(mesh.vertexCount).fill(-1);
  const components: Component[] = [];
  for (let root = 0; root < mesh.vertexCount; root++) {
    if (labels[root] !== -1) continue;
    const component = { vertices: [root], faces: [], pins: [] } satisfies Component;
    const label = components.length;
    components.push(component);
    labels[root] = label;
    for (let i = 0; i < component.vertices.length; i++) {
      for (const next of mesh.neighbors[component.vertices[i]]) {
        if (labels[next] !== -1) continue;
        labels[next] = label;
        component.vertices.push(next);
      }
    }
  }
  for (let i = 0; i < mesh.triangles.length; i += 3) {
    components[labels[mesh.triangles[i]]].faces.push(i);
  }
  for (const pin of pins) {
    const i = pin.triangleIndex * 3;
    if (!Number.isInteger(i) || i < 0 || i + 2 >= mesh.triangles.length) continue;
    const indices: Constraint['indices'] = [mesh.triangles[i], mesh.triangles[i + 1], mesh.triangles[i + 2]];
    const weight = pinWeight(pin.weight);
    const rotation = finite(pin.rotation, 0);
    components[labels[indices[0]]].pins.push({
      pin, indices, strength: 240 * weight, rotationStrength: rotation === 0 ? 0 : 3 * weight,
      cos: Math.cos(rotation), sin: Math.sin(rotation),
    });
  }
  return components;
}

function setRigidPoint(result: Float64Array, rest: Float32Array, i: number, pin: PuppetPin) {
  const x = rest[2 * i] - pin.restX;
  const y = rest[2 * i + 1] - pin.restY;
  const cos = Math.cos(finite(pin.rotation, 0));
  const sin = Math.sin(finite(pin.rotation, 0));
  result[2 * i] = finite(pin.x, pin.restX) + cos * x - sin * y;
  result[2 * i + 1] = finite(pin.y, pin.restY) + sin * x + cos * y;
}

function nearestPin(vertices: Float32Array, component: Component, pins: readonly PuppetPin[]): PuppetPin {
  let nearest = pins[0];
  let shortest = Infinity;
  for (const pin of pins) {
    for (const i of component.vertices) {
      const dx = vertices[2 * i] - pin.restX;
      const dy = vertices[2 * i + 1] - pin.restY;
      const distance = dx * dx + dy * dy;
      if (distance < shortest) {
        shortest = distance;
        nearest = pin;
      }
    }
  }
  return nearest;
}

function rigidFit(pins: readonly Constraint[], weights: Float64Array) {
  let restX = 0;
  let restY = 0;
  let x = 0;
  let y = 0;
  let sum = 0;
  for (let i = 0; i < pins.length; i++) {
    const { pin } = pins[i];
    const w = weights[i];
    restX += w * pin.restX;
    restY += w * pin.restY;
    x += w * finite(pin.x, pin.restX);
    y += w * finite(pin.y, pin.restY);
    sum += w;
  }
  restX /= sum;
  restY /= sum;
  x /= sum;
  y /= sum;
  let dot = 0;
  let det = 0;
  let rotationX = 0;
  let rotationY = 0;
  for (let i = 0; i < pins.length; i++) {
    const { pin, cos, sin } = pins[i];
    const dx = pin.restX - restX;
    const dy = pin.restY - restY;
    const tx = finite(pin.x, pin.restX) - x;
    const ty = finite(pin.y, pin.restY) - y;
    dot += weights[i] * (dx * tx + dy * ty);
    det += weights[i] * cross(dx, dy, tx, ty);
    rotationX += weights[i] * cos;
    rotationY += weights[i] * sin;
  }
  const angle = Math.hypot(dot, det) > 1e-10 ? Math.atan2(det, dot) : Math.atan2(rotationY, rotationX);
  return { restX, restY, x, y, cos: Math.cos(angle), sin: Math.sin(angle) };
}

function orientedArea(triangles: Uint32Array, i: number, vertices: Float32Array | Float64Array) {
  const a = triangles[i] * 2;
  const b = triangles[i + 1] * 2;
  const c = triangles[i + 2] * 2;
  return cross(vertices[b] - vertices[a], vertices[b + 1] - vertices[a + 1],
    vertices[c] - vertices[a], vertices[c + 1] - vertices[a + 1]);
}

function hasValidFaces(mesh: PuppetMesh, component: Component, vertices: Float64Array) {
  return component.faces.every((i) => {
    const area = orientedArea(mesh.triangles, i, vertices);
    return Number.isFinite(area) && area > 0.005 * orientedArea(mesh.triangles, i, mesh.vertices);
  });
}

function initializeComponent(mesh: PuppetMesh, component: Component, result: Float64Array) {
  const { vertices } = mesh;
  const { pins } = component;
  const weights = new Float64Array(pins.length);
  for (const i of component.vertices) {
    const x = vertices[2 * i];
    const y = vertices[2 * i + 1];
    for (let j = 0; j < pins.length; j++) {
      const { pin, strength } = pins[j];
      const dx = x - pin.restX;
      const dy = y - pin.restY;
      weights[j] = strength / (dx * dx + dy * dy + 1e-3);
    }
    const fit = rigidFit(pins, weights);
    const dx = x - fit.restX;
    const dy = y - fit.restY;
    result[2 * i] = fit.x + fit.cos * dx - fit.sin * dy;
    result[2 * i + 1] = fit.y + fit.sin * dx + fit.cos * dy;
  }
  if (hasValidFaces(mesh, component, result)) return;

  const fit = rigidFit(pins, Float64Array.from(pins, ({ strength }) => strength));
  for (const i of component.vertices) {
    const dx = vertices[2 * i] - fit.restX;
    const dy = vertices[2 * i + 1] - fit.restY;
    result[2 * i] = fit.x + fit.cos * dx - fit.sin * dy;
    result[2 * i + 1] = fit.y + fit.sin * dx + fit.cos * dy;
  }
}

// Pin terms only connect vertices of the same face. Row-major mesh indices keep the
// system narrow, so we can factor it once and solve two right-hand sides per iteration.
function factorSystem(mesh: PuppetMesh, components: readonly Component[]) {
  let band = 0;
  mesh.neighbors.forEach((neighbors, i) => {
    for (const j of neighbors) band = Math.max(band, Math.abs(i - j));
  });
  const stride = band + 1;
  const matrix = new Float64Array(mesh.vertexCount * stride);
  const add = (i: number, j: number, value: number) => {
    matrix[Math.max(i, j) * stride + Math.abs(i - j)] += value;
  };
  for (const component of components) {
    for (const i of component.vertices) {
      if (component.pins.length < 2) {
        add(i, i, 1);
        continue;
      }
      mesh.neighbors[i].forEach((j, k) => {
        const w = mesh.edgeWeights[i][k];
        add(i, i, w);
        if (j < i) add(i, j, -w);
      });
    }
    if (component.pins.length < 2) continue;
    for (const { pin, indices, strength, rotationStrength } of component.pins) {
      indices.forEach((i, a) => {
        const w = pin.barycentric[a];
        add(i, i, strength * w * w + 2 * rotationStrength);
        for (let b = 0; b < a; b++) {
          add(i, indices[b], strength * w * pin.barycentric[b] - rotationStrength);
        }
      });
    }
  }
  for (let i = 0; i < mesh.vertexCount; i++) {
    for (let j = Math.max(0, i - band); j <= i; j++) {
      let value = matrix[i * stride + i - j];
      for (let k = Math.max(0, i - band); k < j; k++) {
        value -= matrix[i * stride + i - k] * matrix[j * stride + j - k];
      }
      matrix[i * stride + i - j] = i === j ? Math.sqrt(Math.max(1e-12, value)) : value / matrix[j * stride];
    }
  }
  return (rhs: Float64Array) => {
    for (let i = 0; i < mesh.vertexCount; i++) {
      for (let j = Math.max(0, i - band); j < i; j++) {
        const l = matrix[i * stride + i - j];
        rhs[2 * i] -= l * rhs[2 * j];
        rhs[2 * i + 1] -= l * rhs[2 * j + 1];
      }
      rhs[2 * i] /= matrix[i * stride];
      rhs[2 * i + 1] /= matrix[i * stride];
    }
    for (let i = mesh.vertexCount - 1; i >= 0; i--) {
      for (let j = i + 1; j <= Math.min(i + band, mesh.vertexCount - 1); j++) {
        const l = matrix[j * stride + j - i];
        rhs[2 * i] -= l * rhs[2 * j];
        rhs[2 * i + 1] -= l * rhs[2 * j + 1];
      }
      rhs[2 * i] /= matrix[i * stride];
      rhs[2 * i + 1] /= matrix[i * stride];
    }
  };
}

function arapStep(
  mesh: PuppetMesh,
  components: readonly Component[],
  current: Float64Array,
  rhs: Float64Array,
  rotations: Float64Array,
) {
  const { vertices, neighbors, edgeWeights } = mesh;
  rhs.set(current);
  for (const component of components) {
    if (component.pins.length < 2) continue;
    // Local step: the dot product and determinant are the trace and skew of the covariance.
    for (const i of component.vertices) {
      let dot = 0;
      let det = 0;
      neighbors[i].forEach((j, k) => {
        const x = vertices[2 * i] - vertices[2 * j];
        const y = vertices[2 * i + 1] - vertices[2 * j + 1];
        const dx = current[2 * i] - current[2 * j];
        const dy = current[2 * i + 1] - current[2 * j + 1];
        dot += edgeWeights[i][k] * (x * dx + y * dy);
        det += edgeWeights[i][k] * cross(x, y, dx, dy);
      });
      const angle = Math.atan2(det, dot);
      rotations[2 * i] = Math.cos(angle);
      rotations[2 * i + 1] = Math.sin(angle);
    }
    for (const { indices, rotationStrength, cos, sin } of component.pins) {
      if (!rotationStrength) continue;
      for (const i of indices) {
        rotations[2 * i] += rotationStrength * cos;
        rotations[2 * i + 1] += rotationStrength * sin;
      }
    }
    for (const i of component.vertices) {
      const angle = Math.atan2(rotations[2 * i + 1], rotations[2 * i]);
      rotations[2 * i] = Math.cos(angle);
      rotations[2 * i + 1] = Math.sin(angle);
    }

    // Global step RHS: average the two adjacent rotations on each rest edge.
    for (const i of component.vertices) {
      let x = 0;
      let y = 0;
      neighbors[i].forEach((j, k) => {
        const dx = vertices[2 * i] - vertices[2 * j];
        const dy = vertices[2 * i + 1] - vertices[2 * j + 1];
        const cos = (rotations[2 * i] + rotations[2 * j]) * 0.5;
        const sin = (rotations[2 * i + 1] + rotations[2 * j + 1]) * 0.5;
        x += edgeWeights[i][k] * (cos * dx - sin * dy);
        y += edgeWeights[i][k] * (sin * dx + cos * dy);
      });
      rhs[2 * i] = x;
      rhs[2 * i + 1] = y;
    }
    for (const { pin, indices, strength, rotationStrength, cos, sin } of component.pins) {
      const x = finite(pin.x, pin.restX);
      const y = finite(pin.y, pin.restY);
      indices.forEach((i, a) => {
        const w = strength * pin.barycentric[a];
        rhs[2 * i] += w * x;
        rhs[2 * i + 1] += w * y;
        if (!rotationStrength) return;
        for (let b = 0; b < a; b++) {
          const j = indices[b];
          const dx = vertices[2 * i] - vertices[2 * j];
          const dy = vertices[2 * i + 1] - vertices[2 * j + 1];
          const rx = rotationStrength * (cos * dx - sin * dy);
          const ry = rotationStrength * (sin * dx + cos * dy);
          rhs[2 * i] += rx;
          rhs[2 * i + 1] += ry;
          rhs[2 * j] -= rx;
          rhs[2 * j + 1] -= ry;
        }
      });
    }
  }
}

export function solvePuppetWarp(mesh: PuppetMesh, pins: ReadonlyArray<PuppetPin>, iterations = 6): Float32Array {
  if (pins.length === 0) return mesh.vertices.slice();
  const result = Float64Array.from(mesh.vertices);
  if (pins.length === 1) {
    for (let i = 0; i < mesh.vertexCount; i++) setRigidPoint(result, mesh.vertices, i, pins[0]);
  } else {
    const components = findComponents(mesh, pins);
    for (const component of components) {
      if (component.pins.length >= 2) {
        initializeComponent(mesh, component, result);
      } else {
        const pin = component.pins[0]?.pin ?? nearestPin(mesh.vertices, component, pins);
        for (const i of component.vertices) setRigidPoint(result, mesh.vertices, i, pin);
      }
    }

    const deforming = components.filter(({ pins: componentPins }) => componentPins.length >= 2);
    if (deforming.length) {
      const solve = factorSystem(mesh, components);
      const proposal = new Float64Array(result.length);
      const rotations = new Float64Array(result.length);
      const candidate = result.slice();
      for (let step = 0; step < clamp(Math.floor(finite(iterations, 6)), 0, 100); step++) {
        arapStep(mesh, components, result, proposal, rotations);
        solve(proposal);
        for (const component of deforming) {
          // Keep the last valid mesh when incompatible targets would reverse a face.
          for (let fraction = 1; fraction >= 1 / 128; fraction *= 0.5) {
            for (const i of component.vertices) {
              candidate[2 * i] = result[2 * i] + fraction * (proposal[2 * i] - result[2 * i]);
              candidate[2 * i + 1] = result[2 * i + 1] + fraction * (proposal[2 * i + 1] - result[2 * i + 1]);
            }
            if (!hasValidFaces(mesh, component, candidate)) continue;
            for (const i of component.vertices) {
              result[2 * i] = candidate[2 * i];
              result[2 * i + 1] = candidate[2 * i + 1];
            }
            break;
          }
        }
      }
    }
  }
  return Float32Array.from(result, (value, i) => finite(Math.fround(value), mesh.vertices[i]));
}

const MAX_RASTER_SIDE = 16384;
const MAX_RASTER_PIXELS = 64 * 1024 * 1024;

function rasterBounds(rest: Float32Array, deformed: Float32Array, padding: number, clip?: Bounds): Bounds {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (let i = 0; i < rest.length; i += 2) {
    const x = clamp(finite(deformed[i], rest[i]), -1e9, 1e9);
    const y = clamp(finite(deformed[i + 1], rest[i + 1]), -1e9, 1e9);
    left = Math.min(left, x);
    right = Math.max(right, x);
    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
  }
  padding = clamp(Math.ceil(finite(padding, 2)), 0, MAX_RASTER_SIDE);
  left = Math.floor(left) - padding;
  top = Math.floor(top) - padding;
  right = Math.ceil(right) + padding;
  bottom = Math.ceil(bottom) + padding;
  if (clip) {
    left = Math.max(left, clip.minX);
    top = Math.max(top, clip.minY);
    right = Math.min(right, clip.minX + clip.width);
    bottom = Math.min(bottom, clip.minY + clip.height);
  }
  if (right <= left || bottom <= top) return { minX: clip?.minX ?? 0, minY: clip?.minY ?? 0, width: 1, height: 1 };
  const pixelLimit = Math.max(MAX_RASTER_PIXELS, clip ? clip.width * clip.height : 0);
  let width = Math.min(MAX_RASTER_SIDE, right - left);
  let height = Math.min(MAX_RASTER_SIDE, bottom - top);
  if (width * height > pixelLimit) {
    const scale = Math.sqrt(pixelLimit / (width * height));
    width = Math.floor(width * scale);
    height = Math.floor(height * scale);
  }
  return {
    minX: left + Math.floor((right - left - width) / 2),
    minY: top + Math.floor((bottom - top - height) / 2),
    width, height,
  };
}

function rasterize(
  src: Uint8ClampedArray | Uint8Array,
  srcWidth: number,
  srcHeight: number,
  mesh: PuppetMesh,
  deformed: Float32Array,
  bounds: Bounds,
  pixelBudget = Infinity,
) {
  const { minX, minY, width, height } = bounds;
  const scale = Math.min(1, Math.sqrt(pixelBudget / (width * height)));
  const pixelWidth = Math.max(1, Math.floor(width * scale));
  const pixelHeight = Math.max(1, Math.floor(height * scale));
  const stepX = width / pixelWidth;
  const stepY = height / pixelHeight;
  const rgba = new Uint8ClampedArray(pixelWidth * pixelHeight * 4);
  const { vertices: rest, triangles } = mesh;
  const indexAt = (x: number, y: number) => x >= 0 && y >= 0 && x < srcWidth && y < srcHeight ? (y * srcWidth + x) * 4 : -1;

  for (let i = 0; i < triangles.length; i += 3) {
    const a = 2 * triangles[i];
    const b = 2 * triangles[i + 1];
    const c = 2 * triangles[i + 2];
    const ax = finite(deformed[a], rest[a]);
    const ay = finite(deformed[a + 1], rest[a + 1]);
    const bx = finite(deformed[b], rest[b]);
    const by = finite(deformed[b + 1], rest[b + 1]);
    const cx = finite(deformed[c], rest[c]);
    const cy = finite(deformed[c + 1], rest[c + 1]);
    const area = cross(bx - ax, by - ay, cx - ax, cy - ay);
    if (!Number.isFinite(area) || Math.abs(area) < 1e-12) continue;
    const left = Math.max(0, Math.ceil((Math.min(ax, bx, cx) - minX) / stepX - 0.50000001));
    const right = Math.min(pixelWidth - 1, Math.floor((Math.max(ax, bx, cx) - minX) / stepX - 0.49999999));
    const top = Math.max(0, Math.ceil((Math.min(ay, by, cy) - minY) / stepY - 0.50000001));
    const bottom = Math.min(pixelHeight - 1, Math.floor((Math.max(ay, by, cy) - minY) / stepY - 0.49999999));
    for (let y = top; y <= bottom; y++) {
      const dy = minY + (y + 0.5) * stepY - ay;
      for (let x = left; x <= right; x++) {
        const dx = minX + (x + 0.5) * stepX - ax;
        const v = cross(dx, dy, cx - ax, cy - ay) / area;
        const w = cross(bx - ax, by - ay, dx, dy) / area;
        const u = 1 - v - w;
        if (u < -1e-8 || v < -1e-8 || w < -1e-8) continue;
        // Mesh coordinates use pixel edges. Bilinear coordinates use pixel centers.
        const sx = u * rest[a] + v * rest[b] + w * rest[c] - 0.5;
        const sy = u * rest[a + 1] + v * rest[b + 1] + w * rest[c + 1] - 0.5;
        const ix = Math.floor(sx);
        const iy = Math.floor(sy);
        const fx = sx - ix;
        const fy = sy - iy;
        const tl = indexAt(ix, iy);
        const tr = indexAt(ix + 1, iy);
        const bl = indexAt(ix, iy + 1);
        const br = indexAt(ix + 1, iy + 1);
        // Alpha-weight each contribution before interpolation so hidden RGB cannot tint edges.
        const atl = (src[tl + 3] ?? 0) * (1 - fx) * (1 - fy) * Number(tl >= 0);
        const atr = (src[tr + 3] ?? 0) * fx * (1 - fy) * Number(tr >= 0);
        const abl = (src[bl + 3] ?? 0) * (1 - fx) * fy * Number(bl >= 0);
        const abr = (src[br + 3] ?? 0) * fx * fy * Number(br >= 0);
        const alpha = atl + atr + abl + abr;
        if (alpha <= 0.5) continue;
        const dest = (y * pixelWidth + x) * 4;
        for (let channel = 0; channel < 3; channel++) {
          rgba[dest + channel] = ((src[tl + channel] ?? 0) * atl + (src[tr + channel] ?? 0) * atr
            + (src[bl + channel] ?? 0) * abl + (src[br + channel] ?? 0) * abr) / alpha;
        }
        rgba[dest + 3] = alpha;
      }
    }
  }
  return { rgba, pixelWidth, pixelHeight };
}

export function rasterizePuppetWarpToRgba(
  srcRgba: Uint8ClampedArray | Uint8Array,
  srcWidth: number,
  srcHeight: number,
  mesh: PuppetMesh,
  deformedVertices: Float32Array,
  paddingPx = 2,
): { rgba: Uint8ClampedArray; minX: number; minY: number; width: number; height: number } {
  const bounds = rasterBounds(mesh.vertices, deformedVertices, paddingPx);
  const { rgba } = rasterize(srcRgba, srcWidth, srcHeight, mesh, deformedVertices, bounds);
  return { rgba, ...bounds };
}

interface CanvasRenderOptions {
  sourceRgba?: Uint8ClampedArray;
  previewPixelBudget?: number;
  clipBounds?: Bounds;
}

export function renderPuppetWarpToCanvas(
  sourceCanvas: HTMLCanvasElement,
  mesh: PuppetMesh,
  deformedVertices: Float32Array,
  initialBounds: Bounds,
  { sourceRgba, previewPixelBudget, clipBounds }: CanvasRenderOptions = {},
): { canvas: HTMLCanvasElement; bounds: Bounds } {
  const { width, height } = sourceCanvas;
  const source = sourceRgba ?? sourceCanvas.getContext('2d')?.getImageData(0, 0, width, height).data;
  if (!source) throw new Error('Puppet Warp requires a 2D source canvas');
  const clip = clipBounds && {
    ...clipBounds, minX: clipBounds.minX - initialBounds.minX, minY: clipBounds.minY - initialBounds.minY,
  };
  const bounds = rasterBounds(mesh.vertices, deformedVertices, 2, clip);
  const budget = previewPixelBudget === undefined ? undefined : Math.max(1, finite(previewPixelBudget, 1));
  const output = rasterize(source, width, height, mesh, deformedVertices, bounds, budget);
  const canvas = document.createElement('canvas');
  canvas.width = output.pixelWidth;
  canvas.height = output.pixelHeight;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not allocate the Puppet Warp output canvas');
  context.putImageData(new ImageData(output.rgba, output.pixelWidth, output.pixelHeight), 0, 0);
  return {
    canvas,
    bounds: { ...bounds, minX: bounds.minX + initialBounds.minX, minY: bounds.minY + initialBounds.minY },
  };
}
