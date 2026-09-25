import { BufferGeometry, Float32BufferAttribute, Vector3 } from 'three';
import { barycentricToVector, normalizeBarycentric, readVertex } from './geometryUtils.js';

const v0 = new Vector3();
const v1 = new Vector3();
const v2 = new Vector3();
const flatPointA = new Vector3();
const flatPointB = new Vector3();
const spherePointA = new Vector3();
const spherePointB = new Vector3();

export function sampleBarycentricSegment(start, end, divisions = 8) {
  if (divisions <= 0) {
    return [normalizeBarycentric(start), normalizeBarycentric(end)];
  }

  const samples = [];
  for (let i = 0; i <= divisions; i += 1) {
    const t = i / divisions;
    samples.push(
      normalizeBarycentric({
        a: start.a * (1 - t) + end.a * t,
        b: start.b * (1 - t) + end.b * t,
        c: start.c * (1 - t) + end.c * t,
      }),
    );
  }
  return samples;
}

/**
 * Stamp the template connections onto every face of the geodesic mesh,
 * resample them, and project the samples onto the circumscribed sphere.
 *
 * Returns a flat Float32Array of deduplicated line segments:
 * [x1, y1, z1, x2, y2, z2, ...]. Segments that coincide (e.g. pattern lines
 * lying on shared quad or face edges) are emitted only once.
 */
export function collectProjectedSegments(connections, geometry, options = {}) {
  if (!geometry || !connections.length) {
    return null;
  }

  const { samplesPerSegment = 12, radius = 1 } = options;
  const indexAttr = geometry.getIndex();
  const positionsAttr = geometry.getAttribute('position');

  if (!indexAttr || !positionsAttr) {
    return null;
  }

  const positionsArray = positionsAttr.array;
  const indexArray = indexAttr.array;
  const linePositions = [];
  const seenSegments = new Set();
  const sampledConnections = connections.map((connection) =>
    sampleBarycentricSegment(connection.start, connection.end, samplesPerSegment),
  );

  const quantize = (value) => Math.round((value / radius) * 1e5);
  const pointKey = (p) => `${quantize(p.x)},${quantize(p.y)},${quantize(p.z)}`;

  for (let i = 0; i < indexArray.length; i += 3) {
    readVertex(indexArray[i], v0, positionsArray);
    readVertex(indexArray[i + 1], v1, positionsArray);
    readVertex(indexArray[i + 2], v2, positionsArray);

    sampledConnections.forEach((samples) => {
      for (let s = 0; s < samples.length - 1; s += 1) {
        barycentricToVector(samples[s], v0, v1, v2, flatPointA);
        barycentricToVector(samples[s + 1], v0, v1, v2, flatPointB);

        projectToSphere(flatPointA, spherePointA, radius);
        projectToSphere(flatPointB, spherePointB, radius);

        const keyA = pointKey(spherePointA);
        const keyB = pointKey(spherePointB);
        if (keyA === keyB) {
          continue;
        }
        const segmentKey = keyA < keyB ? `${keyA}|${keyB}` : `${keyB}|${keyA}`;
        if (seenSegments.has(segmentKey)) {
          continue;
        }
        seenSegments.add(segmentKey);

        linePositions.push(
          spherePointA.x,
          spherePointA.y,
          spherePointA.z,
          spherePointB.x,
          spherePointB.y,
          spherePointB.z,
        );
      }
    });
  }

  if (!linePositions.length) {
    return null;
  }

  return new Float32Array(linePositions);
}

/**
 * Pick the segments that run along any of the guide segments, comparing
 * directions from the sphere center only, so segments raised or lowered by
 * weaving still match the flat guides they follow. Both inputs are flat
 * [x1, y1, z1, x2, y2, z2, ...] arrays.
 */
export function segmentsAlong(segments, guides) {
  const a = new Vector3();
  const b = new Vector3();
  const mid = new Vector3();
  const dir = new Vector3();
  const guideStarts = [];
  const guideDirs = [];
  const guideLengths = [];
  let maxGuide = 0;
  for (let i = 0; i < guides.length; i += 6) {
    a.fromArray(guides, i).normalize();
    b.fromArray(guides, i + 3).normalize();
    const length = a.distanceTo(b);
    guideStarts.push(a.clone());
    guideDirs.push(b.clone().sub(a).divideScalar(length || 1));
    guideLengths.push(length);
    maxGuide = Math.max(maxGuide, length);
  }

  const cell = Math.max(maxGuide, 1e-3) * 2;
  const grid = new Map();
  const cellKey = (p) => `${Math.floor(p.x / cell)},${Math.floor(p.y / cell)},${Math.floor(p.z / cell)}`;
  guideStarts.forEach((start, g) => {
    const key = cellKey(mid.copy(guideDirs[g]).multiplyScalar(guideLengths[g] / 2).add(start));
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(g);
  });

  const out = [];
  for (let i = 0; i < segments.length; i += 6) {
    a.fromArray(segments, i).normalize();
    b.fromArray(segments, i + 3).normalize();
    const length = a.distanceTo(b);
    mid.addVectors(a, b).normalize();
    dir.subVectors(b, a).divideScalar(length || 1);
    const tolerance = Math.max(length * 0.15, 1e-4);
    const cx = Math.floor(mid.x / cell);
    const cy = Math.floor(mid.y / cell);
    const cz = Math.floor(mid.z / cell);
    let hit = false;
    for (let dx = -1; dx <= 1 && !hit; dx += 1) {
      for (let dy = -1; dy <= 1 && !hit; dy += 1) {
        for (let dz = -1; dz <= 1 && !hit; dz += 1) {
          const bucket = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
          hit = bucket?.some((g) => {
            if (Math.abs(guideDirs[g].dot(dir)) < 0.9) {
              return false;
            }
            const t = Math.min(guideLengths[g], Math.max(0, b.copy(mid).sub(guideStarts[g]).dot(guideDirs[g])));
            return b.copy(guideStarts[g]).addScaledVector(guideDirs[g], t).distanceTo(mid) < tolerance;
          });
        }
      }
    }
    if (hit) {
      for (let k = 0; k < 6; k += 1) {
        out.push(segments[i + k]);
      }
    }
  }
  return out.length ? new Float32Array(out) : null;
}

/**
 * The geodesic faces themselves, each subdivided and pushed out onto the
 * sphere, so the smooth preview surface is tiled by the same triangles the
 * pattern is stamped onto.
 */
export function buildProjectedFaceGeometry(geometry, { radius = 1, subdivisions = 8 } = {}) {
  const positionsArray = geometry.getAttribute('position').array;
  const indexArray = geometry.getIndex().array;
  const positions = [];
  const indices = [];

  for (let i = 0; i < indexArray.length; i += 3) {
    readVertex(indexArray[i], v0, positionsArray);
    readVertex(indexArray[i + 1], v1, positionsArray);
    readVertex(indexArray[i + 2], v2, positionsArray);

    const base = positions.length / 3;
    const rowStart = [];
    for (let r = 0; r <= subdivisions; r += 1) {
      rowStart.push(positions.length / 3 - base);
      for (let k = 0; k <= subdivisions - r; k += 1) {
        const bary = {
          a: (subdivisions - r - k) / subdivisions,
          b: k / subdivisions,
          c: r / subdivisions,
        };
        projectToSphere(barycentricToVector(bary, v0, v1, v2, flatPointA), spherePointA, radius);
        positions.push(spherePointA.x, spherePointA.y, spherePointA.z);
      }
    }

    for (let r = 0; r < subdivisions; r += 1) {
      const width = subdivisions - r;
      for (let k = 0; k < width; k += 1) {
        const p = base + rowStart[r] + k;
        const q = base + rowStart[r + 1] + k;
        indices.push(p, q, p + 1);
        if (k < width - 1) {
          indices.push(p + 1, q, q + 1);
        }
      }
    }
  }

  const faceGeometry = new BufferGeometry();
  faceGeometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  faceGeometry.setAttribute('normal', new Float32BufferAttribute(positions.map((v) => v / radius), 3));
  faceGeometry.setIndex(indices);
  return faceGeometry;
}

/** Geodesic face edges drawn as arcs on the sphere, each shared edge once. */
export function buildProjectedEdgeGeometry(geometry, { radius = 1, samples = 12, lift = 1.002 } = {}) {
  const positionsArray = geometry.getAttribute('position').array;
  const indexArray = geometry.getIndex().array;
  const seen = new Set();
  const linePositions = [];

  for (let i = 0; i < indexArray.length; i += 3) {
    for (let e = 0; e < 3; e += 1) {
      const ia = indexArray[i + e];
      const ib = indexArray[i + ((e + 1) % 3)];
      const key = ia < ib ? `${ia}_${ib}` : `${ib}_${ia}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      readVertex(ia, v0, positionsArray);
      readVertex(ib, v1, positionsArray);
      for (let s = 0; s < samples; s += 1) {
        projectToSphere(flatPointA.lerpVectors(v0, v1, s / samples), spherePointA, radius * lift);
        projectToSphere(flatPointB.lerpVectors(v0, v1, (s + 1) / samples), spherePointB, radius * lift);
        linePositions.push(spherePointA.x, spherePointA.y, spherePointA.z, spherePointB.x, spherePointB.y, spherePointB.z);
      }
    }
  }

  const edgeGeometry = new BufferGeometry();
  edgeGeometry.setAttribute('position', new Float32BufferAttribute(linePositions, 3));
  return edgeGeometry;
}

function projectToSphere(source, target, radius) {
  target.copy(source);
  if (target.lengthSq() === 0) {
    return target;
  }
  return target.normalize().multiplyScalar(radius);
}
