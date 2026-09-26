import { BufferGeometry, Float32BufferAttribute, Vector3 } from 'three';

const BASE_TYPES = ['icosahedron', 'octahedron', 'pentakis dodecahedron', 'tetrakis hexahedron'];

export function getBaseTypes() {
  return BASE_TYPES.slice();
}

export function createGeodesicSphere({
  frequency = 1,
  radius = 1,
  base = 'icosahedron',
} = {}) {
  const detail = Math.max(1, Math.floor(frequency));
  const { vertices, faces } = createBasePolyhedron(base);

  const positions = [];
  const indices = [];
  const vertexMap = new Map();

  const addVertex = (vector) => {
    const normalized = vector.clone().normalize().multiplyScalar(radius);
    const key = `${normalized.x.toFixed(6)}_${normalized.y.toFixed(6)}_${normalized.z.toFixed(6)}`;

    if (vertexMap.has(key)) {
      return vertexMap.get(key);
    }

    const index = positions.length / 3;
    positions.push(normalized.x, normalized.y, normalized.z);
    vertexMap.set(key, index);
    return index;
  };

  faces.forEach(([a, b, c]) => {
    subdivideFace(vertices[a], vertices[b], vertices[c], detail, addVertex, indices);
  });

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  return geometry;
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
 * Raise a point over every face of a polyhedron and fan triangles around it.
 * Each face is found as the `sides` corners nearest its center direction,
 * sorted around it. Triangles list the face center first and wind outward,
 * matching the other base polyhedra.
 */
function kisPolyhedron(corners, centers, sides) {
  const vertices = [...corners.map((v) => v.clone().normalize()), ...centers.map((v) => v.clone().normalize())];
  const faces = [];
  centers.forEach((_, c) => {
    const centerIndex = corners.length + c;
    const center = vertices[centerIndex];
    const ring = vertices
      .slice(0, corners.length)
      .map((v, i) => ({ i, angle: v.angleTo(center) }))
      .sort((a, b) => a.angle - b.angle)
      .slice(0, sides)
      .map(({ i }) => i);
    const u = vertices[ring[0]].clone().sub(center).normalize();
    const w = center.clone().cross(u);
    ring.sort((a, b) => {
      const pa = vertices[a].clone().sub(center);
      const pb = vertices[b].clone().sub(center);
      return Math.atan2(pa.dot(w), pa.dot(u)) - Math.atan2(pb.dot(w), pb.dot(u));
    });
    ring.forEach((a, k) => {
      const b = ring[(k + 1) % sides];
      const normal = vertices[a].clone().sub(center).cross(vertices[b].clone().sub(center));
      faces.push(normal.dot(center) > 0 ? [centerIndex, a, b] : [centerIndex, b, a]);
    });
  });
  return { vertices, faces };
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

