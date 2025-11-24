import './style.css';
import {
  AmbientLight,
  Color,
  DirectionalLight,
  EdgesGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  SphereGeometry,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GUI } from 'lil-gui';
import { createGeodesicSphere, getBaseTypes } from './geodesic.js';
import { TemplateEditor } from './templateEditor.js';
import { buildPatternGeometry } from './patternMapper.js';
import { buildProjectedPatternGeometry } from './projection.js';

const container = document.querySelector('#app');
const viewport = document.querySelector('#viewport');
const templateRoot = document.querySelector('#template-root');

const overlay = document.createElement('div');
overlay.className = 'overlay';
overlay.innerHTML = 'Geodesic Sphere Explorer<br/>Drag to orbit · Scroll to zoom';
viewport.appendChild(overlay);

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
  frequency: 3,
  radius: 1,
  color: '#8ae5ff',
  wireframe: false,
  flat: true,
  edgeColor: '#ffffff',
  edgeOpacity: 0.45,
  edgeThreshold: 18,
  surfaceOpacity: 0.55,
  displayMode: 'sphere',
  projectionSamples: 12,
};

const material = new MeshStandardMaterial({
  color: params.color,
  metalness: 0.25,
  roughness: 0.35,
  wireframe: params.wireframe,
  flatShading: params.flat,
  transparent: true,
  opacity: params.surfaceOpacity,
});

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
const spherePatternMaterial = patternMaterial.clone();

let sphereMesh;
let edgeLines;
let patternLines;
let projectedLines;
let smoothSphere;

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
  const geometryDetail = Math.max(24, params.frequency * 12);
  const sphereGeometry = new SphereGeometry(params.radius, geometryDetail, geometryDetail);

  if (!smoothSphere) {
    smoothSphere = new Mesh(sphereGeometry, material);
    sphereGroup.add(smoothSphere);
  } else {
    smoothSphere.geometry.dispose();
    smoothSphere.geometry = sphereGeometry;
  }
};

const updateMaterial = () => {
  material.color.set(params.color);
  material.wireframe = params.wireframe;
  material.flatShading = params.flat;
  material.opacity = params.surfaceOpacity;
  const shouldBeTransparent = params.surfaceOpacity < 0.999;
  material.transparent = shouldBeTransparent;
  material.depthWrite = true;
  material.needsUpdate = true;
};

const updateEdgeMaterial = () => {
  edgesMaterial.color.set(params.edgeColor);
  edgesMaterial.opacity = params.edgeOpacity;
};

const updateModeVisibility = () => {
  const isSphereMode = params.displayMode === 'sphere';
  if (sphereMesh) {
    sphereMesh.visible = !isSphereMode;
  }
  if (edgeLines) {
    edgeLines.visible = !isSphereMode;
  }
  if (patternLines) {
    patternLines.visible = !isSphereMode;
  }
  if (smoothSphere) {
    smoothSphere.visible = isSphereMode;
  }
  if (projectedLines) {
    projectedLines.visible = isSphereMode;
  }
};

const rebuildPatternOverlay = () => {
  if (patternLines) {
    sphereGroup.remove(patternLines);
    patternLines.geometry.dispose();
    patternLines = null;
  }

  if (!sphereMesh || !patternState.connections.length) {
    rebuildProjectedOverlay();
    updateModeVisibility();
    return;
  }

  const patternGeometry = buildPatternGeometry(patternState.connections, sphereMesh.geometry);
  if (!patternGeometry) {
    rebuildProjectedOverlay();
    updateModeVisibility();
    return;
  }

  patternLines = new LineSegments(patternGeometry, patternMaterial);
  sphereGroup.add(patternLines);
  rebuildProjectedOverlay();
  updateModeVisibility();
};

const rebuildProjectedOverlay = () => {
  if (projectedLines) {
    sphereGroup.remove(projectedLines);
    projectedLines.geometry.dispose();
    projectedLines = null;
  }

  if (!sphereMesh || !patternState.connections.length) {
    updateModeVisibility();
    return;
  }

  const projectedGeometry = buildProjectedPatternGeometry(patternState.connections, sphereMesh.geometry, {
    radius: params.radius,
    samplesPerSegment: params.projectionSamples,
  });

  if (!projectedGeometry) {
    return;
  }

  projectedLines = new LineSegments(projectedGeometry, spherePatternMaterial);
  sphereGroup.add(projectedLines);
  updateModeVisibility();
};

const gui = new GUI();
gui.title('Sphere Controls');
gui.add(params, 'base', getBaseTypes()).name('Base Polyhedron').onChange(rebuildSphere);
gui.add(params, 'frequency', 1, 6, 1).name('Frequency').onChange(rebuildSphere);
gui.add(params, 'radius', 0.6, 2, 0.1).name('Radius').onChange(rebuildSphere);
gui
  .add(params, 'displayMode', { Dome: 'dome', Sphere: 'sphere' })
  .name('Display Mode')
  .onChange(updateModeVisibility);
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
  .onChange(rebuildProjectedOverlay);

const templateEditor = new TemplateEditor(templateRoot, {
  onChange: ({ connections }) => {
    patternState.connections = connections;
    rebuildPatternOverlay();
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

  sphereGroup.rotation.y += 0.001;

  controls.update();
  renderer.render(scene, camera);
};

rebuildSphere();
updateMaterial();
updateEdgeMaterial();
resize();
updateModeVisibility();
animate();
