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
 * With `loop` ({ height, halfLength } in scene units), the highest free
 * stretch of one strand rises off the sphere in a smooth arch that a ribbon
 * can pass under, forming a hanging loop out of the pattern itself.
 *
 * Returns { segments, strandIds, loopPlaced, pieces, pieceIds }: flat
 * segments [x1, y1, z1, x2, y2, z2, ...], the strand each segment belongs
 * to, whether a loop was requested and found a place, how many separate
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
  { radius, samplesPerSegment, amplitude, minBendRadius, bendRadius, loop, minSeparation },
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
      return h0 + (h1 - h0) * (1 - Math.cos(Math.PI * u)) / 2;
    };

    const bends = strandBends(strand, nodes, arc);
    const directionAt = roundedPath(strand, nodes, arc, bendRadius / radius, bends);
    return { strand, arc, length, knots, bends, heightAt, directionAt };
  });

  // Hang from the largest piece, so the loop carries the whole ornament.
  const placement = loop
    ? placeLoop(prepared, loop.halfLength / radius, (strandId) => strands[strandId].piece === 0)
    : null;

  // Sample every strand as a polyline of unit directions plus a radial
  // height offset (scene units). With a minimum separation, sample finely
  // enough that the height profile near crossings is resolved.
  const polylines = prepared.map(({ strand, arc, heightAt, directionAt }, strandId) => {
    const onLoop = placement && placement.strandId === strandId;
    const loopHalf = loop ? loop.halfLength / radius : 0;
    // Smooth sin² bump: zero height and slope where it meets the strand.
    const lift = (s) => {
      if (!onLoop || Math.abs(s - placement.s) >= loopHalf) {
        return 0;
      }
      const u = (s - placement.s + loopHalf) / (2 * loopHalf);
      return loop.height * Math.sin(Math.PI * u) ** 2;
    };

    const points = [];
    const maxStep = minSeparation > 0 ? minSeparation / 3 / radius : Infinity;
    for (let i = 0; i < strand.edges.length; i += 1) {
      const span = arc[i + 1] - arc[i];
      let steps = Math.max(bendRadius > 0 ? 8 : 1, Math.ceil((samplesPerSegment * span) / graph.faceEdge));
      steps = Math.max(steps, Math.ceil(span / maxStep));
      if (onLoop && arc[i + 1] > placement.s - loopHalf && arc[i] < placement.s + loopHalf) {
        steps = Math.max(steps, Math.ceil((32 * span) / (2 * loopHalf)));
      }
      const isLast = i === strand.edges.length - 1;
      for (let j = 0; j < steps + (isLast ? 1 : 0); j += 1) {
        const s = arc[i] + (span * j) / steps;
        points.push({ dir: directionAt(s, new Vector3()), h: amplitude * heightAt(s) + lift(s), strandId });
      }
    }
    return points;
  });

  const out = [];
  const strandIds = [];
  polylines.forEach((points, strandId) => {
    for (let k = 0; k < points.length - 1; k += 1) {
      [points[k], points[k + 1]].forEach(({ dir, h }) => {
        sample.copy(dir).multiplyScalar(radius + h);
        out.push(sample.x, sample.y, sample.z);
      });
      strandIds.push(strandId);
    }
  });

  if (!out.length) {
    return null;
  }
  return {
    segments: new Float32Array(out),
    strandIds: Uint32Array.from(strandIds),
    loopPlaced: Boolean(placement),
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

/**
 * Find the highest stretch of any allowed strand that is 2 × halfLength
 * long and free of strand ends and corners sharper than 20°, so the hanging
 * loop can rise out of it cleanly. The loop may pass over crossings: lifted off the
 * sphere, it arches over the strands beneath it. Returns { strandId, s } or
 * null.
 */
function placeLoop(prepared, halfLength, allowed) {
  const clearance = halfLength * 1.25;
  const probe = new Vector3();
  let best = null;
  prepared.forEach(({ length, bends, directionAt }, strandId) => {
    if (!allowed(strandId)) {
      return;
    }
    const blocked = bends.filter((b) => b.turn > Math.PI / 9).flatMap((b) => [b.s, b.s - length, b.s + length]);
    const step = halfLength / 4;
    // The whole arch must fit inside [0, length]: on closed strands the arc
    // position wraps at the seam, and an arch straddling it would be cut.
    for (let s = clearance; s <= length - clearance; s += step) {
      if (blocked.some((b) => Math.abs(b - s) < clearance)) {
        continue;
      }
      const height = directionAt(s, probe).y;
      if (!best || height > best.height) {
        best = { strandId, s, height };
      }
    }
  });
  return best;
}

/**
 * The strand's path as a function of arc length s (radians), with every
 * interior corner replaced by a quadratic Bezier between points cut back
 * from the corner. The cut is bend·tan(θ/2), the tangent length of a circular
 * fillet of radius `bend` for a turn of θ, capped at 45% of either adjacent
 * edge so neighboring fillets never overlap. The curve meets both edges
 * tangentially, so the path stays smooth.
 */
function roundedPath(strand, nodes, arc, bend, bends) {
  const length = arc[arc.length - 1];
  const count = strand.edges.length;
  const pos = (i) => nodes[strand.nodes[i]].pos;

  const straightAt = (s, target) => {
    const wrapped = strand.closed ? ((s % length) + length) % length : Math.min(length, Math.max(0, s));
    let e = 0;
    while (e < count - 1 && arc[e + 1] < wrapped) {
      e += 1;
    }
    const span = arc[e + 1] - arc[e];
    const t = span > 0 ? (wrapped - arc[e]) / span : 0;
    return target.lerpVectors(pos(e), pos(e + 1), t).normalize();
  };

  const corners = [];
  if (bend > 0) {
    bends.forEach(({ index: i, prev, s, turn }) => {
      if (turn < 1e-3) {
        return;
      }
      const lengthIn = arc[i === 0 ? count : i] - arc[prev];
      const lengthOut = arc[i + 1] - arc[i];
      const cut = Math.min(bend * Math.tan(turn / 2), 0.45 * lengthIn, 0.45 * lengthOut);
      const corner = {
        s,
        cut,
        p0: straightAt(s - cut, new Vector3()),
        p1: pos(i).clone(),
        p2: straightAt(s + cut, new Vector3()),
      };
      corners.push(corner);
      if (strand.closed && i === 0) {
        corners.push({ ...corner, s: length });
      }
    });
  }

  return (s, target) => {
    const corner = corners.find((c) => Math.abs(s - c.s) < c.cut);
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
