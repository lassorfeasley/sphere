import { BufferGeometry, Float32BufferAttribute, Vector3 } from 'three';

const BASE_TYPES = ['icosahedron', 'octahedron', 'pentakis dodecahedron', 'tetrakis hexahedron', 'truncated icosahedron'];

export function getBaseTypes() {
  return BASE_TYPES.slice();
}

export function createGeodesicSphere({
  frequency = 1,
  radius = 1,
  base = 'icosahedron',
} = {}) {
  const detail = Math.max(1, Math.floor(frequency));
  const { vertices, faces, sides = faces.map(() => 3) } = createBasePolyhedron(base);

  const positions = [];
  const indices = [];
  const vertexMap = new Map();

  // Unsubdivided, base vertices keep their own distance, so polygon faces
  // split around a sunken center stay flat.
  const addVertex = (vector) => {
    const normalized = (detail === 1 ? vector.clone() : vector.clone().normalize()).multiplyScalar(radius);
    const key = `${normalized.x.toFixed(6)}_${normalized.y.toFixed(6)}_${normalized.z.toFixed(6)}`;

    if (vertexMap.has(key)) {
      return vertexMap.get(key);
    }

    const index = positions.length / 3;
    positions.push(normalized.x, normalized.y, normalized.z);
    vertexMap.set(key, index);
    return index;
  };

  // The sides of the polygon face each triangle came from (3 unless the
  // base fans triangles around polygon centers), and of the face across its
  // outer edge (from its second to its third corner).
  const outer = outerSides(faces, sides);
  const faceSides = [];
  const faceOuterSides = [];
  faces.forEach(([a, b, c], f) => {
    const before = indices.length;
    subdivideFace(vertices[a], vertices[b], vertices[c], detail, addVertex, indices);
    for (let k = before; k < indices.length; k += 3) {
      faceSides.push(sides[f]);
      faceOuterSides.push(outer[f]);
    }
  });

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.userData.faceSides = Uint8Array.from(faceSides);
  geometry.userData.faceOuterSides = Uint8Array.from(faceOuterSides);

  return geometry;
}

/** For each face, the `sides` of the face sharing its edge from corner 1 to corner 2. */
function outerSides(faces, sides) {
  const byEdge = new Map();
  faces.forEach((face, f) => {
    face.forEach((a, k) => {
      const b = face[(k + 1) % 3];
      byEdge.set(`${a}_${b}`, f);
    });
  });
  return faces.map(([, b, c]) => sides[byEdge.get(`${c}_${b}`)] ?? 3);
}

function subdivideFace(vA, vB, vC, detail, addVertex, indices) {
  const rows = detail;
  const vertexRows = [];

  for (let i = 0; i <= rows; i += 1) {
    const aj = vA.clone().lerp(vC, i / rows);
    const bj = vB.clone().lerp(vC, i / rows);
    const cells = rows - i;
    const row = [];

    for (let j = 0; j <= cells; j += 1) {
      const t = cells === 0 ? 0 : j / cells;
      const point = aj.clone().lerp(bj, t);
      row.push(addVertex(point));
    }

    vertexRows.push(row);
  }

  for (let i = 0; i < rows; i += 1) {
    const current = vertexRows[i];
    const next = vertexRows[i + 1];

    for (let j = 0; j < current.length - 1; j += 1) {
      indices.push(current[j], next[j], current[j + 1]);

      if (j < next.length - 1) {
        indices.push(current[j + 1], next[j], next[j + 1]);
      }
    }
  }
}

function createBasePolyhedron(type) {
  switch (type) {
    case 'octahedron':
      return createOctahedron();
    case 'pentakis dodecahedron':
      return createPentakisDodecahedron();
    case 'tetrakis hexahedron':
      return createTetrakisHexahedron();
    case 'truncated icosahedron':
      return createTruncatedIcosahedron();
    case 'icosahedron':
    default:
      return createIcosahedron();
  }
}

function createIcosahedron() {
  const t = (1 + Math.sqrt(5)) / 2;
  const vertices = [
    new Vector3(-1, t, 0),
    new Vector3(1, t, 0),
    new Vector3(-1, -t, 0),
    new Vector3(1, -t, 0),
    new Vector3(0, -1, t),
    new Vector3(0, 1, t),
    new Vector3(0, -1, -t),
    new Vector3(0, 1, -t),
    new Vector3(t, 0, -1),
    new Vector3(t, 0, 1),
    new Vector3(-t, 0, -1),
    new Vector3(-t, 0, 1),
  ].map((vertex) => vertex.normalize());

  const faces = [
    [0, 11, 5],
    [0, 5, 1],
    [0, 1, 7],
    [0, 7, 10],
    [0, 10, 11],
    [1, 5, 9],
    [5, 11, 4],
    [11, 10, 2],
    [10, 7, 6],
    [7, 1, 8],
    [3, 9, 4],
    [3, 4, 2],
    [3, 2, 6],
    [3, 6, 8],
    [3, 8, 9],
    [4, 9, 5],
    [2, 4, 11],
    [6, 2, 10],
    [8, 6, 7],
    [9, 8, 1],
  ];

  return { vertices, faces };
}

/** 60 near-equilateral triangles: five around each dodecahedron face center. */
function createPentakisDodecahedron() {
  // The dodecahedron as the icosahedron's dual: its corners are the
  // icosahedron's face centers and its face centers the icosahedron's corners.
  const { vertices, faces } = createIcosahedron();
  const corners = faces.map(([a, b, c]) => vertices[a].clone().add(vertices[b]).add(vertices[c]));
  return kisPolyhedron(corners, vertices, 5);
}

/** 24 isosceles triangles: four around each cube face center. */
function createTetrakisHexahedron() {
  const corners = [];
  [-1, 1].forEach((x) => [-1, 1].forEach((y) => [-1, 1].forEach((z) => corners.push(new Vector3(x, y, z)))));
  const centers = [];
  [-1, 1].forEach((s) => {
    centers.push(new Vector3(s, 0, 0), new Vector3(0, s, 0), new Vector3(0, 0, s));
  });
  return kisPolyhedron(corners, centers, 4);
}

/**
 * The soccer ball: 12 pentagons and 20 hexagons, each split into triangles
 * around its center. The centers sit on the flat faces rather than the
 * sphere, so every hexagon's six triangles are equilateral.
 */
function createTruncatedIcosahedron() {
  const { vertices: ico, faces: icoFaces } = createIcosahedron();
  const corners = [];
  const seen = new Set();
  icoFaces.forEach((face) => {
    face.forEach((a, k) => {
      const b = face[(k + 1) % 3];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      if (!seen.has(key)) {
        seen.add(key);
        corners.push(ico[a].clone().lerp(ico[b], 1 / 3), ico[a].clone().lerp(ico[b], 2 / 3));
      }
    });
  });
  const radius = corners[0].length();
  corners.forEach((v) => v.divideScalar(radius));
  const faceCenter = (ring) => ring.reduce((sum, v) => sum.add(v), new Vector3()).divideScalar(ring.length);
  const nearest = (direction, count) =>
    corners
      .map((v) => ({ v, angle: v.angleTo(direction) }))
      .sort((a, b) => a.angle - b.angle)
      .slice(0, count)
      .map(({ v }) => v);
  const pentagons = ico.map((v) => faceCenter(nearest(v, 5)));
  const hexagons = icoFaces.map(([a, b, c]) => faceCenter(nearest(ico[a].clone().add(ico[b]).add(ico[c]), 6)));
  return kisPolyhedron(corners, [...pentagons, ...hexagons], [...pentagons.map(() => 5), ...hexagons.map(() => 6)], {
    raise: false,
  });
}

/**
 * Put a point over every face of a polyhedron and fan triangles around it.
 * Each face is found as the `sides` corners (a count, or one per center)
 * nearest its center direction, sorted around it. Triangles list the face
 * center first and wind outward, matching the other base polyhedra. Centers
 * are raised to the sphere unless `raise` is false.
 */
function kisPolyhedron(corners, centers, sides, { raise = true } = {}) {
  const vertices = [
    ...corners.map((v) => v.clone().normalize()),
    ...centers.map((v) => (raise ? v.clone().normalize() : v.clone())),
  ];
  const faces = [];
  const faceSides = [];
  centers.forEach((_, c) => {
    const count = Array.isArray(sides) ? sides[c] : sides;
    const centerIndex = corners.length + c;
    const center = vertices[centerIndex];
    const ring = vertices
      .slice(0, corners.length)
      .map((v, i) => ({ i, angle: v.angleTo(center) }))
      .sort((a, b) => a.angle - b.angle)
      .slice(0, count)
      .map(({ i }) => i);
    const u = vertices[ring[0]].clone().sub(center).normalize();
    const w = center.clone().cross(u);
    ring.sort((a, b) => {
      const pa = vertices[a].clone().sub(center);
      const pb = vertices[b].clone().sub(center);
      return Math.atan2(pa.dot(w), pa.dot(u)) - Math.atan2(pb.dot(w), pb.dot(u));
    });
    ring.forEach((a, k) => {
      const b = ring[(k + 1) % count];
      const normal = vertices[a].clone().sub(center).cross(vertices[b].clone().sub(center));
      faces.push(normal.dot(center) > 0 ? [centerIndex, a, b] : [centerIndex, b, a]);
      faceSides.push(count);
    });
  });
  return { vertices, faces, sides: faceSides };
}

function createOctahedron() {
  const vertices = [
    new Vector3(1, 0, 0),
    new Vector3(-1, 0, 0),
    new Vector3(0, 1, 0),
    new Vector3(0, -1, 0),
    new Vector3(0, 0, 1),
    new Vector3(0, 0, -1),
  ];

  const faces = [
    [0, 4, 2],
    [2, 4, 1],
    [1, 4, 3],
    [3, 4, 0],
    [0, 2, 5],
    [2, 1, 5],
    [1, 3, 5],
    [3, 0, 5],
  ];

  return { vertices, faces };
}


/**
 * The same surface without the triangles of polygon faces with `sides`
 * sides, sharing its vertices, for stamping a pattern on only some faces.
 */
export function withoutFaces(geometry, sides) {
  const faceSides = geometry.userData.faceSides;
  const index = geometry.getIndex().array;
  const outer = geometry.userData.faceOuterSides;
  const kept = [];
  const keptSides = [];
  const keptOuter = [];
  for (let t = 0; t < faceSides.length; t += 1) {
    if (faceSides[t] !== sides) {
      kept.push(index[t * 3], index[t * 3 + 1], index[t * 3 + 2]);
      keptSides.push(faceSides[t]);
      keptOuter.push(outer[t]);
    }
  }
  const result = new BufferGeometry();
  result.setAttribute('position', geometry.getAttribute('position'));
  result.setIndex(kept);
  result.userData.faceSides = Uint8Array.from(keptSides);
  result.userData.faceOuterSides = Uint8Array.from(keptOuter);
  return result;
}
