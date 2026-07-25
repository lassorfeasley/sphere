import { BufferGeometry, Float32BufferAttribute, Vector3 } from 'three';
import { barycentricToVector, readVertex } from './geometryUtils.js';

const v0 = new Vector3();
const v1 = new Vector3();
const v2 = new Vector3();
const tempPointA = new Vector3();
const tempPointB = new Vector3();

export function buildPatternGeometry(connections, geometry) {
  if (!geometry || !connections.length) {
    return null;
  }

  const indexAttr = geometry.getIndex();
  if (!indexAttr) {
    return null;
  }

  const positionsAttr = geometry.getAttribute('position');
  const positionsArray = positionsAttr.array;
  const indexArray = indexAttr.array;

  const linePositions = [];

  for (let i = 0; i < indexArray.length; i += 3) {
    const ia = indexArray[i];
    const ib = indexArray[i + 1];
    const ic = indexArray[i + 2];

    readVertex(ia, v0, positionsArray);
    readVertex(ib, v1, positionsArray);
    readVertex(ic, v2, positionsArray);

    connections.forEach((connection) => {
      const mappedA = barycentricToVector(connection.start, v0, v1, v2, tempPointA);
      const mappedB = barycentricToVector(connection.end, v0, v1, v2, tempPointB);
      linePositions.push(
        mappedA.x,
        mappedA.y,
        mappedA.z,
        mappedB.x,
        mappedB.y,
        mappedB.z,
      );
    });
  }

  if (!linePositions.length) {
    return null;
  }

  const buffer = new Float32Array(linePositions);
  const patternGeometry = new BufferGeometry();
  patternGeometry.setAttribute('position', new Float32BufferAttribute(buffer, 3));
  return patternGeometry;
}
