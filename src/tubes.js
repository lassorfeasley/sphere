import {
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Matrix4,
  Quaternion,
  Vector3,
} from 'three';

const Z = new Vector3(0, 0, 1);
// Points per quarter of the rounded outline; a full circle gets 16 sides.
const CORNER_STEPS = 4;
const LATHE_STEPS = 16;
// Joints match the faceted strut's inner size so they don't poke through
// its flat sides.
const JOINT_SCALE = Math.cos(Math.PI / LATHE_STEPS);
const start = new Vector3();
const end = new Vector3();
const mid = new Vector3();
const dir = new Vector3();
const radial = new Vector3();
const lateral = new Vector3();
const unit = new Vector3(1, 1, 1);
const rotation = new Quaternion();
const matrix = new Matrix4();
const basis = new Matrix4();

/**
 * One quarter arc per corner of the rounded rectangle, counterclockwise from
 * the +x side, as { x, z, nx, nz } (x across the surface, z out from it).
 * Arcs of radius 0 collapse to a point whose normals turn sharply.
 */
function outline({ halfWidth, halfHeight, corner }, quarters = [0, 1, 2, 3]) {
  const c = Math.min(corner, halfWidth, halfHeight);
  const points = [];
  quarters.forEach((q) => {
    const cx = (q === 0 || q === 3 ? 1 : -1) * (halfWidth - c);
    const cz = (q < 2 ? 1 : -1) * (halfHeight - c);
    for (let k = 0; k <= CORNER_STEPS; k += 1) {
      const angle = ((q + k / CORNER_STEPS) * Math.PI) / 2;
      const nx = Math.cos(angle);
      const nz = Math.sin(angle);
      points.push({ x: cx + c * nx, z: cz + c * nz, nx, nz });
    }
  });
  return points;
}

/** Index a grid of quads, wound so faces point along the vertex normals. */
function finishGeometry(positions, normals, quads) {
  const index = [];
  quads.forEach(([a, b, c, d]) => index.push(a, b, c, c, b, d));
  // Flip everything if the first non-degenerate triangle faces inward.
  const p = (i) => new Vector3().fromArray(positions, i * 3);
  for (let t = 0; t < index.length; t += 3) {
    const [a, b, c] = [index[t], index[t + 1], index[t + 2]];
    const face = p(b).sub(p(a)).cross(p(c).sub(p(a)));
    if (face.lengthSq() > 1e-18) {
      if (face.dot(new Vector3().fromArray(normals, a * 3)) < 0) {
        for (let i = 0; i < index.length; i += 3) {
          [index[i + 1], index[i + 2]] = [index[i + 2], index[i + 1]];
        }
      }
      break;
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.setIndex(index);
  return geometry;
}

/** The profile extruded along y from -0.5 to 0.5 (open ends). */
function strutGeometry(profile) {
  const points = outline(profile);
  const positions = [];
  const normals = [];
  points.forEach(({ x, z, nx, nz }) => {
    positions.push(x, -0.5, z, x, 0.5, z);
    normals.push(nx, 0, nz, nx, 0, nz);
  });
  const quads = points.map((_, i) => {
    const j = (i + 1) % points.length;
    return [i * 2, j * 2, i * 2 + 1, j * 2 + 1];
  });
  return finishGeometry(positions, normals, quads);
}

/**
 * Half the profile spun around the z axis: the rounded end cap where struts
 * meet, the same shape the solid gives joints.
 */
function jointGeometry(profile) {
  const points = outline(profile, [3, 0]);
  const positions = [];
  const normals = [];
  for (let s = 0; s <= LATHE_STEPS; s += 1) {
    const phi = (s / LATHE_STEPS) * Math.PI * 2;
    const cos = Math.cos(phi);
    const sin = Math.sin(phi);
    points.forEach(({ x, z, nx, nz }) => {
      positions.push(x * cos, x * sin, z);
      normals.push(nx * cos, nx * sin, nz);
    });
  }
  const quads = [];
  const n = points.length;
  for (let s = 0; s < LATHE_STEPS; s += 1) {
    for (let i = 0; i < n - 1; i += 1) {
      quads.push([s * n + i, s * n + i + 1, (s + 1) * n + i, (s + 1) * n + i + 1]);
    }
  }
  return finishGeometry(positions, normals, quads);
}

/**
 * Render flat line segments [x1, y1, z1, x2, y2, z2, ...] as solid struts
 * with the print profile (see `strutProfile`), oriented so the profile's
 * height points away from the sphere center, with rounded joints.
 * Optional `colors` (one Color per segment) tint each strut and its joints.
 */
export function buildTubeGroup(segments, profile, material, colors = null) {
  const count = segments.length / 6;
  const struts = new InstancedMesh(strutGeometry(profile), material, count);
  const joints = [];
  const jointColors = [];
  const seen = new Set();
  const addJoint = (point, segment) => {
    const key = `${point.x.toFixed(5)},${point.y.toFixed(5)},${point.z.toFixed(5)}`;
    if (!seen.has(key)) {
      seen.add(key);
      joints.push(point.clone());
      jointColors.push(colors?.[segment]);
    }
  };

  for (let i = 0; i < count; i += 1) {
    start.fromArray(segments, i * 6);
    end.fromArray(segments, i * 6 + 3);
    dir.subVectors(end, start);
    const length = dir.length();
    dir.divideScalar(length || 1);
    mid.addVectors(start, end).multiplyScalar(0.5);
    radial.copy(mid).normalize();
    lateral.crossVectors(dir, radial).normalize();
    radial.crossVectors(lateral, dir);
    rotation.setFromRotationMatrix(basis.makeBasis(lateral, dir, radial));
    struts.setMatrixAt(i, matrix.compose(mid, rotation, unit.set(1, length, 1)));
    if (colors) {
      struts.setColorAt(i, colors[i]);
    }
    addJoint(start, i);
    addJoint(end, i);
  }

  const jointMesh = new InstancedMesh(jointGeometry(profile), material, joints.length);
  joints.forEach((point, i) => {
    rotation.setFromUnitVectors(Z, radial.copy(point).normalize());
    jointMesh.setMatrixAt(i, matrix.compose(point, rotation, unit.setScalar(JOINT_SCALE)));
    if (colors) {
      jointMesh.setColorAt(i, jointColors[i]);
    }
  });

  const group = new Group();
  group.add(struts, jointMesh);
  return group;
}

export function disposeTubeGroup(group) {
  group.traverse((object) => {
    if (object.isMesh) {
      object.geometry.dispose();
      object.dispose?.();
    }
  });
}
