const TRI_HEIGHT = Math.sqrt(3) / 2;
const EPSILON = 1e-6;

export const templateTriangle = [
  { x: 0.5, y: 0 },
  { x: 0, y: TRI_HEIGHT },
  { x: 1, y: TRI_HEIGHT },
];

/**
 * Symmetry groups of the equilateral triangle, as permutations of the
 * barycentric weights. Only the full dihedral group (D3) guarantees that
 * strokes meet across shared edges regardless of how adjacent mesh faces
 * are oriented.
 */
export const SYMMETRIES = {
  kaleidoscope: {
    label: 'Kaleidoscope (6×)',
    ops: [
      (p) => ({ a: p.a, b: p.b, c: p.c }),
      (p) => ({ a: p.b, b: p.c, c: p.a }),
      (p) => ({ a: p.c, b: p.a, c: p.b }),
      (p) => ({ a: p.a, b: p.c, c: p.b }),
      (p) => ({ a: p.c, b: p.b, c: p.a }),
      (p) => ({ a: p.b, b: p.a, c: p.c }),
    ],
  },
  rotate: {
    label: 'Rotate (3×)',
    ops: [
      (p) => ({ a: p.a, b: p.b, c: p.c }),
      (p) => ({ a: p.b, b: p.c, c: p.a }),
      (p) => ({ a: p.c, b: p.a, c: p.b }),
    ],
  },
  none: {
    label: 'Off',
    ops: [(p) => ({ a: p.a, b: p.b, c: p.c })],
  },
};

export const GRID_SIZES = [2, 3, 4, 6, 8, 9, 12];

/**
 * Starter patterns, defined as strokes to be expanded with kaleidoscope
 * symmetry. Names describe what they form once tiled across the sphere.
 * `grid` and `sphere` are the settings the preset was designed for.
 */
export const PRESETS = {
  lineSphere: {
    label: 'Line Sphere',
    strokes: [[bary(8, 1, 0), bary(0, 5, 4)]],
    grid: 9,
    sphere: { base: 'icosahedron', frequency: 1 },
  },
  honeycomb: {
    label: 'Honeycomb',
    strokes: [[bary(1, 1, 1), bary(1, 1, 0)]],
  },
  trihex: {
    label: 'Tri-Hex',
    strokes: [[bary(1, 1, 0), bary(1, 0, 1)]],
  },
  rings: {
    label: 'Vertex Rings',
    strokes: [[bary(2, 1, 0), bary(2, 0, 1)]],
  },
  flower: {
    label: 'Flower',
    strokes: [
      [bary(1, 1, 1), bary(2, 1, 0)],
      [bary(2, 1, 0), bary(2, 0, 1)],
    ],
  },
};

function bary(a, b, c) {
  const sum = a + b + c;
  return { a: a / sum, b: b / sum, c: c / sum };
}

export function cartesianToBarycentric(point) {
  const [a, b, c] = templateTriangle;
  const denom = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
  const w1 = ((b.y - c.y) * (point.x - c.x) + (c.x - b.x) * (point.y - c.y)) / denom;
  const w2 = ((c.y - a.y) * (point.x - c.x) + (a.x - c.x) * (point.y - c.y)) / denom;
  return { a: w1, b: w2, c: 1 - w1 - w2 };
}

export function barycentricToCartesian(p) {
  const [a, b, c] = templateTriangle;
  return {
    x: p.a * a.x + p.b * b.x + p.c * c.x,
    y: p.a * a.y + p.b * b.y + p.c * c.y,
  };
}

/** Triangular lattice with `divisions` steps per edge, in barycentric coords. */
export function latticePoints(divisions) {
  const points = [];
  for (let i = 0; i <= divisions; i += 1) {
    for (let j = 0; j <= divisions - i; j += 1) {
      points.push(bary(i, j, divisions - i - j));
    }
  }
  return points;
}

export function samePoint(p, q) {
  return Math.abs(p.a - q.a) < EPSILON && Math.abs(p.b - q.b) < EPSILON;
}

/**
 * Apply the symmetry group to a list of source strokes. Each output segment
 * remembers the index of the stroke it came from; exact duplicates (strokes
 * lying on a mirror axis) are dropped.
 */
export function expandStrokes(strokes, symmetry) {
  const { ops } = SYMMETRIES[symmetry] ?? SYMMETRIES.kaleidoscope;
  const result = [];
  strokes.forEach(([start, end], source) => {
    ops.forEach((op) => {
      const s = op(start);
      const e = op(end);
      const duplicate = result.some(
        (seg) =>
          (samePoint(seg.start, s) && samePoint(seg.end, e)) ||
          (samePoint(seg.start, e) && samePoint(seg.end, s)),
      );
      if (!duplicate) {
        result.push({ start: s, end: e, source });
      }
    });
  });
  return result;
}

/**
 * Split segments wherever they cross or where one ends on another, so that
 * every junction becomes a shared endpoint.
 */
export function splitAtJunctions(segments) {
  const cuts = junctionParams(segments);
  const result = [];
  segments.forEach(({ start, end }, i) => {
    const ts = cuts[i];
    for (let k = 0; k < ts.length - 1; k += 1) {
      result.push({ start: lerpBary(start, end, ts[k]), end: lerpBary(start, end, ts[k + 1]) });
    }
  });
  return result;
}

/**
 * For each segment, the sorted positions (0–1 along it) of its endpoints and
 * of every point where another segment crosses it or ends on it.
 */
export function junctionParams(segments) {
  const cart = segments.map(({ start, end }) => [barycentricToCartesian(start), barycentricToCartesian(end)]);
  const cuts = segments.map(() => [0, 1]);
  for (let i = 0; i < cart.length; i += 1) {
    const [p1, p2] = cart[i];
    for (let j = i + 1; j < cart.length; j += 1) {
      const [p3, p4] = cart[j];
      const d1x = p2.x - p1.x;
      const d1y = p2.y - p1.y;
      const d2x = p4.x - p3.x;
      const d2y = p4.y - p3.y;
      const denom = d1x * d2y - d1y * d2x;
      if (Math.abs(denom) < EPSILON) {
        continue;
      }
      const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denom;
      const u = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / denom;
      if (t >= -EPSILON && t <= 1 + EPSILON && u >= -EPSILON && u <= 1 + EPSILON) {
        cuts[i].push(t);
        cuts[j].push(u);
      }
    }
  }
  return cuts.map((ts) =>
    ts
      .map((t) => Math.min(1, Math.max(0, t)))
      .sort((a, b) => a - b)
      .filter((t, k, sorted) => k === 0 || t - sorted[k - 1] > EPSILON),
  );
}

export function lerpBary(p, q, t) {
  return { a: p.a + (q.a - p.a) * t, b: p.b + (q.b - p.b) * t, c: p.c + (q.c - p.c) * t };
}

/** Proper crossing points between segments, excluding shared endpoints. */
export function segmentIntersections(segments) {
  const points = [];
  for (let i = 0; i < segments.length; i += 1) {
    const p1 = barycentricToCartesian(segments[i].start);
    const p2 = barycentricToCartesian(segments[i].end);
    for (let j = i + 1; j < segments.length; j += 1) {
      const p3 = barycentricToCartesian(segments[j].start);
      const p4 = barycentricToCartesian(segments[j].end);
      const d1x = p2.x - p1.x;
      const d1y = p2.y - p1.y;
      const d2x = p4.x - p3.x;
      const d2y = p4.y - p3.y;
      const denom = d1x * d2y - d1y * d2x;
      if (Math.abs(denom) < EPSILON) {
        continue;
      }
      const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denom;
      const u = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / denom;
      if (t <= EPSILON || t >= 1 - EPSILON || u <= EPSILON || u >= 1 - EPSILON) {
        continue;
      }
      const hit = cartesianToBarycentric({ x: p1.x + t * d1x, y: p1.y + t * d1y });
      if (!points.some((p) => samePoint(p, hit))) {
        points.push(hit);
      }
    }
  }
  return points;
}
