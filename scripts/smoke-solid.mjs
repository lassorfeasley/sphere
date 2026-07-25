// Node smoke test for the geometry -> solid -> STL pipeline.
// Run with: node scripts/smoke-solid.mjs
import { writeFileSync } from 'node:fs';
import { createGeodesicSphere } from '../src/geodesic.js';
import { getTessellationQuads, quadUvToBarycentric, mirrorBarycentric } from '../src/templateSpace.js';
import { collectProjectedSegments } from '../src/projection.js';
import { buildStrutSolid } from '../src/solid.js';
import { meshToBinaryStl } from '../src/stl.js';

const geometry = createGeodesicSphere({ base: 'icosahedron', frequency: 3, radius: 1 });
console.log('geodesic vertices:', geometry.getAttribute('position').count);

// A simple test stroke in the quad: one diagonal.
const quadSegments = [
  { id: 'seg-test', start: { uv: { u: 0, v: 0.25 } }, end: { uv: { u: 1, v: 0.75 } } },
];

const quads = getTessellationQuads('triforce');
const connections = [];
quads.forEach((quad) => {
  quadSegments.forEach((segment) => {
    const start = quadUvToBarycentric(quad, segment.start.uv);
    const end = quadUvToBarycentric(quad, segment.end.uv);
    connections.push({ id: `${segment.id}-${quad.id}`, start, end });
    connections.push({
      id: `${segment.id}-${quad.id}-m`,
      start: mirrorBarycentric(start),
      end: mirrorBarycentric(end),
    });
  });
});
console.log('triangle connections:', connections.length);

const segments = collectProjectedSegments(connections, geometry, {
  radius: 1,
  samplesPerSegment: 8,
});
console.log('deduped sub-segments:', segments.length / 6);

const diameterMm = 60;
const scale = diameterMm / 2;
const segmentsMm = Float32Array.from(segments, (v) => v * scale);

console.time('buildStrutSolid');
const meshData = await buildStrutSolid({
  segments: segmentsMm,
  sphereRadius: diameterMm / 2,
  strutRadius: 1.25,
  edgeLength: 1.0,
});
console.timeEnd('buildStrutSolid');
console.log('solid triangles:', meshData.triangleCount, 'vertices:', meshData.vertexCount);

if (!meshData.triangleCount) {
  throw new Error('Solid is empty!');
}

const stl = meshToBinaryStl(meshData);
writeFileSync('/tmp/sphere-smoke.stl', Buffer.from(stl));
console.log('wrote /tmp/sphere-smoke.stl,', stl.byteLength, 'bytes');
