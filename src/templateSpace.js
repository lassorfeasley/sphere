const TRI_HEIGHT = Math.sqrt(3) / 2;
const EPSILON = 1e-6;
// Straight pieces per curve when a curve is flattened for the sphere.
const CURVE_SAMPLES = 16;

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

export const GRID_MIN = 1;
export const GRID_MAX = 40;

/** A whole number of grid steps per edge within range, or null if `value` isn't one. */
export function parseGrid(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= GRID_MIN && n <= GRID_MAX ? n : null;
}

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
 * Whether two segments trace the same line, in either direction. A curve's
 * control point is the same both ways, so it must simply match.
 */
export function sameSegment(p, q) {
  if (Boolean(p.control) !== Boolean(q.control) || (p.control && !samePoint(p.control, q.control))) {
    return false;
  }
  return (
    (samePoint(p.start, q.start) && samePoint(p.end, q.end)) ||
    (samePoint(p.start, q.end) && samePoint(p.end, q.start))
  );
}

/**
 * Apply the symmetry group to a list of source strokes. A stroke is
 * `[start, end]`, or `[start, end, control]` for a quadratic Bézier curve.
 * Each output segment remembers the index of the stroke it came from and the
 * symmetry op that produced it; exact duplicates (strokes lying on a mirror
 * axis) are dropped.
 */
export function expandStrokes(strokes, symmetry) {
  const { ops } = SYMMETRIES[symmetry] ?? SYMMETRIES.kaleidoscope;
  const result = [];
  strokes.forEach(([start, end, control], source) => {
    ops.forEach((op, index) => {
      const seg = { start: op(start), end: op(end), source, op: index };
      if (control) {
        seg.control = op(control);
      }
      if (!result.some((other) => sameSegment(other, seg))) {
        result.push(seg);
      }
    });
  });
  return result;
}

/** The symmetry op that undoes op `index`. */
export function inverseOp(symmetry, index) {
  const { ops } = SYMMETRIES[symmetry] ?? SYMMETRIES.kaleidoscope;
  const probe = { a: 0.1, b: 0.3, c: 0.6 };
  return ops.find((inverse) => samePoint(inverse(ops[index](probe)), probe));
}

/** The point at parameter t (0–1) along a straight or curved segment. */
export function pointAt({ start, end, control }, t) {
  if (!control) {
    return lerpBary(start, end, t);
  }
  const s = 1 - t;
  const w0 = s * s;
  const w1 = 2 * s * t;
  const w2 = t * t;
  return {
    a: w0 * start.a + w1 * control.a + w2 * end.a,
    b: w0 * start.b + w1 * control.b + w2 * end.b,
    c: w0 * start.c + w1 * control.c + w2 * end.c,
  };
}

/** The part of a segment between parameters t0 and t1, itself a segment. */
export function subSegment(seg, t0, t1) {
  const start = t0 === 0 ? { ...seg.start } : pointAt(seg, t0);
  const end = t1 === 1 ? { ...seg.end } : pointAt(seg, t1);
  if (!seg.control) {
    return { start, end };
  }
  // Blossom of the quadratic at (t0, t1): the sub-curve's control point.
  const w0 = (1 - t0) * (1 - t1);
  const w1 = (1 - t0) * t1 + t0 * (1 - t1);
  const w2 = t0 * t1;
  const p = seg.start;
  const c = seg.control;
  const q = seg.end;
  return {
    start,
    end,
    control: {
      a: w0 * p.a + w1 * c.a + w2 * q.a,
      b: w0 * p.b + w1 * c.b + w2 * q.b,
      c: w0 * p.c + w1 * c.c + w2 * q.c,
    },
  };
}

/**
 * Straight pieces approximating a segment, with a vertex at every parameter
 * in `cuts` so junctions on a curve stay exact shared endpoints.
 */
export function flattenSegment(seg, cuts = []) {
  if (!seg.control) {
    return [{ start: seg.start, end: seg.end }];
  }
  const params = [0, 1, ...cuts];
  for (let k = 1; k < CURVE_SAMPLES; k += 1) {
    const t = k / CURVE_SAMPLES;
    if (cuts.every((cut) => Math.abs(cut - t) > 0.25 / CURVE_SAMPLES)) {
      params.push(t);
    }
  }
  const ts = params.sort((a, b) => a - b).filter((t, k, sorted) => k === 0 || t - sorted[k - 1] > EPSILON);
  const points = ts.map((t) => (t === 0 ? seg.start : t === 1 ? seg.end : pointAt(seg, t)));
  return points.slice(1).map((end, k) => ({ start: points[k], end }));
}

/**
 * The expanded segments as straight lines for building the sphere. Curves
 * are split at every junction before sampling, so lines that meet on a curve
 * share an exact endpoint.
 */
export function flattenSegments(segments) {
  if (!segments.some((seg) => seg.control)) {
    return segments.map(({ start, end }) => ({ start, end }));
  }
  const cuts = junctionParams(segments);
  return segments.flatMap((seg, i) => flattenSegment(seg, cuts[i].slice(1, -1)));
}

/**
 * The fewest source strokes that expand under `symmetry` back to `segments`.
 * Switching to a smaller symmetry group with these keeps every visible line.
 */
export function strokesForSegments(segments, symmetry) {
  const strokes = [];
  const covered = [];
  segments.forEach((segment) => {
    if (!covered.some((seg) => sameSegment(seg, segment))) {
      const stroke = [segment.start, segment.end, segment.control].filter(Boolean).map((p) => ({ ...p }));
      strokes.push(stroke);
      covered.push(...expandStrokes([stroke], symmetry));
    }
  });
  return strokes;
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
  const shapes = segments.map(cartesianShape);
  const cuts = segments.map(() => [0, 1]);
  for (let i = 0; i < shapes.length; i += 1) {
    for (let j = i + 1; j < shapes.length; j += 1) {
      shapeHits(shapes[i], shapes[j]).forEach(({ t, u }) => {
        if (t >= -EPSILON && t <= 1 + EPSILON && u >= -EPSILON && u <= 1 + EPSILON) {
          cuts[i].push(t);
          cuts[j].push(u);
        }
      });
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
  const shapes = segments.map(cartesianShape);
  const points = [];
  for (let i = 0; i < shapes.length; i += 1) {
    for (let j = i + 1; j < shapes.length; j += 1) {
      shapeHits(shapes[i], shapes[j]).forEach(({ t, u }) => {
        if (t <= EPSILON || t >= 1 - EPSILON || u <= EPSILON || u >= 1 - EPSILON) {
          return;
        }
        const hit = pointAt(segments[i], t);
        if (!points.some((p) => samePoint(p, hit))) {
          points.push(hit);
        }
      });
    }
  }
  return points;
}

/** A segment in Cartesian editor space, with its sampled polyline for curves. */
function cartesianShape({ start, end, control }) {
  const shape = {
    p0: barycentricToCartesian(start),
    p1: barycentricToCartesian(end),
    c: control ? barycentricToCartesian(control) : null,
  };
  shape.points = shape.c
    ? Array.from({ length: CURVE_SAMPLES + 1 }, (_, k) => shapePoint(shape, k / CURVE_SAMPLES))
    : [shape.p0, shape.p1];
  const xs = shape.points.map((p) => p.x);
  const ys = shape.points.map((p) => p.y);
  shape.box = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  return shape;
}

function shapePoint({ p0, p1, c }, t) {
  if (!c) {
    return { x: p0.x + (p1.x - p0.x) * t, y: p0.y + (p1.y - p0.y) * t };
  }
  const s = 1 - t;
  return {
    x: s * s * p0.x + 2 * s * t * c.x + t * t * p1.x,
    y: s * s * p0.y + 2 * s * t * c.y + t * t * p1.y,
  };
}

function shapeTangent({ p0, p1, c }, t) {
  if (!c) {
    return { x: p1.x - p0.x, y: p1.y - p0.y };
  }
  return {
    x: 2 * (1 - t) * (c.x - p0.x) + 2 * t * (p1.x - c.x),
    y: 2 * (1 - t) * (c.y - p0.y) + 2 * t * (p1.y - c.y),
  };
}

/** Parameters where two straight lines (extended) meet, or null if parallel. */
function lineHit(p1, p2, p3, p4) {
  const d1x = p2.x - p1.x;
  const d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x;
  const d2y = p4.y - p3.y;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < EPSILON) {
    return null;
  }
  return {
    t: ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denom,
    u: ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / denom,
  };
}

/**
 * Candidate meeting parameters (t on `a`, u on `b`) of two shapes. Straight
 * pairs are solved exactly. With a curve, crossings of the sampled polylines
 * (widened a little, so a line ending exactly on the true curve still counts)
 * seed Newton's method on the true curves, which pins each one down exactly.
 */
function shapeHits(a, b) {
  if (!a.c && !b.c) {
    const hit = lineHit(a.p0, a.p1, b.p0, b.p1);
    return hit ? [hit] : [];
  }
  const margin = 1e-3;
  if (a.box.x0 > b.box.x1 + margin || b.box.x0 > a.box.x1 + margin || a.box.y0 > b.box.y1 + margin || b.box.y0 > a.box.y1 + margin) {
    return [];
  }
  const na = a.points.length - 1;
  const nb = b.points.length - 1;
  const hits = [];
  for (let i = 0; i < na; i += 1) {
    for (let j = 0; j < nb; j += 1) {
      const seed = lineHit(a.points[i], a.points[i + 1], b.points[j], b.points[j + 1]);
      if (!seed || seed.t < -0.25 || seed.t > 1.25 || seed.u < -0.25 || seed.u > 1.25) {
        continue;
      }
      const hit = refineHit(a, b, (i + seed.t) / na, (j + seed.u) / nb);
      if (hit && !hits.some((h) => Math.abs(h.t - hit.t) < EPSILON && Math.abs(h.u - hit.u) < EPSILON)) {
        hits.push(hit);
      }
    }
  }
  return hits;
}

function refineHit(a, b, t, u) {
  for (let step = 0; step < 30; step += 1) {
    const pa = shapePoint(a, t);
    const pb = shapePoint(b, u);
    const fx = pa.x - pb.x;
    const fy = pa.y - pb.y;
    if (Math.hypot(fx, fy) < 1e-14) {
      return { t, u };
    }
    const da = shapeTangent(a, t);
    const db = shapeTangent(b, u);
    const det = db.x * da.y - da.x * db.y;
    if (Math.abs(det) < 1e-14) {
      return null;
    }
    t += (fx * db.y - db.x * fy) / det;
    u += (da.y * fx - da.x * fy) / det;
    if (t < -0.5 || t > 1.5 || u < -0.5 || u > 1.5) {
      return null;
    }
  }
  const pa = shapePoint(a, t);
  const pb = shapePoint(b, u);
  return Math.hypot(pa.x - pb.x, pa.y - pb.y) < 1e-10 ? { t, u } : null;
}
