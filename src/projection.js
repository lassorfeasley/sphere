import { BufferGeometry, Float32BufferAttribute, Vector3 } from 'three';

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

export function buildProjectedPatternGeometry(connections, geometry, options = {}) {
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

  for (let i = 0; i < indexArray.length; i += 3) {
    const ia = indexArray[i];
    const ib = indexArray[i + 1];
    const ic = indexArray[i + 2];

    readVertex(ia, v0, positionsArray);
    readVertex(ib, v1, positionsArray);
    readVertex(ic, v2, positionsArray);

    connections.forEach((connection) => {
      const cacheKey = connection.id || `${connection.start.a}-${connection.end.a}-${samplesPerSegment}`;
      const samples =
        sampleCache.get(cacheKey) ||
        (sampleCache.set(cacheKey, sampleBarycentricSegment(connection.start, connection.end, samplesPerSegment)),
        sampleCache.get(cacheKey));

      for (let s = 0; s < samples.length - 1; s += 1) {
        const baryA = samples[s];
        const baryB = samples[s + 1];

        barycentricToVector(baryA, v0, v1, v2, flatPointA);
        barycentricToVector(baryB, v0, v1, v2, flatPointB);

        projectToSphere(flatPointA, spherePointA, radius);
        projectToSphere(flatPointB, spherePointB, radius);

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

  const buffer = new Float32Array(linePositions);
  const projectedGeometry = new BufferGeometry();
  projectedGeometry.setAttribute('position', new Float32BufferAttribute(buffer, 3));
  return projectedGeometry;
}

function readVertex(index, target, positionsArray) {
  const offset = index * 3;
  target.set(
    positionsArray[offset],
    positionsArray[offset + 1],
    positionsArray[offset + 2],
  );
  return target;
}

function barycentricToVector(bary, a, b, c, target) {
  target.set(0, 0, 0);
  target.addScaledVector(a, bary.a);
  target.addScaledVector(b, bary.b);
  target.addScaledVector(c, bary.c);
  return target;
}

function projectToSphere(source, target, radius) {
  target.copy(source);
  if (target.lengthSq() === 0) {
    return target;
  }
  return target.normalize().multiplyScalar(radius);
}

function normalizeBarycentric(bary) {
  const sum = bary.a + bary.b + bary.c;
  if (sum === 0) {
    return { a: 1 / 3, b: 1 / 3, c: 1 / 3 };
  }
  return {
    a: bary.a / sum,
    b: bary.b / sum,
    c: bary.c / sum,
  };
}

