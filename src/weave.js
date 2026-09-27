import { Vector3 } from 'three';
import { barycentricToVector, readVertex } from './geometryUtils.js';
import { splitAtJunctions } from './templateSpace.js';

const v0 = new Vector3();
const v1 = new Vector3();
const v2 = new Vector3();
const point = new Vector3();
const sample = new Vector3();

/**
 * Stamp the pattern onto the sphere and weave it: wherever two lines cross
 * cleanly, one rises and the other dips, alternating over/under along every
 * line. Heights ease smoothly between crossings and return to the sphere at
 * line ends and at junctions where three or more lines meet.
 *
 * Where crossings are close together the weave is made shallower, so that
 * no strand bends more tightly than `minBendRadius`. Corners where a strand
 * changes direction are rounded to about `bendRadius` (scene units), shrunk
 * where the neighboring edges are too short. With `amplitude` 0 this simply
 * traces the flat pattern into strands.
 *
 * With `loop` ({ height, angle, anchor, strand, along, minBend, neck }; see
 * `loopProfile` and `fitLoop`), a stretch of the main piece rises off the
 * sphere into a hanging loop grown out of the strand itself: an arch a
 * ribbon passes under or, steeper than 90°, a closed ring.
 *
 * Returns { segments, strandIds, ups, loop, pieces, pieceIds }: flat
 * segments [x1, y1, z1, x2, y2, z2, ...], the strand each segment belongs
 * to, the direction each segment's strut height points [x, y, z, ...]
 * (zero means straight out from the sphere; only the loop, which turns
 * away from the sphere, sets it), the loop as placed (see `fitLoop`; null if none), how many separate
 * pieces the strands form, and each segment's piece (largest piece first). Strands always join where lines meet at
 * junctions; at crossings they join only if `crossingsTouch`. With
 * `minSeparation` (scene units), strands are sampled at a third of that
 * spacing so clearances near crossings are modeled accurately. `run` sets
 * the weave rhythm: each strand goes over `run` crossings, then under `run`
 * (1 is a plain weave, 2 a twill).
 */
export function buildWovenSegments(
  connections,
  geometry,
  {
    radius = 1,
    samplesPerSegment = 12,
    amplitude = 0,
    minBendRadius = 0,
    bendRadius = 0,
    loop = null,
    crossingsTouch = true,
    minSeparation = 0,
    run = 1,
    taut = 0,
  } = {},
) {
  if (!connections.length || !geometry) {
    return null;
  }
  const graph = buildGraph(splitAtJunctions(connections), geometry);
  pairStrandsAtNodes(graph);
  const strands = traceStrands(graph);
  // Only really tight knots of crossings are stacked as a cluster; ordinary
  // dense crossings still alternate.
  assignOverUnder(graph, strands, { run, clusterReach: (0.6 * minSeparation) / radius });
  strandPieces(graph, strands, crossingsTouch).forEach((piece, id) => {
    strands[id].piece = piece;
  });
  const result = sampleStrands(graph, strands, {
    radius,
    samplesPerSegment,
    amplitude,
    minBendRadius,
    bendRadius,
    loop,
    minSeparation,
    taut,
  });
  if (result) {
    result.pieceIds = result.strandIds.map((strand) => strands[strand].piece);
    result.pieces = strands.length ? Math.max(...strands.map((strand) => strand.piece)) + 1 : 0;
    result.junctions = junctionPoints(graph, radius);
  }
  return result;
}

/** Positions (at `radius`) of nodes where lines meet without passing through. */
function junctionPoints(graph, radius) {
  const points = [];
  graph.nodes.forEach((node) => {
    if (!node.crossing && node.edges.length !== 2) {
      points.push(node.pos.x * radius, node.pos.y * radius, node.pos.z * radius);
    }
  });
  return new Float32Array(points);
}

/**
 * Smallest surface-to-surface gap between cylinders of different strands,
 * for round struts of radius `strutRadius`. Segments within `junctionRadius`
 * of a junction are skipped, since strands meet there by design. Only gaps
 * under `searchGap` are looked for; returns { gap, point } for the closest
 * pair found, or null if every pair is at least `searchGap` apart.
 */
export function measureClearance(segments, strandIds, junctions, { strutRadius, junctionRadius, searchGap }) {
  const reach = 2 * strutRadius + searchGap;
  const count = segments.length / 6;
  const cell = reach;

  const junctionGrid = new Map();
  const jCell = junctionRadius;
  for (let j = 0; j < junctions.length; j += 3) {
    const k = `${Math.floor(junctions[j] / jCell)},${Math.floor(junctions[j + 1] / jCell)},${Math.floor(junctions[j + 2] / jCell)}`;
    if (!junctionGrid.has(k)) junctionGrid.set(k, []);
    junctionGrid.get(k).push(j);
  }
  const nearJunction = (x, y, z) => {
    const cx = Math.floor(x / jCell);
    const cy = Math.floor(y / jCell);
    const cz = Math.floor(z / jCell);
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
          const bucket = junctionGrid.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (bucket?.some((j) => {
            const ex = x - junctions[j];
            const ey = y - junctions[j + 1];
            const ez = z - junctions[j + 2];
            return ex * ex + ey * ey + ez * ez < junctionRadius * junctionRadius;
          })) {
            return true;
          }
        }
      }
    }
    return false;
  };

  const grid = new Map();
  const mids = new Float64Array(count * 3);
  const skip = new Uint8Array(count);
  for (let i = 0; i < count; i += 1) {
    const o = i * 6;
    const x = (segments[o] + segments[o + 3]) / 2;
    const y = (segments[o + 1] + segments[o + 4]) / 2;
    const z = (segments[o + 2] + segments[o + 5]) / 2;
    mids[i * 3] = x;
    mids[i * 3 + 1] = y;
    mids[i * 3 + 2] = z;
    skip[i] = nearJunction(x, y, z) ? 1 : 0;
    if (!skip[i]) {
      const k = `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(i);
    }
  }

  let best = null;
  for (let i = 0; i < count; i += 1) {
    if (skip[i]) {
      continue;
    }
    const cx = Math.floor(mids[i * 3] / cell);
    const cy = Math.floor(mids[i * 3 + 1] / cell);
    const cz = Math.floor(mids[i * 3 + 2] / cell);
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
          const bucket = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (!bucket) {
            continue;
          }
          for (let b = 0; b < bucket.length; b += 1) {
            const j = bucket[b];
            if (j <= i || strandIds[j] === strandIds[i]) {
              continue;
            }
            const distance = segmentDistance(segments, i, j);
            const gap = distance - 2 * strutRadius;
            if (gap < searchGap && (!best || gap < best.gap)) {
              best = { gap, point: new Vector3(mids[i * 3], mids[i * 3 + 1], mids[i * 3 + 2]) };
            }
          }
        }
      }
    }
  }
  return best;
}

/** Closest distance between segments i and j of a flat segment array. */
function segmentDistance(seg, i, j) {
  const px = seg[i * 6];
  const py = seg[i * 6 + 1];
  const pz = seg[i * 6 + 2];
  const d1x = seg[i * 6 + 3] - px;
  const d1y = seg[i * 6 + 4] - py;
  const d1z = seg[i * 6 + 5] - pz;
  const qx = seg[j * 6];
  const qy = seg[j * 6 + 1];
  const qz = seg[j * 6 + 2];
  const d2x = seg[j * 6 + 3] - qx;
  const d2y = seg[j * 6 + 4] - qy;
  const d2z = seg[j * 6 + 5] - qz;
  const rx = px - qx;
  const ry = py - qy;
  const rz = pz - qz;
  const a = d1x * d1x + d1y * d1y + d1z * d1z;
  const e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz;
  const c = d1x * rx + d1y * ry + d1z * rz;
  const b = d1x * d2x + d1y * d2y + d1z * d2z;
  const denom = a * e - b * b;
  let s = denom > 1e-12 ? Math.min(1, Math.max(0, (b * f - c * e) / denom)) : 0;
  let t = e > 1e-12 ? (b * s + f) / e : 0;
  if (t < 0) {
    t = 0;
    s = a > 1e-12 ? Math.min(1, Math.max(0, -c / a)) : 0;
  } else if (t > 1) {
    t = 1;
    s = a > 1e-12 ? Math.min(1, Math.max(0, (b - c) / a)) : 0;
  }
  const dx = px + d1x * s - (qx + d2x * t);
  const dy = py + d1y * s - (qy + d2y * t);
  const dz = pz + d1z * s - (qz + d2z * t);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Piece index per strand: strands in the same connected piece share one.
 * Pieces are numbered by size (total strand length), largest first.
 */
function strandPieces(graph, strands, crossingsTouch) {
  const edgeStrand = new Int32Array(graph.edges.length);
  strands.forEach((strand, id) => strand.edges.forEach((edge) => {
    edgeStrand[edge] = id;
  }));
  const parent = strands.map((_, id) => id);
  const find = (id) => {
    while (parent[id] !== id) {
      parent[id] = parent[parent[id]];
      id = parent[id];
    }
    return id;
  };
  graph.nodes.forEach((node) => {
    if (node.crossing && !crossingsTouch) {
      return;
    }
    const root = find(edgeStrand[node.edges[0]]);
    node.edges.forEach((edge) => {
      parent[find(edgeStrand[edge])] = root;
    });
  });
  const size = new Map();
  strands.forEach((strand, id) => {
    const root = find(id);
    size.set(root, (size.get(root) ?? 0) + strand.length);
  });
  const order = [...size.keys()].sort((a, b) => size.get(b) - size.get(a));
  const index = new Map(order.map((root, i) => [root, i]));
  return strands.map((_, id) => index.get(find(id)));
}

/** Pattern pieces stamped on every face, merged into one graph on the unit sphere. */
function buildGraph(pieces, geometry) {
  const positions = geometry.getAttribute('position').array;
  const index = geometry.getIndex().array;
  const nodes = [];
  const edges = [];
  const nodeIds = new Map();
  const edgeKeys = new Set();

  const nodeFor = (bary) => {
    barycentricToVector(bary, v0, v1, v2, point).normalize();
    const key = `${Math.round(point.x * 1e5)},${Math.round(point.y * 1e5)},${Math.round(point.z * 1e5)}`;
    let id = nodeIds.get(key);
    if (id === undefined) {
      id = nodes.length;
      nodes.push({ pos: point.clone(), edges: [], pair: new Map(), pairOf: new Map(), crossing: false });
      nodeIds.set(key, id);
    }
    return id;
  };

  for (let i = 0; i < index.length; i += 3) {
    readVertex(index[i], v0, positions);
    readVertex(index[i + 1], v1, positions);
    readVertex(index[i + 2], v2, positions);
    pieces.forEach(({ start, end }) => {
      const a = nodeFor(start);
      const b = nodeFor(end);
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      if (a === b || edgeKeys.has(key)) {
        return;
      }
      edgeKeys.add(key);
      nodes[a].edges.push(edges.length);
      nodes[b].edges.push(edges.length);
      edges.push({ a, b });
    });
  }

  readVertex(index[0], v0, positions);
  readVertex(index[1], v1, positions);
  const faceEdge = v0.normalize().angleTo(v1.normalize());
  return { nodes, edges, faceEdge };
}

function otherEnd(edge, node) {
  return edge.a === node ? edge.b : edge.a;
}

function tangentAt(graph, nodeId, edgeId, target) {
  const { pos } = graph.nodes[nodeId];
  target.copy(graph.nodes[otherEnd(graph.edges[edgeId], nodeId)].pos).sub(pos);
  return target.addScaledVector(pos, -target.dot(pos)).normalize();
}

/**
 * Decide which edges continue into which at every node. Two edges always
 * continue into each other. An even number of edges (up to eight) forms a
 * crossing when they split into nearly straight pass-throughs, one per line
 * crossing there. Any other node is a junction where strands end.
 */
function pairStrandsAtNodes(graph) {
  graph.nodes.forEach((node, id) => {
    const es = node.edges;
    if (es.length === 2) {
      node.pair.set(es[0], es[1]);
      node.pair.set(es[1], es[0]);
      return;
    }
    if (es.length % 2 !== 0 || es.length > 8) {
      return;
    }
    const dirs = es.map((e) => tangentAt(graph, id, e, new Vector3()));
    const { pairs, score } = straightestPairing(dirs, es.map((_, i) => i));
    if (score > -0.4) {
      return;
    }
    node.crossing = true;
    node.lineCount = pairs.length;
    pairs.forEach(([i, j], pairIndex) => {
      node.pair.set(es[i], es[j]);
      node.pair.set(es[j], es[i]);
      node.pairOf.set(es[i], pairIndex);
      node.pairOf.set(es[j], pairIndex);
    });
  });
}

/**
 * Perfect matching of directions into pass-throughs that minimizes the
 * worst (least opposed) pair. `score` is that pair's dot product: -1 means
 * every pair is perfectly straight.
 */
function straightestPairing(dirs, remaining) {
  if (!remaining.length) {
    return { pairs: [], score: -Infinity };
  }
  const [first, ...rest] = remaining;
  let best = { pairs: [], score: Infinity };
  rest.forEach((partner) => {
    const sub = straightestPairing(
      dirs,
      rest.filter((i) => i !== partner),
    );
    const score = Math.max(dirs[first].dot(dirs[partner]), sub.score);
    if (score < best.score) {
      best = { pairs: [[first, partner], ...sub.pairs], score };
    }
  });
  return best;
}

/** Follow edges through their pairings into strands: ordered node/edge lists. */
function traceStrands(graph) {
  const { nodes, edges } = graph;
  const visited = new Uint8Array(edges.length);
  const strands = [];

  const extend = (startEdge, fromNode) => {
    const steps = [];
    let edge = startEdge;
    let node = fromNode;
    for (;;) {
      const next = nodes[node].pair.get(edge);
      if (next === undefined) {
        return { steps, closed: false };
      }
      if (next === startEdge) {
        return { steps, closed: true };
      }
      if (visited[next]) {
        return { steps, closed: false };
      }
      visited[next] = 1;
      node = otherEnd(edges[next], node);
      steps.push({ edge: next, node });
      edge = next;
    }
  };

  edges.forEach((edge, id) => {
    if (visited[id]) {
      return;
    }
    visited[id] = 1;
    const forward = extend(id, edge.b);
    if (forward.closed) {
      strands.push({
        nodes: [edge.a, edge.b, ...forward.steps.map((s) => s.node)],
        edges: [id, ...forward.steps.map((s) => s.edge)],
        closed: true,
      });
      return;
    }
    const backward = extend(id, edge.a).steps.reverse();
    strands.push({
      nodes: [...backward.map((s) => s.node), edge.a, edge.b, ...forward.steps.map((s) => s.node)],
      edges: [...backward.map((s) => s.edge), id, ...forward.steps.map((s) => s.edge)],
      closed: false,
    });
  });
  return strands;
}

/**
 * Stack the strands at every crossing. Crossings closer together than
 * `clusterReach` (radians) are treated as one cluster, so a tight knot of
 * crossings stacks cleanly instead of forcing strands to switch sides within
 * a few millimeters. Every strand passing through a crossing or cluster gets
 * its own evenly spaced level and holds it all the way through; the stack
 * order per cluster is either as listed or reversed, chosen so that each
 * strand goes over `run` successive clusters, then under `run`. Solved as a
 * parity union-find, keeping same-side links first; the rare contradictions
 * (e.g. a closed loop whose crossing count doesn't fit the rhythm) are left
 * as they fall, and a strand in the exact middle of an odd stack doesn't
 * constrain its neighbors.
 */
function assignOverUnder(graph, strands, { run = 1, clusterReach = 0 } = {}) {
  const { nodes } = graph;
  const clusterOf = clusterCrossings(nodes, clusterReach);

  // Passes: consecutive crossing occurrences of one strand in one cluster.
  const clusters = new Map();
  strands.forEach((strand, strandId) => {
    const arc = [0];
    for (let i = 0; i < strand.edges.length; i += 1) {
      arc.push(arc[i] + nodes[strand.nodes[i]].pos.angleTo(nodes[strand.nodes[i + 1]].pos));
    }
    strand.length = arc[arc.length - 1];
    strand.crossings = [];
    strand.passes = [];
    const last = strand.closed ? strand.edges.length - 1 : strand.nodes.length - 2;
    for (let i = strand.closed ? 0 : 1; i <= last; i += 1) {
      const nodeId = strand.nodes[i];
      if (!nodes[nodeId].crossing) {
        continue;
      }
      const cluster = clusterOf.get(nodeId);
      const crossing = { index: i, node: nodeId, s: arc[i] };
      strand.crossings.push(crossing);
      const previous = strand.passes[strand.passes.length - 1];
      if (previous && previous.cluster === cluster) {
        previous.crossings.push(crossing);
      } else {
        strand.passes.push({ cluster, crossings: [crossing], strandId });
      }
    }
    const passes = strand.passes;
    if (strand.closed && passes.length > 1 && passes[0].cluster === passes[passes.length - 1].cluster) {
      passes[0].crossings.unshift(...passes.pop().crossings);
    }
    passes.forEach((pass) => {
      if (!clusters.has(pass.cluster)) clusters.set(pass.cluster, []);
      clusters.get(pass.cluster).push(pass);
    });
  });

  clusters.forEach((passes) => {
    passes.forEach((pass, rank) => {
      pass.offset = (passes.length - 1) / 2 - rank;
      pass.upper = pass.offset > 0 ? 1 : 0;
    });
  });

  const floatLinks = [];
  const alternateLinks = [];
  strands.forEach((strand) => {
    const occ = strand.passes.filter(({ offset }) => offset !== 0);
    const count = strand.closed ? occ.length : occ.length - 1;
    for (let k = 0; k < count && occ.length > 1; k += 1) {
      const a = occ[k];
      const b = occ[(k + 1) % occ.length];
      const floats = (k + 1) % run !== 0;
      (floats ? floatLinks : alternateLinks).push([a.cluster, b.cluster, a.upper ^ b.upper ^ (floats ? 0 : 1)]);
    }
  });

  // Union-find with parity. Same-side links are applied first so a strand's
  // runs stay intact where constraints contradict.
  const parent = new Map();
  const parity = new Map();
  const find = (c) => {
    if (!parent.has(c)) {
      parent.set(c, c);
      parity.set(c, 0);
    }
    let root = c;
    let flip = 0;
    while (parent.get(root) !== root) {
      flip ^= parity.get(root);
      root = parent.get(root);
    }
    let node = c;
    let nodeFlip = flip;
    while (node !== root && parent.get(node) !== root) {
      const next = parent.get(node);
      const nextFlip = nodeFlip ^ parity.get(node);
      parent.set(node, root);
      parity.set(node, nodeFlip);
      node = next;
      nodeFlip = nextFlip;
    }
    return { root, flip };
  };
  [...floatLinks, ...alternateLinks].forEach(([c, d, want]) => {
    const a = find(c);
    const b = find(d);
    if (a.root !== b.root) {
      parent.set(b.root, a.root);
      parity.set(b.root, a.flip ^ b.flip ^ want);
    }
  });

  // Adjacent levels are 2 apart, so neighbors in a stack separate by the
  // same 2 × amplitude as the two strands of a simple crossing.
  strands.forEach((strand) => {
    strand.passes.forEach((pass) => {
      const height = 2 * pass.offset * (find(pass.cluster).flip ? -1 : 1);
      pass.crossings.forEach((crossing) => {
        crossing.height = height;
      });
    });
  });
}

/** Map each crossing node to a cluster id; nodes within `reach` share one. */
function clusterCrossings(nodes, reach) {
  const crossing = nodes.map((node, id) => (node.crossing ? id : -1)).filter((id) => id >= 0);
  const parent = new Map(crossing.map((id) => [id, id]));
  const find = (id) => {
    while (parent.get(id) !== id) {
      parent.set(id, parent.get(parent.get(id)));
      id = parent.get(id);
    }
    return id;
  };
  if (reach > 0) {
    const cell = reach;
    const grid = new Map();
    const cellOf = (p) => [Math.floor(p.x / cell), Math.floor(p.y / cell), Math.floor(p.z / cell)];
    crossing.forEach((id) => {
      const k = cellOf(nodes[id].pos).join();
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(id);
    });
    crossing.forEach((id) => {
      const [cx, cy, cz] = cellOf(nodes[id].pos);
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dz = -1; dz <= 1; dz += 1) {
            (grid.get([cx + dx, cy + dy, cz + dz].join()) ?? []).forEach((other) => {
              if (other !== id && nodes[id].pos.angleTo(nodes[other].pos) < reach) {
                parent.set(find(other), find(id));
              }
            });
          }
        }
      }
    });
  }
  return new Map(crossing.map((id) => [id, find(id)]));
}

function sampleStrands(
  graph,
  strands,
  { radius, samplesPerSegment, amplitude, minBendRadius, bendRadius, loop, minSeparation, taut },
) {
  const { nodes } = graph;

  const prepared = strands.map((strand) => {
    const arc = [0];
    for (let i = 0; i < strand.edges.length; i += 1) {
      arc.push(arc[i] + nodes[strand.nodes[i]].pos.angleTo(nodes[strand.nodes[i + 1]].pos));
    }
    const length = arc[arc.length - 1];

    let knots = strand.crossings.map(({ index, height }) => ({ s: arc[index], h: height }));
    if (strand.closed) {
      knots = knots.length ? [...knots.map((k) => ({ s: k.s - length, h: k.h })), ...knots, ...knots.map((k) => ({ s: k.s + length, h: k.h }))] : [];
    } else {
      knots = [{ s: 0, h: 0 }, ...knots, { s: length, h: 0 }];
    }
    limitBending(knots, amplitude, minBendRadius, radius);
    tautenSpans(knots, taut, amplitude, minBendRadius, radius);
    const heightAt = (s) => {
      if (knots.length < 2) {
        return 0;
      }
      // Last knot at or before s (binary search; knots are sorted by s).
      let lo = 0;
      let hi = knots.length - 2;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (knots[mid].s <= s) {
          lo = mid;
        } else {
          hi = mid - 1;
        }
      }
      const k = lo;
      const { s: s0, h: h0 } = knots[k];
      const { s: s1, h: h1 } = knots[k + 1];
      const u = s1 > s0 ? Math.min(1, Math.max(0, (s - s0) / (s1 - s0))) : 0;
      return h0 + (h1 - h0) * tautEase(u, knots[k].bendShare);
    };

    const bends = strandBends(strand, nodes, arc);
    const directionAt = roundedPath(strand, nodes, arc, bendRadius / radius, bends);
    return { strand, arc, length, knots, bends, heightAt, directionAt };
  });

  // Hang from the largest piece, so the loop carries the whole ornament.
  const maxStep = minSeparation > 0 ? minSeparation / 3 : Infinity;
  // A loop may pass over rounded corners of its line, so its points are at
  // least as close as the line's own samples and corner rounding need.
  const loopStep = Math.min(
    maxStep,
    (radius * graph.faceEdge) / samplesPerSegment,
    bendRadius > 0 ? bendRadius / 4 : Infinity,
  );
  const fitted = loop
    ? fitLoop(prepared, nodes, loop, radius, loopStep, (strandId) => strands[strandId].piece === 0)
    : null;

  // Sample every strand as a polyline of unit directions plus a radial
  // height offset (scene units). With a minimum separation, sample finely
  // enough that the height profile near crossings is resolved.
  const polylines = prepared.map(({ strand, arc, length, knots, heightAt, directionAt }, strandId) => {
    let along = [];
    for (let i = 0; i < strand.edges.length; i += 1) {
      const span = arc[i + 1] - arc[i];
      let steps = Math.max(bendRadius > 0 ? 8 : 1, Math.ceil((samplesPerSegment * span) / graph.faceEdge));
      steps = Math.max(steps, Math.ceil((span * radius) / maxStep));
      for (let j = 0; j < steps; j += 1) {
        along.push(arc[i] + (span * j) / steps);
      }
    }
    // A taut strand bends tightly over each crossing; sample those bends
    // finely enough to stay smooth.
    const extra = [];
    for (let k = 0; k < knots.length - 1; k += 1) {
      const { bendShare } = knots[k];
      if (bendShare === undefined || knots[k].h === knots[k + 1].h) {
        continue;
      }
      const reach = bendShare * (knots[k + 1].s - knots[k].s);
      for (let j = 1; j <= TAUT_BEND_SAMPLES; j += 1) {
        const d = (reach * j) / TAUT_BEND_SAMPLES;
        extra.push(knots[k].s + d, knots[k + 1].s - d);
      }
    }
    if (extra.length) {
      along = [...along, ...extra.filter((s) => s > 0 && s < length)]
        .sort((a, b) => a - b)
        .filter((s, i, all) => i === 0 || s - all[i - 1] > 1e-9);
    }
    along.push(length);
    const wrap = strand.closed ? (s) => ((s % length) + length) % length : (s) => s;
    const side = new Vector3();
    const at = (s, lift, lateral = 0) => {
      const w = wrap(s);
      const dir = directionAt(w, new Vector3());
      if (lateral) {
        side.crossVectors(dir, directionAt(wrap(s + 1e-4), side).sub(dir)).normalize();
        dir.addScaledVector(side, lateral / (radius + lift)).normalize();
      }
      return { dir, h: amplitude * heightAt(w) + lift, strandId };
    };
    if (fitted?.strandId !== strandId) {
      return along.map((s) => at(s, 0));
    }

    // Start a closed strand opposite the loop, so the loop never straddles
    // the point where the strand closes on itself.
    let center = fitted.s;
    if (strand.closed) {
      const cut = (center + length / 2) % length;
      const once = along.slice(0, -1);
      along = [...once.filter((s) => s >= cut), ...once.filter((s) => s < cut).map((s) => s + length)];
      along.push(along[0] + length);
      if (center < cut) {
        center += length;
      }
    }
    // Profile x runs along the strand; dividing by the distance from the
    // center keeps horizontal lengths true at every height.
    const half = fitted.profile.halfLength / radius;
    const profilePoints = fitted.profile.points;
    const ahead = new Vector3();
    const loopPoints = profilePoints.map(({ x, y, z = 0 }, i) => {
      const s = center + x / (radius + y);
      const point = at(s, y, z);
      // The strut's height follows the loop round: square to the path in
      // the profile plane, which is straight out from the sphere at the feet.
      const before = profilePoints[Math.max(0, i - 1)];
      const after = profilePoints[Math.min(profilePoints.length - 1, i + 1)];
      const [dx, dy] = [after.x - before.x, after.y - before.y];
      const length = Math.hypot(dx, dy) || 1;
      const base = directionAt(wrap(s), new Vector3());
      directionAt(wrap(s + 1e-4), ahead).sub(base);
      ahead.addScaledVector(base, -ahead.dot(base)).normalize();
      point.up = ahead.multiplyScalar(-dy / length).addScaledVector(base, dx / length).normalize().clone();
      return point;
    });
    return [
      ...along.filter((s) => s < center - half - 1e-9).map((s) => at(s, 0)),
      ...loopPoints,
      ...along.filter((s) => s > center + half + 1e-9).map((s) => at(s, 0)),
    ];
  });

  const out = [];
  const strandIds = [];
  const ups = [];
  polylines.forEach((points, strandId) => {
    for (let k = 0; k < points.length - 1; k += 1) {
      [points[k], points[k + 1]].forEach(({ dir, h }) => {
        sample.copy(dir).multiplyScalar(radius + h);
        out.push(sample.x, sample.y, sample.z);
      });
      strandIds.push(strandId);
      const [a, b] = [points[k].up, points[k + 1].up];
      if (a || b) {
        sample.set(0, 0, 0).add(a ?? b).add(b ?? a).normalize();
        ups.push(sample.x, sample.y, sample.z);
      } else {
        ups.push(0, 0, 0);
      }
    }
  });

  if (!out.length) {
    return null;
  }
  let placedLoop = null;
  if (fitted) {
    const item = prepared[fitted.strandId];
    const { directionAt, heightAt, length } = item;
    const { profile } = fitted;
    const foot = directionAt(fitted.s, new Vector3());
    const top = foot.clone().multiplyScalar(radius + amplitude * heightAt(fitted.s) + profile.height);
    const origin = strandOrigin(item);
    placedLoop = {
      top: top.toArray(),
      foot: foot.toArray(),
      height: profile.height,
      angle: profile.angle,
      halfLength: profile.halfLength,
      topRadius: profile.topRadius,
      curl: Boolean(profile.curl),
      crossHeight: profile.crossHeight ?? 0,
      offset: fitted.offset * radius,
      adjusted: fitted.adjusted,
      bent: fitted.bent,
      moved: fitted.moved,
      strandId: fitted.strandId,
      closed: item.strand.closed,
      strandLength: length * radius,
      along: fractionAlong(item, origin, fitted.s),
      marks: strandMarks(item, origin),
      free: freeStretches(item, origin, loopFits(item, fitted.clearance, fitted.straight)),
    };
  }
  return {
    segments: new Float32Array(out),
    strandIds: Uint32Array.from(strandIds),
    ups: new Float32Array(ups),
    loop: placedLoop,
  };
}

/** Turn angle at every interior node of a strand (all nodes if closed). */
function strandBends(strand, nodes, arc) {
  const count = strand.edges.length;
  const pos = (i) => nodes[strand.nodes[i]].pos;
  const tin = new Vector3();
  const tout = new Vector3();
  const bends = [];
  for (let i = strand.closed ? 0 : 1; i <= count - 1; i += 1) {
    const prev = i === 0 ? count - 1 : i - 1;
    const p = pos(i);
    tin.subVectors(p, pos(prev)).addScaledVector(p, -tin.dot(p)).normalize();
    tout.subVectors(pos(i + 1), p).addScaledVector(p, -tout.dot(p)).normalize();
    bends.push({ index: i, prev, s: arc[i], turn: tin.angleTo(tout) });
  }
  return bends;
}

const MIN_LOOP_ANGLE = Math.PI / 18;
const MAX_LOOP_ANGLE = (175 * Math.PI) / 180;

/**
 * Side profile of the hanging loop in the plane of its strand, in scene
 * units: x along the strand, y out from it. Leaving the strand at x = -a, it
 * turns up through `angle` on a fillet, arcs over the top, and comes down to
 * x = a the same way, meeting the strand tangentially at both feet and
 * peaking at `height`. With the fillets and top arc touching (no straight
 * run between them), the footprint follows from the other two:
 * a = height / tan(angle / 2). Past 90° the sides overhang and the strand
 * curls into a closed ring; the angle is capped so the two legs stay `neck`
 * apart (centerline to centerline) where they cross under the ring, and no
 * fillet is tighter than `minBend`. Points are no more than `maxStep` apart.
 */
function loopProfile(loop, maxStep) {
  return loop.curl ? curlProfile(loop, maxStep) : archProfile(loop, maxStep);
}

function archProfile({ height, angle, minBend, neck }, maxStep) {
  const maxAngle = Math.min(MAX_LOOP_ANGLE, 2 * Math.atan(height / (minBend + neck / 2)));
  const beta = Math.min(Math.max(angle, MIN_LOOP_ANGLE), maxAngle);
  // Foot and top radius together.
  const reach = height / (1 - Math.cos(beta));
  const halfLength = reach * Math.sin(beta);
  let footRadius = reach / 2;
  if (beta > Math.PI / 2) {
    footRadius = Math.min(footRadius, halfLength - neck / 2);
  }
  footRadius = Math.max(footRadius, Math.min(minBend, reach / 2));
  const topRadius = reach - footRadius;

  const points = [{ x: -halfLength, y: 0 }];
  let heading = 0;
  [
    { turn: beta, radius: footRadius, sign: 1 },
    { turn: 2 * beta, radius: topRadius, sign: -1 },
    { turn: beta, radius: footRadius, sign: 1 },
  ].forEach(({ turn, radius, sign }) => {
    const start = points[points.length - 1];
    const cx = start.x - sign * radius * Math.sin(heading);
    const cy = start.y + sign * radius * Math.cos(heading);
    const steps = Math.max(2, Math.ceil(turn / (Math.PI / 36)), Math.ceil((turn * radius) / maxStep));
    for (let k = 1; k <= steps; k += 1) {
      const theta = heading + (sign * turn * k) / steps;
      points.push({ x: cx + sign * radius * Math.sin(theta), y: cy - sign * radius * Math.cos(theta) });
    }
    heading += sign * turn;
  });
  return { points, halfLength, height, angle: beta, maxAngle, topRadius };
}

const MIN_CURL_ANGLE = (20 * Math.PI) / 180;
// Steeper legs close in on each other just below the crossing.
const MAX_CURL_ANGLE = (60 * Math.PI) / 180;

/**
 * Side profile of a curl: the strand leaves the line on a fillet, climbs
 * straight at `angle`, runs once around a perfect circle, and comes back
 * down crossing its own way up. The legs cross about one strut thickness
 * above the fillets; there they step sideways (z, across the surface) to
 * pass `neck` apart, centerline to centerline.
 *
 * The path is built from its curvature along its length, which `rounding`
 * (a length) then blurs, so every change of bend (line to fillet, fillet to
 * leg, leg to circle) eases in instead of switching at once. Blurring keeps
 * the total turn, so the curl still lands back on its line, and leaves the
 * middle of the circle exactly round. The circle is sized so the peak meets
 * `height`, but never smaller than `minBend`.
 */
function curlProfile({ height, angle, minBend, neck, rounding = 0 }, maxStep) {
  const phi = Math.min(Math.max(angle, MIN_CURL_ANGLE), MAX_CURL_ANGLE);
  const step = Math.min(maxStep, minBend / 8);
  let target = height;
  let shape = null;
  for (let k = 0; k < 6; k += 1) {
    shape = traceCurl(phi, target, minBend, rounding, step);
    if (Math.abs(shape.peak - height) < step / 4 || shape.clamped) {
      break;
    }
    target += height - shape.peak;
  }
  const { points, crossAt, crossHeight, total } = shape;

  // Sideways: out to +neck/2 by the first pass of the crossing, easing over
  // to -neck/2 by the second, then back to the line. The easing runs round
  // the whole circle, so the legs stay apart wherever they are close.
  points.forEach((point) => {
    const l = point.l;
    let shift;
    if (l < crossAt) {
      shift = Math.sin((Math.PI / 2) * (l / crossAt)) ** 2;
    } else if (l > total - crossAt) {
      shift = -(Math.sin((Math.PI / 2) * ((total - l) / crossAt)) ** 2);
    } else {
      shift = Math.cos((Math.PI * (l - crossAt)) / (total - 2 * crossAt));
    }
    point.z = (neck / 2) * shift;
    delete point.l;
  });
  return {
    points,
    halfLength: shape.halfLength,
    height: shape.peak,
    angle: phi,
    maxAngle: MAX_CURL_ANGLE,
    topRadius: shape.radius,
    crossHeight,
    curl: true,
  };
}

/**
 * Trace a curl whose unrounded layout peaks at `height`: its curvature per
 * unit length, blurred over `rounding` with a raised-cosine window, turned
 * into points `step` apart and centered on x = 0. Returns { points (x, y,
 * and l, the length along), halfLength, peak, radius, crossAt, crossHeight,
 * total, clamped }.
 */
function traceCurl(phi, height, minBend, rounding, step) {
  const [sin, cos] = [Math.sin(phi), Math.cos(phi)];
  const footRadius = minBend;
  const lift = footRadius * (1 - cos);
  const cross = lift + minBend;
  const wanted = (height - cross) / (1 + 1 / cos);
  const radius = Math.max(minBend, wanted);
  const centerY = cross + radius / cos;
  const legStart = { x: -(cross - lift) / Math.tan(phi), y: lift };
  const tangent = { x: radius * sin, y: centerY - radius * cos };
  const leg = Math.hypot(tangent.x - legStart.x, tangent.y - legStart.y);
  const lead = rounding / 2 + 2 * step;
  const pieces = [
    [lead, 0],
    [phi * footRadius, 1 / footRadius],
    [leg, 0],
    [(2 * Math.PI - 2 * phi) * radius, 1 / radius],
    [leg, 0],
    [phi * footRadius, 1 / footRadius],
    [lead, 0],
  ];
  const length = pieces.reduce((sum, [l]) => sum + l, 0);
  const count = Math.ceil(length / step);
  const ds = length / count;
  // Curvature at the middle of each step, spread evenly over pieces.
  const bend = new Float64Array(count);
  let piece = 0;
  let pieceEnd = pieces[0][0];
  for (let i = 0; i < count; i += 1) {
    const s = (i + 0.5) * ds;
    while (s > pieceEnd && piece < pieces.length - 1) {
      piece += 1;
      pieceEnd += pieces[piece][0];
    }
    bend[i] = pieces[piece][1];
  }
  const reach = Math.floor(rounding / 2 / ds);
  let smooth = bend;
  if (reach > 0) {
    const window = Array.from({ length: 2 * reach + 1 }, (_, j) => 1 + Math.cos((Math.PI * (j - reach)) / (reach + 1)));
    const sum = window.reduce((a, b) => a + b, 0);
    smooth = bend.map((_, i) => {
      let total = 0;
      for (let j = -reach; j <= reach; j += 1) {
        const k = Math.min(count - 1, Math.max(0, i + j));
        total += bend[k] * window[j + reach];
      }
      return total / sum;
    });
  }

  // Steps never line up exactly with the pieces, so scale the turn back to
  // one full revolution; otherwise the far foot misses the line.
  const turned = smooth.reduce((sum, k) => sum + k * ds, 0);
  const raw = [{ x: 0, y: 0 }];
  let heading = 0;
  let x = 0;
  let y = 0;
  for (let i = 0; i < count; i += 1) {
    const turn = (smooth[i] * ds * 2 * Math.PI) / turned;
    const mid = heading + turn / 2;
    x += Math.cos(mid) * ds;
    y += Math.sin(mid) * ds;
    heading += turn;
    raw.push({ x, y });
  }
  // Level what error is left, so both feet sit on the line.
  const tilt = Math.atan2(y, x);
  raw.forEach((p) => {
    [p.x, p.y] = [p.x * Math.cos(tilt) + p.y * Math.sin(tilt), p.y * Math.cos(tilt) - p.x * Math.sin(tilt)];
  });
  // Keep from the last flat point before the curl to the first after it.
  let first = 0;
  while (first < count - 1 && smooth[first] < 1e-9) {
    first += 1;
  }
  let last = count - 1;
  while (last > 0 && smooth[last] < 1e-9) {
    last -= 1;
  }
  const kept = raw.slice(first, last + 2);
  const offsetX = (kept[0].x + kept[kept.length - 1].x) / 2;
  const offsetY = kept[0].y;
  const points = kept.map((p, i) => ({ x: p.x - offsetX, y: p.y - offsetY, l: i * ds }));
  const total = (points.length - 1) * ds;

  // The way up crosses the middle where the legs cross.
  let crossAt = total / 4;
  let crossHeight = cross;
  for (let i = 1; i < points.length / 2; i += 1) {
    const [a, b] = [points[i - 1], points[i]];
    if (a.x < 0 && b.x >= 0) {
      const t = -a.x / (b.x - a.x);
      crossAt = a.l + t * ds;
      crossHeight = a.y + t * (b.y - a.y);
      break;
    }
  }
  return {
    points,
    halfLength: points[points.length - 1].x,
    peak: Math.max(...points.map((p) => p.y)),
    radius,
    crossAt,
    crossHeight,
    total,
    clamped: wanted < minBend,
  };
}

// Where no straight stretch is long enough, the loop may follow bends in the
// line, as long as this middle fraction of it stays straight.
const BENT_LOOP_STRAIGHT = 0.25;

/**
 * Place the loop on the strand of the main piece passing nearest
 * `loop.anchor` (`loop.strand` wins ties, e.g. where two strands cross), at
 * `loop.along` (a fraction of the strand from `strandOrigin`) or, when that
 * is negative, nearest the anchor. It slides along the strand to the nearest
 * spot with room, first on a straight stretch, then following bends.
 *
 * When that strand is too short, the loop moves to the free stretch of any
 * line nearest the anchor, and if it is still too long there, it is made
 * steeper (up to 90°, or the asked angle if already steeper) and then lower
 * until it fits. Returns { strandId, s, offset, profile, clearance,
 * straight, adjusted, bent, moved } or null, where `offset` is how far
 * (radians) the loop ended up from where it was asked to go.
 */
function fitLoop(prepared, nodes, loop, radius, maxStep, allowed) {
  const anchor = new Vector3().fromArray(loop.anchor).normalize();
  const angleCap = Math.max(loop.angle, Math.PI / 2);
  const lowest = Math.max(loop.minBend, loop.height * 0.1);
  const measure = (height, angle, straight) => {
    const profile = loopProfile({ ...loop, height, angle }, maxStep);
    const clearance = (profile.halfLength + loop.minBend) / radius;
    return { profile, clearance, straight: clearance * straight, bent: straight < 1 };
  };

  const chosen = nearestStrand(prepared, nodes, anchor, allowed, loop.strand ?? -1);
  if (chosen) {
    const item = prepared[chosen.strandId];
    const target = loop.along >= 0 ? strandOrigin(item) + loop.along * item.length : chosen.s;
    for (const straight of [1, BENT_LOOP_STRAIGHT]) {
      const fit = measure(loop.height, loop.angle, straight);
      const s = slideLoop(item, loopFits(item, fit.clearance, fit.straight), target);
      if (s !== null) {
        const offset = alongDistance(item, s, target);
        return { ...fit, strandId: chosen.strandId, s, offset, adjusted: false, moved: false };
      }
    }
  }

  const attempt = (height, angle, straight) => {
    const fit = measure(height, angle, straight);
    const placement = placeLoop(prepared, fit.clearance, fit.straight, anchor, allowed);
    return placement && { ...placement, ...fit, moved: Boolean(chosen) };
  };
  const asked = attempt(loop.height, loop.angle, 1);
  if (asked) {
    return { ...asked, adjusted: false };
  }
  let { height, angle } = loop;
  for (let first = true; first || height >= lowest; first = false) {
    const placed = attempt(height, angle, BENT_LOOP_STRAIGHT);
    if (placed) {
      return { ...placed, adjusted: !first };
    }
    const { angle: used, maxAngle } = loopProfile({ ...loop, height, angle }, maxStep);
    const steepest = Math.min(angleCap, maxAngle);
    if (used < steepest - 1e-6) {
      angle = Math.min(used + Math.PI / 36, steepest);
    } else {
      height *= 0.85;
    }
  }
  return null;
}

/**
 * The point of any allowed strand nearest `anchor` (a unit direction) with
 * `clearance` (radians) of strand on either side free of strand ends, and
 * `straight` (radians) on either side free of corners sharper than 20°, so
 * the loop can rise out of it cleanly. The loop may pass over crossings:
 * lifted off the sphere, it clears the strands beneath it. Returns
 * { strandId, s, offset } or null, where `offset` is the angle (radians)
 * from `anchor` to the chosen point.
 */
function placeLoop(prepared, clearance, straight, anchor, allowed) {
  const probe = new Vector3();
  const step = Math.min(clearance, straight * 2) / 4;
  let best = null;
  const candidates = prepared.map((item, strandId) => {
    const { strand, length, directionAt } = item;
    if (!allowed(strandId) || 2 * clearance >= length) {
      return null;
    }
    const fits = loopFits(item, clearance, straight);
    const [lo, hi] = strand.closed ? [0, length] : [clearance, length - clearance];
    const consider = (raw) => {
      const s = strand.closed ? ((raw % length) + length) % length : raw;
      if (!fits(s)) {
        return;
      }
      const angle = directionAt(s, probe).angleTo(anchor);
      if (!best || angle < best.angle) {
        best = { strandId, s, angle };
      }
    };
    for (let s = lo; s <= hi; s += step) {
      consider(s);
    }
    return consider;
  });
  if (best) {
    const coarse = best;
    for (let s = coarse.s - step; s <= coarse.s + step; s += step / 16) {
      candidates[coarse.strandId](s);
    }
  }
  return best && { strandId: best.strandId, s: best.s, offset: best.angle };
}

/**
 * Whether a loop can be centered at s (radians, within the strand) with
 * `clearance` of strand on either side free of strand ends and `straight`
 * free of corners sharper than 20°.
 */
function loopFits({ strand, length, bends }, clearance, straight) {
  const blocked = bends.filter((b) => b.turn > Math.PI / 9).flatMap((b) => [b.s, b.s - length, b.s + length]);
  return (s) =>
    2 * clearance < length &&
    (strand.closed || (s >= clearance && s <= length - clearance)) &&
    !blocked.some((b) => Math.abs(b - s) < straight);
}

const wrapAlong = ({ strand, length }, s) =>
  strand.closed ? ((s % length) + length) % length : Math.min(length, Math.max(0, s));

/** Distance (radians) between two points of a strand, the short way round if closed. */
function alongDistance(item, a, b) {
  const d = Math.abs(a - b);
  return item.strand.closed ? Math.min(d % item.length, item.length - (d % item.length)) : d;
}

/**
 * Where the position slider starts on a strand: an open strand's start, or
 * a closed strand's first crossing, so crossings land on round fractions.
 */
function strandOrigin({ strand }) {
  return strand.closed && strand.crossings.length ? strand.crossings[0].s : 0;
}

const fractionAlong = (item, origin, s) => wrapAlong(item, s - origin) / item.length;

/** The point nearest `target` (radians along the strand) where `fits` holds, or null. */
function slideLoop(item, fits, target) {
  const { strand, length } = item;
  const start = wrapAlong(item, target);
  if (fits(start)) {
    return start;
  }
  const step = length / 2000;
  const reach = strand.closed ? length / 2 : length;
  for (let d = step; d <= reach + step; d += step) {
    for (const s of [target - d, target + d]) {
      if (!strand.closed && (s < 0 || s > length)) {
        continue;
      }
      if (fits(wrapAlong(item, s))) {
        // Home in on the edge of the free stretch.
        let inside = s;
        let outside = s < target ? s + step : s - step;
        for (let k = 0; k < 20; k += 1) {
          const mid = (inside + outside) / 2;
          if (fits(wrapAlong(item, mid))) {
            inside = mid;
          } else {
            outside = mid;
          }
        }
        return wrapAlong(item, inside);
      }
    }
  }
  return null;
}

/**
 * The allowed strand passing nearest `anchor` (a unit direction), with the
 * arc length s of its closest point. `preferred` wins when it passes as
 * close, as where strands cross. Returns { strandId, s, angle } or null.
 */
function nearestStrand(prepared, nodes, anchor, allowed, preferred) {
  const closest = new Vector3();
  const chord = new Vector3();
  let best = null;
  let preferredHit = null;
  prepared.forEach(({ strand, arc }, strandId) => {
    if (!allowed(strandId)) {
      return;
    }
    let own = null;
    for (let i = 0; i < strand.edges.length; i += 1) {
      const a = nodes[strand.nodes[i]].pos;
      const b = nodes[strand.nodes[i + 1]].pos;
      chord.subVectors(b, a);
      const lengthSq = chord.lengthSq();
      const t = lengthSq > 0 ? Math.min(1, Math.max(0, closest.subVectors(anchor, a).dot(chord) / lengthSq)) : 0;
      const angle = closest.lerpVectors(a, b, t).normalize().angleTo(anchor);
      if (!own || angle < own.angle) {
        own = { strandId, s: arc[i] + t * (arc[i + 1] - arc[i]), angle };
      }
    }
    if (own && (!best || own.angle < best.angle)) {
      best = own;
    }
    if (strandId === preferred) {
      preferredHit = own;
    }
  });
  return preferredHit && best && preferredHit.angle <= best.angle + 2e-3 ? preferredHit : best;
}

// Crossings closer together than this fraction of the strand share one stop.
const MARK_MERGE = 0.03;

/**
 * Handy stops for the position slider, as fractions from `origin`:
 * crossings (major), and halfway between neighboring crossings, sharp
 * corners, or strand ends (minor). Tight runs of crossings share one stop
 * at their middle. Sparse strands also get quarter points, and an open
 * strand its middle.
 */
function strandMarks(item, origin) {
  const { strand, length, bends } = item;
  const features = [
    ...strand.crossings.map((c) => ({ f: fractionAlong(item, origin, c.s), stop: true })),
    ...bends.filter((b) => b.turn > Math.PI / 9).map((b) => ({ f: fractionAlong(item, origin, b.s), stop: false })),
  ].sort((a, b) => a.f - b.f);
  const groups = [];
  features.forEach((feature) => {
    const group = groups[groups.length - 1];
    if (group && feature.f - group[group.length - 1].f < MARK_MERGE) {
      group.push(feature);
    } else {
      groups.push([feature]);
    }
  });
  const inner = groups
    .map((group) => ({ f: (group[0].f + group[group.length - 1].f) / 2, stop: group.some((g) => g.stop) }))
    .filter(({ f }) => f > MARK_MERGE / 2 && f < 1 - MARK_MERGE / 2);
  const wrapsAtCrossing = strand.closed && strand.crossings.length > 0;
  const sorted = [{ f: 0, stop: wrapsAtCrossing }, ...inner, { f: 1, stop: wrapsAtCrossing }];
  const marks = sorted.filter(({ stop }) => stop).map(({ f }) => ({ value: f, major: true }));
  const spans = sorted.length - 1;
  for (let i = 0; i < spans; i += 1) {
    const [a, b] = [sorted[i].f, sorted[i + 1].f];
    const parts = spans <= 2 ? [0.25, 0.5, 0.75] : [0.5];
    parts.forEach((u) => marks.push({ value: a + (b - a) * u, major: false }));
  }
  if (!strand.closed) {
    marks.push({ value: 0.5, major: true });
  }
  const unique = [];
  marks
    .sort((a, b) => a.value - b.value || Number(b.major) - Number(a.major))
    .forEach((mark) => {
      const last = unique[unique.length - 1];
      if (last && Math.abs(last.value - mark.value) * length < 1e-4) {
        last.major ||= mark.major;
      } else {
        unique.push(mark);
      }
    });
  return unique;
}

/** Stretches of the strand where the loop fits, as [from, to] fractions from `origin`. */
function freeStretches(item, origin, fits) {
  const steps = 400;
  const stretches = [];
  let start = null;
  for (let k = 0; k <= steps; k += 1) {
    const f = k / steps;
    const ok = fits(wrapAlong(item, origin + f * item.length));
    if (ok && start === null) {
      start = f;
    } else if (!ok && start !== null) {
      stretches.push([start, (k - 1) / steps]);
      start = null;
    }
  }
  if (start !== null) {
    stretches.push([start, 1]);
  }
  return stretches;
}

/**
 * The strand's path as a function of arc length s (radians), with corners
 * replaced by quadratic Beziers between points cut back from the corner.
 * The cut is bend·tan(θ/2), the tangent length of a circular fillet of
 * radius `bend` for a turn of θ. Sharpest corners are rounded first, each
 * reaching at most 45% of the way to the next corner at least
 * `ROUNDING_PEER_SHARE` as sharp (or the strand's end) and never into a
 * fillet already placed. So where two curves (flattened into many short,
 * gently turning edges) meet at a kink, the fillet spans several edges and
 * swallows their small corners instead of being capped by one short edge.
 * The Bezier's middle point is where the path's tangents at both cut points
 * meet, so it leaves and rejoins the path tangentially, curved or straight.
 */
function roundedPath(strand, nodes, arc, bend, bends) {
  const length = arc[arc.length - 1];
  const count = strand.edges.length;
  const pos = (i) => nodes[strand.nodes[i]].pos;
  const wrap = (s) => (strand.closed ? ((s % length) + length) % length : Math.min(length, Math.max(0, s)));
  // Arc distance from a to b, the short way round on a closed strand.
  const gap = (a, b) => {
    const d = Math.abs(a - b);
    return strand.closed ? Math.min(d, length - d) : d;
  };

  // The edge holding s; at a node, the one leaving it when `leaving` is set.
  const edgeAt = (s, leaving) => {
    const wrapped = wrap(s);
    let e = 0;
    while (e < count - 1 && (leaving ? arc[e + 1] <= wrapped : arc[e + 1] < wrapped)) {
      e += 1;
    }
    return e;
  };
  const straightAt = (s, target) => {
    const e = edgeAt(s, false);
    const span = arc[e + 1] - arc[e];
    const t = span > 0 ? (wrap(s) - arc[e]) / span : 0;
    return target.lerpVectors(pos(e), pos(e + 1), t).normalize();
  };
  const tangentAlong = (s, point, leaving) => {
    const e = edgeAt(s, leaving);
    const t = new Vector3().subVectors(pos(e + 1), pos(e));
    return t.addScaledVector(point, -t.dot(point)).normalize();
  };

  const corners = [];
  if (bend > 0) {
    const sharp = bends.filter(({ turn }) => turn >= 1e-3).sort((a, b) => b.turn - a.turn);
    sharp.forEach(({ index: i, s, turn }) => {
      if (corners.some((c) => gap(s, c.s) < c.cut)) {
        return;
      }
      let cut = bend * Math.tan(turn / 2);
      if (!strand.closed) {
        cut = Math.min(cut, 0.45 * s, 0.45 * (length - s));
      }
      sharp.forEach((other) => {
        if (other.index !== i && other.turn >= ROUNDING_PEER_SHARE * turn) {
          cut = Math.min(cut, 0.45 * gap(s, other.s));
        }
      });
      corners.forEach((c) => {
        cut = Math.min(cut, gap(s, c.s) - c.cut);
      });
      if (cut <= 1e-9) {
        return;
      }
      const p0 = straightAt(s - cut, new Vector3());
      const p2 = straightAt(s + cut, new Vector3());
      const t0 = tangentAlong(s - cut, p0, true);
      const t2 = tangentAlong(s + cut, p2, false);
      corners.push({ s, cut, p0, p1: filletControl(p0, t0, p2, t2) ?? pos(i).clone(), p2 });
    });
  }
  // A fillet on a closed strand may straddle where s wraps round.
  const placed = strand.closed
    ? corners.flatMap((c) => [c, { ...c, s: c.s + length }, { ...c, s: c.s - length }])
    : corners;

  return (s, target) => {
    const corner = placed.find((c) => Math.abs(s - c.s) < c.cut);
    if (!corner) {
      return straightAt(s, target);
    }
    const u = (s - (corner.s - corner.cut)) / (2 * corner.cut);
    return target
      .copy(corner.p0)
      .multiplyScalar((1 - u) * (1 - u))
      .addScaledVector(corner.p1, 2 * u * (1 - u))
      .addScaledVector(corner.p2, u * u)
      .normalize();
  };
}

/**
 * Where the line through p0 along t0 meets the line reaching p2 along t2
 * (midpoint of their closest approach), or null when they don't meet ahead
 * of p0 and behind p2, as for near-parallel tangents or an S-bend.
 */
function filletControl(p0, t0, p2, t2) {
  const w = new Vector3().subVectors(p0, p2);
  const b = t0.dot(t2);
  const denom = 1 - b * b;
  if (denom < 1e-6) {
    return null;
  }
  const d = t0.dot(w);
  const e = t2.dot(w);
  const along0 = (b * e - d) / denom;
  const along2 = (e - b * d) / denom;
  const chord = p0.distanceTo(p2);
  if (along0 <= 0 || along2 >= 0 || along0 > 2 * chord || -along2 > 2 * chord) {
    return null;
  }
  return p0
    .clone()
    .addScaledVector(t0, along0)
    .add(p2.clone().addScaledVector(t2, along2))
    .multiplyScalar(0.5);
}

/**
 * Ease from 0 to 1 over u in [0, 1]. Without `bendShare` it is the soft
 * cosine wave. With it, the strand runs straight across the middle and does
 * all its bending within `bendShare` of either end, as a taut strand bends
 * only where it wraps over or under the strands it crosses. Both keep level
 * at the ends, so strands stay flat across each crossing.
 */
function tautEase(u, bendShare) {
  if (bendShare === undefined) {
    return (1 - Math.cos(Math.PI * u)) / 2;
  }
  const a = bendShare;
  if (u < a) {
    return (u * u) / (2 * a * (1 - a));
  }
  if (u > 1 - a) {
    return 1 - ((1 - u) * (1 - u)) / (2 * a * (1 - a));
  }
  return (u - a / 2) / (1 - a);
}

// At full tension a strand bends only within this share of each end of a
// span between crossings; slack (0) spreads the bend over the whole span.
const TAUT_BEND_SHARE = 0.06;
const TAUT_BEND_SAMPLES = 6;
// A corner's rounding stops short of corners turning at least this share as
// much; gentler ones in reach (such as a flattened curve's) are smoothed over.
const ROUNDING_PEER_SHARE = 0.5;

/**
 * With `taut` (0 to 1) set, give every span between knots the share of its
 * length each end bends over (see `tautEase`): half the span when slack,
 * shrinking as tension rises, but never so small that the bend (peak
 * curvature Δh / (a (1 - a) L²)) is tighter than `minBend`.
 */
function tautenSpans(knots, taut, amplitude, minBend, radius) {
  if (!(taut > 0) || !amplitude) {
    return;
  }
  const wanted = Math.max(TAUT_BEND_SHARE, 0.5 * (1 - taut) ** 1.5);
  for (let k = 0; k < knots.length - 1; k += 1) {
    const span = (knots[k + 1].s - knots[k].s) * radius;
    const rise = Math.abs(knots[k + 1].h - knots[k].h) * amplitude;
    const q = span > 0 ? Math.min(0.25, (rise * minBend) / (span * span)) : 0.25;
    const needed = (1 - Math.sqrt(1 - 4 * q)) / 2;
    knots[k].bendShare = Math.min(0.5, Math.max(wanted, needed));
  }
}

/**
 * The cosine ease between two knots a distance L apart with a height change
 * dh has peak curvature dh·π²/(2L²). Shrink each crossing's height until
 * that stays under 1/minBend for the spans on both sides of it. Knot
 * positions are in radians; `radius` converts them to scene units.
 */
function limitBending(knots, amplitude, minBend, radius) {
  if (!amplitude || !minBend) {
    return;
  }
  const scales = knots.map((knot, i) => {
    if (knot.h === 0) {
      return 1;
    }
    const height = Math.abs(knot.h) * amplitude;
    let limit = height;
    [knots[i - 1], knots[i + 1]].forEach((neighbor) => {
      if (neighbor) {
        const span = Math.abs(knot.s - neighbor.s) * radius;
        // Toward another raised or lowered knot both ends move (dh ≈ 2h);
        // toward a flat knot only this one does.
        const share = neighbor.h === 0 ? 1 : 2;
        limit = Math.min(limit, (2 * span * span) / (Math.PI * Math.PI * minBend * share));
      }
    });
    return limit / height;
  });
  knots.forEach((knot, i) => {
    knot.h *= scales[i];
  });
}
