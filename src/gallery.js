import {
  AmbientLight,
  Color,
  DirectionalLight,
  Group,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  SphereGeometry,
  WebGLRenderer,
} from 'three';
import { PRESETS, expandStrokes, flattenSegments } from './templateSpace.js';
import { getSurface } from './surfaces.js';
import { buildWovenSegments } from './weave.js';
import { buildTubeGroup, disposeTubeGroup } from './tubes.js';
import {
  DEFAULT_PRINT,
  migratePrint,
  sceneScale,
  strutProfile,
  surfaceInset,
  weaveOptions,
} from './printSettings.js';
import { icon } from './ui/icons.js';

const STORAGE_KEY = 'sphere-gallery-v1';
const THUMB_SIZE = 320;
const THUMB_BACKGROUND = '#0d0f14';
export const DEFAULT_SURFACE_COLOR = '#8ae5ff';
export const PATTERN_COLOR = '#fef4b4';

const starter = (id, name, presetKey, base, frequency = 1) => {
  const preset = PRESETS[presetKey];
  return {
    id,
    name,
    starter: true,
    pattern: { symmetry: 'kaleidoscope', grid: preset.grid, strokes: preset.strokes },
    surface: { type: 'geodesic', base, frequency },
  };
};

/**
 * Built-in designs. Loading one replaces the pattern and surface but keeps
 * the current print settings and color.
 */
export const STARTERS = [
  starter('line-sphere', 'Line Sphere', 'lineSphere', 'icosahedron'),
  starter('soccer', 'Soccer Ball', 'honeycomb', 'pentakis dodecahedron'),
  starter('honeycomb', 'Honeycomb', 'honeycomb', 'icosahedron', 2),
  starter('squares-hexes', 'Squares & Hexagons', 'honeycomb', 'tetrakis hexahedron'),
  starter('trihex', 'Tri-Hex', 'trihex', 'icosahedron'),
  starter('rings', 'Vertex Rings', 'rings', 'icosahedron'),
  starter('flower', 'Flower', 'flower', 'icosahedron'),
  starter('flower-octa', 'Octa Flower', 'flower', 'octahedron'),
];

/**
 * Renders a design into a small square image, using the same strand and
 * strut pipeline as the Sphere view so thumbnails match what loads.
 */
class ThumbnailRenderer {
  constructor() {
    this.renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(THUMB_SIZE, THUMB_SIZE, false);
    this.renderer.setClearColor(new Color(THUMB_BACKGROUND), 1);
    this.scene = new Scene();
    this.camera = new PerspectiveCamera(32, 1, 0.1, 50);
    this.camera.position.set(1, 1.2, 4.7);
    this.camera.lookAt(0, 0.08, 0);
    const key = new DirectionalLight(0xffffff, 1.1);
    key.position.set(4, 5, 5);
    const rim = new DirectionalLight(0x6bc4ff, 0.5);
    rim.position.set(-4, -2, -4);
    this.scene.add(new AmbientLight(0xf5f5f5, 0.55), key, rim);
    this.tubeMaterial = new MeshStandardMaterial({ color: PATTERN_COLOR, metalness: 0.1, roughness: 0.45 });
    this.surfaceMaterial = new MeshStandardMaterial({ metalness: 0.25, roughness: 0.4 });
    this.ball = new Mesh(new SphereGeometry(1, 48, 32), this.surfaceMaterial);
  }

  render(design) {
    const radius = 1;
    const print = { ...DEFAULT_PRINT, ...migratePrint(design.print) };
    const surface = getSurface(design.surface?.type);
    const geometry = surface.createGeometry({ ...surface.defaults, ...design.surface }, radius);
    const connections = flattenSegments(expandStrokes(design.pattern.strokes, design.pattern.symmetry));
    const group = new Group();
    this.surfaceMaterial.color.set(design.appearance?.color ?? DEFAULT_SURFACE_COLOR);
    this.ball.scale.setScalar(radius);
    group.add(this.ball);

    let tubes = null;
    const result = connections.length
      ? buildWovenSegments(connections, geometry, weaveOptions(print, { radius, samples: 10 }))
      : null;
    if (result?.segments) {
      const scale = sceneScale(print, radius);
      const profile = strutProfile(print, scale);
      tubes = buildTubeGroup(result.segments, profile, this.tubeMaterial);
      group.add(tubes);
      this.ball.scale.setScalar(radius - surfaceInset(result.segments, profile, radius));
    }
    geometry.dispose();

    this.scene.add(group);
    this.renderer.render(this.scene, this.camera);
    const url = this.renderer.domElement.toDataURL('image/jpeg', 0.86);
    this.scene.remove(group);
    if (tubes) {
      disposeTubeGroup(tubes);
    }
    return url;
  }
}

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

function loadSaved() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

/**
 * Full-screen browser of starter designs and designs the user has saved.
 * `getDesign()` snapshots the current design; `applyDesign(design)` loads one.
 */
export class Gallery {
  constructor(root, { getDesign, applyDesign, onOpenChange }) {
    this.root = root;
    this.getDesign = getDesign;
    this.applyDesign = applyDesign;
    this.onOpenChange = onOpenChange;
    this.saved = loadSaved();
    this.starterThumbs = new Map();
    this.renderer = null;
    this.isOpen = false;

    root.className = 'gallery';
    root.hidden = true;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Gallery');
    root.innerHTML = `
      <div class="gallery-sheet">
        <header class="gallery-header">
          <div>
            <h2>Gallery</h2>
            <p>Load a starter, or save the current design to come back to it.</p>
          </div>
          <button type="button" class="icon-btn" data-action="close" title="Close (Esc)">${icon('close')}</button>
        </header>
        <section>
          <h3>Your designs</h3>
          <div class="gallery-grid" data-grid="saved"></div>
        </section>
        <section>
          <h3>Starters</h3>
          <div class="gallery-grid" data-grid="starters"></div>
        </section>
      </div>`;
    this.savedGrid = root.querySelector('[data-grid="saved"]');
    this.starterGrid = root.querySelector('[data-grid="starters"]');
    root.querySelector('[data-action="close"]').addEventListener('click', () => this.close());
    root.addEventListener('pointerdown', (event) => {
      if (event.target === root) {
        this.close();
      }
    });
    window.addEventListener('keydown', (event) => {
      if (this.isOpen && event.key === 'Escape' && !event.target.isContentEditable) {
        this.close();
      }
    });
  }

  thumbnail(design) {
    this.renderer ??= new ThumbnailRenderer();
    return this.renderer.render(design);
  }

  open() {
    if (this.isOpen) {
      return;
    }
    this.isOpen = true;
    this.root.hidden = false;
    requestAnimationFrame(() => this.root.classList.add('open'));
    this.renderSaved();
    this.renderStarters();
    this.onOpenChange?.(true);
  }

  close() {
    if (!this.isOpen) {
      return;
    }
    this.isOpen = false;
    this.root.classList.remove('open');
    this.root.hidden = true;
    this.onOpenChange?.(false);
  }

  toggle() {
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
  }

  persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.saved));
      return true;
    } catch {
      return false;
    }
  }

  saveCurrent() {
    const design = this.getDesign();
    const entry = {
      ...design,
      id: `d${Date.now().toString(36)}`,
      name: `Design ${this.saved.length + 1}`,
      createdAt: Date.now(),
      thumbnail: this.thumbnail(design),
    };
    this.saved.unshift(entry);
    if (!this.persist()) {
      this.saved.shift();
      window.alert('Could not save: browser storage is full. Delete a few designs and try again.');
      return;
    }
    this.renderSaved();
    const card = this.savedGrid.querySelector(`[data-id="${entry.id}"]`);
    card?.classList.add('just-saved');
    this.startRename(entry, card);
  }

  load(design) {
    this.applyDesign(design);
    this.close();
  }

  remove(entry) {
    this.saved = this.saved.filter((d) => d.id !== entry.id);
    this.persist();
    this.renderSaved();
  }

  startRename(entry, card) {
    const name = card?.querySelector('.card-name');
    if (!name) {
      return;
    }
    const original = entry.name;
    const controller = new AbortController();
    const { signal } = controller;
    name.contentEditable = 'plaintext-only';
    name.focus();
    document.getSelection().selectAllChildren(name);
    const rename = (text) => {
      entry.name = text || original;
      this.persist();
    };
    name.addEventListener('input', () => rename(name.textContent.trim()), { signal });
    name.addEventListener(
      'blur',
      () => {
        controller.abort();
        name.contentEditable = 'false';
        name.textContent = entry.name;
      },
      { signal },
    );
    name.addEventListener(
      'keydown',
      (event) => {
        event.stopPropagation();
        if (event.key === 'Enter') {
          event.preventDefault();
          name.blur();
        } else if (event.key === 'Escape') {
          rename(original);
          name.textContent = original;
          name.blur();
        }
      },
      { signal },
    );
  }

  renderSaved() {
    this.savedGrid.innerHTML = '';
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'gallery-card gallery-add';
    add.innerHTML = `<span class="add-icon">${icon('plus')}</span><span>Save current design</span>`;
    add.addEventListener('click', () => this.saveCurrent());
    this.savedGrid.append(add);
    this.saved.forEach((entry) => {
      const card = this.card(entry, entry.thumbnail);
      const actions = document.createElement('div');
      actions.className = 'card-actions';
      actions.append(
        this.cardAction('edit', 'Rename', () => this.startRename(entry, card)),
        this.cardAction('trash', 'Delete', () => {
          if (window.confirm(`Delete “${entry.name}”?`)) {
            this.remove(entry);
          }
        }),
      );
      card.append(actions);
      this.savedGrid.append(card);
    });
  }

  async renderStarters() {
    if (this.starterGrid.childElementCount) {
      return;
    }
    const cards = STARTERS.map((design) => {
      const card = this.card(design, this.starterThumbs.get(design.id));
      this.starterGrid.append(card);
      return card;
    });
    for (let i = 0; i < STARTERS.length; i += 1) {
      const design = STARTERS[i];
      if (!this.starterThumbs.has(design.id)) {
        await nextFrame();
        this.starterThumbs.set(design.id, this.thumbnail(design));
      }
      cards[i].querySelector('.card-thumb').style.backgroundImage = `url(${this.starterThumbs.get(design.id)})`;
      cards[i].classList.remove('loading');
    }
  }

  card(design, thumbnail) {
    const card = document.createElement('div');
    card.className = `gallery-card${thumbnail ? '' : ' loading'}`;
    card.dataset.id = design.id;
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    const surface = getSurface(design.surface?.type);
    const { short, faces } = surface.describe({ ...surface.defaults, ...design.surface });
    card.innerHTML = `
      <div class="card-thumb"></div>
      <div class="card-body">
        <div class="card-name"></div>
        <div class="card-meta">${short} · ${faces} faces</div>
      </div>`;
    card.querySelector('.card-name').textContent = design.name;
    if (thumbnail) {
      card.querySelector('.card-thumb').style.backgroundImage = `url(${thumbnail})`;
    }
    const activate = (event) => {
      if (event.target.closest('.card-actions') || event.target.isContentEditable) {
        return;
      }
      this.load(design);
    };
    card.addEventListener('click', activate);
    card.addEventListener('keydown', (event) => {
      if ((event.key === 'Enter' || event.key === ' ') && event.target === card) {
        event.preventDefault();
        activate(event);
      }
    });
    return card;
  }

  cardAction(iconName, title, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'icon-btn';
    button.title = title;
    button.innerHTML = icon(iconName);
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      onClick();
    });
    return button;
  }
}
