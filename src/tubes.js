import {
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  Quaternion,
  Vector3,
} from 'three';

const Z = new Vector3(0, 0, 1);
// Points per quarter of the rounded outline; a full circle gets 16 sides.
const CORNER_STEPS = 4;
const LATHE_STEPS = 16;
// Joints match the faceted strut's inner width so they don't poke through
// its flat sides, but keep full height so they close off tube ends.
const JOINT_SCALE = new Vector3(Math.cos(Math.PI / LATHE_STEPS), Math.cos(Math.PI / LATHE_STEPS), 1);
// Segments whose ends are closer than this (squared, scene units) are joined.
const JOIN_EPSILON_SQ = 1e-12;
// A tube bends through turns up to this angle with a mitered ring; sharper
// corners end the tube and get a rounded joint, as the solid does.
const MAX_MITER_COS = Math.cos((40 * Math.PI) / 180);
const rotation = new Quaternion();
const matrix = new Matrix4();
const up = new Vector3();

// Joints sit just inside flat strut sides, nearly coplanar with them; a
// depth offset keeps the strut faces in front.
const jointMaterials = new WeakMap();
export const jointMaterial = (material) => {
  let joint = jointMaterials.get(material);
  if (!joint) {
    joint = material.clone();
    // Joints are instanced and tinted per instance, never by vertex.
    joint.vertexColors = false;
    joint.polygonOffset = true;
    joint.polygonOffsetFactor = 1;
    joint.polygonOffsetUnits = 4;
    jointMaterials.set(material, joint);
  }
  return joint;
};

/**
 * One quarter arc per corner of the rounded rectangle, counterclockwise from
 * the +x side, as { x, z, nx, nz } (x across the surface, z out from it).
 * Arcs of radius 0 collapse to a point whose normals turn sharply.
 * Exported so the UI can draw the exact cross-section the struts extrude.
 */
export function outline({ halfWidth, halfHeight, corner }, quarters = [0, 1, 2, 3]) {
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

/**
 * Half the profile spun around the z axis: the rounded end cap where struts
 * meet, the same shape the solid gives joints.
 */
function jointGeometry(profile) {
  const points = outline(profile, [3, 0]);
  // Flat-topped profiles leave a hole on the axis; close it top and bottom.
  if (points[0].x > 1e-9) {
    points.unshift({ x: 0, z: points[0].z, nx: 0, nz: -1 });
    points.push({ x: 0, z: points[points.length - 1].z, nx: 0, nz: 1 });
  }
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
 * Split segments into chains of points: runs of consecutive segments where
 * each starts at the previous one's end, turns gently, and keeps the same
 * color. A chain whose ends meet (with a gentle turn) is marked closed.
 */
function traceChains(segments, colors) {
  const count = segments.length / 6;
  const chains = [];
  let chain = null;
  let lastDir = null;
  for (let i = 0; i < count; i += 1) {
    const a = new Vector3().fromArray(segments, i * 6);
    const b = new Vector3().fromArray(segments, i * 6 + 3);
    const dir = b.clone().sub(a);
    if (dir.lengthSq() < JOIN_EPSILON_SQ) {
      continue;
    }
    dir.normalize();
    const joins =
      chain &&
      chain.points[chain.points.length - 1].distanceToSquared(a) < JOIN_EPSILON_SQ &&
      lastDir.dot(dir) >= MAX_MITER_COS &&
      (!colors || colors[i].equals(chain.color));
    if (joins) {
      chain.points.push(b);
      chain.spans.push(i);
    } else {
      chain = { points: [a, b], spans: [i], color: colors?.[i], closed: false };
      chains.push(chain);
    }
    lastDir = dir;
  }
  chains.forEach((c) => {
    const { points } = c;
    const n = points.length;
    if (n > 3 && points[0].distanceToSquared(points[n - 1]) < JOIN_EPSILON_SQ) {
      const first = points[1].clone().sub(points[0]).normalize();
      const last = points[n - 1].clone().sub(points[n - 2]).normalize();
      if (first.dot(last) >= MAX_MITER_COS) {
        points.pop();
        c.closed = true;
      }
    }
  });
  return chains;
}

/**
 * One continuous tube per chain: a ring of the profile at every point,
 * facing halfway between the neighboring segments and stretched across the
 * bend so the tube keeps its thickness, with the profile's height pointing
 * along the segments' `ups`, or away from the sphere center where those are
 * zero. Neighboring segments share rings, so the shading runs smoothly
 * along the whole chain.
 */
function sweptGeometry(chains, profile, withColors, ups) {
  const ring = outline(profile);
  const size = ring.length;
  const positions = [];
  const normals = [];
  const colors = [];
  const quads = [];
  const tangent = new Vector3();
  const lateral = new Vector3();
  const bend = new Vector3();
  const offset = new Vector3();
  const normal = new Vector3();
  const prev = new Vector3();
  const next = new Vector3();
  let base = 0;

  const hint = new Vector3();
  const addUp = (span) => {
    if (ups && span !== undefined) {
      hint.x += ups[span * 3];
      hint.y += ups[span * 3 + 1];
      hint.z += ups[span * 3 + 2];
    }
  };

  chains.forEach(({ points, spans, color, closed }) => {
    const n = points.length;
    const lastUp = new Vector3();
    for (let k = 0; k < n; k += 1) {
      const p = points[k];
      const hasPrev = k > 0 || closed;
      const hasNext = k < n - 1 || closed;
      if (hasPrev) {
        prev.subVectors(p, points[(k - 1 + n) % n]).normalize();
      }
      if (hasNext) {
        next.subVectors(points[(k + 1) % n], p).normalize();
      }
      tangent.set(0, 0, 0);
      if (hasPrev) {
        tangent.add(prev);
      }
      if (hasNext) {
        tangent.add(next);
      }
      tangent.normalize();

      hint.set(0, 0, 0);
      addUp(k > 0 ? spans[k - 1] : closed ? spans[n - 1] : undefined);
      addUp(spans[k]);
      if (hint.lengthSq() > 1e-12) {
        up.copy(hint).normalize();
      } else {
        up.copy(p).normalize();
      }
      up.addScaledVector(tangent, -up.dot(tangent));
      if (up.lengthSq() < 1e-12) {
        up.copy(lastUp);
      }
      up.normalize();
      lastUp.copy(up);
      lateral.crossVectors(tangent, up).normalize();
      up.crossVectors(lateral, tangent);

      let stretch = 0;
      if (hasPrev && hasNext) {
        bend.subVectors(next, prev);
        if (bend.lengthSq() > 1e-12) {
          bend.normalize();
          stretch = 1 / Math.max(prev.dot(tangent), 1e-3) - 1;
        }
      }

      ring.forEach(({ x, z, nx, nz }) => {
        offset.copy(lateral).multiplyScalar(x).addScaledVector(up, z);
        if (stretch) {
          offset.addScaledVector(bend, offset.dot(bend) * stretch);
        }
        positions.push(p.x + offset.x, p.y + offset.y, p.z + offset.z);
        normal.copy(lateral).multiplyScalar(nx).addScaledVector(up, nz);
        normals.push(normal.x, normal.y, normal.z);
        if (withColors) {
          colors.push(color.r, color.g, color.b);
        }
      });
    }

    const spanCount = closed ? n : n - 1;
    for (let k = 0; k < spanCount; k += 1) {
      const r0 = base + k * size;
      const r1 = base + ((k + 1) % n) * size;
      for (let i = 0; i < size; i += 1) {
        const j = (i + 1) % size;
        quads.push([r0 + i, r0 + j, r1 + i, r1 + j]);
      }
    }
    base += n * size;
  });

  const geometry = finishGeometry(positions, normals, quads);
  if (withColors) {
    geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  }
  return geometry;
}

/**
 * Render flat line segments [x1, y1, z1, x2, y2, z2, ...] as solid struts
 * with the print profile (see `strutProfile`), oriented so the profile's
 * height points away from the sphere center, or along `ups` (one direction
 * per segment, zero for away from the center) where given. Consecutive
 * segments that join end to start form one smooth tube; tube ends get
 * rounded joints. Optional `colors` (one Color per segment) tint each strut
 * and its joints; the material must then have `vertexColors` on.
 */
export function buildTubeGroup(segments, profile, material, colors = null, ups = null) {
  const chains = traceChains(segments, colors);
  const tubes = new Mesh(sweptGeometry(chains, profile, Boolean(colors), ups), material);

  const joints = [];
  const jointColors = [];
  const seen = new Set();
  const addJoint = (point, color) => {
    const key = `${point.x.toFixed(5)},${point.y.toFixed(5)},${point.z.toFixed(5)}`;
    if (!seen.has(key)) {
      seen.add(key);
      joints.push(point);
      jointColors.push(color);
    }
  };
  chains.forEach(({ points, color, closed }) => {
    if (!closed) {
      addJoint(points[0], color);
      addJoint(points[points.length - 1], color);
    }
  });

  const jointMesh = new InstancedMesh(jointGeometry(profile), jointMaterial(material), joints.length);
  joints.forEach((point, i) => {
    rotation.setFromUnitVectors(Z, up.copy(point).normalize());
    jointMesh.setMatrixAt(i, matrix.compose(point, rotation, JOINT_SCALE));
    if (colors) {
      jointMesh.setColorAt(i, jointColors[i]);
    }
  });

  const group = new Group();
  group.add(tubes, jointMesh);
  return group;
}

/**
 * Per-vertex colors for a mesh built around `segments`: each vertex takes the
 * color of its nearest segment within `reach`, or `fallback` beyond it.
 * Returns a flat [r, g, b, ...] array matching `positions`.
 */
export function nearestSegmentColors(positions, segments, colors, reach, fallback) {
  const grid = new Map();
  const cell = (v) => Math.floor(v / reach);
  const key = (x, y, z) => `${x},${y},${z}`;
  for (let s = 0; s < segments.length / 6; s += 1) {
    const o = s * 6;
    const lo = [0, 1, 2].map((k) => cell(Math.min(segments[o + k], segments[o + 3 + k]) - reach));
    const hi = [0, 1, 2].map((k) => cell(Math.max(segments[o + k], segments[o + 3 + k]) + reach));
    for (let x = lo[0]; x <= hi[0]; x += 1) {
      for (let y = lo[1]; y <= hi[1]; y += 1) {
        for (let z = lo[2]; z <= hi[2]; z += 1) {
          const k = key(x, y, z);
          if (!grid.has(k)) {
            grid.set(k, []);
          }
          grid.get(k).push(s);
        }
      }
    }
  }

  const out = new Float32Array(positions.length);
  for (let v = 0; v < positions.length; v += 3) {
    const px = positions[v];
    const py = positions[v + 1];
    const pz = positions[v + 2];
    const bucket = grid.get(key(cell(px), cell(py), cell(pz)));
    let best = -1;
    let bestSq = reach * reach;
    for (let i = 0; bucket && i < bucket.length; i += 1) {
      const o = bucket[i] * 6;
      const dx = segments[o + 3] - segments[o];
      const dy = segments[o + 4] - segments[o + 1];
      const dz = segments[o + 5] - segments[o + 2];
      const lengthSq = dx * dx + dy * dy + dz * dz;
      const t = lengthSq > 0
        ? Math.min(Math.max(((px - segments[o]) * dx + (py - segments[o + 1]) * dy + (pz - segments[o + 2]) * dz) / lengthSq, 0), 1)
        : 0;
      const ex = px - segments[o] - dx * t;
      const ey = py - segments[o + 1] - dy * t;
      const ez = pz - segments[o + 2] - dz * t;
      const distSq = ex * ex + ey * ey + ez * ez;
      if (distSq < bestSq) {
        bestSq = distSq;
        best = bucket[i];
      }
    }
    const color = best >= 0 ? colors[best] : fallback;
    out[v] = color.r;
    out[v + 1] = color.g;
    out[v + 2] = color.b;
  }
  return out;
}

export function disposeTubeGroup(group) {
  group.traverse((object) => {
    if (object.isMesh) {
      object.geometry.dispose();
      object.dispose?.();
    }
  });
}
