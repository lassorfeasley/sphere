import './style.css';
import {
  AmbientLight,
  BufferGeometry,
  Color,
  DirectionalLight,
  EdgesGeometry,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Quaternion,
  Scene,
  TorusGeometry,
  Uint32BufferAttribute,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GUI } from 'lil-gui';
import { createGeodesicSphere, getBaseTypes } from './geodesic.js';
import { TemplateEditor } from './templateEditor.js';
import { buildPatternGeometry } from './patternMapper.js';
import {
  buildProjectedEdgeGeometry,
  buildProjectedFaceGeometry,
  collectProjectedSegments,
  segmentsAlong,
} from './projection.js';
import { buildTubeGroup, disposeTubeGroup } from './tubes.js';
import { buildStrutSolid } from './solid.js';
import { countPieces } from './connectivity.js';
import { buildWovenSegments, measureClearance } from './weave.js';
import { downloadBinaryStl } from './stl.js';

const viewport = document.querySelector('#viewport');
const templateRoot = document.querySelector('#template-root');

const overlay = document.createElement('div');
overlay.className = 'overlay';
viewport.appendChild(overlay);

const setStatus = (message) => {
  overlay.innerHTML = `Geodesic Sphere Studio<br/>${message}`;
};
setStatus('Drag to orbit · Scroll to zoom');

const canvas = document.createElement('canvas');
canvas.id = 'scene-canvas';
viewport.appendChild(canvas);

const renderer = new WebGLRenderer({
  antialias: true,
  canvas,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(new Color('#050608'), 1);

const scene = new Scene();
const sphereGroup = new Group();
scene.add(sphereGroup);

const camera = new PerspectiveCamera(45, 1, 0.1, 100);
camera.position.set(0, 0, 4);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 1.5;
controls.maxDistance = 6;

const ambientLight = new AmbientLight(0xf5f5f5, 0.5);
const keyLight = new DirectionalLight(0xffffff, 0.9);
keyLight.position.set(5, 5, 5);
const rimLight = new DirectionalLight(0x6bc4ff, 0.4);
rimLight.position.set(-4, -2, -4);
scene.add(ambientLight, keyLight, rimLight);

const params = {
  base: 'icosahedron',
  frequency: 1,
  radius: 1,
  color: '#8ae5ff',
  wireframe: false,
  flat: true,
  edgeColor: '#ffffff',
  edgeOpacity: 0.45,
  edgeThreshold: 18,
  surfaceOpacity: 1,
  displayMode: 'sphere',
  projectionSamples: 12,
  spin: true,
  showSphere: true,
  colorPieces: true,
};

// Defaults suit a hanging ornament: round struts about 3.5% of the diameter
// print cleanly in FDM, and woven crossings read like the original SketchUp
// line spheres.
const printParams = {
  diameterMm: 70,
  profile: 'round',
  weave: true,
  tension: 0.5,
  weaveRun: 1,
  strandsTouch: true,
  crossingGapMm: 1,
  jointSmoothing: 0.5,
  bendMm: 3,
  strutMm: 2.5,
  bandWidthMm: 2.4,
  bandDepthMm: 3.0,
  loop: true,
  detailMm: 0.8,
};

const LOOP_MAJOR_MM = 3.5;
// The organic loop: a stretch of strand this long rises this high off the
// sphere, leaving room under it for a ribbon.
const ARCH_HEIGHT_MM = 7;
const ARCH_HALF_LENGTH_MM = 10;
// Tension 0 leaves crossing strands just touching (centerlines one diameter
// apart); tension 1 presses them 70% into each other. Returns each strand's
// rise or dip as a fraction of the strut diameter.
// With Strands Touch off, centerlines separate by one diameter plus the gap.
const weaveFraction = () =>
  printParams.strandsTouch
    ? 0.5 - 0.35 * printParams.tension
    : 0.5 + printParams.crossingGapMm / (2 * printParams.strutMm);
// Strands never bend tighter than this many strut radii.
const MIN_BEND_RADII = 3;
// Joint Smoothing 1 gives a fillet of 1.5 strut radii where strands meet.
const blendRadiusMm = () => printParams.jointSmoothing * 1.5 * (printParams.strutMm / 2);

// The GUI edits the cylinder radius; everything else works in diameters.
const cylinder = {
  get radiusMm() {
    return printParams.strutMm / 2;
  },
  set radiusMm(value) {
    printParams.strutMm = value * 2;
  },
};

const weaving = () => printParams.weave && printParams.profile === 'round';
const gapMode = () => weaving() && !printParams.strandsTouch;

/**
 * Pattern segments on the sphere in scene units, traced into strands with
 * rounded bends, and woven if enabled. Also returns the strand each segment
 * belongs to, which the solid uses to fillet joints between strands.
 */
const patternSegments = () => {
  const scale = params.radius / (printParams.diameterMm / 2);
  return buildWovenSegments(patternState.connections, sphereMesh.geometry, {
    radius: params.radius,
    samplesPerSegment: params.projectionSamples,
    amplitude: weaving() ? weaveFraction() * printParams.strutMm * scale : 0,
    // A minimum gap is a hard requirement, so the weave keeps its full height
    // at every crossing instead of flattening where crossings are close.
    minBendRadius: gapMode() ? 0 : MIN_BEND_RADII * (printParams.strutMm / 2) * scale,
    bendRadius: printParams.bendMm * scale,
    loop:
      printParams.loop && printParams.profile === 'round'
        ? { height: ARCH_HEIGHT_MM * scale, halfLength: ARCH_HALF_LENGTH_MM * scale }
        : null,
    crossingsTouch: !weaving() || printParams.strandsTouch,
    run: printParams.weaveRun,
    minSeparation: gapMode() ? (printParams.strutMm + printParams.crossingGapMm) * scale : 0,
  });
};

// A fillet wider than the crossing gap would bridge it, so cap it there.
const effectiveBlendMm = () =>
  weaving() && !printParams.strandsTouch ? Math.min(blendRadiusMm(), printParams.crossingGapMm) : blendRadiusMm();

// The separate ring loop is only used when the loop can't grow out of a
// strand: with flat bands, or when no free stretch of line is long enough.
const needsRingLoop = (result) => printParams.loop && !result?.loopPlaced;

// Strut cross-section in scene units (scale = scene units per millimeter).
const strutProfile = (scale) =>
  printParams.profile === 'band'
    ? { type: 'band', width: printParams.bandWidthMm * scale, depth: printParams.bandDepthMm * scale }
    : { type: 'round', radius: (printParams.strutMm / 2) * scale };

const strutThicknessMm = () =>
  printParams.profile === 'band' ? Math.min(printParams.bandWidthMm, printParams.bandDepthMm) : printParams.strutMm;

/**
 * Place the hanging loop on the pattern point closest to the top, standing
 * up out of the sphere in line with the strut it grows from.
 */
const hangingLoop = (segments, sphereRadius, scale) => {
  let best = -1;
  for (let i = 0; i < segments.length; i += 3) {
    if (best < 0 || segments[i + 1] / Math.hypot(segments[i], segments[i + 1], segments[i + 2]) >
      segments[best + 1] / Math.hypot(segments[best], segments[best + 1], segments[best + 2])) {
      best = i;
    }
  }
  const up = new Vector3().fromArray(segments, best).normalize();
  const partner = best % 6 === 0 ? best + 3 : best - 3;
  const along = new Vector3().fromArray(segments, partner).sub(new Vector3().fromArray(segments, best));
  along.addScaledVector(up, -along.dot(up)).normalize();
  const majorRadius = LOOP_MAJOR_MM * scale;
  const minorRadius = Math.max(1, strutThicknessMm() / 2) * scale;
  const baseRadius = new Vector3().fromArray(segments, best).length();
  const center = up.clone().multiplyScalar(Math.max(sphereRadius, baseRadius) + majorRadius - minorRadius);
  const normal = new Vector3().crossVectors(up, along).normalize();
  return { center: center.toArray(), normal: normal.toArray(), majorRadius, minorRadius };
};

const material = new MeshStandardMaterial({
  color: params.color,
  metalness: 0.25,
  roughness: 0.35,
  wireframe: params.wireframe,
  flatShading: params.flat,
  transparent: params.surfaceOpacity < 0.999,
  opacity: params.surfaceOpacity,
  // Keeps pattern and edge lines lying on the surface from z-fighting it.
  polygonOffset: true,
  polygonOffsetFactor: 1,
  polygonOffsetUnits: 1,
});

const sphereSurfaceMaterial = material.clone();
sphereSurfaceMaterial.flatShading = false;

const edgesMaterial = new LineBasicMaterial({
  color: params.edgeColor,
  transparent: true,
  opacity: params.edgeOpacity,
  depthTest: true,
});

const patternState = {
  connections: [],
};

const patternMaterial = new LineBasicMaterial({
  color: '#fef4b4',
  transparent: true,
  opacity: 0.95,
  depthTest: true,
  depthWrite: false,
});
const tubeMaterial = new MeshStandardMaterial({
  color: '#fef4b4',
  metalness: 0.1,
  roughness: 0.45,
});

// Separate pieces get distinct colors; the largest piece keeps the usual
// cream. Orange is left out so the selection highlight stays distinct.
const PIECE_COLORS = [
  '#fef4b4', '#7fd4ff', '#b88cff', '#7ee08a', '#ff7fb0',
  '#ffd84d', '#5ce0c8', '#9aa5ff', '#c9a27a', '#e6e6e6',
].map((hex) => new Color(hex));
const pieceColor = (id) => PIECE_COLORS[id % PIECE_COLORS.length];
const pieceMaterial = tubeMaterial.clone();
pieceMaterial.color.set('#ffffff');

const highlightMaterial = new MeshStandardMaterial({
  color: '#ff9f5a',
  emissive: '#ff7a2e',
  emissiveIntensity: 0.35,
  metalness: 0.1,
  roughness: 0.45,
});

const solidMaterial = new MeshStandardMaterial({
  color: '#e8e8e2',
  metalness: 0.05,
  roughness: 0.55,
  flatShading: false,
});

let sphereMesh;
let edgeLines;
let patternLines;
let projectedLines;
let loopMesh;
let highlightMesh;
let displayedSegments = null;
let displayedPieces = null;
let selectedSpans = [];
let smoothSphere;
let smoothSphereEdges;
let solidMesh;

const solidState = {
  meshData: null,
  generating: false,
};

const rebuildSphere = () => {
  const geometry = createGeodesicSphere({
    base: params.base,
    frequency: params.frequency,
    radius: params.radius,
  });

  if (!sphereMesh) {
    sphereMesh = new Mesh(geometry, material);
    sphereGroup.add(sphereMesh);
  } else {
    sphereMesh.geometry.dispose();
    sphereMesh.geometry = geometry;
  }

  const newEdges = new EdgesGeometry(geometry, params.edgeThreshold);
  if (!edgeLines) {
    edgeLines = new LineSegments(newEdges, edgesMaterial);
    sphereGroup.add(edgeLines);
  } else {
    edgeLines.geometry.dispose();
    edgeLines.geometry = newEdges;
  }

  rebuildSmoothSphere();
  rebuildPatternOverlay();
};

const rebuildSmoothSphere = () => {
  const subdivisions = Math.max(3, Math.ceil(24 / params.frequency));
  const faceGeometry = buildProjectedFaceGeometry(sphereMesh.geometry, { radius: params.radius, subdivisions });
  const edgeGeometry = buildProjectedEdgeGeometry(sphereMesh.geometry, { radius: params.radius, samples: subdivisions });

  if (!smoothSphere) {
    smoothSphere = new Mesh(faceGeometry, sphereSurfaceMaterial);
    smoothSphereEdges = new LineSegments(edgeGeometry, edgesMaterial);
    sphereGroup.add(smoothSphere, smoothSphereEdges);
  } else {
    smoothSphere.geometry.dispose();
    smoothSphere.geometry = faceGeometry;
    smoothSphereEdges.geometry.dispose();
    smoothSphereEdges.geometry = edgeGeometry;
  }
};

const updateMaterial = () => {
  material.color.set(params.color);
  material.wireframe = params.wireframe;
  material.flatShading = params.flat;
  material.opacity = params.surfaceOpacity;
  material.transparent = params.surfaceOpacity < 0.999;
  material.depthWrite = true;
  material.needsUpdate = true;
  sphereSurfaceMaterial.color.set(params.color);
  sphereSurfaceMaterial.wireframe = params.wireframe;
  sphereSurfaceMaterial.opacity = params.surfaceOpacity;
  sphereSurfaceMaterial.transparent = params.surfaceOpacity < 0.999;
  sphereSurfaceMaterial.needsUpdate = true;
};

const updateEdgeMaterial = () => {
  edgesMaterial.color.set(params.edgeColor);
  edgesMaterial.opacity = params.edgeOpacity;
};

const updateModeVisibility = () => {
  const mode = params.displayMode;
  if (sphereMesh) {
    sphereMesh.visible = mode === 'dome';
  }
  if (edgeLines) {
    edgeLines.visible = mode === 'dome';
  }
  if (patternLines) {
    patternLines.visible = mode === 'dome';
  }
  if (smoothSphere) {
    smoothSphere.visible = mode === 'sphere' && params.showSphere;
    smoothSphereEdges.visible = mode === 'sphere' && params.showSphere;
  }
  if (projectedLines) {
    projectedLines.visible = mode === 'sphere';
  }
  if (loopMesh) {
    loopMesh.visible = mode === 'sphere';
  }
  if (highlightMesh) {
    highlightMesh.visible = mode === 'sphere';
  }
  if (solidMesh) {
    solidMesh.visible = mode === 'solid';
  }
};

// Any change to the pattern or sphere invalidates a previously generated
// solid; drop it so the preview and STL can't go stale.
const invalidateSolid = () => {
  solidState.meshData = null;
  if (solidMesh) {
    sphereGroup.remove(solidMesh);
    solidMesh.geometry.dispose();
    solidMesh = null;
  }
  if (params.displayMode === 'solid') {
    params.displayMode = 'sphere';
    displayModeController.updateDisplay();
  }
};

const rebuildPatternOverlay = () => {
  invalidateSolid();

  if (patternLines) {
    sphereGroup.remove(patternLines);
    patternLines.geometry.dispose();
    patternLines = null;
  }

  if (sphereMesh && patternState.connections.length) {
    const patternGeometry = buildPatternGeometry(patternState.connections, sphereMesh.geometry);
    if (patternGeometry) {
      patternLines = new LineSegments(patternGeometry, patternMaterial);
      sphereGroup.add(patternLines);
    }
  }

  rebuildProjectedOverlay();
  updateModeVisibility();
  updateEditorFeedback();
};

let templateEditor = null;

/**
 * Tint each editor line with the color of the piece it belongs to on the
 * sphere, as seen on the first face (other faces may split differently).
 */
const colorEditorLines = (result) => {
  if (!templateEditor) {
    return;
  }
  if (!params.colorPieces || !result || result.pieces < 2) {
    templateEditor.setLineColors(null);
    return;
  }
  const positions = sphereMesh.geometry.getAttribute('position');
  const index = sphereMesh.geometry.getIndex();
  const corners = [0, 1, 2].map((k) => new Vector3().fromBufferAttribute(positions, index.getX(k)));
  const { segments, pieceIds } = result;
  const mid = new Vector3();
  const probe = new Vector3();
  const colors = templateEditor.segments.map(({ start, end }) => {
    const a = (start.a + end.a) / 2;
    const b = (start.b + end.b) / 2;
    const c = (start.c + end.c) / 2;
    mid.set(0, 0, 0).addScaledVector(corners[0], a).addScaledVector(corners[1], b).addScaledVector(corners[2], c).normalize();
    let best = 0;
    let bestAngle = Infinity;
    for (let i = 0; i < segments.length; i += 6) {
      probe.set(segments[i] + segments[i + 3], segments[i + 1] + segments[i + 4], segments[i + 2] + segments[i + 5]);
      const angle = probe.angleTo(mid);
      if (angle < bestAngle) {
        bestAngle = angle;
        best = pieceIds[i / 6];
      }
    }
    return `#${pieceColor(best).getHexString()}`;
  });
  templateEditor.setLineColors(colors);
};

/**
 * With a minimum gap set, measure the closest approach between separate
 * strands (away from junctions, where lines meet by design) and report it
 * under the editor.
 */
const reportClearance = (result) => {
  if (!templateEditor) {
    return;
  }
  if (!gapMode() || !result?.segments) {
    templateEditor.setClearance(null);
    return;
  }
  const scale = params.radius / (printParams.diameterMm / 2);
  const target = printParams.crossingGapMm;
  const closest = measureClearance(result.segments, result.strandIds, result.junctions, {
    strutRadius: (printParams.strutMm / 2) * scale,
    junctionRadius: (2 * printParams.strutMm + target) * scale,
    searchGap: target * 1.5 * scale,
  });
  // Stacks rise and dip symmetrically, so measure the dip; the hanging loop
  // only rises and would otherwise dominate.
  let deepest = 0;
  for (let i = 0; i < result.segments.length; i += 3) {
    const r = Math.hypot(result.segments[i], result.segments[i + 1], result.segments[i + 2]);
    deepest = Math.max(deepest, params.radius - r);
  }
  const stack = ` Strands move up to ${(deepest / scale).toFixed(1)} mm off the sphere to keep clear.`;
  if (!closest) {
    templateEditor.setClearance(`Strands stay at least ${target.toFixed(1)} mm apart.${stack}`, false);
    return;
  }
  const gapMm = closest.gap / scale;
  const short = gapMm < target - 0.05;
  templateEditor.setClearance(
    gapMm <= 0
      ? `Some strands still touch or overlap (by ${(-gapMm).toFixed(1)} mm) — lines pass too close outside the weave.`
      : `Closest gap between strands: ${gapMm.toFixed(1)} mm${short ? ` — below your ${target.toFixed(1)} mm minimum where lines pass close outside the weave.` : '.'}${stack}`,
    short,
  );
};

const updateEditorFeedback = () => {
  if (!templateEditor || !sphereMesh) {
    return;
  }
  templateEditor.setConnectivity(displayedPieces ?? countPieces(patternState.connections, sphereMesh.geometry));

  // Editor units are one face edge; use the first face as a representative size.
  const positions = sphereMesh.geometry.getAttribute('position');
  const index = sphereMesh.geometry.getIndex();
  const a = new Vector3().fromBufferAttribute(positions, index.getX(0));
  const b = new Vector3().fromBufferAttribute(positions, index.getX(1));
  const edgeMm = (a.distanceTo(b) / params.radius) * (printParams.diameterMm / 2);
  const widthMm = printParams.profile === 'band' ? printParams.bandWidthMm : printParams.strutMm;
  templateEditor.setLineWidth(widthMm / edgeMm);
};

const rebuildProjectedOverlay = () => {
  if (projectedLines) {
    sphereGroup.remove(projectedLines);
    disposeTubeGroup(projectedLines);
    projectedLines = null;
  }
  if (loopMesh) {
    sphereGroup.remove(loopMesh);
    loopMesh.geometry.dispose();
    loopMesh = null;
  }

  displayedSegments = null;
  displayedPieces = null;
  if (sphereMesh && patternState.connections.length) {
    const result = patternSegments();
    const segments = result?.segments;
    displayedSegments = segments ?? null;
    displayedPieces = result?.pieces ?? null;
    colorEditorLines(result);
    reportClearance(result);
    if (segments) {
      const scale = params.radius / (printParams.diameterMm / 2);
      const profile = strutProfile(scale);
      // Sink the preview surface to the struts' inner face so they stand
      // proud of it, as they will in the print.
      let lowest = params.radius;
      for (let i = 0; i < segments.length; i += 3) {
        lowest = Math.min(lowest, Math.hypot(segments[i], segments[i + 1], segments[i + 2]));
      }
      const inset = profile.type === 'band' ? profile.depth : params.radius - lowest + profile.radius;
      smoothSphere.scale.setScalar(1 - inset / params.radius);
      smoothSphereEdges.scale.setScalar(1 - inset / params.radius);
      const colored = params.colorPieces && result.pieces > 1;
      projectedLines = colored
        ? buildTubeGroup(segments, profile, pieceMaterial, Array.from(result.pieceIds, pieceColor))
        : buildTubeGroup(segments, profile, tubeMaterial);
      sphereGroup.add(projectedLines);
      if (needsRingLoop(result)) {
        const loop = hangingLoop(segments, params.radius, scale);
        loopMesh = new Mesh(new TorusGeometry(loop.majorRadius, loop.minorRadius, 12, 40), tubeMaterial);
        loopMesh.position.fromArray(loop.center);
        loopMesh.quaternion.copy(
          new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), new Vector3().fromArray(loop.normal)),
        );
        sphereGroup.add(loopMesh);
      }
    }
  }

  updateHighlight();
};

/**
 * Redraw the cylinders that belong to the line selected in the editor,
 * slightly thicker and in the selection color, on top of the pattern.
 */
const updateHighlight = () => {
  if (highlightMesh) {
    sphereGroup.remove(highlightMesh);
    disposeTubeGroup(highlightMesh);
    highlightMesh = null;
  }
  if (sphereMesh && displayedSegments && selectedSpans.length) {
    const guides = collectProjectedSegments(selectedSpans, sphereMesh.geometry, {
      radius: 1,
      samplesPerSegment: params.projectionSamples,
    });
    const matched = guides && segmentsAlong(displayedSegments, guides);
    if (matched) {
      const profile = strutProfile(params.radius / (printParams.diameterMm / 2));
      const enlarged =
        profile.type === 'band'
          ? { ...profile, width: profile.width * 1.15, depth: profile.depth * 1.04 }
          : { ...profile, radius: profile.radius * 1.12 };
      highlightMesh = buildTubeGroup(matched, enlarged, highlightMaterial);
      sphereGroup.add(highlightMesh);
    }
  }
  updateModeVisibility();
};

const nextFrame = () =>
  new Promise((resolve) => {
    requestAnimationFrame(() => setTimeout(resolve, 30));
  });

const generateSolid = async () => {
  if (solidState.generating) {
    return;
  }
  if (!patternState.connections.length) {
    setStatus('Draw a pattern first — drag between two dots on the triangle.');
    return;
  }

  solidState.generating = true;
  setStatus('Generating solid… this can take a little while.');
  await nextFrame();

  try {
    const result = patternSegments();
    const { segments, strandIds } = result ?? {};
    if (!segments) {
      setStatus('No printable segments found.');
      return;
    }

    const sphereRadiusMm = printParams.diameterMm / 2;
    const scale = sphereRadiusMm / params.radius;
    const segmentsMm = new Float32Array(segments.length);
    for (let i = 0; i < segments.length; i += 1) {
      segmentsMm[i] = segments[i] * scale;
    }

    const meshData = await buildStrutSolid({
      segments: segmentsMm,
      sphereRadius: sphereRadiusMm,
      profile: strutProfile(1),
      loop: needsRingLoop(result) ? hangingLoop(segmentsMm, sphereRadiusMm, 1) : null,
      strandIds,
      blendRadius: printParams.profile === 'round' ? effectiveBlendMm() : 0,
      edgeLength: printParams.detailMm,
    });

    if (!meshData.triangleCount) {
      setStatus('Solid came out empty — try thicker struts or finer detail.');
      return;
    }

    solidState.meshData = meshData;
    rebuildSolidPreview(meshData, 1 / scale);
    params.displayMode = 'solid';
    displayModeController.updateDisplay();
    updateModeVisibility();
    setStatus(
      `Solid ready: ${meshData.triangleCount.toLocaleString()} triangles · ` +
        `${printParams.diameterMm} mm — use Export STL.`,
    );
  } catch (error) {
    console.error(error);
    setStatus('Solid generation failed — see the browser console.');
  } finally {
    solidState.generating = false;
  }
};

const rebuildSolidPreview = (meshData, scaleToScene) => {
  const positions = new Float32Array((meshData.vertProperties.length / meshData.numProp) * 3);
  for (let v = 0; v < positions.length / 3; v += 1) {
    positions[v * 3] = meshData.vertProperties[v * meshData.numProp] * scaleToScene;
    positions[v * 3 + 1] = meshData.vertProperties[v * meshData.numProp + 1] * scaleToScene;
    positions[v * 3 + 2] = meshData.vertProperties[v * meshData.numProp + 2] * scaleToScene;
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setIndex(new Uint32BufferAttribute(meshData.triVerts, 1));
  geometry.computeVertexNormals();

  if (solidMesh) {
    solidMesh.geometry.dispose();
    solidMesh.geometry = geometry;
  } else {
    solidMesh = new Mesh(geometry, solidMaterial);
    sphereGroup.add(solidMesh);
  }
};

const exportStl = () => {
  if (!solidState.meshData) {
    setStatus('Generate a solid first, then export.');
    return;
  }
  downloadBinaryStl(solidState.meshData, `sphere-${printParams.diameterMm}mm.stl`);
  setStatus('STL downloaded. Happy printing!');
};

const gui = new GUI({ container: viewport });
gui.title('Sphere Controls');
gui.add(params, 'base', getBaseTypes()).name('Base Polyhedron').onChange(rebuildSphere);
gui.add(params, 'frequency', 1, 6, 1).name('Frequency').onChange(rebuildSphere);
gui.add(params, 'radius', 0.6, 2, 0.1).name('Radius').onChange(rebuildSphere);
const displayModeController = gui
  .add(params, 'displayMode', { Dome: 'dome', Sphere: 'sphere', Solid: 'solid' })
  .name('Display Mode')
  .onChange(updateModeVisibility);
gui.add(params, 'spin').name('Spin');
gui.add(params, 'showSphere').name('Show Sphere').onChange(updateModeVisibility);
gui.add(params, 'colorPieces').name('Color Pieces').onChange(rebuildPatternOverlay);
gui.addColor(params, 'color').name('Color').onChange(updateMaterial);
gui.add(params, 'wireframe').name('Wireframe').onChange(updateMaterial);
gui.add(params, 'flat').name('Flat Shading').onChange(updateMaterial);
gui.add(params, 'surfaceOpacity', 0.2, 1, 0.05).name('Surface Opacity').onChange(updateMaterial);
gui
  .add(params, 'edgeThreshold', 1, 40, 1)
  .name('Edge Threshold')
  .onChange(rebuildSphere);
gui.addColor(params, 'edgeColor').name('Edge Color').onChange(updateEdgeMaterial);
gui.add(params, 'edgeOpacity', 0.1, 1, 0.05).name('Edge Opacity').onChange(updateEdgeMaterial);
gui
  .add(params, 'projectionSamples', 4, 32, 1)
  .name('Sphere Samples')
  .onChange(rebuildPatternOverlay);

const printFolder = gui.addFolder('3D Print');
printFolder.add(printParams, 'diameterMm', 20, 200, 1).name('Diameter (mm)').onChange(rebuildPatternOverlay);
const updateProfileControls = () => {
  const band = printParams.profile === 'band';
  strutController.show(!band);
  weaveController.show(!band);
  touchController.show(!band && printParams.weave);
  runController.show(!band && printParams.weave);
  tensionController.show(!band && printParams.weave && printParams.strandsTouch);
  gapController.show(!band && printParams.weave && !printParams.strandsTouch);
  jointController.show(!band);
  bandWidthController.show(band);
  bandDepthController.show(band);
};
printFolder
  .add(printParams, 'profile', { Round: 'round', 'Flat band': 'band' })
  .name('Strut Profile')
  .onChange(() => {
    updateProfileControls();
    rebuildPatternOverlay();
  });
const strutController = printFolder
  .add(cylinder, 'radiusMm', 0.5, 4, 0.05)
  .name('Cylinder Radius (mm)')
  .onChange(rebuildPatternOverlay);
const weaveController = printFolder
  .add(printParams, 'weave')
  .name('Weave Crossings')
  .onChange(() => {
    updateProfileControls();
    rebuildPatternOverlay();
  });
const runController = printFolder
  .add(printParams, 'weaveRun', 1, 4, 1)
  .name('Over/Under Run')
  .onChange(rebuildPatternOverlay);
const touchController = printFolder
  .add(printParams, 'strandsTouch')
  .name('Strands Touch')
  .onChange(() => {
    updateProfileControls();
    rebuildPatternOverlay();
  });
const gapController = printFolder
  .add(printParams, 'crossingGapMm', 0.2, 6, 0.1)
  .name('Minimum Gap (mm)')
  .onChange(rebuildPatternOverlay);
const tensionController = printFolder
  .add(printParams, 'tension', 0, 1, 0.05)
  .name('Weave Tension')
  .onChange(rebuildPatternOverlay);
const jointController = printFolder
  .add(printParams, 'jointSmoothing', 0, 1, 0.05)
  .name('Joint Smoothing')
  .onChange(invalidateSolid);
printFolder.add(printParams, 'bendMm', 0, 15, 0.5).name('Bend Smoothing (mm)').onChange(rebuildPatternOverlay);
const bandWidthController = printFolder
  .add(printParams, 'bandWidthMm', 1, 8, 0.1)
  .name('Band Width (mm)')
  .onChange(rebuildPatternOverlay);
const bandDepthController = printFolder
  .add(printParams, 'bandDepthMm', 1, 10, 0.1)
  .name('Band Depth (mm)')
  .onChange(rebuildPatternOverlay);
updateProfileControls();
printFolder.add(printParams, 'loop').name('Hanging Loop').onChange(rebuildPatternOverlay);
printFolder.add(printParams, 'detailMm', 0.3, 3, 0.1).name('Detail (mm)').onChange(invalidateSolid);
printFolder.add({ generate: generateSolid }, 'generate').name('Generate Solid');
printFolder.add({ exportStl }, 'exportStl').name('Export STL');

templateEditor = new TemplateEditor(templateRoot, {
  onChange: ({ connections }) => {
    patternState.connections = connections;
    rebuildPatternOverlay();
  },
  onSelect: (spans) => {
    selectedSpans = spans;
    updateHighlight();
  },
  onPreset: ({ sphere }) => {
    Object.assign(params, sphere);
    gui.controllersRecursive().forEach((controller) => controller.updateDisplay());
    rebuildSphere();
  },
});

const resize = () => {
  const width = viewport.clientWidth;
  const height = viewport.clientHeight;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height);
};

window.addEventListener('resize', resize);

const animate = () => {
  requestAnimationFrame(animate);

  if (params.spin) {
    sphereGroup.rotation.y += 0.001;
  }

  controls.update();
  renderer.render(scene, camera);
};

rebuildSphere();
updateMaterial();
updateEdgeMaterial();
resize();
updateModeVisibility();
animate();
