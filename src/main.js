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
  Scene,
  SphereGeometry,
  Uint32BufferAttribute,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GUI } from 'lil-gui';
import { createGeodesicSphere, getBaseTypes } from './geodesic.js';
import { TemplateEditor } from './templateEditor.js';
import { buildPatternGeometry } from './patternMapper.js';
import { buildProjectedPatternGeometry, collectProjectedSegments } from './projection.js';
import { buildStrutSolid } from './solid.js';
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
  spin: true,
};

const printParams = {
  diameterMm: 80,
  strutMm: 2.5,
  detailMm: 1.0,
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
let smoothSphere;
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
  material.transparent = params.surfaceOpacity < 0.999;
  material.depthWrite = true;
  material.needsUpdate = true;
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
    smoothSphere.visible = mode === 'sphere';
  }
  if (projectedLines) {
    projectedLines.visible = mode === 'sphere';
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
};

const rebuildProjectedOverlay = () => {
  if (projectedLines) {
    sphereGroup.remove(projectedLines);
    projectedLines.geometry.dispose();
    projectedLines = null;
  }

  if (sphereMesh && patternState.connections.length) {
    const projectedGeometry = buildProjectedPatternGeometry(patternState.connections, sphereMesh.geometry, {
      radius: params.radius,
      samplesPerSegment: params.projectionSamples,
    });
    if (projectedGeometry) {
      projectedLines = new LineSegments(projectedGeometry, spherePatternMaterial);
      sphereGroup.add(projectedLines);
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
    setStatus('Draw a pattern first — click two anchors to connect them.');
    return;
  }

  solidState.generating = true;
  setStatus('Generating solid… this can take a little while.');
  await nextFrame();

  try {
    const segments = collectProjectedSegments(patternState.connections, sphereMesh.geometry, {
      radius: params.radius,
      samplesPerSegment: params.projectionSamples,
    });
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
      strutRadius: printParams.strutMm / 2,
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
        `${printParams.diameterMm} mm · struts ${printParams.strutMm} mm — use Export STL.`,
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

const gui = new GUI();
gui.title('Sphere Controls');
gui.add(params, 'base', getBaseTypes()).name('Base Polyhedron').onChange(rebuildSphere);
gui.add(params, 'frequency', 1, 6, 1).name('Frequency').onChange(rebuildSphere);
gui.add(params, 'radius', 0.6, 2, 0.1).name('Radius').onChange(rebuildSphere);
const displayModeController = gui
  .add(params, 'displayMode', { Dome: 'dome', Sphere: 'sphere', Solid: 'solid' })
  .name('Display Mode')
  .onChange(updateModeVisibility);
gui.add(params, 'spin').name('Spin');
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
printFolder.add(printParams, 'diameterMm', 20, 200, 1).name('Diameter (mm)').onChange(invalidateSolid);
printFolder.add(printParams, 'strutMm', 1, 8, 0.1).name('Strut Ø (mm)').onChange(invalidateSolid);
printFolder.add(printParams, 'detailMm', 0.3, 3, 0.1).name('Detail (mm)').onChange(invalidateSolid);
printFolder.add({ generate: generateSolid }, 'generate').name('Generate Solid');
printFolder.add({ exportStl }, 'exportStl').name('Export STL');

new TemplateEditor(templateRoot, {
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
