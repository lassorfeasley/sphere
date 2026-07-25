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
  const sampleCache = new Map();
  const seenSegments = new Set();

  const quantize = (value) => Math.round((value / radius) * 1e5);
  const pointKey = (p) => `${quantize(p.x)},${quantize(p.y)},${quantize(p.z)}`;

  for (let i = 0; i < indexArray.length; i += 3) {
    readVertex(indexArray[i], v0, positionsArray);
    readVertex(indexArray[i + 1], v1, positionsArray);
    readVertex(indexArray[i + 2], v2, positionsArray);

    connections.forEach((connection) => {
      const cacheKey = connection.id || `${connection.start.a}-${connection.end.a}-${samplesPerSegment}`;
      let samples = sampleCache.get(cacheKey);
      if (!samples) {
        samples = sampleBarycentricSegment(connection.start, connection.end, samplesPerSegment);
        sampleCache.set(cacheKey, samples);
      }

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

export function buildProjectedPatternGeometry(connections, geometry, options = {}) {
  const segments = collectProjectedSegments(connections, geometry, options);
  if (!segments) {
    return null;
  }

  const projectedGeometry = new BufferGeometry();
  projectedGeometry.setAttribute('position', new Float32BufferAttribute(segments, 3));
  return projectedGeometry;
}

function projectToSphere(source, target, radius) {
  target.copy(source);
  if (target.lengthSq() === 0) {
    return target;
  }
  return target.normalize().multiplyScalar(radius);
}
