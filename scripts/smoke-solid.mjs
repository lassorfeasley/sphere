// Node smoke test for the geometry -> solid -> STL pipeline.
// Run with: node scripts/smoke-solid.mjs
import { writeFileSync } from 'node:fs';
import { createGeodesicSphere } from '../src/geodesic.js';
import { PRESETS, expandStrokes } from '../src/templateSpace.js';
import { buildWovenSegments } from '../src/weave.js';
import { countPieces } from '../src/connectivity.js';
import { buildStrutSolid } from '../src/solid.js';
import { meshToBinaryStl } from '../src/stl.js';

const geometry = createGeodesicSphere({ base: 'icosahedron', frequency: 1, radius: 1 });
console.log('geodesic vertices:', geometry.getAttribute('position').count);

const connections = expandStrokes(PRESETS.lineSphere.strokes, 'kaleidoscope');
console.log('triangle connections:', connections.length, 'pieces:', countPieces(connections, geometry));

// Woven round struts: 2.5 mm struts on a 60 mm sphere.
const { segments, strandIds } = buildWovenSegments(connections, geometry, {
  radius: 1,
  samplesPerSegment: 16,
  amplitude: (0.32 * 2.5) / 30,
  minBendRadius: (3 * 1.25) / 30,
  bendRadius: 3 / 30,
  loop: { height: 7 / 30, halfLength: 10 / 30 },
});
console.log('deduped sub-segments:', segments.length / 6);

const diameterMm = 60;
const scale = diameterMm / 2;
const segmentsMm = Float32Array.from(segments, (v) => v * scale);

console.time('buildStrutSolid');
const meshData = await buildStrutSolid({
  segments: segmentsMm,
  sphereRadius: diameterMm / 2,
  profile: { type: 'round', radius: 1.25 },
  strandIds,
  blendRadius: 0.7 * 1.25,
  edgeLength: 0.8,
});
console.timeEnd('buildStrutSolid');
console.log('solid triangles:', meshData.triangleCount, 'vertices:', meshData.vertexCount);

if (!meshData.triangleCount) {
  throw new Error('Solid is empty!');
}

const stl = meshToBinaryStl(meshData);
writeFileSync('/tmp/sphere-smoke.stl', Buffer.from(stl));
console.log('wrote /tmp/sphere-smoke.stl,', stl.byteLength, 'bytes');
