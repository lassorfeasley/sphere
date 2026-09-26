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
  MOUSE,
  PerspectiveCamera,
  PMREMGenerator,
  Quaternion,
  Raycaster,
  Scene,
  Sphere,
  TOUCH,
  Uint32BufferAttribute,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { SURFACES, getSurface } from './surfaces.js';
import { TemplateEditor } from './templateEditor.js';
import { buildPatternGeometry } from './patternMapper.js';
import {
  buildProjectedEdgeGeometry,
  buildProjectedFaceGeometry,
  collectProjectedSegments,
  segmentsAlong,
} from './projection.js';
import { buildTubeGroup, disposeTubeGroup, jointMaterial } from './tubes.js';
import { DEFAULT_FINISH, DEFAULT_POLISH, FINISHES, applyFinish, isMetal, polishName } from './finishes.js';
import { SolidWorker, isCancelled } from './solidClient.js';
import { countPieces } from './connectivity.js';
import { buildWovenSegments, measureClearance } from './weave.js';
import { HangSimulation } from './hangSim.js';
import { downloadBinaryStl } from './stl.js';
import {
  DEFAULT_PRINT,
  crossingBlendMm,
  describeLoop,
  effectiveBlendMm,
  gapMode,
  migratePrint,
  pressSwell,
  sceneScale,
  strutProfile,
  strutWidthMm,
  surfaceInset,
  weaveOptions,
} from './printSettings.js';
import { ControlGroup } from './ui/controls.js';
import { createProfilePreview } from './ui/profilePreview.js';
import { icon } from './ui/icons.js';
import { DEFAULT_SURFACE_COLOR, Gallery, PATTERN_COLOR } from './gallery.js';

const SETTINGS_KEY = 'sphere-settings-v1';
// The surface is modeled at this size in scene units; Diameter sets print size.
const RADIUS = 1;
const EDGE_THRESHOLD_DEG = 18;
const HELP_TEXT = 'Drag to orbit · Right-drag to pan · Scroll to zoom';
const PAN_HELP_TEXT = 'Pan mode: drag to pan · Right-drag to orbit · Scroll to zoom';
let panMode = false;
const helpText = () => (panMode ? PAN_HELP_TEXT : HELP_TEXT);

const viewport = document.querySelector('#viewport');
const statusEl = document.querySelector('#status');

/** Show a message in the viewport status pill; tone is 'info', 'busy', 'ok', or 'warn'. */
const setStatus = (message, tone = 'info') => {
  statusEl.textContent = message;
  statusEl.dataset.tone = tone;
};
setStatus(helpText());

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

// Reflections for the strut finishes only; the guide surface keeps plain lighting.
const pmrem = new PMREMGenerator(renderer);
const studioEnvironment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
pmrem.dispose();

const params = {
  surface: 'geodesic',
  color: DEFAULT_SURFACE_COLOR,
  surfaceOpacity: 1,
  displayMode: 'sphere',
  projectionSamples: 12,
  spin: true,
  showSphere: true,
  colorPieces: true,
  finish: DEFAULT_FINISH,
  polish: DEFAULT_POLISH,
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
  if (!FINISHES[params.finish]) {
    params.finish = DEFAULT_FINISH;
  }
  // A solid is never saved, so always start in the Sphere view.
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
pieceMaterial.vertexColors = true;

const highlightMaterial = new MeshStandardMaterial({
  color: '#ff9f5a',
  emissive: '#ff7a2e',
  emissiveIntensity: 0.35,
  metalness: 0.1,
  roughness: 0.45,
});

const SOLID_PLASTIC_COLOR = '#e8e8e2';
const solidMaterial = new MeshStandardMaterial({ flatShading: false });

let sphereMesh;
let edgeLines;
let patternLines;
let projectedLines;
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
  // Hang from the loop: turn the ornament so the loop points up the screen.
  if (result.loop) {
    const loopUp = new Vector3().fromArray(result.loop.top).normalize();
    const screenUp = new Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    sphereGroup.quaternion.setFromUnitVectors(loopUp, screenUp);
  }
  // A spinning turntable would keep shifting gravity; pause it while hanging.
  hang.spinWas = params.spin;
  params.spin = false;
  panel.refresh();
  hang.sim = sim;
  hang.running = true;
  hang.groups = sim.bodies.map((body) => {
    const segments = new Float32Array(body.segments.length * 6);
    const ups = new Float32Array(body.segments.length * 3);
    body.segments.forEach(([a, b], i) => {
      body.points[a].toArray(segments, i * 6);
      body.points[b].toArray(segments, i * 6 + 3);
      ups.set(result.ups.subarray(body.sources[i] * 3, body.sources[i] * 3 + 3), i * 3);
    });
    const color = pieceColor(body.id);
    const group = buildTubeGroup(segments, profile, pieceMaterial, Array.from({ length: body.segments.length }, () => color), ups);
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
    setStatus(helpText());
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

/** Apply the finish to every strut material, including the tubes' joint clones. */
const updateFinish = () => {
  const finish = { finish: params.finish, polish: params.polish, envMap: studioEnvironment };
  [
    [tubeMaterial, PATTERN_COLOR],
    [pieceMaterial, '#ffffff'],
    [solidMaterial, SOLID_PLASTIC_COLOR],
  ].forEach(([m, plasticColor]) => applyFinish(m, { ...finish, plasticColor }));
  [tubeMaterial, pieceMaterial].forEach((m) => {
    const joint = jointMaterial(m);
    applyFinish(joint, finish);
    joint.color.copy(m.color);
  });
  polishControl?.setHint(
    `${polishName(params.polish)}.${isMetal(params.finish) && params.colorPieces ? ' Separate pieces tint the metal; turn off Color separate pieces to see it plain.' : ''}`,
  );
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
    projectedLines.visible = mode === 'sphere' && !hang.groups;
  }
  if (highlightMesh) {
    highlightMesh.visible = mode === 'sphere' && !hang.groups;
  }
  if (strandFocus.mesh) {
    strandFocus.mesh.visible = mode === 'sphere' && !hang.groups;
  }
  if (solidMesh) {
    solidMesh.visible = mode === 'solid';
  }
};

// Any change to the pattern or sphere invalidates a previously generated
// solid; drop it so the Solid view and STL can't go stale.
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

  displayedSegments = null;
  displayedPieces = null;
  displayedResult = null;
  if (sphereMesh && patternState.connections.length) {
    const result = patternSegments();
    const segments = result?.segments;
    displayedSegments = segments ?? null;
    displayedPieces = result?.pieces ?? null;
    displayedResult = result;
    jointFilletControl?.setHint(
      result?.junctions?.length
        ? JOINT_FILLET_HINT
        : `${JOINT_FILLET_HINT} This pattern has none: its lines only cross${printParams.weave ? '.' : ', so use Crossing fillet.'}`,
    );
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
        ? buildTubeGroup(segments, profile, pieceMaterial, Array.from(result.pieceIds, pieceColor), result.ups)
        : buildTubeGroup(segments, profile, tubeMaterial, null, result.ups);
      sphereGroup.add(projectedLines);
    }
  } else {
    templateEditor?.setLineColors(null);
    templateEditor?.setClearance(null);
  }
  updateLoopNote();
  updateStrandHighlight({ force: true });
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
    strandIds: result.strandIds,
    ups: result.ups,
    blendRadius: effectiveBlendMm(printParams),
    crossingBlendRadius: crossingBlendMm(printParams),
    pressSwell: pressSwell(printParams),
    junctions: Float32Array.from(result.junctions, (v) => (v * sphereRadius) / RADIUS),
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
    setStatus(helpText());
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

const PANEL_STORAGE_KEY = 'sphere-ui-collapsed-panels';
const readCollapsedPanels = () => {
  try {
    return JSON.parse(localStorage.getItem(PANEL_STORAGE_KEY)) ?? {};
  } catch {
    return {};
  }
};

// Collapses one side panel; `collapsed` defaults to flipping the current state.
const setPanelCollapsed = (side, collapsed = !document.body.classList.contains(`${side}-collapsed`)) => {
  document.body.classList.toggle(`${side}-collapsed`, collapsed);
  const { button, name } = panelToggles[side];
  button.classList.toggle('active', collapsed);
  button.title = `${collapsed ? 'Show' : 'Hide'} ${name}`;
  try {
    localStorage.setItem(PANEL_STORAGE_KEY, JSON.stringify({ ...readCollapsedPanels(), [side]: collapsed }));
  } catch {
    // Remembering collapsed panels is best-effort.
  }
};

// Pan mode swaps the primary drag from orbiting to panning; orbit moves to right-drag.
const togglePanMode = () => {
  panMode = !panMode;
  controls.mouseButtons = panMode
    ? { LEFT: MOUSE.PAN, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.ROTATE }
    : { LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.PAN };
  controls.touches = panMode
    ? { ONE: TOUCH.PAN, TWO: TOUCH.DOLLY_ROTATE }
    : { ONE: TOUCH.ROTATE, TWO: TOUCH.DOLLY_PAN };
  panButton.classList.toggle('active', panMode);
  renderer.domElement.classList.toggle('pan-mode', panMode);
  setStatus(helpText());
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
  onChange: () => {
    rebuildPatternOverlay();
    profilePreview.refresh();
  },
});

const updateProfileControls = () => {
  runControl.show(printParams.weave);
  touchControl.show(printParams.weave);
  tensionControl.show(printParams.weave && printParams.strandsTouch);
  crossingFilletControl.show(!printParams.weave);
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

const JOINT_FILLET_HINT = 'Blends lines where three or more meet and end.';

const onFilletChange = () => invalidateSolid();

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
const profilePreview = strutSection.add(createProfilePreview(() => printParams));
strutSection.slider(printParams, 'widthMm', {
  limits: [0.2, 40],
  label: 'Width',
  min: 0.5,
  max: 8,
  step: 0.1,
  unit: 'mm',
  hint: 'Across the surface.',
  onChange: onProfileChange,
});
strutSection.slider(printParams, 'heightMm', {
  limits: [0.2, 40],
  label: 'Height',
  min: 0.5,
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
const jointFilletControl = strutSection.slider(printParams, 'jointSmoothing', {
  limits: [0, 10],
  label: 'Joint fillet',
  min: 0,
  max: 3,
  step: 0.05,
  hint: JOINT_FILLET_HINT,
  onChange: onFilletChange,
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
  hint: 'How taut the strands pull, like stretched elastic. Higher runs them straighter between crossings and wraps them tighter over each other, pressing harder into each other where they cross.',
  onChange: rebuildPatternOverlay,
});
const crossingFilletControl = weaveSection.slider(printParams, 'crossingSmoothing', {
  limits: [0, 10],
  label: 'Crossing fillet',
  min: 0,
  max: 3,
  step: 0.05,
  hint: 'Blends lines where they cross and merge, as Joint fillet does where they meet. Woven crossings pass over and under instead.',
  onChange: onFilletChange,
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
  hint: 'Grows a loop for a ribbon or hook out of one line of the pattern.',
  onChange: () => {
    updateLoopControls();
    if (!printParams.loop) {
      setLoopPicking(false);
    }
    rebuildPatternOverlay();
  },
});
const loopContainer = document.createElement('div');
loopContainer.className = 'control-stack';
hangSection.el.append(loopContainer);
const loopGroup = hangSection.group(loopContainer);

// Quick shapes set the steepness; a ring also needs some height to open up.
// A curl is its own shape: its steepness is the angle its legs climb at.
const LOOP_SHAPES = { bump: 45, arch: 90, ring: 150 };
const CURL_ANGLE = 40;
const RING_MIN_HEIGHT_MM = 12;
const loopShape = {
  get preset() {
    if (printParams.loopCurl) {
      return 'curl';
    }
    return Object.keys(LOOP_SHAPES).find((key) => Math.abs(LOOP_SHAPES[key] - printParams.loopAngle) < 0.5) ?? 'custom';
  },
  set preset(value) {
    printParams.loopCurl = value === 'curl';
    printParams.loopAngle = printParams.loopCurl ? CURL_ANGLE : LOOP_SHAPES[value];
    if (value === 'ring' || value === 'curl') {
      printParams.loopHeightMm = Math.max(printParams.loopHeightMm, RING_MIN_HEIGHT_MM);
    }
  },
};
const updateSteepnessHint = () => {
  loopRoundingControl.show(printParams.loopCurl);
  loopSteepnessControl.setHint(
    printParams.loopCurl
      ? 'The angle the curl climbs at before its legs cross (20° to 60°). Lower is longer and flatter; the round loop takes the rest of the height.'
      : 'The angle the loop leaves the line at. Lower is longer and gentler; past 90° the sides lean out and the line curls into a ring.',
  );
};
loopGroup.segmented(loopShape, 'preset', {
  label: 'Shape',
  options: [
    { value: 'bump', label: 'Bump', title: 'A long, gentle rise out of the line' },
    { value: 'arch', label: 'Arch', title: 'Steep sides, a ribbon passes under it' },
    { value: 'ring', label: 'Ring', title: 'The line curls into a closed ring' },
    { value: 'curl', label: 'Curl', title: 'The line crosses over itself into a round loop' },
  ],
  onChange: () => {
    updateSteepnessHint();
    onProfileChange();
  },
});
loopGroup.slider(printParams, 'loopHeightMm', {
  limits: [1, 100],
  label: 'Height',
  min: 3,
  max: 30,
  step: 0.5,
  unit: 'mm',
  hint: 'How far the loop rises above the line it grows from.',
  onChange: onProfileChange,
});
const loopSteepnessControl = loopGroup.slider(printParams, 'loopAngle', {
  limits: [10, 175],
  label: 'Steepness',
  min: 20,
  max: 170,
  step: 1,
  unit: '°',
  onChange: onProfileChange,
});
const loopRoundingControl = loopGroup.slider(printParams, 'loopRoundingMm', {
  limits: [0, 50],
  label: 'Rounding',
  min: 0,
  max: 15,
  step: 0.5,
  unit: 'mm',
  hint: 'How gradually the curl eases into each bend, where it leaves the line and where its legs meet the circle. 0 keeps plain arcs, which meet with a visible crease on flat struts.',
  onChange: onProfileChange,
});
updateSteepnessHint();
const placeRow = loopGroup.inline();
const placeLoopButton = placeRow.button({
  label: 'Pick a line',
  icon: 'target',
  title: 'Click a line on the sphere to put the loop on it, then slide it along with Position',
  onClick: () => setLoopPicking(!loopPick.active),
});
placeRow.button({
  label: 'Top',
  icon: 'reset',
  title: 'Put the loop back at the top',
  onClick: () => {
    setLoopPicking(false);
    placeLoop({ anchor: [0, 1, 0], strand: -1 });
  },
});

const roundAnchor = (v) => Array.from(v, (x) => Number(x.toFixed(4)));

// The slider reads where the loop landed until it is first dragged; from
// then on it holds the loop to that fraction of its line.
const loopPosition = {
  get percent() {
    const along = printParams.loopAlong >= 0 ? printParams.loopAlong : displayedResult?.loop?.along ?? 0;
    return Number((along * 100).toFixed(1));
  },
  set percent(value) {
    const loop = displayedResult?.loop;
    if (loop) {
      printParams.loopAnchor = roundAnchor(loop.foot);
      printParams.loopStrand = loop.strandId;
    }
    printParams.loopAlong = value / 100;
  },
};
const loopPositionControl = loopGroup.slider(loopPosition, 'percent', {
  label: 'Position',
  min: 0,
  max: 100,
  step: 0.1,
  unit: '%',
  onChange: rebuildPatternOverlay,
});
loopPositionControl.el.addEventListener('pointerenter', () => setStrandFocus('slider', true));
loopPositionControl.el.addEventListener('pointerleave', () => setStrandFocus('slider', false));
loopPositionControl.el.addEventListener('focusin', () => setStrandFocus('sliderFocus', true));
loopPositionControl.el.addEventListener('focusout', () => setStrandFocus('sliderFocus', false));
const loopNote = loopGroup.note();

const updateLoopControls = () => loopGroup.show(printParams.loop);

const updateLoopNote = () => {
  const show = printParams.loop && displayedResult?.segments;
  const loop = displayedResult?.loop;
  loopNote.set(
    show ? describeLoop(printParams, loop, sceneScale(printParams, RADIUS)) : '',
    show && (!loop || loop.adjusted || loop.moved) ? 'warn' : undefined,
  );
  loopPositionControl.show(Boolean(show && loop));
  if (show && loop) {
    const toPercent = (f) => f * 100;
    const scale = sceneScale(printParams, RADIUS);
    loopPositionControl.setMarks(
      loop.marks.map(({ value, major }) => ({ value: toPercent(value), major })),
      loop.free.map((band) => band.map(toPercent)),
    );
    loopPositionControl.setHint(
      `Along a ${(loop.strandLength / scale).toFixed(0)} mm ${loop.closed ? 'closed ' : ''}line. ` +
        'Ticks mark crossings and the points halfway between them; the shaded stretches have room for the loop.',
    );
    loopPositionControl.refresh();
  }
};

const placeLoop = ({ anchor, strand, along = -1 }) => {
  printParams.loopAnchor = anchor;
  printParams.loopStrand = strand;
  printParams.loopAlong = along;
  saveSettings();
  rebuildPatternOverlay();
};

// The line the loop sits on (or would, while picking) is drawn highlighted
// while the pointer is over the Position slider or hovering while picking.
const strandFocus = { slider: false, sliderFocus: false, hovered: -1, mesh: null, shown: null };

const setStrandFocus = (key, value) => {
  strandFocus[key] = value;
  updateStrandHighlight();
};

const updateStrandHighlight = ({ force = false } = {}) => {
  const result = displayedResult;
  let strandId = -1;
  if (loopPick.active) {
    strandId = strandFocus.hovered;
  } else if ((strandFocus.slider || strandFocus.sliderFocus) && result?.loop) {
    strandId = result.loop.strandId;
  }
  const key = strandId >= 0 && result ? `${strandId}` : null;
  if (!force && key === strandFocus.shown) {
    return;
  }
  if (strandFocus.mesh) {
    sphereGroup.remove(strandFocus.mesh);
    disposeTubeGroup(strandFocus.mesh);
    strandFocus.mesh = null;
  }
  strandFocus.shown = key;
  if (key === null) {
    return;
  }
  const { segments, strandIds, ups } = result;
  const picked = [];
  const pickedUps = [];
  for (let i = 0; i < strandIds.length; i += 1) {
    if (strandIds[i] === strandId) {
      for (let k = 0; k < 6; k += 1) {
        picked.push(segments[i * 6 + k]);
      }
      pickedUps.push(ups[i * 3], ups[i * 3 + 1], ups[i * 3 + 2]);
    }
  }
  const profile = strutProfile(printParams, sceneScale(printParams, RADIUS));
  const enlarged = {
    halfWidth: profile.halfWidth * 1.15,
    halfHeight: profile.halfHeight * 1.15,
    corner: profile.corner * 1.15,
  };
  strandFocus.mesh = buildTubeGroup(new Float32Array(picked), enlarged, highlightMaterial, null, pickedUps);
  sphereGroup.add(strandFocus.mesh);
  updateModeVisibility();
};

// Picking a line: while picking, the line of the main piece nearest the
// pointer lights up, and a click (not a drag, which still orbits) puts the
// loop on it at the nearest point.
const loopPick = { active: false, down: null, move: null };
const raycaster = new Raycaster();
const pickTarget = new Sphere(new Vector3(), RADIUS);

const setLoopPicking = (active) => {
  if (loopPick.active === active) {
    return;
  }
  loopPick.active = active;
  strandFocus.hovered = -1;
  renderer.domElement.classList.toggle('picking', active);
  placeLoopButton.setLabel(active ? 'Cancel' : 'Pick a line', active ? 'close' : 'target');
  setStatus(active ? 'Click the line the loop should sit on · Esc to cancel' : helpText());
  updateStrandHighlight();
};

/** The point on the sphere under the pointer, in the ornament's own frame, or null. */
const sphereHit = (event) => {
  const rect = renderer.domElement.getBoundingClientRect();
  const pointer = new Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  );
  raycaster.setFromCamera(pointer, camera);
  const ray = raycaster.ray.clone().applyMatrix4(sphereGroup.matrixWorld.clone().invert());
  return ray.intersectSphere(pickTarget, new Vector3());
};

/** The strand of the main piece passing nearest `point`, with its closest point. */
const nearestLoopStrand = (point) => {
  const result = displayedResult;
  if (!result?.segments) {
    return null;
  }
  const { segments, strandIds, pieceIds } = result;
  const a = new Vector3();
  const b = new Vector3();
  const closest = new Vector3();
  let best = null;
  for (let i = 0; i < strandIds.length; i += 1) {
    if (pieceIds[i] !== 0) {
      continue;
    }
    a.fromArray(segments, i * 6);
    b.fromArray(segments, i * 6 + 3);
    b.sub(a);
    const lengthSq = b.lengthSq();
    const t = lengthSq > 0 ? Math.min(1, Math.max(0, closest.subVectors(point, a).dot(b) / lengthSq)) : 0;
    closest.copy(a).addScaledVector(b, t);
    const distance = closest.distanceTo(point);
    if (!best || distance < best.distance) {
      best = { strandId: strandIds[i], point: closest.clone(), distance };
    }
  }
  return best;
};

renderer.domElement.addEventListener('pointerdown', (event) => {
  loopPick.down = loopPick.active && event.button === 0 ? { x: event.clientX, y: event.clientY } : null;
});
renderer.domElement.addEventListener('pointermove', (event) => {
  if (!loopPick.active || event.buttons) {
    return;
  }
  const queued = loopPick.move;
  loopPick.move = event;
  if (queued) {
    return;
  }
  requestAnimationFrame(() => {
    const latest = loopPick.move;
    loopPick.move = null;
    if (!loopPick.active) {
      return;
    }
    const hit = sphereHit(latest);
    strandFocus.hovered = hit ? nearestLoopStrand(hit)?.strandId ?? -1 : -1;
    updateStrandHighlight();
  });
});
renderer.domElement.addEventListener('pointerleave', () => {
  if (loopPick.active) {
    setStrandFocus('hovered', -1);
  }
});
renderer.domElement.addEventListener('pointerup', (event) => {
  const { down } = loopPick;
  loopPick.down = null;
  if (!down || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5) {
    return;
  }
  const hit = sphereHit(event);
  const picked = hit && nearestLoopStrand(hit);
  if (!picked) {
    setStatus('That missed the sphere. Click on a line, or press Esc to cancel.', 'warn');
    return;
  }
  setLoopPicking(false);
  placeLoop({ anchor: roundAnchor(picked.point.normalize().toArray()), strand: picked.strandId });
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
  onChange: () => {
    rebuildPatternOverlay();
    updateFinish();
  },
});
viewSection.select(params, 'finish', {
  label: 'Strut finish',
  options: Object.entries(FINISHES).map(([value, { label }]) => ({ value, label })),
  onChange: updateFinish,
});
const polishControl = viewSection.slider(params, 'polish', {
  label: 'Polish',
  min: 0,
  max: 1,
  step: 0.05,
  onChange: updateFinish,
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
  onChange: invalidateSolid,
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
const leftPanelButton = toolbarButton('panel-left', '', () => setPanelCollapsed('left'));
toolbarLeft.prepend(leftPanelButton);
const panButton = toolbarButton('pan', 'Pan mode (P)', togglePanMode);
toolbarButton('reset', 'Reset view', resetView);
const focusButton = toolbarButton('focus', 'Hide panels (F)', toggleFocus);
toolbarButton('gallery', 'Gallery (G)', () => gallery.toggle(), 'Gallery');
const rightPanelButton = toolbarButton('panel-right', '', () => setPanelCollapsed('right'));

const panelToggles = {
  left: { button: leftPanelButton, name: 'settings ([)' },
  right: { button: rightPanelButton, name: 'pattern editor (])' },
};
const collapsedPanels = readCollapsedPanels();
setPanelCollapsed('left', Boolean(collapsedPanels.left));
setPanelCollapsed('right', Boolean(collapsedPanels.right));

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
  appearance: { color: params.color, finish: params.finish, polish: params.polish },
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
  if (FINISHES[design.appearance?.finish]) {
    params.finish = design.appearance.finish;
  }
  if (typeof design.appearance?.polish === 'number') {
    params.polish = design.appearance.polish;
  }
  assignKnown(printParams, migratePrint(design.print));
  batching = true;
  templateEditor.loadPattern(design.pattern);
  batching = false;
  showSurfaceControls();
  updateProfileControls();
  updateLoopControls();
  updateSteepnessHint();
  updateMaterial();
  updateFinish();
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
  if (event.key === 'Escape' && loopPick.active) {
    setLoopPicking(false);
  } else if (event.key === 'g') {
    gallery.toggle();
  } else if (event.key === 'f' && !gallery.isOpen) {
    toggleFocus();
  } else if (event.key === 'p' && !gallery.isOpen) {
    togglePanMode();
  } else if (event.key === '[' && !gallery.isOpen) {
    setPanelCollapsed('left');
  } else if (event.key === ']' && !gallery.isOpen) {
    setPanelCollapsed('right');
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
updateLoopControls();
rebuildSphere();
updateMaterial();
updateFinish();
resize();
updateModeVisibility();
animate();
