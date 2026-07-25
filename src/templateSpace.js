const TRI_HEIGHT = Math.sqrt(3) / 2;

export const templateTriangle = [
  { x: 0.5, y: 0 },
  { x: 0, y: TRI_HEIGHT },
  { x: 1, y: TRI_HEIGHT },
];

export const TESSELLATIONS = {
  triforce: 'Tri Fan',
  striped: 'Striped',
  hexfan: 'Hex Fan',
};

export function getTessellationOptions() {
  return Object.entries(TESSELLATIONS).map(([value, label]) => ({ value, label }));
}

export function cartesianToBarycentric(point) {
  const [a, b, c] = templateTriangle;
  const denom =
    (b.y - c.y) * (a.x - c.x) +
    (c.x - b.x) * (a.y - c.y);

  if (Math.abs(denom) < 1e-9) {
    return { a: 1 / 3, b: 1 / 3, c: 1 / 3 };
  }

  const w1 =
    ((b.y - c.y) * (point.x - c.x) +
      (c.x - b.x) * (point.y - c.y)) /
    denom;
  const w2 =
    ((c.y - a.y) * (point.x - c.x) +
      (a.x - c.x) * (point.y - c.y)) /
    denom;
  const w3 = 1 - w1 - w2;

  return { a: w1, b: w2, c: w3 };
}

export function barycentricToCartesian(bary) {
  const [a, b, c] = templateTriangle;
  return {
    x: bary.a * a.x + bary.b * b.x + bary.c * c.x,
    y: bary.a * a.y + bary.b * b.y + bary.c * c.y,
  };
}

export function clampBarycentric(bary) {
  const clamped = {
    a: Math.max(0, bary.a),
    b: Math.max(0, bary.b),
    c: Math.max(0, bary.c),
  };
  const sum = clamped.a + clamped.b + clamped.c;
  if (sum === 0) {
    return { a: 1 / 3, b: 1 / 3, c: 1 / 3 };
  }
  return {
    a: clamped.a / sum,
    b: clamped.b / sum,
    c: clamped.c / sum,
  };
}

/**
 * Reflect a barycentric point across the triangle's vertical altitude
 * (through vertex A). Combined with the 3-fold symmetry of the quad fan,
 * this produces full dihedral (D3) symmetry, which guarantees the pattern
 * lines up across shared edges of adjacent mesh faces.
 */
export function mirrorBarycentric(bary) {
  return { a: bary.a, b: bary.c, c: bary.b };
}

export function getTessellationQuads(type = 'triforce') {
  switch (type) {
    case 'striped':
      return buildStripedQuads();
    case 'hexfan':
      return buildHexFanQuads();
    case 'triforce':
    default:
      return buildTriFanQuads();
  }
}

export function quadUvToBarycentric(quad, uv) {
  const corners = quad.corners;
  const top = lerpBary(corners[0].bary, corners[1].bary, uv.u);
  const bottom = lerpBary(corners[3].bary, corners[2].bary, uv.u);
  return clampBarycentric(lerpBary(top, bottom, uv.v));
}

function buildTriFanQuads() {
  const [a, b, c] = templateTriangle;
  const midAB = midpoint(a, b);
  const midBC = midpoint(b, c);
  const midCA = midpoint(c, a);
  const center = barycentricToCartesian({ a: 1 / 3, b: 1 / 3, c: 1 / 3 });

  return [
    createQuad('triforce-0', [center, midCA, a, midAB]),
    createQuad('triforce-1', [center, midAB, b, midBC]),
    createQuad('triforce-2', [center, midBC, c, midCA]),
  ];
}

function buildStripedQuads() {
  const [a, b, c] = templateTriangle;
  const centroid = barycentricToCartesian({ a: 1 / 3, b: 1 / 3, c: 1 / 3 });
  const innerA = interpolate(a, centroid, 0.45);
  const innerB = interpolate(b, centroid, 0.45);
  const innerC = interpolate(c, centroid, 0.45);
  const edgeAB = interpolate(a, b, 0.5);
  const edgeBC = interpolate(b, c, 0.5);
  const edgeCA = interpolate(c, a, 0.5);

  return [
    createQuad('striped-0', [innerA, edgeAB, b, innerB]),
    createQuad('striped-1', [innerB, edgeBC, c, innerC]),
    createQuad('striped-2', [innerC, edgeCA, a, innerA]),
  ];
}

function buildHexFanQuads() {
  const [a, b, c] = templateTriangle;
  const midAB = midpoint(a, b);
  const midBC = midpoint(b, c);
  const midCA = midpoint(c, a);
  const center = barycentricToCartesian({ a: 1 / 3, b: 1 / 3, c: 1 / 3 });
  const edgeABInner = interpolate(midAB, center, 0.6);
  const edgeBCInner = interpolate(midBC, center, 0.6);
  const edgeCAInner = interpolate(midCA, center, 0.6);

  return [
    createQuad('hexfan-0', [edgeCAInner, midCA, a, midAB]),
    createQuad('hexfan-1', [edgeABInner, midAB, b, midBC]),
    createQuad('hexfan-2', [edgeBCInner, midBC, c, midCA]),
  ].map((quad, idx) => {
    // adjust final corner to inner edge to keep quads
    const inner = [edgeABInner, edgeBCInner, edgeCAInner][idx];
    quad.corners[0] = { cartesian: inner, bary: clampBarycentric(cartesianToBarycentric(inner)) };
    return quad;
  });
}

function createQuad(id, vertices) {
  return {
    id,
    corners: vertices.map((point) => ({
      cartesian: point,
      bary: clampBarycentric(cartesianToBarycentric(point)),
    })),
  };
}

function midpoint(p1, p2) {
  return {
    x: (p1.x + p2.x) / 2,
    y: (p1.y + p2.y) / 2,
  };
}

function interpolate(p1, p2, t) {
  return {
    x: p1.x * (1 - t) + p2.x * t,
    y: p1.y * (1 - t) + p2.y * t,
  };
}

function lerpBary(b1, b2, t) {
  return {
    a: b1.a * (1 - t) + b2.a * t,
    b: b1.b * (1 - t) + b2.b * t,
    c: b1.c * (1 - t) + b2.c * t,
  };
}
