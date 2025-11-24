const TRI_HEIGHT = Math.sqrt(3) / 2;

export const templateTriangle = [
  { x: 0.5, y: 0 },
  { x: 0, y: TRI_HEIGHT },
  { x: 1, y: TRI_HEIGHT },
];

export const EDGE_POINTS_PER_SIDE = 5;
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

export function clampPointToTriangle(point) {
  const bary = clampBarycentric(cartesianToBarycentric(point));
  return {
    cartesian: barycentricToCartesian(bary),
    bary,
  };
}

export function createEdgePointData(pointsPerSide = EDGE_POINTS_PER_SIDE) {
  const edges = [
    { name: 'AB', start: 0, end: 1 },
    { name: 'BC', start: 1, end: 2 },
    { name: 'CA', start: 2, end: 0 },
  ];

  const uniquePoints = new Map();
  const points = [];
  const edgeBuckets = edges.map(() => []);
  const segments = pointsPerSide - 1;

  edges.forEach((edge, edgeIndex) => {
    const startVertex = templateTriangle[edge.start];
    const endVertex = templateTriangle[edge.end];

    for (let i = 0; i < pointsPerSide; i += 1) {
      const t = segments === 0 ? 0 : i / segments;
      const cartesian = {
        x: startVertex.x * (1 - t) + endVertex.x * t,
        y: startVertex.y * (1 - t) + endVertex.y * t,
      };
      const bary = toEdgeBarycentric(edgeIndex, t);
      const key = baryKey(bary);

      if (!uniquePoints.has(key)) {
        const pointData = {
          id: `edge-${edge.name}-${i}`,
          edge: edgeIndex,
          index: i,
          bary,
          cartesian,
        };
        uniquePoints.set(key, pointData);
        points.push(pointData);
      }

      const pointRef = uniquePoints.get(key);
      edgeBuckets[edgeIndex].push(pointRef);
    }
  });

  return {
    points,
    edges: edgeBuckets,
  };
}

function toEdgeBarycentric(edgeIndex, t) {
  switch (edgeIndex) {
    case 0: // AB
      return { a: 1 - t, b: t, c: 0 };
    case 1: // BC
      return { a: 0, b: 1 - t, c: t };
    case 2: // CA
    default:
      return { a: t, b: 0, c: 1 - t };
  }
}

function baryKey(bary) {
  return `${bary.a.toFixed(4)}_${bary.b.toFixed(4)}_${bary.c.toFixed(4)}`;
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

