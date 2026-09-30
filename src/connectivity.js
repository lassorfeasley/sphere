import { Vector3 } from 'three';
import { barycentricToVector, readVertex } from './geometryUtils.js';
import { onVariant, splitAtJunctions } from './templateSpace.js';

const v0 = new Vector3();
const v1 = new Vector3();
const v2 = new Vector3();
const point = new Vector3();

/**
 * Count how many separate pieces the pattern forms once stamped onto every
 * face. Lines only count as joined where they meet or cross, so strokes that
 * merely pass close to each other are reported as separate.
 */
export function countPieces(connections, geometry) {
  if (!connections.length || !geometry) {
    return 0;
  }
  const pieces = splitAtJunctions(connections);
  const positions = geometry.getAttribute('position').array;
  const index = geometry.getIndex().array;
  const ids = new Map();
  const parent = [];

  const nodeId = (bary) => {
    barycentricToVector(bary, v0, v1, v2, point);
    const key = `${Math.round(point.x * 1e4)},${Math.round(point.y * 1e4)},${Math.round(point.z * 1e4)}`;
    let id = ids.get(key);
    if (id === undefined) {
      id = parent.length;
      parent.push(id);
      ids.set(key, id);
    }
    return id;
  };
  const find = (id) => {
    while (parent[id] !== id) {
      parent[id] = parent[parent[id]];
      id = parent[id];
    }
    return id;
  };

  const variants = geometry.userData.faceVariant;
  for (let i = 0; i < index.length; i += 3) {
    readVertex(index[i], v0, positions);
    readVertex(index[i + 1], v1, positions);
    readVertex(index[i + 2], v2, positions);
    const variant = variants?.[i / 3];
    pieces.forEach((piece) => {
      if (!onVariant(piece, variant)) {
        return;
      }
      const { start, end } = piece;
      const a = find(nodeId(start));
      const b = find(nodeId(end));
      if (a !== b) {
        parent[a] = b;
      }
    });
  }

  const roots = new Set();
  for (let id = 0; id < parent.length; id += 1) {
    roots.add(find(id));
  }
  return roots.size;
}
