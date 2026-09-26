import Module from 'manifold-3d';

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
  junctions = null,
  edgeLength,
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
  const strutDistance = (px, py, pz, s) => {
    const o = s * 6;
    const ax = segments[o];
    const ay = segments[o + 1];
    const az = segments[o + 2];
    const dx = segments[o + 3] - ax;
    const dy = segments[o + 4] - ay;
    const dz = segments[o + 5] - az;
    const lengthSq = dx * dx + dy * dy + dz * dz;
    let t = 0;
    if (lengthSq > 0) {
      t = ((px - ax) * dx + (py - ay) * dy + (pz - az) * dz) / lengthSq;
      t = Math.max(0, Math.min(1, t));
    }
    const qx = ax + dx * t;
    const qy = ay + dy * t;
    const qz = az + dz * t;
    const ox = px - qx;
    const oy = py - qy;
    const oz = pz - qz;
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
  // into the crossing fillet over the next `easeLength`. Junctions are
  // hashed into every cell their reach touches, like the segments.
  const jointReach = 2 * halfExtent + maxBlend;
  const easeLength = 2 * halfExtent;
  const junctionCell = jointReach + easeLength;
  const junctionGrid = new Map();
  const varyingBlend = blend && crossingBlendRadius !== blendRadius && junctions?.length > 0;
  const hashJunctions = blend && junctions?.length > 0 && (varyingBlend || maxSwell > 0);
  for (let j = 0; hashJunctions && j < junctions.length; j += 3) {
    const lo = [0, 1, 2].map((k) => Math.floor((junctions[j + k] - junctionCell) / junctionCell));
    const hi = [0, 1, 2].map((k) => Math.floor((junctions[j + k] + junctionCell) / junctionCell));
    for (let ix = lo[0]; ix <= hi[0]; ix += 1) {
      for (let iy = lo[1]; iy <= hi[1]; iy += 1) {
        for (let iz = lo[2]; iz <= hi[2]; iz += 1) {
          const key = cellKey(ix, iy, iz);
          let bucket = junctionGrid.get(key);
          if (!bucket) {
            bucket = [];
            junctionGrid.set(key, bucket);
          }
          bucket.push(j);
        }
      }
    }
  }
  // 0 within `jointReach` of a junction, easing up to 1 at crossings.
  const crossingWeight = (x, y, z) => {
    if (!hashJunctions) {
      return 1;
    }
    const bucket = junctionGrid.get(cellKey(
      Math.floor(x / junctionCell),
      Math.floor(y / junctionCell),
      Math.floor(z / junctionCell),
    ));
    let nearest = Infinity;
    for (let i = 0; bucket && i < bucket.length; i += 1) {
      const j = bucket[i];
      nearest = Math.min(nearest, Math.hypot(x - junctions[j], y - junctions[j + 1], z - junctions[j + 2]));
    }
    const t = Math.min(Math.max((nearest - jointReach) / easeLength, 0), 1);
    return t * t * (3 - 2 * t);
  };
  const blendAt = (x, y, z, weight) =>
    varyingBlend ? blendRadius + (crossingBlendRadius - blendRadius) * weight : crossingBlendRadius;

  const nearestCenter = [0, 0, 0];
  const nearestOnSegment = (px, py, pz, s, out) => {
    const o = s * 6;
    const dx = segments[o + 3] - segments[o];
    const dy = segments[o + 4] - segments[o + 1];
    const dz = segments[o + 5] - segments[o + 2];
    const lengthSq = dx * dx + dy * dy + dz * dz;
    const t = lengthSq > 0
      ? Math.min(Math.max(((px - segments[o]) * dx + (py - segments[o + 1]) * dy + (pz - segments[o + 2]) * dz) / lengthSq, 0), 1)
      : 0;
    out[0] = segments[o] + dx * t;
    out[1] = segments[o + 1] + dy * t;
    out[2] = segments[o + 2] + dz * t;
  };

  // How deep each segment's ends press into other strands, and which way
  // (unit vector toward the nearest one): struts stacked closer than their
  // combined height overlap by the difference. Stored per segment end
  // [depth, dx, dy, dz] and interpolated along it, so the press varies
  // smoothly along the strand whichever strut happens to be nearest.
  const pressAtEnds = new Float64Array(maxSwell > 0 ? segmentCount * 8 : 0);
  for (let s = 0; blend && maxSwell > 0 && s < segmentCount; s += 1) {
    for (let end = 0; end < 2; end += 1) {
      const px = segments[s * 6 + end * 3];
      const py = segments[s * 6 + end * 3 + 1];
      const pz = segments[s * 6 + end * 3 + 2];
      const bucket = grid.get(cellKey(cellIndex(px), cellIndex(py), cellIndex(pz))) ?? [];
      let nearest = 2 * halfHeight;
      for (let i = 0; i < bucket.length; i += 1) {
        if (!sameStretch(s, bucket[i])) {
          nearestOnSegment(px, py, pz, bucket[i], nearestCenter);
          const distance = Math.hypot(nearestCenter[0] - px, nearestCenter[1] - py, nearestCenter[2] - pz);
          if (distance < nearest && distance > 1e-9) {
            nearest = distance;
            const o = s * 8 + end * 4;
            pressAtEnds[o + 1] = (nearestCenter[0] - px) / distance;
            pressAtEnds[o + 2] = (nearestCenter[1] - py) / distance;
            pressAtEnds[o + 3] = (nearestCenter[2] - pz) / distance;
          }
        }
      }
      pressAtEnds[s * 8 + end * 4] = 2 * halfHeight - nearest;
    }
  }

  // How far strut `s` bulges at a point. The displaced material goes
  // sideways: nothing toward or away from the strut it presses on.
  const pressSwellAt = (x, y, z, s) => {
    const o = s * 6;
    const dx = segments[o + 3] - segments[o];
    const dy = segments[o + 4] - segments[o + 1];
    const dz = segments[o + 5] - segments[o + 2];
    const lengthSq = dx * dx + dy * dy + dz * dz;
    const t = lengthSq > 0
      ? Math.min(Math.max(((x - segments[o]) * dx + (y - segments[o + 1]) * dy + (z - segments[o + 2]) * dz) / lengthSq, 0), 1)
      : 0;
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
    const ox = x - segments[o] - dx * t;
    const oy = y - segments[o + 1] - dy * t;
    const oz = z - segments[o + 2] - dz * t;
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
  const pressRound = maxSwell > 0 ? 0.6 * halfHeight : 0;
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

  // Nearest strut distance blended with the nearest one that isn't part of
  // the same stretch of tube, each first pressed against the other, then
  // joined with a polynomial smooth-min.
  const blendedStrandDistance = (x, y, z) => {
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
      return d1;
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
  const result = {
    numProp: mesh.numProp,
    vertProperties: mesh.vertProperties,
    triVerts: mesh.triVerts,
    triangleCount: mesh.triVerts.length / 3,
    vertexCount: mesh.vertProperties.length / mesh.numProp,
  };
  manifold.delete();
  return result;
}
