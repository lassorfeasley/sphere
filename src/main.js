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
import { SURFACES, getSurface } from './surfaces.js';
import { TemplateEditor } from './templateEditor.js';
import { buildPatternGeometry } from './patternMapper.js';
import {
  buildProjectedEdgeGeometry,
  buildProjectedFaceGeometry,
  collectProjectedSegments,
  segmentsAlong,
} from './projection.js';
import { buildTubeGroup, disposeTubeGroup } from './tubes.js';
import { SolidWorker, isCancelled } from './solidClient.js';
import { countPieces } from './connectivity.js';
import { buildWovenSegments, measureClearance } from './weave.js';
import { HangSimulation } from './hangSim.js';
import { downloadBinaryStl } from './stl.js';
import {
  DEFAULT_PRINT,
  effectiveBlendMm,
  gapMode,
  hangingLoop,
  migratePrint,
  needsRingLoop,
  sceneScale,
  strutProfile,
  strutThicknessMm,
  strutWidthMm,
  surfaceInset,
  weaveOptions,
} from './printSettings.js';
import { ControlGroup } from './ui/controls.js';
import { icon } from './ui/icons.js';
import { DEFAULT_SURFACE_COLOR, Gallery, PATTERN_COLOR } from './gallery.js';

const SETTINGS_KEY = 'sphere-settings-v1';
// The surface is modeled at this size in scene units; Diameter sets print size.
const RADIUS = 1;
const EDGE_THRESHOLD_DEG = 18;
const HELP_TEXT = 'Drag to orbit · Right-drag to pan · Scroll to zoom';
// Pause after the last edit before the filleted preview starts building.
const PREVIEW_DELAY_MS = 350;

const viewport = document.querySelector('#viewport');
const statusEl = document.querySelector('#status');

/** Show a message in the viewport status pill; tone is 'info', 'busy', 'ok', or 'warn'. */
const setStatus = (message, tone = 'info') => {
  statusEl.textContent = message;
  statusEl.dataset.tone = tone;
};
setStatus(HELP_TEXT);

const renderer = new WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(new Color('#07080b'), 0);
renderer.domElement.id = 'scene-canvas';
viewport.prepend(renderer.domElement);

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
  surface: 'geodesic',
  color: DEFAULT_SURFACE_COLOR,
  surfaceOpacity: 1,
  displayMode: 'sphere',
  projectionSamples: 12,
  spin: true,
  showSphere: true,
  colorPieces: true,
  smoothPreview: true,
};

// Each surface keeps its own settings, so switching surfaces and back
// restores them.
const surfaceSettings = Object.fromEntries(Object.entries(SURFACES).map(([id, s]) => [id, { ...s.defaults }]));
const currentSurfaceParams = () => surfaceSettings[params.surface];

const printParams = { ...DEFAULT_PRINT };

/** Copy values for keys `target` already has, when the types match. */
const assignKnown = (target, source) => {
  if (!source) {
    return;
  }
  Object.keys(target).forEach((key) => {
    if (typeof source[key] === typeof target[key]) {
      target[key] = source[key];
    }
  });
};

const restoreSettings = () => {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY));
    assignKnown(params, saved?.params);
    Object.keys(surfaceSettings).forEach((id) => assignKnown(surfaceSettings[id], saved?.surfaces?.[id]));
    assignKnown(printParams, migratePrint(saved?.print));
  } catch {
    // Ignore corrupt saved settings.
  }
  if (!SURFACES[params.surface]) {
    params.surface = 'geodesic';
  }
  // A solid is never saved, so always start in the preview.
  if (params.displayMode === 'solid') {
    params.displayMode = 'sphere';
  }
};

let saveTimer = 0;
const saveSettings = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(
        SETTINGS_KEY,
        JSON.stringify({ params, surfaces: surfaceSettings, print: printParams }),
      );
    } catch {
      // Persisting settings is best-effort.
    }
  }, 300);
};

restoreSettings();

/**
 * Pattern segments on the sphere in scene units, traced into strands with
 * rounded bends, and woven if enabled. Also returns the strand each segment
 * belongs to, which the solid uses to fillet joints between strands.
 */
const patternSegments = () =>
  buildWovenSegments(
    patternState.connections,
    sphereMesh.geometry,
    weaveOptions(printParams, { radius: RADIUS, samples: params.projectionSamples }),
  );

const material = new MeshStandardMaterial({
  color: params.color,
  metalness: 0.25,
  roughness: 0.35,
  flatShading: true,
  // Keeps pattern and edge lines lying on the surface from z-fighting it.
  polygonOffset: true,
  polygonOffsetFactor: 1,
  polygonOffsetUnits: 1,
});

const sphereSurfaceMaterial = material.clone();
sphereSurfaceMaterial.flatShading = false;

const edgesMaterial = new LineBasicMaterial({
  color: '#ffffff',
  transparent: true,
  opacity: 0.3,
  depthTest: true,
});

const patternState = {
  connections: [],
};

const patternMaterial = new LineBasicMaterial({
  color: PATTERN_COLOR,
  transparent: true,
  opacity: 0.95,
  depthTest: true,
  depthWrite: false,
});
const tubeMaterial = new MeshStandardMaterial({
  color: PATTERN_COLOR,
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
let displayedResult = null;

// Hanging simulation: the piece with the loop stays put and loose pieces
// settle under gravity. `groups` holds one mesh group per rigid body.
const hang = { sim: null, groups: null, running: false, spinWas: false };

const stopHang = () => {
  if (hang.groups) {
    hang.groups.forEach(({ group }) => {
      sphereGroup.remove(group);
      disposeTubeGroup(group);
    });
  }
  if (hang.sim) {
    params.spin = hang.spinWas;
    panel.refresh();
  }
  hang.sim = null;
  hang.groups = null;
  hang.running = false;
  hangButton?.setLabel('Simulate hanging', 'play');
  updateModeVisibility();
};

const startHang = () => {
  const result = displayedResult;
  if (!result?.segments || !sphereMesh) {
    setStatus('Draw a pattern first, then simulate hanging.', 'warn');
    return;
  }
  const scale = sceneScale(printParams, RADIUS);
  const profile = strutProfile(printParams, scale);
  const sim = new HangSimulation({
    segments: result.segments,
    pieceIds: result.pieceIds,
    strutRadius: Math.min(profile.halfWidth, profile.halfHeight),
    gravity: 9810 * scale,
    fallLimit: 2 * RADIUS,
  });
  if (!sim.loosePieceCount) {
    setStatus(
      result.pieces > 1
        ? 'Nothing hangs loose: the separate pieces overlap, so they fuse into one rigid piece when printed.'
        : 'Nothing hangs loose: the design is one rigid piece.',
      'ok',
    );
    return;
  }

  params.displayMode = 'sphere';
  // A spinning turntable would keep shifting gravity; pause it while hanging.
  hang.spinWas = params.spin;
  params.spin = false;
  panel.refresh();
  hang.sim = sim;
  hang.running = true;
  hang.groups = sim.bodies.map((body) => {
    const segments = new Float32Array(body.segments.length * 6);
    body.segments.forEach(([a, b], i) => {
      body.points[a].toArray(segments, i * 6);
      body.points[b].toArray(segments, i * 6 + 3);
    });
    const color = pieceColor(body.id);
    const group = buildTubeGroup(segments, profile, pieceMaterial, Array.from({ length: body.segments.length }, () => color));
    sphereGroup.add(group);
    return { body, group };
  });
  hangButton.setLabel('Stop simulation', 'stop');
  setStatus(`Hanging from the loop… ${sim.loosePieceCount} loose piece${sim.loosePieceCount > 1 ? 's' : ''} settling.`, 'busy');
  updateModeVisibility();
};

const toggleHang = () => {
  if (hang.groups) {
    stopHang();
    setStatus(HELP_TEXT);
  } else {
    startHang();
  }
};

const gravityProbe = new Vector3();
const groupRotation = new Quaternion();

const stepHang = () => {
  if (!hang.sim) {
    return;
  }
  // Gravity always points down the screen: take the camera's down direction
  // into the ornament's own frame, so orbiting the view turns the ornament.
  gravityProbe.set(0, -1, 0).applyQuaternion(camera.quaternion);
  gravityProbe.applyQuaternion(groupRotation.copy(sphereGroup.quaternion).invert());
  if (hang.sim.setGravityDirection(gravityProbe) && !hang.running) {
    hang.running = true;
    setStatus('Hanging from the loop… settling after the turn.', 'busy');
  }
  if (!hang.running) {
    return;
  }
  const done = hang.sim.step(3);
  const offset = new Vector3();
  hang.groups.forEach(({ body, group }) => {
    group.visible = !body.fallen;
    group.quaternion.copy(body.rotation);
    group.position.copy(body.center).sub(offset.copy(body.restCenter).applyQuaternion(body.rotation));
  });
  if (done) {
    hang.running = false;
    reportHang();
  }
};

const reportHang = () => {
  const scale = sceneScale(printParams, RADIUS);
  const loose = hang.sim.moving;
  const fallen = loose.filter((body) => body.fallen).length;
  const resting = loose.filter((body) => !body.fallen);
  const parts = [];
  if (resting.length) {
    const shifts = resting.map((body) => body.shift / scale);
    const max = Math.max(...shifts);
    const mean = shifts.reduce((sum, v) => sum + v, 0) / shifts.length;
    parts.push(
      `${resting.length} loose piece${resting.length > 1 ? 's' : ''} settle up to ${max.toFixed(1)} mm ` +
        `from their designed position (average ${mean.toFixed(1)} mm)`,
    );
  }
  if (fallen) {
    parts.push(`${fallen} piece${fallen > 1 ? 's' : ''} fall out — not caught by the weave`);
  }
  setStatus(`Hanging from the loop: ${parts.join('; ')}.`, fallen ? 'warn' : 'ok');
};
let selectedSpans = [];
let smoothSphere;
let smoothSphereEdges;
let solidMesh;

const solidState = {
  meshData: null,
  generating: false,
};
const solidWorker = new SolidWorker();

// The Sphere view first shows fast cylinders, then swaps in a coarse solid
// built in the background, which shows the joint fillets.
const preview = { mesh: null, timer: 0, version: 0 };
const previewWorker = new SolidWorker();

// While loading a whole design, pattern edits wait for the one rebuild at the end.
let batching = false;

const rebuildSphere = () => {
  const surface = getSurface(params.surface);
  const geometry = surface.createGeometry(currentSurfaceParams(), RADIUS);

  if (!sphereMesh) {
    sphereMesh = new Mesh(geometry, material);
    sphereGroup.add(sphereMesh);
  } else {
    sphereMesh.geometry.dispose();
    sphereMesh.geometry = geometry;
  }

  const newEdges = new EdgesGeometry(geometry, EDGE_THRESHOLD_DEG);
  if (!edgeLines) {
    edgeLines = new LineSegments(newEdges, edgesMaterial);
    sphereGroup.add(edgeLines);
  } else {
    edgeLines.geometry.dispose();
    edgeLines.geometry = newEdges;
  }

  const { faces } = surface.describe(currentSurfaceParams());
  surfaceSummary?.set(`${faces.toLocaleString()} faces, each carrying one copy of the pattern.`);
  rebuildSmoothSphere();
  rebuildPatternOverlay();
};

const rebuildSmoothSphere = () => {
  const subdivisions = Math.max(3, Math.ceil(24 / currentSurfaceParams().frequency));
  const faceGeometry = buildProjectedFaceGeometry(sphereMesh.geometry, { radius: RADIUS, subdivisions });
  const edgeGeometry = buildProjectedEdgeGeometry(sphereMesh.geometry, { radius: RADIUS, samples: subdivisions });

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
  [material, sphereSurfaceMaterial].forEach((m) => {
    m.color.set(params.color);
    m.opacity = params.surfaceOpacity;
    m.transparent = params.surfaceOpacity < 0.999;
    m.needsUpdate = true;
  });
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
  const smooth = Boolean(preview.mesh);
  if (projectedLines) {
    projectedLines.visible = mode === 'sphere' && !hang.groups && !smooth;
  }
  if (loopMesh) {
    loopMesh.visible = mode === 'sphere' && !smooth;
  }
  if (preview.mesh) {
    preview.mesh.visible = mode === 'sphere' && !hang.groups;
  }
  if (highlightMesh) {
    highlightMesh.visible = mode === 'sphere' && !hang.groups;
  }
  if (solidMesh) {
    solidMesh.visible = mode === 'solid';
  }
};

// Any change to the pattern or sphere invalidates a previously generated
// solid; drop it so the preview and STL can't go stale.
const invalidateSolid = () => {
  solidWorker.cancel();
  solidState.meshData = null;
  exportButton?.setDisabled(true);
  if (solidMesh) {
    sphereGroup.remove(solidMesh);
    solidMesh.geometry.dispose();
    solidMesh = null;
  }
  if (params.displayMode === 'solid') {
    params.displayMode = 'sphere';
    panel.refresh();
  }
};

const rebuildPatternOverlay = () => {
  stopHang();
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
  if (!gapMode(printParams) || !result?.segments) {
    templateEditor.setClearance(null);
    return;
  }
  const scale = sceneScale(printParams, RADIUS);
  const target = printParams.crossingGapMm;
  const closest = measureClearance(result.segments, result.strandIds, result.junctions, {
    strutRadius: (printParams.heightMm / 2) * scale,
    junctionRadius: (2 * printParams.heightMm + target) * scale,
    searchGap: target * 1.5 * scale,
  });
  // Stacks rise and dip symmetrically, so measure the dip; the hanging loop
  // only rises and would otherwise dominate.
  let deepest = 0;
  for (let i = 0; i < result.segments.length; i += 3) {
    const r = Math.hypot(result.segments[i], result.segments[i + 1], result.segments[i + 2]);
    deepest = Math.max(deepest, RADIUS - r);
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
  const edgeMm = (a.distanceTo(b) / RADIUS) * (printParams.diameterMm / 2);
  templateEditor.setLineWidth(strutWidthMm(printParams) / edgeMm);
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
  displayedResult = null;
  if (sphereMesh && patternState.connections.length) {
    const result = patternSegments();
    const segments = result?.segments;
    displayedSegments = segments ?? null;
    displayedPieces = result?.pieces ?? null;
    displayedResult = result;
    colorEditorLines(result);
    reportClearance(result);
    if (segments) {
      const scale = sceneScale(printParams, RADIUS);
      const profile = strutProfile(printParams, scale);
      const shrink = 1 - surfaceInset(segments, profile, RADIUS) / RADIUS;
      smoothSphere.scale.setScalar(shrink);
      smoothSphereEdges.scale.setScalar(shrink);
      const colored = params.colorPieces && result.pieces > 1;
      projectedLines = colored
        ? buildTubeGroup(segments, profile, pieceMaterial, Array.from(result.pieceIds, pieceColor))
        : buildTubeGroup(segments, profile, tubeMaterial);
      sphereGroup.add(projectedLines);
      if (needsRingLoop(printParams, result)) {
        const loop = hangingLoop(printParams, segments, RADIUS, scale);
        loopMesh = new Mesh(new TorusGeometry(loop.majorRadius, loop.minorRadius, 12, 40), tubeMaterial);
        loopMesh.position.fromArray(loop.center);
        loopMesh.quaternion.copy(
          new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), new Vector3().fromArray(loop.normal)),
        );
        sphereGroup.add(loopMesh);
      }
    }
  } else {
    templateEditor?.setLineColors(null);
    templateEditor?.setClearance(null);
  }

  schedulePreview();
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
      const profile = strutProfile(printParams, sceneScale(printParams, RADIUS));
      const enlarged = {
        halfWidth: profile.halfWidth * 1.12,
        halfHeight: profile.halfHeight * 1.12,
        corner: profile.corner * 1.12,
      };
      highlightMesh = buildTubeGroup(matched, enlarged, highlightMaterial);
      sphereGroup.add(highlightMesh);
    }
  }
  updateModeVisibility();
};

/** Arguments for `buildStrutSolid` from a strand result, in millimeters. */
const solidArgs = (result, edgeLength) => {
  const sphereRadius = printParams.diameterMm / 2;
  const segments = Float32Array.from(result.segments, (v) => (v * sphereRadius) / RADIUS);
  return {
    segments,
    sphereRadius,
    profile: strutProfile(printParams, 1),
    loop: needsRingLoop(printParams, result) ? hangingLoop(printParams, segments, sphereRadius, 1) : null,
    strandIds: result.strandIds,
    blendRadius: effectiveBlendMm(printParams),
    edgeLength,
  };
};

/** Scene geometry for a solid mesh in millimeters. */
const meshGeometry = (meshData) => {
  const scaleToScene = RADIUS / (printParams.diameterMm / 2);
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
  return geometry;
};

// Coarse enough to build in a fraction of a second, fine enough that round
// struts still look round.
const previewEdgeMm = () =>
  Math.max(printParams.detailMm, Math.min(strutThicknessMm(printParams) * 0.45, printParams.diameterMm / 40));

// Pieces colored separately keep the cylinders, which carry per-piece colors.
const previewWanted = () =>
  params.smoothPreview && displayedResult?.segments && !(params.colorPieces && displayedResult.pieces > 1);

const clearPreview = () => {
  if (preview.mesh) {
    sphereGroup.remove(preview.mesh);
    preview.mesh.geometry.dispose();
    preview.mesh = null;
  }
};

/**
 * Rebuild the filleted preview once edits pause. Geometry changes drop the
 * old preview at once so the cylinders show the new shape; with `keep`
 * (fillet-only changes) the old one stays up until the new one is ready.
 */
const schedulePreview = ({ keep = false } = {}) => {
  preview.version += 1;
  const version = preview.version;
  clearTimeout(preview.timer);
  previewWorker.cancel();
  previewBadge.hidden = true;
  if (!keep || !previewWanted()) {
    clearPreview();
    updateModeVisibility();
  }
  if (!previewWanted()) {
    return;
  }
  preview.timer = setTimeout(async () => {
    previewBadge.hidden = false;
    try {
      const meshData = await previewWorker.run(solidArgs(displayedResult, previewEdgeMm()));
      if (version !== preview.version) {
        return;
      }
      clearPreview();
      if (meshData.triangleCount) {
        preview.mesh = new Mesh(meshGeometry(meshData), tubeMaterial);
        sphereGroup.add(preview.mesh);
      }
      updateModeVisibility();
    } catch (error) {
      if (!isCancelled(error)) {
        console.error(error);
        setStatus('Smooth preview failed — showing cylinders. See the browser console.', 'warn');
      }
    } finally {
      if (version === preview.version) {
        previewBadge.hidden = true;
      }
    }
  }, PREVIEW_DELAY_MS);
};

const generateSolid = async () => {
  if (solidState.generating) {
    return;
  }
  if (!patternState.connections.length) {
    setStatus('Draw a pattern first — drag between two dots on the triangle.', 'warn');
    return;
  }
  if (!displayedResult?.segments) {
    setStatus('No printable segments found.', 'warn');
    return;
  }

  solidState.generating = true;
  generateButton.setBusy(true);
  generateButton.setLabel('Generating…', 'cube');
  setStatus('Generating solid… you can keep orbiting while it builds.', 'busy');

  try {
    const meshData = await solidWorker.run(solidArgs(displayedResult, printParams.detailMm));
    if (!meshData.triangleCount) {
      setStatus('Solid came out empty — try thicker struts or finer detail.', 'warn');
      return;
    }

    stopHang();
    solidState.meshData = meshData;
    if (solidMesh) {
      solidMesh.geometry.dispose();
      solidMesh.geometry = meshGeometry(meshData);
    } else {
      solidMesh = new Mesh(meshGeometry(meshData), solidMaterial);
      sphereGroup.add(solidMesh);
    }
    params.displayMode = 'solid';
    panel.refresh();
    updateModeVisibility();
    exportButton.setDisabled(false);
    setStatus(
      `Solid ready: ${meshData.triangleCount.toLocaleString()} triangles · ${printParams.diameterMm} mm. Export STL when you're happy.`,
      'ok',
    );
  } catch (error) {
    if (isCancelled(error)) {
      setStatus('Settings changed while generating, so the solid was discarded. Generate again when ready.', 'warn');
    } else {
      console.error(error);
      setStatus('Solid generation failed — see the browser console.', 'warn');
    }
  } finally {
    solidState.generating = false;
    generateButton.setBusy(false);
    generateButton.setLabel('Generate solid', 'cube');
  }
};

const exportStl = () => {
  if (!solidState.meshData) {
    setStatus('Generate a solid first, then export.', 'warn');
    return;
  }
  downloadBinaryStl(solidState.meshData, `sphere-${printParams.diameterMm}mm.stl`);
  setStatus('STL downloaded. Happy printing!', 'ok');
};

// Picking Solid before one exists generates it; the view switches when done.
const changeDisplayMode = (mode) => {
  if (mode === 'solid' && !solidState.meshData) {
    params.displayMode = 'sphere';
    panel.refresh();
    generateSolid();
    return;
  }
  if (mode !== 'sphere' && hang.groups) {
    stopHang();
    setStatus(HELP_TEXT);
  }
  updateModeVisibility();
};

const resetView = () => {
  camera.position.set(0, 0, 4);
  controls.target.set(0, 0, 0);
  sphereGroup.rotation.set(0, 0, 0);
  controls.update();
};

const toggleFocus = () => {
  const focused = document.body.classList.toggle('focus-mode');
  focusButton.classList.toggle('active', focused);
};

// ---------------------------------------------------------------------------
// Side panel

const panel = new ControlGroup(document.querySelector('#controls'));
panel.onAnyChange = saveSettings;

const surfaceSection = panel.section('Surface');
if (Object.keys(SURFACES).length > 1) {
  surfaceSection.select(params, 'surface', {
    label: 'Shape',
    options: Object.entries(SURFACES).map(([value, { label }]) => ({ value, label })),
    onChange: () => {
      showSurfaceControls();
      rebuildSphere();
    },
  });
}
const surfaceGroups = Object.fromEntries(
  Object.entries(SURFACES).map(([id, surface]) => {
    const container = document.createElement('div');
    container.className = 'control-stack';
    surfaceSection.el.append(container);
    const group = surfaceSection.group(container);
    surface.controls.forEach(({ type, key, ...spec }) => {
      group[type](surfaceSettings[id], key, { ...spec, onChange: rebuildSphere });
    });
    return [id, group];
  }),
);
const showSurfaceControls = () => {
  Object.entries(surfaceGroups).forEach(([id, group]) => group.show(id === params.surface));
};
showSurfaceControls();
const surfaceSummary = surfaceSection.note();
surfaceSection.slider(printParams, 'diameterMm', {
  limits: [5, 1000],
  label: 'Diameter',
  min: 20,
  max: 200,
  step: 1,
  unit: 'mm',
  onChange: rebuildPatternOverlay,
});

const updateProfileControls = () => {
  runControl.show(printParams.weave);
  touchControl.show(printParams.weave);
  tensionControl.show(printParams.weave && printParams.strandsTouch);
  gapControl.show(printParams.weave && !printParams.strandsTouch);
};

// Quick shapes set height and roundness from the current width; any other
// combination highlights none of them.
const strutShape = {
  get preset() {
    const { widthMm: w, heightMm: h, roundness } = printParams;
    if (roundness >= 0.999) {
      return Math.abs(w - h) < 1e-6 ? 'round' : h < w ? 'oval' : 'custom';
    }
    return roundness <= 0.2 ? 'band' : 'custom';
  },
  set preset(value) {
    const w = printParams.widthMm;
    const shapes = {
      round: { heightMm: w, roundness: 1 },
      oval: { heightMm: Number((w * 0.6).toFixed(2)), roundness: 1 },
      band: { heightMm: Number((w * 1.25).toFixed(2)), roundness: 0.15 },
    };
    Object.assign(printParams, shapes[value]);
  },
};

const onProfileChange = () => {
  panel.refresh();
  rebuildPatternOverlay();
};

const strutSection = panel.section('Struts');
strutSection.segmented(strutShape, 'preset', {
  label: 'Shape',
  options: [
    { value: 'round', label: 'Round', title: 'Circular cross-section' },
    { value: 'oval', label: 'Oval', title: 'Wider than tall, like cane or rattan' },
    { value: 'band', label: 'Band', title: 'Square-edged ribbon standing on its edge' },
  ],
  onChange: onProfileChange,
});
strutSection.slider(printParams, 'widthMm', {
  limits: [0.2, 40],
  label: 'Width',
  min: 1,
  max: 8,
  step: 0.1,
  unit: 'mm',
  hint: 'Across the surface.',
  onChange: onProfileChange,
});
strutSection.slider(printParams, 'heightMm', {
  limits: [0.2, 40],
  label: 'Height',
  min: 1,
  max: 8,
  step: 0.1,
  unit: 'mm',
  hint: 'Out from the surface. Also sets how far woven strands rise and dip.',
  onChange: onProfileChange,
});
strutSection.slider(printParams, 'roundness', {
  label: 'Roundness',
  min: 0,
  max: 1,
  step: 0.05,
  hint: '1 rounds the edges fully (circle, or pill when width and height differ); 0 keeps them square.',
  onChange: onProfileChange,
});
strutSection.slider(printParams, 'bendMm', {
  limits: [0, 100],
  label: 'Corner rounding',
  min: 0,
  max: 15,
  step: 0.5,
  unit: 'mm',
  hint: 'Radius of the curve where a line changes direction. 0 keeps sharp corners.',
  onChange: rebuildPatternOverlay,
});
strutSection.slider(printParams, 'jointSmoothing', {
  limits: [0, 10],
  label: 'Joint fillet',
  min: 0,
  max: 3,
  step: 0.05,
  hint: 'Blends strands where they meet or cross.',
  onChange: () => {
    invalidateSolid();
    schedulePreview({ keep: true });
  },
});

const weaveSection = panel.section('Weave');
weaveSection.toggle(printParams, 'weave', {
  label: 'Weave crossings',
  hint: 'Lines pass over and under each other instead of merging.',
  onChange: () => {
    updateProfileControls();
    rebuildPatternOverlay();
  },
});
const runControl = weaveSection.segmented(printParams, 'weaveRun', {
  label: 'Over / under run',
  options: [
    { value: 1, label: '1', title: 'Plain weave' },
    { value: 2, label: '2', title: 'Twill' },
    { value: 3, label: '3' },
    { value: 4, label: '4' },
  ],
  hint: '1 is a plain weave (over one, under one); 2 a twill.',
  onChange: rebuildPatternOverlay,
});
const touchControl = weaveSection.toggle(printParams, 'strandsTouch', {
  label: 'Strands touch',
  hint: 'Off keeps a minimum gap between crossing strands instead.',
  onChange: () => {
    updateProfileControls();
    rebuildPatternOverlay();
  },
});
const tensionControl = weaveSection.slider(printParams, 'tension', {
  label: 'Tension',
  min: 0,
  max: 1,
  step: 0.05,
  hint: 'How hard crossing strands press together.',
  onChange: rebuildPatternOverlay,
});
const gapControl = weaveSection.slider(printParams, 'crossingGapMm', {
  limits: [0, 40],
  label: 'Minimum gap',
  min: 0.2,
  max: 6,
  step: 0.1,
  unit: 'mm',
  onChange: rebuildPatternOverlay,
});

const hangSection = panel.section('Hanging');
hangSection.toggle(printParams, 'loop', {
  label: 'Hanging loop',
  hint: 'Lifts a stretch of line near the top into an arch a ribbon can pass under.',
  onChange: rebuildPatternOverlay,
});
const hangButton = hangSection.button({
  label: 'Simulate hanging',
  icon: 'play',
  title: 'Hang from the loop and let loose pieces settle under gravity',
  onClick: toggleHang,
});

const viewSection = panel.section('Appearance');
viewSection.toggle(params, 'showSphere', { label: 'Show surface', onChange: updateModeVisibility });
viewSection.toggle(params, 'colorPieces', {
  label: 'Color separate pieces',
  hint: 'Pieces that print separately each get their own color.',
  onChange: rebuildPatternOverlay,
});
viewSection.toggle(params, 'smoothPreview', {
  label: 'Smooth preview',
  hint: 'After edits pause, shows the printed shape with fillets instead of plain cylinders.',
  onChange: () => schedulePreview(),
});
viewSection.toggle(params, 'spin', { label: 'Turntable spin' });
viewSection.swatches(params, 'color', {
  label: 'Surface color',
  colors: [DEFAULT_SURFACE_COLOR, '#2a2f3a', '#e8e4da', '#ff9fb2', '#9be8a8', '#b39dff'],
  onChange: updateMaterial,
});
viewSection.slider(params, 'surfaceOpacity', {
  label: 'Surface opacity',
  min: 0.2,
  max: 1,
  step: 0.05,
  onChange: updateMaterial,
});

const qualitySection = panel.section('Quality', { open: false });
qualitySection.slider(params, 'projectionSamples', {
  limits: [2, 128],
  integer: true,
  label: 'Preview samples',
  min: 4,
  max: 32,
  step: 1,
  hint: 'Points per pattern line when bending it onto the surface. Also used by the solid.',
  onChange: rebuildPatternOverlay,
});
qualitySection.slider(printParams, 'detailMm', {
  limits: [0.1, 10],
  label: 'Solid detail',
  min: 0.3,
  max: 3,
  step: 0.1,
  unit: 'mm',
  hint: 'Triangle size of the exported mesh. Lower is smoother but slower and larger.',
  onChange: () => {
    invalidateSolid();
    schedulePreview({ keep: true });
  },
});

const exportBar = panel.group(document.querySelector('#export-bar')).inline();
const generateButton = exportBar.button({
  label: 'Generate solid',
  icon: 'cube',
  variant: 'primary',
  title: 'Build the watertight printable mesh',
  onClick: generateSolid,
});
const exportButton = exportBar.button({
  label: 'Export STL',
  icon: 'download',
  onClick: exportStl,
});
exportButton.setDisabled(true);

// ---------------------------------------------------------------------------
// Viewport toolbar

const toolbar = document.querySelector('#viewport-toolbar');
const toolbarLeft = document.createElement('div');
const toolbarRight = document.createElement('div');
toolbarLeft.className = 'toolbar-group';
toolbarRight.className = 'toolbar-group';
toolbar.append(toolbarLeft, toolbarRight);
panel.group(toolbarLeft).segmented(params, 'displayMode', {
  className: 'segmented-floating',
  options: [
    { value: 'dome', label: 'Faceted', title: 'Flat faces with the pattern drawn on them' },
    { value: 'sphere', label: 'Sphere', title: 'Struts projected onto the sphere' },
    { value: 'solid', label: 'Solid', title: 'The printable mesh (generated on demand)' },
  ],
  onChange: changeDisplayMode,
});
const previewBadge = document.createElement('div');
previewBadge.className = 'preview-badge';
previewBadge.hidden = true;
previewBadge.textContent = 'Smoothing…';
previewBadge.title = 'Building the filleted preview';
toolbarLeft.append(previewBadge);

const toolbarButton = (iconName, title, onClick, label) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = label ? 'toolbar-btn' : 'toolbar-btn icon-only';
  button.title = title;
  button.innerHTML = `${icon(iconName)}${label ? `<span>${label}</span>` : ''}`;
  button.addEventListener('click', onClick);
  toolbarRight.append(button);
  return button;
};
toolbarButton('reset', 'Reset view', resetView);
const focusButton = toolbarButton('focus', 'Hide panels (F)', toggleFocus);
toolbarButton('gallery', 'Gallery (G)', () => gallery.toggle(), 'Gallery');

// ---------------------------------------------------------------------------
// Pattern editor and gallery

templateEditor = new TemplateEditor(document.querySelector('#template-root'), {
  onChange: ({ connections }) => {
    patternState.connections = connections;
    if (!batching) {
      rebuildPatternOverlay();
    }
  },
  onSelect: (spans) => {
    selectedSpans = spans;
    updateHighlight();
  },
});

const currentDesign = () => ({
  pattern: templateEditor.getPattern(),
  surface: { type: params.surface, ...currentSurfaceParams() },
  appearance: { color: params.color },
  print: { ...printParams },
});

/** Load a gallery design. Starters carry no print settings or color, so those stay. */
const applyDesign = (design) => {
  const surface = design.surface ?? {};
  if (SURFACES[surface.type]) {
    params.surface = surface.type;
    assignKnown(surfaceSettings[surface.type], surface);
  }
  if (design.appearance?.color) {
    params.color = design.appearance.color;
  }
  assignKnown(printParams, migratePrint(design.print));
  batching = true;
  templateEditor.loadPattern(design.pattern);
  batching = false;
  showSurfaceControls();
  updateProfileControls();
  updateMaterial();
  panel.refresh();
  rebuildSphere();
  saveSettings();
  setStatus(`Loaded “${design.name}”. Undo in the pattern panel restores the previous pattern.`, 'ok');
};

const gallery = new Gallery(document.querySelector('#gallery'), {
  getDesign: currentDesign,
  applyDesign,
  onOpenChange: (open) => {
    templateEditor.keyboardEnabled = !open;
  },
});

window.addEventListener('keydown', (event) => {
  const target = event.target;
  if (
    event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable
  ) {
    return;
  }
  if (event.key === 'g') {
    gallery.toggle();
  } else if (event.key === 'f' && !gallery.isOpen) {
    toggleFocus();
  }
});

const resize = () => {
  const width = viewport.clientWidth;
  const height = viewport.clientHeight;
  if (!width || !height) {
    return;
  }
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height, false);
};

new ResizeObserver(resize).observe(viewport);

const animate = () => {
  requestAnimationFrame(animate);

  if (params.spin) {
    sphereGroup.rotation.y += 0.001;
  }

  stepHang();
  controls.update();
  renderer.render(scene, camera);
};

updateProfileControls();
rebuildSphere();
updateMaterial();
resize();
updateModeVisibility();
animate();
