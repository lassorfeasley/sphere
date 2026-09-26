import { Quaternion, Vector3 } from 'three';

/**
 * Hang the ornament from its loop and let the loose pieces settle.
 *
 * The piece carrying the loop (`fixedPiece`) stays put; every other piece is
 * a rigid body made of round struts that falls under gravity until it rests
 * against struts of other pieces. Uses position-based rigid-body dynamics:
 * each step predicts every body's pose, then pushes bodies out of contact
 * by moving and turning them as a whole (weighted by how far the contact is
 * from the body's center), and derives velocities from the corrected poses.
 * Inertia is approximated as isotropic and friction as extra damping while
 * in contact, which is plenty for seeing how loose the pieces hang. Pieces
 * whose struts already overlap in the design fuse when printed, so they are
 * welded into one rigid body before simulating.
 *
 * All lengths are in scene units. Gravity points along -Y until changed with
 * setGravityDirection, which re-wakes the simulation.
 */
export class HangSimulation {
  constructor({ segments, pieceIds: designPieces, strutRadius, gravity, fixedPiece = 0, fallLimit }) {
    this.strutRadius = strutRadius;
    this.gravity = gravity;
    this.fallLimit = fallLimit;
    this.gravityDirection = new Vector3(0, -1, 0);
    this.dt = 1 / 240;
    this.damping = 0.98;
    this.steps = 0;

    const pieceIds = weldOverlappingPieces(segments, designPieces, strutRadius, fixedPiece);
    const bodies = new Map();
    const bodyOf = (id) => {
      if (!bodies.has(id)) {
        bodies.set(id, { id, fixed: id === fixedPiece, points: [], keys: new Map(), segments: [] });
      }
      return bodies.get(id);
    };
    for (let i = 0; i < segments.length / 6; i += 1) {
      const body = bodyOf(pieceIds[i]);
      const ends = [0, 3].map((o) => {
        const p = new Vector3().fromArray(segments, i * 6 + o);
        const key = `${p.x.toFixed(5)},${p.y.toFixed(5)},${p.z.toFixed(5)}`;
        if (!body.keys.has(key)) {
          body.keys.set(key, body.points.length);
          body.points.push(p);
        }
        return body.keys.get(key);
      });
      body.segments.push(ends);
    }

    bodies.forEach((body) => {
      body.restCenter = body.points.reduce((sum, p) => sum.add(p), new Vector3()).divideScalar(body.points.length);
      body.local = body.points.map((p) => p.clone().sub(body.restCenter));
      body.gyration = body.local.reduce((sum, p) => sum + p.lengthSq(), 0) / body.local.length || strutRadius ** 2;
      body.center = body.restCenter.clone();
      body.rotation = new Quaternion();
      body.velocity = new Vector3();
      body.spin = new Vector3();
      body.world = body.local.map((p) => p.clone().add(body.center));
      body.fallen = false;
      body.shift = 0;
      body.touching = false;
    });
    this.bodies = [...bodies.values()];
    this.moving = this.bodies.filter((body) => !body.fixed);
    // Which body each design piece ended up in (pieces can be welded).
    this.bodyOfPiece = new Map();
    designPieces.forEach((piece, i) => this.bodyOfPiece.set(piece, bodies.get(pieceIds[i])));
  }

  /**
   * Point gravity along `direction` (any length). Returns true if it moved
   * enough (over half a degree) to restart settling.
   */
  setGravityDirection(direction) {
    const next = direction.clone().normalize();
    if (next.angleTo(this.gravityDirection) < Math.PI / 360) {
      return false;
    }
    this.gravityDirection.copy(next);
    this.steps = 0;
    return true;
  }

  get loosePieceCount() {
    return this.moving.length;
  }

  /** Current rigid pose of a piece: world = rotation · (rest − restCenter) + center. */
  pose(pieceId) {
    return this.bodies.find((body) => body.id === pieceId);
  }

  /** Advance `count` time steps. Returns true once everything has settled. */
  step(count = 1) {
    for (let n = 0; n < count; n += 1) {
      this.steps += 1;
      const active = this.moving.filter((body) => !body.fallen);
      if (!active.length) {
        return true;
      }
      const dt = this.dt;

      active.forEach((body) => {
        body.previousCenter = body.center.clone();
        body.previousRotation = body.rotation.clone();
        body.velocity.addScaledVector(this.gravityDirection, this.gravity * dt);
        body.center.addScaledVector(body.velocity, dt);
        rotateBy(body.rotation, body.spin.clone().multiplyScalar(dt));
        updateWorld(body);
      });

      active.forEach((body) => {
        body.touching = false;
      });
      for (let iteration = 0; iteration < 4; iteration += 1) {
        this.resolveContacts(active);
      }

      active.forEach((body) => {
        // Friction, approximated: bodies in contact lose speed much faster.
        const damping = body.touching ? this.damping * 0.95 : this.damping;
        body.velocity.subVectors(body.center, body.previousCenter).divideScalar(dt).multiplyScalar(damping);
        const delta = body.rotation.clone().multiply(body.previousRotation.clone().invert());
        if (delta.w < 0) {
          delta.set(-delta.x, -delta.y, -delta.z, -delta.w);
        }
        body.spin.set(delta.x, delta.y, delta.z).multiplyScalar((2 / dt) * damping);
        // No point may move more than half a strut radius per step, so struts
        // can't tunnel through each other between contact checks.
        const maxSpeed = (this.strutRadius * 0.5) / dt;
        if (body.velocity.length() > maxSpeed) {
          body.velocity.setLength(maxSpeed);
        }
        const maxSpin = maxSpeed / Math.sqrt(body.gyration);
        if (body.spin.length() > maxSpin) {
          body.spin.setLength(maxSpin);
        }
        body.shift = Math.max(...body.world.map((p, i) => p.distanceTo(body.points[i])));
        if (body.shift > this.fallLimit) {
          body.fallen = true;
        }
      });
    }
    return this.settled();
  }

  settled() {
    if (this.steps > 2400) {
      return true;
    }
    if (this.steps < 60) {
      return false;
    }
    // Speeds are per second: settled once nothing moves faster than about
    // one strut radius per second.
    const still = this.strutRadius;
    return this.moving.every(
      (body) => body.fallen || (body.velocity.length() < still && body.spin.length() * Math.sqrt(body.gyration) < still),
    );
  }

  /**
   * Visit every (particle, nearby strut of another piece) pair, using
   * positions as of the call: callback(body, particleIndex, other, a, b).
   */
  forEachCandidate(bodies, callback) {
    const reach = 2 * this.strutRadius;
    const cell = reach * 2;
    const grid = new Map();
    const key = (x, y, z) => cellKey(Math.floor(x / cell), Math.floor(y / cell), Math.floor(z / cell));
    this.bodies.forEach((body) => {
      if (body.fallen) {
        return;
      }
      body.segments.forEach(([a, b]) => {
        const pa = body.world[a];
        const pb = body.world[b];
        const k = key((pa.x + pb.x) / 2, (pa.y + pb.y) / 2, (pa.z + pb.z) / 2);
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push({ body, a, b });
      });
    });

    bodies.forEach((body) => {
      body.world.forEach((p, index) => {
        const cx = Math.floor(p.x / cell);
        const cy = Math.floor(p.y / cell);
        const cz = Math.floor(p.z / cell);
        for (let dx = -1; dx <= 1; dx += 1) {
          for (let dy = -1; dy <= 1; dy += 1) {
            for (let dz = -1; dz <= 1; dz += 1) {
              const bucket = grid.get(cellKey(cx + dx, cy + dy, cz + dz));
              if (!bucket) {
                continue;
              }
              for (let k = 0; k < bucket.length; k += 1) {
                const { body: other, a, b } = bucket[k];
                if (other !== body) {
                  callback(body, index, other, a, b);
                }
              }
            }
          }
        }
      });
    });
  }

  /**
   * One pass of contact resolution, applied contact by contact. Candidate
   * pairs come from positions at the start of the pass; each test uses both
   * bodies' current poses, so corrections take effect immediately.
   */
  resolveContacts(active) {
    const reach = 2 * this.strutRadius;
    const p = new Vector3();
    const a = new Vector3();
    const b = new Vector3();
    const closest = new Vector3();
    const normal = new Vector3();
    const arm = new Vector3();
    this.forEachCandidate(active, (body, index, other, ia, ib) => {
      toWorld(body, index, p);
      toWorld(other, ia, a);
      toWorld(other, ib, b);
      closestOnSegment(p, a, b, closest);
      normal.subVectors(p, closest);
      const distance = normal.length();
      // Capped per contact, so points that start almost on top of another
      // strut (where the push direction is unreliable) can't fling a body.
      const depth = Math.min(reach - distance, this.strutRadius * 0.4);
      if (depth <= 0 || distance < this.strutRadius * 0.05) {
        return;
      }
      body.touching = true;
      normal.divideScalar(distance);
      const bothMove = !other.fixed && !other.fallen;
      arm.subVectors(p, body.center);
      applyCorrection(body, normal, bothMove ? depth / 2 : depth, arm);
      if (bothMove) {
        other.touching = true;
        arm.subVectors(closest, other.center);
        applyCorrection(other, normal.negate(), depth / 2, arm);
      }
    });
    active.forEach(updateWorld);
  }
}

/**
 * Move a body so the contact point at `arm` (from its center) travels
 * `depth` along `normal`, split between translation and rotation by the
 * generalized inverse mass (unit mass, isotropic inertia).
 */
function applyCorrection(body, normal, depth, arm) {
  const torqueAxis = arm.clone().cross(normal);
  const inverseInertia = 1 / body.gyration;
  const lambda = depth / (1 + torqueAxis.lengthSq() * inverseInertia);
  body.center.addScaledVector(normal, lambda);
  rotateBy(body.rotation, torqueAxis.multiplyScalar(lambda * inverseInertia));
}

function toWorld(body, index, target) {
  return target.copy(body.local[index]).applyQuaternion(body.rotation).add(body.center);
}

function rotateBy(rotation, angleVector) {
  const angle = angleVector.length();
  if (angle < 1e-12) {
    return;
  }
  rotation.premultiply(new Quaternion().setFromAxisAngle(angleVector.divideScalar(angle), angle)).normalize();
}

function updateWorld(body) {
  body.local.forEach((p, i) => {
    body.world[i].copy(p).applyQuaternion(body.rotation).add(body.center);
  });
}

/**
 * Merge design pieces whose struts overlap (they fuse when printed). Returns
 * a piece id per segment; a merged group takes `fixedPiece` if it contains
 * it, otherwise its smallest id.
 */
function weldOverlappingPieces(segments, pieceIds, strutRadius, fixedPiece) {
  const count = segments.length / 6;
  const reach = 2 * strutRadius * 0.98;
  const parent = new Map();
  const find = (id) => {
    if (!parent.has(id)) parent.set(id, id);
    while (parent.get(id) !== id) {
      parent.set(id, parent.get(parent.get(id)));
      id = parent.get(id);
    }
    return id;
  };
  const cell = reach * 2;
  const grid = new Map();
  const mid = (i, k) => (segments[i * 6 + k] + segments[i * 6 + 3 + k]) / 2;
  for (let i = 0; i < count; i += 1) {
    const key = cellKey(Math.floor(mid(i, 0) / cell), Math.floor(mid(i, 1) / cell), Math.floor(mid(i, 2) / cell));
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(i);
  }
  const p = new Vector3();
  const a = new Vector3();
  const b = new Vector3();
  const closest = new Vector3();
  for (let i = 0; i < count; i += 1) {
    const cx = Math.floor(mid(i, 0) / cell);
    const cy = Math.floor(mid(i, 1) / cell);
    const cz = Math.floor(mid(i, 2) / cell);
    p.set(mid(i, 0), mid(i, 1), mid(i, 2));
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
          (grid.get(cellKey(cx + dx, cy + dy, cz + dz)) ?? []).forEach((j) => {
            if (find(pieceIds[i]) === find(pieceIds[j])) {
              return;
            }
            a.fromArray(segments, j * 6);
            b.fromArray(segments, j * 6 + 3);
            if (closestOnSegment(p, a, b, closest).distanceTo(p) < reach) {
              const ri = find(pieceIds[i]);
              const rj = find(pieceIds[j]);
              const keep = ri === find(fixedPiece) || (rj !== find(fixedPiece) && ri < rj) ? ri : rj;
              parent.set(ri === keep ? rj : ri, keep);
            }
          });
        }
      }
    }
  }
  return Array.from(pieceIds, (id) => find(id));
}

function cellKey(x, y, z) {
  return ((x + 1024) * 2048 + (y + 1024)) * 2048 + (z + 1024);
}

function closestOnSegment(p, a, b, target) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const lengthSq = abx * abx + aby * aby + abz * abz;
  const t = lengthSq > 0 ? Math.min(1, Math.max(0, ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / lengthSq)) : 0;
  return target.set(a.x + abx * t, a.y + aby * t, a.z + abz * t);
}
