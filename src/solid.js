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
 * Each segment becomes a capsule (a cylinder with hemispherical ends) of
 * radius `strutRadius`; overlapping capsules fuse automatically because the
 * whole lattice is extracted as one level set of a signed distance field.
 * The result is guaranteed manifold, so it slices cleanly for 3D printing.
 *
 * @param segments Flat Float32Array [x1,y1,z1,x2,y2,z2,...] in output units (mm).
 * @param sphereRadius Radius of the sphere the segment centerlines lie on (mm).
 * @param strutRadius Strut radius (mm).
 * @param edgeLength Approximate output triangle edge length (mm); smaller = finer.
 */
export async function buildStrutSolid({ segments, sphereRadius, strutRadius, edgeLength }) {
  const wasm = await getManifoldModule();
  const { Manifold } = wasm;

  const segmentCount = segments.length / 6;
  const sdfMargin = strutRadius + edgeLength * 2;

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

  const distanceToSegment = (px, py, pz, s) => {
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
    const qx = px - (ax + dx * t);
    const qy = py - (ay + dy * t);
    const qz = pz - (az + dz * t);
    return Math.sqrt(qx * qx + qy * qy + qz * qz);
  };

  // Positive inside, negative outside. Far from the spherical shell the
  // centerlines live on, |r - R| is a valid lower bound on the distance to
  // any strut, so we can skip the spatial lookup entirely.
  const sdf = (point) => {
    const [x, y, z] = point;
    const r = Math.sqrt(x * x + y * y + z * z);
    const shellDistance = Math.abs(r - sphereRadius);
    if (shellDistance > sdfMargin) {
      return strutRadius - shellDistance;
    }

    const bucket = grid.get(cellKey(cellIndex(x), cellIndex(y), cellIndex(z)));
    if (!bucket) {
      return strutRadius - sdfMargin;
    }

    let minDistance = Infinity;
    for (let i = 0; i < bucket.length; i += 1) {
      const distance = distanceToSegment(x, y, z, bucket[i]);
      if (distance < minDistance) {
        minDistance = distance;
      }
    }
    return strutRadius - minDistance;
  };

  const bound = sphereRadius + strutRadius * 2;
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
