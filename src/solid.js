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
 * struts fuse automatically because the whole lattice (plus the optional
 * hanging loop) is extracted as one level set of a signed distance field,
 * so the result is guaranteed manifold.
 *
 * @param segments Flat Float32Array [x1,y1,z1,x2,y2,z2,...] in output units (mm).
 * @param sphereRadius Radius of the sphere the segments lie on (mm).
 * @param profile { halfWidth, halfHeight, corner } (mm), from `strutProfile`.
 * @param loop Optional torus { center, normal, majorRadius, minorRadius } (mm).
 * @param strandIds Optional strand index per segment. Different strands are
 *   joined with a smooth fillet of `blendRadius` where they touch, so
 *   crossings look like soft tubes pressed together.
 * @param edgeLength Approximate output triangle edge length (mm); smaller = finer.
 */
export async function buildStrutSolid({
  segments,
  sphereRadius,
  profile,
  loop = null,
  strandIds = null,
  blendRadius = 0,
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
  const sdfMargin = halfExtent + blendRadius + edgeLength * 2;

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
    const qLength = Math.sqrt(qx * qx + qy * qy + qz * qz) || 1;
    const r = (ox * qx + oy * qy + oz * qz) / qLength;
    const l = Math.sqrt(Math.max(0, ox * ox + oy * oy + oz * oz - r * r));
    const ux = l - insetX;
    const uz = Math.abs(r) - insetZ;
    const outside = Math.hypot(Math.max(ux, 0), Math.max(uz, 0));
    return outside + Math.min(Math.max(ux, uz), 0) - corner;
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

  // Nearest distance to the two closest different strands, blended with a
  // polynomial smooth-min. Blending only across strands keeps each strand's
  // own joints from bulging.
  const blendedStrandDistance = (x, y, z) => {
    const bucket = grid.get(cellKey(cellIndex(x), cellIndex(y), cellIndex(z)));
    if (!bucket) {
      return farDistance;
    }
    let d1 = Infinity;
    let d2 = Infinity;
    let s1 = -1;
    let s2 = -1;
    for (let i = 0; i < bucket.length; i += 1) {
      const d = strutDistance(x, y, z, bucket[i]);
      const strand = strandIds[bucket[i]];
      if (strand === s1) {
        d1 = Math.min(d1, d);
      } else if (strand === s2) {
        d2 = Math.min(d2, d);
        if (d2 < d1) {
          [d1, d2, s1, s2] = [d2, d1, s2, s1];
        }
      } else if (d < d1) {
        [d2, s2, d1, s1] = [d1, s1, d, strand];
      } else if (d < d2) {
        [d2, s2] = [d, strand];
      }
    }
    const h = Math.max(blendRadius - Math.abs(d1 - d2), 0) / blendRadius;
    return Math.min(d1, d2) - (h * h * blendRadius) / 4;
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

  const blend = strandIds && blendRadius > 0;
  // Positive inside, negative outside.
  const latticeSdf = (x, y, z, r) => {
    const shellDistance = Math.max(minRadius - r, r - maxRadius, 0);
    if (shellDistance > sdfMargin) {
      return halfExtent - shellDistance;
    }
    return -(blend ? blendedStrandDistance(x, y, z) : nearestStrutDistance(x, y, z));
  };

  const loopSdf = loop
    ? (x, y, z) => {
        const px = x - loop.center[0];
        const py = y - loop.center[1];
        const pz = z - loop.center[2];
        const h = px * loop.normal[0] + py * loop.normal[1] + pz * loop.normal[2];
        const inPlane = Math.sqrt(Math.max(0, px * px + py * py + pz * pz - h * h));
        return loop.minorRadius - Math.hypot(inPlane - loop.majorRadius, h);
      }
    : null;

  const sdf = ([x, y, z]) => {
    const r = Math.sqrt(x * x + y * y + z * z);
    const lattice = latticeSdf(x, y, z, r);
    return loopSdf ? Math.max(lattice, loopSdf(x, y, z)) : lattice;
  };

  const loopReach = loop ? loop.majorRadius * 2 + loop.minorRadius * 2 : 0;
  const bound = Math.max(sphereRadius, maxRadius) + Math.max(halfExtent * 2, loopReach) + edgeLength * 2;
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
