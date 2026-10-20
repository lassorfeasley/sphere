import Module from 'manifold-3d';
import { junctionWeight, pressAtEnds as findPresses } from './press.js';

let manifoldPromise = null;

function getManifoldModule() {
  if (!manifoldPromise) {
    manifoldPromise = Module().then((wasm) => {
      wasm.setup();
      return wasm;
    });
  }
  return manifoldPromise;
}

// Far below any printer's resolution, but well above float32 rounding at
// sphere sizes, so STL readers can't weld the vertices back together.
const TOUCH_SEPARATION_MM = 0.01;

/**
 * Where two parts of the level-set surface just touch, the mesh keeps
 * separate vertices at one position. That's manifold as an indexed mesh, but
 * STL matches corners by position, so print services see edges shared by
 * four triangles and reject the file. Move each such vertex `distance` into
 * its own side of the surface (against its normal), opening the contact.
 */
function separateTouchingVertices(vertProperties, triVerts, numProp, distance) {
  const vertexCount = vertProperties.length / numProp;
  const firstAt = new Map();
  const touching = new Uint8Array(vertexCount);
  let any = false;
  for (let v = 0; v < vertexCount; v += 1) {
    const o = v * numProp;
    const key = `${vertProperties[o]},${vertProperties[o + 1]},${vertProperties[o + 2]}`;
    const first = firstAt.get(key);
    if (first === undefined) {
      firstAt.set(key, v);
    } else {
      touching[first] = 1;
      touching[v] = 1;
      any = true;
    }
  }
  if (!any) {
    return;
  }
  // Area-weighted normals, only for the touching vertices.
  const normals = new Map();
  for (let t = 0; t < triVerts.length; t += 3) {
    const a = triVerts[t];
    const b = triVerts[t + 1];
    const c = triVerts[t + 2];
    if (!(touching[a] || touching[b] || touching[c])) {
      continue;
    }
    const ax = vertProperties[a * numProp];
    const ay = vertProperties[a * numProp + 1];
    const az = vertProperties[a * numProp + 2];
    const ux = vertProperties[b * numProp] - ax;
    const uy = vertProperties[b * numProp + 1] - ay;
    const uz = vertProperties[b * numProp + 2] - az;
    const wx = vertProperties[c * numProp] - ax;
    const wy = vertProperties[c * numProp + 1] - ay;
    const wz = vertProperties[c * numProp + 2] - az;
    const n = [uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx];
    [a, b, c].forEach((v) => {
      if (touching[v]) {
        const sum = normals.get(v) ?? [0, 0, 0];
        sum[0] += n[0];
        sum[1] += n[1];
        sum[2] += n[2];
        normals.set(v, sum);
      }
    });
  }
  normals.forEach(([nx, ny, nz], v) => {
    const length = Math.hypot(nx, ny, nz);
    if (length > 0) {
      const o = v * numProp;
      vertProperties[o] -= (nx / length) * distance;
      vertProperties[o + 1] -= (ny / length) * distance;
      vertProperties[o + 2] -= (nz / length) * distance;
    }
  });
}

/**
 * Vertex neighbors from a triangle list, as CSR arrays { start, list }:
 * the neighbors of v are list[start[v]] .. list[start[v + 1] - 1].
 */
function vertexNeighbors(vertexCount, triVerts) {
  const count = new Uint32Array(vertexCount + 1);
  for (let t = 0; t < triVerts.length; t += 1) {
    count[triVerts[t] + 1] += 2;
  }
  for (let v = 0; v < vertexCount; v += 1) {
    count[v + 1] += count[v];
  }
  const list = new Uint32Array(count[vertexCount]);
  const fill = count.slice(0, vertexCount);
  for (let t = 0; t < triVerts.length; t += 3) {
    for (let k = 0; k < 3; k += 1) {
      const v = triVerts[t + k];
      list[fill[v]++] = triVerts[t + ((k + 1) % 3)];
      list[fill[v]++] = triVerts[t + ((k + 2) % 3)];
    }
  }
  // Each neighbor shows up twice (once per shared triangle), which weights
  // them all alike.
  return { start: count, list };
}

/**
 * Split the marked triangles (all of them when `marked` is null) into four
 * at their edge midpoints. A neighbor sharing one or two split edges is cut
 * into two or three, so the mesh stays closed with no hanging vertices.
 * Returns the new mesh and which vertices belong to a split triangle.
 */
function subdivide(positions, triVerts, marked = null) {
  const vertexCount = positions.length / 3;
  const midpoints = new Map();
  const added = [];
  const edgeKey = (a, b) => (a < b ? a * vertexCount + b : b * vertexCount + a);
  const split = (a, b) => {
    const key = edgeKey(a, b);
    let index = midpoints.get(key);
    if (index === undefined) {
      index = vertexCount + added.length / 3;
      midpoints.set(key, index);
      for (let k = 0; k < 3; k += 1) {
        added.push((positions[a * 3 + k] + positions[b * 3 + k]) / 2);
      }
    }
    return index;
  };
  for (let t = 0; t < triVerts.length; t += 3) {
    if (!marked || marked[t / 3]) {
      split(triVerts[t], triVerts[t + 1]);
      split(triVerts[t + 1], triVerts[t + 2]);
      split(triVerts[t + 2], triVerts[t]);
    }
  }
  const out = new Float64Array(positions.length + added.length);
  out.set(positions);
  out.set(added, positions.length);
  const touched = new Uint8Array(out.length / 3);
  const distanceSq = (a, b) => {
    const dx = out[a * 3] - out[b * 3];
    const dy = out[a * 3 + 1] - out[b * 3 + 1];
    const dz = out[a * 3 + 2] - out[b * 3 + 2];
    return dx * dx + dy * dy + dz * dz;
  };
  // A triangle with n split edges becomes n + 1 triangles.
  const triangleCount = triVerts.length / 3;
  const splitEdges = new Uint8Array(triangleCount);
  let total = 0;
  for (let t = 0; t < triangleCount; t += 1) {
    for (let k = 0; k < 3; k += 1) {
      if (midpoints.has(edgeKey(triVerts[t * 3 + k], triVerts[t * 3 + ((k + 1) % 3)]))) {
        splitEdges[t] += 1;
      }
    }
    total += splitEdges[t] + 1;
  }
  const tris = new Uint32Array(total * 3);
  let at = 0;
  const emit = (...corners) => {
    tris.set(corners, at);
    at += corners.length;
    corners.forEach((v) => {
      touched[v] = 1;
    });
  };
  for (let t = 0; t < triVerts.length; t += 3) {
    const splitCount = splitEdges[t / 3];
    if (splitCount === 0) {
      tris.set(triVerts.subarray(t, t + 3), at);
      at += 3;
      continue;
    }
    let corners = [triVerts[t], triVerts[t + 1], triVerts[t + 2]];
    let mids = corners.map((v, k) => midpoints.get(edgeKey(v, corners[(k + 1) % 3])));
    // Turn the triangle so its split edges come first (keeping its winding).
    while (mids[0] === undefined || (splitCount === 2 && mids[1] === undefined)) {
      corners = [corners[1], corners[2], corners[0]];
      mids = [mids[1], mids[2], mids[0]];
    }
    const [a, b, c] = corners;
    const [ab, bc, ca] = mids;
    if (splitCount === 3) {
      emit(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
    } else if (splitCount === 1) {
      emit(a, ab, c, ab, b, c);
    } else if (distanceSq(a, bc) < distanceSq(ab, c)) {
      emit(b, bc, ab, a, ab, bc, a, bc, c);
    } else {
      emit(b, bc, ab, a, ab, c, ab, bc, c);
    }
  }
  return { positions: out, triVerts: tris, touched };
}

/**
 * Settle a level-set mesh onto its surface: each round evens out the
 * triangles (moving every vertex toward its neighbors' middle, along the
 * surface only) and then puts every vertex back on the surface with Newton
 * steps along the field's gradient. Even triangles lying exactly on the
 * surface shade smoothly, where the grid's interpolated vertices zigzag
 * across tight creases. `sdf(x, y, z)` is positive inside. Only the
 * `movable` vertices move when given. After each vertex is measured,
 * `inCrease()` tells whether the field there is a crease, and that goes into
 * `creaseFlags` when given.
 */
function settleOnSurface(positions, triVerts, sdf, { step, rounds, movable = null, inCrease = null, creaseFlags = null }) {
  const vertexCount = positions.length / 3;
  const { start, list } = vertexNeighbors(vertexCount, triVerts);
  // Where two parts of the surface touch, separate vertices share a spot;
  // moved apart, they could pass through each other, so they stay put.
  const pinned = new Uint8Array(vertexCount);
  const firstAt = new Map();
  for (let v = 0; v < vertexCount; v += 1) {
    const key = `${positions[v * 3]},${positions[v * 3 + 1]},${positions[v * 3 + 2]}`;
    const first = firstAt.get(key);
    if (first === undefined) {
      firstAt.set(key, v);
    } else {
      pinned[first] = 1;
      pinned[v] = 1;
    }
    if (movable && !movable[v]) {
      pinned[v] = 1;
    }
  }
  firstAt.clear();
  const h = step * 0.05;
  const gradient = [0, 0, 0];
  // The gradient found while projecting a vertex is kept for the next
  // round's evening out, which saves measuring the field again there.
  const known = new Float64Array(vertexCount * 3);
  const hasKnown = new Uint8Array(vertexCount);
  const gradientAt = (x, y, z, f) => {
    gradient[0] = (sdf(x + h, y, z) - f) / h;
    gradient[1] = (sdf(x, y + h, z) - f) / h;
    gradient[2] = (sdf(x, y, z + h) - f) / h;
    return gradient[0] * gradient[0] + gradient[1] * gradient[1] + gradient[2] * gradient[2];
  };
  const normalOf = (p, t, out) => {
    const [a, b, c] = [triVerts[t] * 3, triVerts[t + 1] * 3, triVerts[t + 2] * 3];
    const [ux, uy, uz] = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]];
    const [wx, wy, wz] = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
    out[0] = uy * wz - uz * wy;
    out[1] = uz * wx - ux * wz;
    out[2] = ux * wy - uy * wx;
    return out;
  };
  const [n0, n1] = [[0, 0, 0], [0, 0, 0]];
  const project = (v) => {
    if (pinned[v]) {
      return;
    }
    const o = v * 3;
    for (let i = 0; i < 3; i += 1) {
      const [x, y, z] = [positions[o], positions[o + 1], positions[o + 2]];
      const f = sdf(x, y, z);
      if (creaseFlags) {
        creaseFlags[v] = inCrease() ? 1 : 0;
      }
      if (Math.abs(f) < step * 1e-3) {
        return;
      }
      const lengthSq = gradientAt(x, y, z, f);
      if (!(lengthSq > 1e-12)) {
        return;
      }
      known.set(gradient, o);
      hasKnown[v] = 1;
      // Never farther than a step, in case the field is rough there.
      let scale = f / lengthSq;
      const move = Math.abs(scale) * Math.sqrt(lengthSq);
      if (move > step) {
        scale *= step / move;
      }
      positions[o] -= scale * gradient[0];
      positions[o + 1] -= scale * gradient[1];
      positions[o + 2] -= scale * gradient[2];
    }
  };
  const next = new Float64Array(positions.length);
  const before = new Float64Array(positions.length);
  // Any triangle the round turned over (or squashed flat) goes back to
  // where it was, so settling never folds the surface onto itself. Its
  // corners first get another try without the evening out, which is what
  // usually turns triangles over in tight creases.
  const undone = new Uint8Array(vertexCount);
  const flipped = (t) => {
    normalOf(before, t, n0);
    normalOf(positions, t, n1);
    const was = Math.hypot(...n0);
    const now = Math.hypot(...n1);
    return !(n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2] > 0 && now > 0.05 * was);
  };
  const undoFlips = () => {
    undone.fill(0);
    for (let pass = 0; pass < 4; pass += 1) {
      let undoneCount = 0;
      for (let t = 0; t < triVerts.length; t += 3) {
        if (!flipped(t)) {
          continue;
        }
        for (let k = 0; k < 3; k += 1) {
          const v = triVerts[t + k];
          const o = v * 3;
          if (positions[o] !== before[o] || positions[o + 1] !== before[o + 1] || positions[o + 2] !== before[o + 2]) {
            positions[o] = before[o];
            positions[o + 1] = before[o + 1];
            positions[o + 2] = before[o + 2];
            if (pass === 0 && !undone[v]) {
              undone[v] = 1;
              project(v);
            }
            undoneCount += 1;
          }
        }
      }
      if (!undoneCount) {
        return;
      }
    }
  };
  for (let round = 0; round < rounds; round += 1) {
    before.set(positions);
    for (let v = 0; v < vertexCount; v += 1) {
      const o = v * 3;
      const [x, y, z] = [positions[o], positions[o + 1], positions[o + 2]];
      if (pinned[v]) {
        next[o] = x;
        next[o + 1] = y;
        next[o + 2] = z;
        continue;
      }
      let [cx, cy, cz] = [0, 0, 0];
      const n = start[v + 1] - start[v];
      for (let j = start[v]; j < start[v + 1]; j += 1) {
        const u = list[j] * 3;
        cx += positions[u];
        cy += positions[u + 1];
        cz += positions[u + 2];
      }
      let [dx, dy, dz] = n ? [cx / n - x, cy / n - y, cz / n - z] : [0, 0, 0];
      let lengthSq;
      if (hasKnown[v]) {
        gradient[0] = known[o];
        gradient[1] = known[o + 1];
        gradient[2] = known[o + 2];
        lengthSq = gradient[0] * gradient[0] + gradient[1] * gradient[1] + gradient[2] * gradient[2];
      } else {
        lengthSq = gradientAt(x, y, z, sdf(x, y, z));
      }
      if (lengthSq > 1e-12) {
        const along = (dx * gradient[0] + dy * gradient[1] + dz * gradient[2]) / lengthSq;
        dx -= along * gradient[0];
        dy -= along * gradient[1];
        dz -= along * gradient[2];
      }
      next[o] = x + 0.5 * dx;
      next[o + 1] = y + 0.5 * dy;
      next[o + 2] = z + 0.5 * dz;
    }
    positions.set(next);
    for (let v = 0; v < vertexCount; v += 1) {
      project(v);
    }
    undoFlips();
  }
}

/**
 * Build a watertight strut lattice from a set of line segments.
 *
 * Every segment becomes a strut with a rounded-rectangle cross-section
 * centered on it: `halfWidth` across the sphere surface and `halfHeight` out
 * from it (measured along the sphere normal at the nearest point of the
 * segment), with corners of radius `corner`. Equal half sizes with a full
 * corner give a round capsule. Strut ends are that profile spun around the
 * sphere normal, so struts meeting at a joint fuse smoothly. Overlapping
 * struts fuse automatically because the whole lattice (hanging loop
 * included, as part of its strand) is extracted as one level set of a
 * signed distance field, so the result is guaranteed manifold.
 *
 * @param segments Flat Float32Array [x1,y1,z1,x2,y2,z2,...] in output units (mm).
 * @param sphereRadius Radius of the sphere the segments lie on (mm).
 * @param profile { halfWidth, halfHeight, corner } (mm), from `strutProfile`.
 * @param strandIds Optional strand index per segment; each strand's segments
 *   are consecutive, in order along it. Different strands, and distant
 *   stretches of one strand, are joined with a smooth fillet where they
 *   touch, so crossings look like soft tubes pressed together.
 * @param ups Optional direction per segment [x, y, z, ...] to measure the
 *   strut's height along instead of the sphere normal (zero keeps the
 *   normal), for stretches such as the hanging loop that turn off the sphere.
 * @param blendRadius Fillet radius near `junctions` (mm).
 * @param crossingBlendRadius Fillet radius away from junctions (mm), where
 *   strands only touch at crossings. Eases into `blendRadius` near them.
 * @param pressSwell Where different strands overlap away from junctions,
 *   each flattens against the other, meeting it in a rounded groove, and
 *   bulges sideways by up to this fraction of the overlap depth, like soft
 *   tubes pressed together. 0 lets them simply intersect.
 * @param pressRounding Rounding of the rim of each pressed flat, as a share of
 *   `halfHeight`: small meets in a crisp crease, large in a wide soft groove.
 * @param pressSpread How far along each strand the bulge eases out from
 *   where it presses (mm); 0 keeps it to the press itself.
 * @param junctions Optional flat [x,y,z,...] of points where lines meet (mm).
 * @param edgeLength Approximate output triangle edge length (mm); smaller = finer.
 */
export async function buildStrutSolid({
  segments,
  sphereRadius,
  profile,
  strandIds = null,
  ups = null,
  blendRadius = 0,
  crossingBlendRadius = blendRadius,
  pressSwell = 0,
  pressRounding = 0.6,
  pressSpread = 0,
  junctions = null,
  edgeLength,
  settleRounds = 0,
  subdivisions = 0,
}) {
  const wasm = await getManifoldModule();
  const { Manifold } = wasm;

  const { halfWidth, halfHeight } = profile;
  const halfExtent = Math.max(halfWidth, halfHeight);
  // Perfectly sharp edges alias badly in the level-set mesh, so every corner
  // keeps a little rounding.
  const corner = Math.min(
    Math.max(profile.corner, Math.min(edgeLength * 0.6, halfWidth * 0.5, halfHeight * 0.5)),
    halfWidth,
    halfHeight,
  );
  const segmentCount = segments.length / 6;
  const maxBlend = Math.max(blendRadius, crossingBlendRadius);
  const maxSwell = pressSwell * 2 * halfHeight;
  // Pressing looks for other strands up to one strut height apart.
  const sdfMargin = Math.max(halfExtent + maxBlend + maxSwell, maxSwell > 0 ? 2 * halfHeight : 0) + edgeLength * 2;

  // Spatial hash so each SDF evaluation only tests nearby segments. Segments
  // are inserted into every cell their margin-expanded bounding box touches,
  // so a lookup in the query point's own cell is sufficient: any segment
  // whose surface could be within `sdfMargin` of the point is in that list.
  const cellSize = sdfMargin * 2;
  const grid = new Map();
  const cellIndex = (value) => Math.floor(value / cellSize);
  const cellKey = (ix, iy, iz) => ((ix + 1024) * 4096 + (iy + 1024)) * 4096 + (iz + 1024);

  for (let s = 0; s < segmentCount; s += 1) {
    const o = s * 6;
    const minX = Math.min(segments[o], segments[o + 3]) - sdfMargin;
    const maxX = Math.max(segments[o], segments[o + 3]) + sdfMargin;
    const minY = Math.min(segments[o + 1], segments[o + 4]) - sdfMargin;
    const maxY = Math.max(segments[o + 1], segments[o + 4]) + sdfMargin;
    const minZ = Math.min(segments[o + 2], segments[o + 5]) - sdfMargin;
    const maxZ = Math.max(segments[o + 2], segments[o + 5]) + sdfMargin;

    for (let ix = cellIndex(minX); ix <= cellIndex(maxX); ix += 1) {
      for (let iy = cellIndex(minY); iy <= cellIndex(maxY); iy += 1) {
        for (let iz = cellIndex(minZ); iz <= cellIndex(maxZ); iz += 1) {
          const key = cellKey(ix, iy, iz);
          let bucket = grid.get(key);
          if (!bucket) {
            bucket = [];
            grid.set(key, bucket);
          }
          bucket.push(s);
        }
      }
    }
  }

  // Distance from a point to the surface of one strut, positive outside.
  // The offset from the nearest point on the segment splits into a radial
  // part (along the sphere normal there) and everything else, and the
  // rounded-rectangle distance is taken in that plane.
  const insetX = halfWidth - corner;
  const insetZ = halfHeight - corner;
  // A fully rounded square profile is a capsule: no frame needed.
  const round = insetX < 1e-9 && insetZ < 1e-9;
  // Segments with an `ups` direction measure height along it (made square
  // to the segment) instead of along the sphere normal.
  const heightAxis = new Float64Array(round || !ups ? 0 : segmentCount * 3);
  const hasAxis = new Uint8Array(heightAxis.length ? segmentCount : 0);
  for (let s = 0; s < hasAxis.length; s += 1) {
    const o = s * 6;
    const d = [segments[o + 3] - segments[o], segments[o + 4] - segments[o + 1], segments[o + 5] - segments[o + 2]];
    const dLength = Math.hypot(...d) || 1;
    const u = [ups[s * 3], ups[s * 3 + 1], ups[s * 3 + 2]];
    const along = (u[0] * d[0] + u[1] * d[1] + u[2] * d[2]) / dLength;
    const axis = u.map((v, k) => v - (along * d[k]) / dLength);
    const length = Math.hypot(...axis);
    if (length > 1e-6) {
      hasAxis[s] = 1;
      axis.forEach((v, k) => {
        heightAxis[s * 3 + k] = v / length;
      });
    }
  }
  // Each segment is straight, so where a strand bends the square-cut ends
  // of neighboring segments meet at an angle, and the joined struts have a
  // dent or ridge at every joint: a bending strand comes out ribbed. So each
  // segment is instead cut by a plane square to a tangent that turns
  // smoothly from one segment to the next, shared by both at each joint: a
  // point's place along the segment is where that plane passes through it.
  // Past a free end the whole offset counts, which caps the end with the
  // profile spun around. Past a joint the strut ends flat in the shared
  // plane and the neighbor's own measure takes over there: a spun cap would
  // poke out of a strand that runs at a slant to its profile's height axis,
  // bulging at every joint.
  const directions = new Float64Array(segmentCount * 3);
  for (let s = 0; s < segmentCount; s += 1) {
    const o = s * 6;
    const d = [segments[o + 3] - segments[o], segments[o + 4] - segments[o + 1], segments[o + 5] - segments[o + 2]];
    const length = Math.hypot(...d) || 1;
    directions.set(d.map((v) => v / length), s * 3);
  }
  const meets = (a, b) => {
    const [i, j] = [a * 6 + 3, b * 6];
    return Math.hypot(segments[i] - segments[j], segments[i + 1] - segments[j + 1], segments[i + 2] - segments[j + 2]) < 1e-6;
  };
  // Per segment: the joined segment before and after it (or -1), and the
  // smoothed tangent at its start and end.
  const neighbors = new Int32Array(segmentCount * 2).fill(-1);
  const tangents = new Float64Array(segmentCount * 6);
  for (let s = 0; s < segmentCount; s += 1) {
    if (s > 0 && meets(s - 1, s)) {
      neighbors[s * 2] = s - 1;
    }
    if (s + 1 < segmentCount && meets(s, s + 1)) {
      neighbors[s * 2 + 1] = s + 1;
    }
  }
  // A closed strand's last segment joins its first.
  if (strandIds) {
    const firstOf = new Map();
    strandIds.forEach((strand, s) => {
      if (!firstOf.has(strand)) {
        firstOf.set(strand, s);
      }
      const first = firstOf.get(strand);
      if (s > first && (s + 1 === segmentCount || strandIds[s + 1] !== strand) && meets(s, first)) {
        neighbors[s * 2 + 1] = first;
        neighbors[first * 2] = s;
      }
    });
  }
  for (let s = 0; s < segmentCount; s += 1) {
    for (let end = 0; end < 2; end += 1) {
      const other = neighbors[s * 2 + end];
      const sum = [0, 1, 2].map((k) => directions[s * 3 + k] + (other >= 0 ? directions[other * 3 + k] : directions[s * 3 + k]));
      const length = Math.hypot(...sum);
      sum.forEach((v, k) => {
        tangents[s * 6 + end * 3 + k] = length > 1e-9 ? v / length : directions[s * 3 + k];
      });
    }
  }
  // Signed distance from the profile of segment s for an offset o from the
  // point q on its axis.
  const profileDistance = (ox, oy, oz, qx, qy, qz, s) => {
    const offsetSq = ox * ox + oy * oy + oz * oz;
    if (round) {
      return Math.sqrt(offsetSq) - corner;
    }
    const r = hasAxis.length && hasAxis[s]
      ? ox * heightAxis[s * 3] + oy * heightAxis[s * 3 + 1] + oz * heightAxis[s * 3 + 2]
      : (ox * qx + oy * qy + oz * qz) / (Math.sqrt(qx * qx + qy * qy + qz * qz) || 1);
    const ux = Math.sqrt(Math.max(0, offsetSq - r * r)) - insetX;
    const uz = Math.abs(r) - insetZ;
    const cx = ux > 0 ? ux : 0;
    const cz = uz > 0 ? uz : 0;
    return Math.sqrt(cx * cx + cz * cz) + Math.min(ux > uz ? ux : uz, 0) - corner;
  };

  const strutDistance = (px, py, pz, s) => {
    const o = s * 6;
    const ax = segments[o];
    const ay = segments[o + 1];
    const az = segments[o + 2];
    const dx = segments[o + 3] - ax;
    const dy = segments[o + 4] - ay;
    const dz = segments[o + 5] - az;
    const lengthSq = dx * dx + dy * dy + dz * dz;
    const wx = px - ax;
    const wy = py - ay;
    const wz = pz - az;
    let t = 0;
    if (lengthSq > 0) {
      // Solve (w - t d) . (T0 + t (T1 - T0)) = 0 for t, the place along the
      // segment whose sweep plane holds the point. Of the two roots, the
      // one that becomes the straight projection as the tangents agree.
      const ex = tangents[o + 3] - tangents[o];
      const ey = tangents[o + 4] - tangents[o + 1];
      const ez = tangents[o + 5] - tangents[o + 2];
      const straight = dx * tangents[o] + dy * tangents[o + 1] + dz * tangents[o + 2];
      const quadratic = -(dx * ex + dy * ey + dz * ez);
      const linear = wx * ex + wy * ey + wz * ez - straight;
      const constant = wx * tangents[o] + wy * tangents[o + 1] + wz * tangents[o + 2];
      const discriminant = linear * linear - 4 * quadratic * constant;
      if (Math.abs(quadratic) < 1e-12 * lengthSq || discriminant < 0) {
        t = linear !== 0 ? -constant / linear : (wx * dx + wy * dy + wz * dz) / lengthSq;
      } else {
        const q = -0.5 * (linear + (linear < 0 ? -1 : 1) * Math.sqrt(discriminant));
        t = q !== 0 ? constant / q : -constant / linear;
      }
    }
    const end = t < 0 ? 0 : t > 1 ? 1 : -1;
    t = Math.max(0, Math.min(1, t));
    const qx = ax + dx * t;
    const qy = ay + dy * t;
    const qz = az + dz * t;
    const ox = px - qx;
    const oy = py - qy;
    const oz = pz - qz;
    if (end >= 0 && neighbors[s * 2 + end] >= 0) {
      const k = o + end * 3;
      const h = ox * tangents[k] + oy * tangents[k + 1] + oz * tangents[k + 2];
      // Only once truly beyond the joint plane; a point the sweep planes
      // fold past on the inside of a tight bend keeps the spun cap, which
      // is what fills a bend tighter than the strut is thick.
      if (end === 1 ? h > 0 : h < 0) {
        const face = profileDistance(ox - h * tangents[k], oy - h * tangents[k + 1], oz - h * tangents[k + 2], qx, qy, qz, s);
        return face > 0 ? Math.sqrt(face * face + h * h) : Math.abs(h);
      }
    }
    return profileDistance(ox, oy, oz, qx, qy, qz, s);
  };

  // Beyond the margin the exact value doesn't matter, only its sign.
  const farDistance = sdfMargin - halfExtent;

  const nearestStrutDistance = (x, y, z) => {
    const bucket = grid.get(cellKey(cellIndex(x), cellIndex(y), cellIndex(z)));
    if (!bucket) {
      return farDistance;
    }
    let minDistance = Infinity;
    for (let i = 0; i < bucket.length; i += 1) {
      const distance = strutDistance(x, y, z, bucket[i]);
      if (distance < minDistance) {
        minDistance = distance;
      }
    }
    return minDistance;
  };

  const blend = strandIds && (maxBlend > 0 || maxSwell > 0);

  // Position of each segment's middle along its strand (mm), and each
  // strand's length and whether it closes on itself.
  const segmentArc = new Float64Array(blend ? segmentCount : 0);
  const strandCount = blend ? strandIds.reduce((most, strand) => Math.max(most, strand + 1), 0) : 0;
  const strandLength = new Float64Array(strandCount);
  const strandFirst = new Int32Array(strandCount).fill(-1);
  const strandLast = new Int32Array(strandCount);
  for (let s = 0; blend && s < segmentCount; s += 1) {
    const o = s * 6;
    const length = Math.hypot(segments[o + 3] - segments[o], segments[o + 4] - segments[o + 1], segments[o + 5] - segments[o + 2]);
    const strand = strandIds[s];
    if (strandFirst[strand] < 0) {
      strandFirst[strand] = s;
    }
    strandLast[strand] = s;
    segmentArc[s] = strandLength[strand] + length / 2;
    strandLength[strand] += length;
  }
  const strandClosed = strandFirst.map((first, strand) => {
    if (first < 0) {
      return 0;
    }
    const a = first * 6;
    const b = strandLast[strand] * 6 + 3;
    return Math.hypot(segments[a] - segments[b], segments[a + 1] - segments[b + 1], segments[a + 2] - segments[b + 2]) < 1e-3
      ? 1
      : 0;
  });

  // Stretches of one strand closer than this along it are the same piece of
  // tube, so they never blend: that keeps the strand's own bends from
  // bulging, while still filleting where it loops back and crosses itself.
  const stretchReach = 6 * (halfExtent + maxBlend + maxSwell);
  const sameStretch = (a, b) => {
    const strand = strandIds[a];
    if (strandIds[b] !== strand) {
      return false;
    }
    let apart = Math.abs(segmentArc[a] - segmentArc[b]);
    if (strandClosed[strand]) {
      apart = Math.min(apart, strandLength[strand] - apart);
    }
    return apart < stretchReach;
  };

  // The joint fillet applies within `jointReach` of a junction and eases
  // into the crossing fillet over the next `easeLength`.
  const jointReach = 2 * halfExtent + maxBlend;
  const easeLength = 2 * halfExtent;
  const varyingBlend = blend && crossingBlendRadius !== blendRadius && junctions?.length > 0;
  const hashJunctions = blend && junctions?.length > 0 && (varyingBlend || maxSwell > 0);
  // 0 within `jointReach` of a junction, easing up to 1 at crossings.
  const crossingWeight = (hashJunctions && junctionWeight(junctions, jointReach, easeLength)) || (() => 1);
  const blendAt = (x, y, z, weight) =>
    varyingBlend ? blendRadius + (crossingBlendRadius - blendRadius) * weight : crossingBlendRadius;

  // How deep each segment's ends press into other strands, and which way
  // (unit vector toward the nearest one): struts stacked closer than their
  // combined height overlap by the difference. Stored per segment end
  // [depth, dx, dy, dz] and interpolated along it, so the press varies
  // smoothly along the strand whichever strut happens to be nearest.
  const pressAtEnds = blend && maxSwell > 0
    ? findPresses(segments, strandIds, {
      contact: 2 * halfHeight,
      apart: stretchReach,
      spread: pressSpread,
      weight: hashJunctions ? crossingWeight : null,
    })
    : new Float64Array(0);

  // How far strut `s` bulges at a point. The displaced material goes
  // sideways: nothing toward or away from the strut it presses on.
  const alongSegment = (x, y, z, s) => {
    const o = s * 6;
    const dx = segments[o + 3] - segments[o];
    const dy = segments[o + 4] - segments[o + 1];
    const dz = segments[o + 5] - segments[o + 2];
    const lengthSq = dx * dx + dy * dy + dz * dz;
    return lengthSq > 0 ? ((x - segments[o]) * dx + (y - segments[o + 1]) * dy + (z - segments[o + 2]) * dz) / lengthSq : 0;
  };
  const pressSwellAt = (x, y, z, nearest) => {
    // Near a bend the nearest strut can be one whose end the point lies
    // past; read the press from the strut the point lies alongside, or the
    // swell steps where the nearest one changes.
    let s = nearest;
    let t = alongSegment(x, y, z, s);
    if (t > 1 && s + 1 < segmentCount && strandIds[s + 1] === strandIds[s]) {
      s += 1;
      t = alongSegment(x, y, z, s);
    } else if (t < 0 && s > 0 && strandIds[s - 1] === strandIds[s]) {
      s -= 1;
      t = alongSegment(x, y, z, s);
    }
    t = Math.min(Math.max(t, 0), 1);
    const o = s * 6;
    const dx = segments[o + 3] - segments[o];
    const dy = segments[o + 4] - segments[o + 1];
    const dz = segments[o + 5] - segments[o + 2];
    const lengthSq = dx * dx + dy * dy + dz * dz;
    const p = s * 8;
    // A Catmull-Rom curve through the neighboring segments' ends keeps the
    // bulge free of creases at segment joints.
    const d0 = pressAtEnds[p];
    const d1 = pressAtEnds[p + 4];
    const before = s > 0 && strandIds[s - 1] === strandIds[s] ? pressAtEnds[p - 8] : d0;
    const after = s + 1 < segmentCount && strandIds[s + 1] === strandIds[s] ? pressAtEnds[p + 12] : d1;
    const depth = d0 + 0.5 * t * (d1 - before + t * (2 * before - 5 * d0 + 4 * d1 - after + t * (3 * (d0 - d1) + after - before)));
    if (depth <= 0) {
      return 0;
    }
    // Square to the strand, so past a segment's end (where the next one
    // takes over) the offset doesn't tilt along it and the swell matches.
    let ox = x - segments[o] - dx * t;
    let oy = y - segments[o + 1] - dy * t;
    let oz = z - segments[o + 2] - dz * t;
    if (lengthSq > 0) {
      const axial = (ox * dx + oy * dy + oz * dz) / lengthSq;
      ox -= axial * dx;
      oy -= axial * dy;
      oz -= axial * dz;
    }
    const nx = pressAtEnds[p + 1] + (pressAtEnds[p + 5] - pressAtEnds[p + 1]) * t;
    const ny = pressAtEnds[p + 2] + (pressAtEnds[p + 6] - pressAtEnds[p + 2]) * t;
    const nz = pressAtEnds[p + 3] + (pressAtEnds[p + 7] - pressAtEnds[p + 3]) * t;
    const lengths = (ox * ox + oy * oy + oz * oz) * (nx * nx + ny * ny + nz * nz);
    const along = lengths > 1e-18 ? (ox * nx + oy * ny + oz * nz) ** 2 / lengths : 0;
    // Eased in from zero so the bulge has no visible edge where it starts.
    const eased = (depth * depth) / (depth + 0.5 * halfHeight);
    return pressSwell * eased * (1 - along);
  };

  // Where struts press together each is flattened against the plane midway
  // between them, and the rim of that flat gets this rounding, so the two
  // meet in a narrow groove like pillows instead of cutting into each other.
  // Each flat reaches a little past the midway plane so the two stay fused.
  const pressRound = maxSwell > 0 ? pressRounding * halfHeight : 0;
  const pressFuse = 0.4 * pressRound;
  const roundedMax = (p, q, r) => {
    if (!(r > 0)) {
      return p > q ? p : q;
    }
    const u = Math.max(r + p, 0);
    const v = Math.max(r + q, 0);
    return Math.min(-r, p > q ? p : q) + Math.sqrt(u * u + v * v);
  };
  // Beyond this gap between the two nearest struts, the farther one can't
  // swell, flatten, or fillet the nearer one.
  const pairReach = maxSwell > 0
    ? maxBlend + maxSwell + 2 * pressRound + 2 * halfHeight + halfExtent
    : maxBlend;

  let maxBucket = 0;
  grid.forEach((bucket) => {
    maxBucket = Math.max(maxBucket, bucket.length);
  });
  const bucketDistances = new Float64Array(maxBucket);

  // Whether the last point measured lies in a crease: within reach of the
  // fillet or pressed rim where two struts meet.
  let creaseHere = false;

  // Nearest strut distance blended with the nearest one that isn't part of
  // the same stretch of tube, each first pressed against the other, then
  // joined with a polynomial smooth-min.
  const blendedStrandDistance = (x, y, z) => {
    creaseHere = false;
    const bucket = grid.get(cellKey(cellIndex(x), cellIndex(y), cellIndex(z)));
    if (!bucket) {
      return farDistance;
    }
    let d1 = Infinity;
    let s1 = -1;
    for (let i = 0; i < bucket.length; i += 1) {
      const d = strutDistance(x, y, z, bucket[i]);
      bucketDistances[i] = d;
      if (d < d1) {
        d1 = d;
        s1 = bucket[i];
      }
    }
    let d2 = Infinity;
    let s2 = -1;
    for (let i = 0; i < bucket.length; i += 1) {
      if (bucketDistances[i] < d2 && !sameStretch(s1, bucket[i])) {
        d2 = bucketDistances[i];
        s2 = bucket[i];
      }
    }
    if (d2 - d1 >= pairReach) {
      // A bulge spread along the strand can reach past any other strand.
      const swell = maxSwell > 0 && pressSpread > 0 ? pressSwellAt(x, y, z, s1) : 0;
      return swell > 0 ? d1 - crossingWeight(x, y, z) * swell : d1;
    }
    const weight = crossingWeight(x, y, z);
    let a = d1;
    let b = d2;
    if (maxSwell > 0 && weight > 0) {
      const swollenA = d1 - weight * pressSwellAt(x, y, z, s1);
      const swollenB = d2 - weight * pressSwellAt(x, y, z, s2);
      const round = weight * pressRound;
      const fuse = weight * pressFuse;
      a = roundedMax(swollenA, (swollenA - swollenB) / 2 - fuse, round);
      b = roundedMax(swollenB, (swollenB - swollenA) / 2 - fuse, round);
      if (b < a) {
        [a, b] = [b, a];
      }
    }
    const k = blendAt(x, y, z, weight);
    // The fillet reaches where the struts are within `k` of each other, the
    // rim's rounding where they are within 1.2 of its radius.
    creaseHere = b - a < 1.25 * Math.max(k, 1.2 * weight * pressRound);
    if (!(k > 0) || b - a >= k) {
      return a;
    }
    const h = (k - (b - a)) / k;
    return a - (h * h * k) / 4;
  };

  // Far from the spherical shell the struts live in, the radial distance is
  // a valid bound, so the spatial lookup can be skipped entirely.
  let minRadius = Infinity;
  let maxRadius = 0;
  for (let i = 0; i < segments.length; i += 3) {
    const radius = Math.hypot(segments[i], segments[i + 1], segments[i + 2]);
    minRadius = Math.min(minRadius, radius);
    maxRadius = Math.max(maxRadius, radius);
  }

  // Positive inside, negative outside.
  const latticeSdf = (x, y, z, r) => {
    const shellDistance = Math.max(minRadius - r, r - maxRadius, 0);
    if (shellDistance > sdfMargin) {
      creaseHere = false;
      return halfExtent - shellDistance;
    }
    return -(blend ? blendedStrandDistance(x, y, z) : nearestStrutDistance(x, y, z));
  };

  const sdf = ([x, y, z]) => latticeSdf(x, y, z, Math.sqrt(x * x + y * y + z * z));

  const bound = Math.max(sphereRadius, maxRadius) + halfExtent * 2 + edgeLength * 2;
  const bounds = {
    min: [-bound, -bound, -bound],
    max: [bound, bound, bound],
  };

  const manifold = Manifold.levelSet(sdf, bounds, edgeLength);
  const mesh = manifold.getMesh();
  manifold.delete();
  let positions = new Float64Array(mesh.vertProperties.length / mesh.numProp * 3);
  for (let v = 0; v < positions.length / 3; v += 1) {
    positions.set(mesh.vertProperties.subarray(v * mesh.numProp, v * mesh.numProp + 3), v * 3);
  }
  let triVerts = mesh.triVerts;
  const field = (x, y, z) => latticeSdf(x, y, z, Math.sqrt(x * x + y * y + z * z));
  // Settling only the final mesh is both quicker and smoother than also
  // settling the grid mesh before splitting it.
  let step = edgeLength;
  for (let i = 0; i < subdivisions; i += 1) {
    ({ positions, triVerts } = subdivide(positions, triVerts));
    step /= 2;
  }
  // The fillets and pressed rims where struts meet are narrower than the
  // triangles, so the mesh zigzags across them however fine the grid. Split
  // the triangles in those creases, and only those, until they are a few
  // per fillet, settling the new ones onto the surface each time.
  const finestFillet = Math.min(...[blendRadius, crossingBlendRadius].filter((radius) => radius > 0));
  let creaseLevels = 0;
  for (let spacing = step; blend && settleRounds > 0 && creaseLevels < 2 && spacing > finestFillet / 2.5; spacing /= 2) {
    creaseLevels += 1;
  }
  let creaseFlags = settleRounds > 0 && creaseLevels > 0 ? new Uint8Array(positions.length / 3) : null;
  const inCrease = () => creaseHere;
  if (settleRounds > 0) {
    settleOnSurface(positions, triVerts, field, { step, rounds: settleRounds, inCrease, creaseFlags });
  }
  for (let level = 0; level < creaseLevels; level += 1) {
    const marked = new Uint8Array(triVerts.length / 3);
    let any = false;
    for (let t = 0; t < triVerts.length; t += 3) {
      if (creaseFlags[triVerts[t]] || creaseFlags[triVerts[t + 1]] || creaseFlags[triVerts[t + 2]]) {
        marked[t / 3] = 1;
        any = true;
      }
    }
    if (!any) {
      break;
    }
    let touched;
    ({ positions, triVerts, touched } = subdivide(positions, triVerts, marked));
    step /= 2;
    const flags = new Uint8Array(positions.length / 3);
    flags.set(creaseFlags);
    creaseFlags = flags;
    settleOnSurface(positions, triVerts, field, { step, rounds: settleRounds, movable: touched, inCrease, creaseFlags });
  }
  const vertProperties = Float32Array.from(positions);
  separateTouchingVertices(vertProperties, triVerts, 3, TOUCH_SEPARATION_MM);
  return {
    numProp: 3,
    vertProperties,
    triVerts,
    triangleCount: triVerts.length / 3,
    vertexCount: vertProperties.length / 3,
    ...(globalThis.process?.env?.SOLID_DEBUG ? { field } : {}),
  };
}
