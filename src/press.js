// Where woven strands press into each other, shared by the solid and the
// preview so both squash crossings the same way.

const cellKey = (ix, iy, iz) => ((ix + 1024) * 4096 + (iy + 1024)) * 4096 + (iz + 1024);

/**
 * 0 within `reach` of any of `junctions` (flat [x, y, z, ...]), easing up to
 * 1 over the next `ease`. Returns null when there are no junctions.
 */
export function junctionWeight(junctions, reach, ease) {
  if (!junctions?.length) {
    return null;
  }
  const cell = reach + ease;
  const grid = new Map();
  for (let j = 0; j < junctions.length; j += 3) {
    const lo = [0, 1, 2].map((k) => Math.floor((junctions[j + k] - cell) / cell));
    const hi = [0, 1, 2].map((k) => Math.floor((junctions[j + k] + cell) / cell));
    for (let ix = lo[0]; ix <= hi[0]; ix += 1) {
      for (let iy = lo[1]; iy <= hi[1]; iy += 1) {
        for (let iz = lo[2]; iz <= hi[2]; iz += 1) {
          const key = cellKey(ix, iy, iz);
          let bucket = grid.get(key);
          if (!bucket) {
            bucket = [];
            grid.set(key, bucket);
          }
          bucket.push(j);
        }
      }
    }
  }
  return (x, y, z) => {
    const bucket = grid.get(cellKey(Math.floor(x / cell), Math.floor(y / cell), Math.floor(z / cell)));
    let nearest = Infinity;
    for (let i = 0; bucket && i < bucket.length; i += 1) {
      const j = bucket[i];
      nearest = Math.min(nearest, Math.hypot(x - junctions[j], y - junctions[j + 1], z - junctions[j + 2]));
    }
    const t = Math.min(Math.max((nearest - reach) / ease, 0), 1);
    return t * t * (3 - 2 * t);
  };
}

/**
 * Each segment's length, where it starts along its strand, and per strand
 * its first and last segment, length, and whether it closes on itself.
 * A strand's segments are consecutive, in order along it.
 */
function strandLayout(segments, strandIds, closeTolerance) {
  const count = segments.length / 6;
  const lengths = new Float64Array(count);
  const starts = new Float64Array(count);
  const strandCount = strandIds.reduce((most, strand) => Math.max(most, strand + 1), 0);
  const total = new Float64Array(strandCount);
  const first = new Int32Array(strandCount).fill(-1);
  const last = new Int32Array(strandCount);
  for (let s = 0; s < count; s += 1) {
    const o = s * 6;
    const strand = strandIds[s];
    lengths[s] = Math.hypot(segments[o + 3] - segments[o], segments[o + 4] - segments[o + 1], segments[o + 5] - segments[o + 2]);
    if (first[strand] < 0) {
      first[strand] = s;
    }
    last[strand] = s;
    starts[s] = total[strand];
    total[strand] += lengths[s];
  }
  const closed = Array.from(first, (f, strand) => {
    if (f < 0) {
      return false;
    }
    const a = f * 6;
    const b = last[strand] * 6 + 3;
    return Math.hypot(segments[a] - segments[b], segments[a + 1] - segments[b + 1], segments[a + 2] - segments[b + 2]) < closeTolerance;
  });
  return { count, lengths, starts, total, first, last, closed };
}

/**
 * How deep each segment end sits inside the nearest other strand, and which
 * way that strand lies, as [depth, dx, dy, dz] per end (8 numbers per
 * segment). Depth is `contact` (the centerline spacing at which strands
 * just touch) less the spacing, so 0 where they only touch. Stretches of
 * one strand less than `apart` from each other along it never press, so a
 * strand's own bends don't count. Optional `weight(x, y, z)` (0 to 1) scales
 * each depth, to keep junctions, where lines meet by design, from pressing.
 *
 * With `spread`, each press also eases out along its strand over that
 * length, so a soft tube gives around a dent rather than only at it.
 */
export function pressAtEnds(segments, strandIds, { contact, apart, spread = 0, weight = null }) {
  const layout = strandLayout(segments, strandIds, contact * 1e-3);
  const { count, lengths, starts, total, closed } = layout;
  const ends = new Float64Array(count * 8);
  if (!(contact > 0)) {
    return ends;
  }

  const grid = new Map();
  const cellIndex = (v) => Math.floor(v / contact);
  for (let s = 0; s < count; s += 1) {
    const o = s * 6;
    const lo = [0, 1, 2].map((k) => cellIndex(Math.min(segments[o + k], segments[o + 3 + k]) - contact));
    const hi = [0, 1, 2].map((k) => cellIndex(Math.max(segments[o + k], segments[o + 3 + k]) + contact));
    for (let ix = lo[0]; ix <= hi[0]; ix += 1) {
      for (let iy = lo[1]; iy <= hi[1]; iy += 1) {
        for (let iz = lo[2]; iz <= hi[2]; iz += 1) {
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

  const sameStretch = (a, b) => {
    const strand = strandIds[a];
    if (strandIds[b] !== strand) {
      return false;
    }
    let gap = Math.abs(starts[a] + lengths[a] / 2 - starts[b] - lengths[b] / 2);
    if (closed[strand]) {
      gap = Math.min(gap, total[strand] - gap);
    }
    return gap < apart;
  };

  for (let s = 0; s < count; s += 1) {
    for (let end = 0; end < 2; end += 1) {
      const px = segments[s * 6 + end * 3];
      const py = segments[s * 6 + end * 3 + 1];
      const pz = segments[s * 6 + end * 3 + 2];
      const bucket = grid.get(cellKey(cellIndex(px), cellIndex(py), cellIndex(pz))) ?? [];
      const o = s * 8 + end * 4;
      let nearest = contact;
      for (let i = 0; i < bucket.length; i += 1) {
        const b = bucket[i];
        if (sameStretch(s, b)) {
          continue;
        }
        const q = b * 6;
        const dx = segments[q + 3] - segments[q];
        const dy = segments[q + 4] - segments[q + 1];
        const dz = segments[q + 5] - segments[q + 2];
        const lengthSq = dx * dx + dy * dy + dz * dz;
        const t = lengthSq > 0
          ? Math.min(Math.max(((px - segments[q]) * dx + (py - segments[q + 1]) * dy + (pz - segments[q + 2]) * dz) / lengthSq, 0), 1)
          : 0;
        const cx = segments[q] + dx * t - px;
        const cy = segments[q + 1] + dy * t - py;
        const cz = segments[q + 2] + dz * t - pz;
        const distance = Math.hypot(cx, cy, cz);
        if (distance < nearest && distance > 1e-9) {
          nearest = distance;
          ends[o + 1] = cx / distance;
          ends[o + 2] = cy / distance;
          ends[o + 3] = cz / distance;
        }
      }
      ends[o] = (contact - nearest) * (weight ? weight(px, py, pz) : 1);
    }
  }

  return spread > 0 ? spreadAlongStrands(ends, layout, spread) : ends;
}

/**
 * Every end takes the deepest press within `spread` of it along its strand,
 * scaled down smoothly to nothing at that distance, with that press's
 * direction.
 */
function spreadAlongStrands(ends, { lengths, starts, total, first, last, closed }, spread) {
  const out = new Float64Array(ends.length);
  // Ends are numbered 2 * segment + (0 at its start, 1 at its finish).
  const along = (e) => starts[e >> 1] + (e & 1) * lengths[e >> 1];
  first.forEach((f, strand) => {
    if (f < 0) {
      return;
    }
    const lo = 2 * f;
    const hi = 2 * last[strand] + 1;
    const span = hi - lo + 1;
    for (let e = lo; e <= hi; e += 1) {
      let best = ends[e * 4];
      let from = e;
      const here = along(e);
      for (let step = -1; step <= 1; step += 2) {
        for (let k = 1; k < span; k += 1) {
          let j = e + step * k;
          let wrapped = false;
          if (j < lo || j > hi) {
            if (!closed[strand]) {
              break;
            }
            j += step > 0 ? -span : span;
            wrapped = true;
          }
          const gap = wrapped ? total[strand] - Math.abs(along(j) - here) : Math.abs(along(j) - here);
          if (gap >= spread) {
            break;
          }
          const u = gap / spread;
          const depth = ends[j * 4] * (1 - u * u) ** 2;
          if (depth > best) {
            best = depth;
            from = j;
          }
        }
      }
      out[e * 4] = best;
      out[e * 4 + 1] = ends[from * 4 + 1];
      out[e * 4 + 2] = ends[from * 4 + 2];
      out[e * 4 + 3] = ends[from * 4 + 3];
    }
  });
  return out;
}
