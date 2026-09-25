import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three';

const UP = new Vector3(0, 1, 0);
const TUBE_SIDES = 16;
// Joint spheres match the faceted cylinder's inner radius so they don't poke
// through its flat sides.
const JOINT_SCALE = Math.cos(Math.PI / TUBE_SIDES);
const start = new Vector3();
const end = new Vector3();
const mid = new Vector3();
const dir = new Vector3();
const radial = new Vector3();
const lateral = new Vector3();
const scale = new Vector3();
const rotation = new Quaternion();
const matrix = new Matrix4();
const basis = new Matrix4();

/**
 * Render flat line segments [x1, y1, z1, x2, y2, z2, ...] as solid struts
 * matching the print profile: round tubes with spherical joints, or flat
 * bands whose outer face sits on the sphere with cylindrical joints.
 * Optional `colors` (one Color per segment) tint each strut and its joints.
 */
export function buildTubeGroup(segments, profile, material, colors = null) {
  const count = segments.length / 6;
  const band = profile.type === 'band';
  const struts = new InstancedMesh(
    band ? new BoxGeometry(1, 1, 1) : new CylinderGeometry(1, 1, 1, TUBE_SIDES, 1, true),
    material,
    count,
  );
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
    if (band) {
      radial.copy(mid).normalize();
      lateral.crossVectors(dir, radial).normalize();
      radial.crossVectors(lateral, dir);
      rotation.setFromRotationMatrix(basis.makeBasis(lateral, dir, radial));
      mid.addScaledVector(radial, -profile.depth / 2);
      scale.set(profile.width, length, profile.depth);
    } else {
      rotation.setFromUnitVectors(UP, dir);
      scale.set(profile.radius, length, profile.radius);
    }
    struts.setMatrixAt(i, matrix.compose(mid, rotation, scale));
    if (colors) {
      struts.setColorAt(i, colors[i]);
    }
    addJoint(start, i);
    addJoint(end, i);
  }

  const jointMesh = new InstancedMesh(
    band ? new CylinderGeometry(1, 1, 1, 12) : new SphereGeometry(1, TUBE_SIDES, TUBE_SIDES / 2),
    material,
    joints.length,
  );
  joints.forEach((point, i) => {
    if (band) {
      radial.copy(point).normalize();
      rotation.setFromUnitVectors(UP, radial);
      mid.copy(point).addScaledVector(radial, -profile.depth / 2);
      scale.set(profile.width / 2, profile.depth, profile.width / 2);
    } else {
      rotation.identity();
      mid.copy(point);
      scale.setScalar(profile.radius * JOINT_SCALE);
    }
    jointMesh.setMatrixAt(i, matrix.compose(mid, rotation, scale));
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
