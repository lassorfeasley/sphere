import {
  GRID_SIZES,
  PRESETS,
  SYMMETRIES,
  barycentricToCartesian,
  expandStrokes,
  junctionParams,
  latticePoints,
  lerpBary,
  samePoint,
  segmentIntersections,
  templateTriangle,
} from './templateSpace.js';
import { icon } from './ui/icons.js';

const STORAGE_KEY = 'sphere-template-v2';
const SVG_NS = 'http://www.w3.org/2000/svg';
const EDITOR_VIEWBOX = '-0.06 -0.06 1.12 0.99';
// Fits the template triangle plus its three mirrored neighbors.
const NEIGHBOR_VIEWBOX = '-0.55 -0.05 2.1 1.85';
const SNAP_RADIUS = 0.045;
// On dense grids the snap radius shrinks so the stretch of line between
// neighboring dots stays clickable.
const SNAP_FRACTION_OF_SPACING = 0.3;
const LINE_HIT_RADIUS = 0.02;

export class TemplateEditor {
  constructor(rootEl, { onChange, onSelect } = {}) {
    this.rootEl = rootEl;
    this.onChange = onChange;
    this.onSelect = onSelect;
    this.keyboardEnabled = true;
    this.state = {
      symmetry: 'kaleidoscope',
      grid: 6,
      strokes: [],
    };
    this.pending = null;
    this.dragStart = null;
    this.hover = null;
    this.cursor = null;
    this.selected = null;
    this.lineColors = null;
    this.mode = 'draw';
    this.lineWidth = 0;
    this.history = [];

    this.buildUI();
    this.restoreFromStorage();
    this.syncControls();
    this.refresh();
    this.setMode('draw');

    window.addEventListener('keydown', (event) => this.handleKeyDown(event));
  }

  buildUI() {
    const tools = document.createElement('div');
    tools.className = 'template-tools';
    const modes = document.createElement('div');
    modes.className = 'segmented';
    this.drawButton = makeButton('Draw', () => this.setMode('draw'), { icon: 'pen', className: 'segment' });
    this.selectButton = makeButton('Select', () => this.setMode('select'), { icon: 'cursor', className: 'segment' });
    this.drawButton.title = 'Draw lines between dots (D)';
    this.selectButton.title = 'Select lines to delete them (V, or hold Option while clicking)';
    modes.append(this.drawButton, this.selectButton);
    const undo = makeButton('', () => this.undo(), { icon: 'undo', className: 'icon-btn' });
    undo.title = 'Undo (⌘Z)';
    const clear = makeButton('', () => this.clear(), { icon: 'trash', className: 'icon-btn' });
    clear.title = 'Clear all lines';
    tools.append(modes, undo, clear);

    const settings = document.createElement('div');
    settings.className = 'template-settings';
    this.symmetrySelect = makeSelect(
      Object.entries(SYMMETRIES).map(([value, { label }]) => ({ value, label })),
    );
    this.symmetrySelect.addEventListener('change', () => {
      this.pushHistory();
      this.state.symmetry = this.symmetrySelect.value;
      this.refresh();
    });
    this.gridSelect = makeSelect(GRID_SIZES.map((n) => ({ value: String(n), label: `${n} per edge` })));
    this.gridSelect.addEventListener('change', () => {
      this.state.grid = Number(this.gridSelect.value);
      this.refresh(false);
    });
    settings.append(labelled('Symmetry', this.symmetrySelect), labelled('Snap grid', this.gridSelect));

    this.hint = document.createElement('p');
    this.hint.className = 'template-hint';

    this.editorSvg = svgEl('svg', { viewBox: EDITOR_VIEWBOX, id: 'triangle-editor' });
    this.gridLayer = svgEl('g');
    this.axisLayer = svgEl('g');
    this.segmentLayer = svgEl('g');
    this.snapLayer = svgEl('g');
    this.rubberBand = svgEl('line', { class: 'rubber-band' });
    this.editorSvg.append(
      svgEl('polygon', { points: trianglePoints(templateTriangle), class: 'template-outline' }),
      this.gridLayer,
      this.axisLayer,
      this.segmentLayer,
      this.rubberBand,
      this.snapLayer,
    );
    this.editorSvg.addEventListener('pointerdown', (event) => this.handlePointerDown(event));
    this.editorSvg.addEventListener('pointermove', (event) => this.handlePointerMove(event));
    this.editorSvg.addEventListener('pointerup', (event) => this.handlePointerUp(event));
    this.editorSvg.addEventListener('pointerleave', () => {
      this.hover = null;
      this.cursor = null;
      this.renderInteraction();
    });

    const editorFrame = document.createElement('div');
    editorFrame.className = 'editor-frame';
    editorFrame.append(this.editorSvg);

    const neighbors = document.createElement('details');
    neighbors.className = 'template-details';
    neighbors.open = true;
    const neighborTitle = document.createElement('summary');
    neighborTitle.textContent = 'With neighboring faces';
    this.neighborSvg = svgEl('svg', { viewBox: NEIGHBOR_VIEWBOX, id: 'neighbor-preview' });
    this.neighborWarning = document.createElement('p');
    this.neighborWarning.className = 'note';
    this.neighborWarning.dataset.tone = 'warn';
    this.neighborWarning.textContent =
      'Without kaleidoscope symmetry, faces on the sphere can be rotated relative to each other, ' +
      'so lines may not meet at the edges the way this preview shows.';
    neighbors.append(neighborTitle, this.neighborSvg, this.neighborWarning);

    this.connectivityNote = document.createElement('p');
    this.connectivityNote.className = 'note';
    this.clearanceNote = document.createElement('p');
    this.clearanceNote.className = 'note';
    const notes = document.createElement('div');
    notes.className = 'template-notes';
    notes.append(this.connectivityNote, this.clearanceNote);

    this.fileInput = document.createElement('input');
    this.fileInput.type = 'file';
    this.fileInput.accept = 'application/json,.json';
    this.fileInput.hidden = true;
    this.fileInput.addEventListener('change', () => this.importJsonFile());
    const files = document.createElement('div');
    files.className = 'template-files';
    const importButton = makeButton('Import JSON', () => this.fileInput.click(), { icon: 'upload', className: 'btn btn-ghost' });
    const exportButton = makeButton('Export JSON', () => this.exportJson(), { icon: 'download', className: 'btn btn-ghost' });
    importButton.title = 'Load a pattern saved as JSON';
    exportButton.title = 'Download this pattern as JSON';
    files.append(importButton, exportButton, this.fileInput);

    this.rootEl.append(tools, editorFrame, this.hint, notes, settings, neighbors, files);
  }

  syncControls() {
    this.symmetrySelect.value = this.state.symmetry;
    this.gridSelect.value = String(this.state.grid);
  }

  /** Recompute derived geometry and redraw; optionally notify the sphere. */
  refresh(emit = true) {
    this.segments = expandStrokes(this.state.strokes, this.state.symmetry);
    this.snapTargets = this.computeSnapTargets();
    this.renderGrid();
    this.renderAxes();
    this.renderSegments();
    this.renderInteraction();
    this.renderNeighbors();
    this.neighborWarning.hidden = this.state.symmetry === 'kaleidoscope';
    if (emit) {
      this.emitChange();
    }
  }

  computeSnapTargets() {
    const targets = latticePoints(this.state.grid).map((p) => ({ p, kind: 'grid' }));
    const add = (p, kind) => {
      if (!targets.some((t) => samePoint(t.p, p))) {
        targets.push({ p, kind });
      }
    };
    this.segments.forEach(({ start, end }) => {
      add(start, 'endpoint');
      add(end, 'endpoint');
    });
    segmentIntersections(this.segments).forEach((p) => add(p, 'crossing'));
    return targets;
  }

  renderGrid() {
    this.gridLayer.innerHTML = '';
    const n = this.state.grid;
    for (let i = 1; i < n; i += 1) {
      const t = i / n;
      // One family of lattice lines parallel to each triangle edge.
      [
        [{ a: t, b: 1 - t, c: 0 }, { a: t, b: 0, c: 1 - t }],
        [{ a: 1 - t, b: t, c: 0 }, { a: 0, b: t, c: 1 - t }],
        [{ a: 1 - t, b: 0, c: t }, { a: 0, b: 1 - t, c: t }],
      ].forEach(([p, q]) => {
        this.gridLayer.appendChild(baryLine(p, q, 'grid-line'));
      });
    }
  }

  renderAxes() {
    this.axisLayer.innerHTML = '';
    if (this.state.symmetry !== 'kaleidoscope') {
      return;
    }
    [
      [{ a: 1, b: 0, c: 0 }, { a: 0, b: 0.5, c: 0.5 }],
      [{ a: 0, b: 1, c: 0 }, { a: 0.5, b: 0, c: 0.5 }],
      [{ a: 0, b: 0, c: 1 }, { a: 0.5, b: 0.5, c: 0 }],
    ].forEach(([p, q]) => this.axisLayer.appendChild(baryLine(p, q, 'mirror-axis')));
  }

  renderSegments() {
    this.segmentLayer.innerHTML = '';
    this.segments.forEach(({ start, end }, i) => {
      const line = baryLine(start, end, 'pattern-line');
      if (this.lineColors?.[i]) {
        line.style.stroke = this.lineColors[i];
      }
      this.segmentLayer.appendChild(line);
    });
    // Symmetric copies share the source stroke's parameterization, so the
    // selected span maps onto every copy at the same positions.
    const selection = this.selected;
    const spans = selection
      ? this.segments
          .filter(({ source }) => source === selection.source)
          .map(({ start, end }) => ({
            start: lerpBary(start, end, selection.t0),
            end: lerpBary(start, end, selection.t1),
          }))
      : [];
    spans.forEach(({ start, end }) => {
      this.segmentLayer.appendChild(baryLine(start, end, 'pattern-line selected'));
    });
    if (typeof this.onSelect === 'function') {
      this.onSelect(spans);
    }
  }

  renderInteraction() {
    this.snapLayer.innerHTML = '';
    this.snapTargets.forEach(({ p, kind }) => {
      const { x, y } = barycentricToCartesian(p);
      const dot = svgEl('circle', { cx: x, cy: y, r: kind === 'grid' ? 0.009 : 0.008, class: `snap-dot ${kind}` });
      if (this.hover && samePoint(p, this.hover)) {
        dot.classList.add('hover');
      }
      if (this.anchor() && samePoint(p, this.anchor())) {
        dot.classList.add('active');
      }
      this.snapLayer.appendChild(dot);
    });

    const from = this.anchor();
    const to = this.hover ? barycentricToCartesian(this.hover) : this.cursor;
    if (from && to) {
      const start = barycentricToCartesian(from);
      setAttrs(this.rubberBand, { x1: start.x, y1: start.y, x2: to.x, y2: to.y, visibility: 'visible' });
    } else {
      setAttrs(this.rubberBand, { visibility: 'hidden' });
    }
    this.editorSvg.style.cursor = this.hover ? 'crosshair' : this.mode === 'select' ? 'pointer' : 'default';
  }

  /** Draw the pattern mirrored across each edge, as it appears on adjacent faces. */
  renderNeighbors() {
    this.neighborSvg.innerHTML = '';
    const [a, b, c] = templateTriangle;
    [
      [a, b],
      [b, c],
      [c, a],
    ].forEach(([p1, p2]) => {
      const reflect = (point) => reflectAcrossLine(point, p1, p2);
      this.neighborSvg.appendChild(
        svgEl('polygon', { points: trianglePoints(templateTriangle.map(reflect)), class: 'neighbor-outline' }),
      );
      this.segments.forEach(({ start, end }) => {
        this.neighborSvg.appendChild(
          cartLine(reflect(barycentricToCartesian(start)), reflect(barycentricToCartesian(end)), 'neighbor-line'),
        );
      });
    });
    this.neighborSvg.appendChild(
      svgEl('polygon', { points: trianglePoints(templateTriangle), class: 'template-outline' }),
    );
    this.segments.forEach(({ start, end }) => {
      this.neighborSvg.appendChild(baryLine(start, end, 'pattern-line'));
    });
  }

  anchor() {
    return this.dragStart ?? this.pending;
  }

  toLocal(event) {
    const pt = this.editorSvg.createSVGPoint();
    pt.x = event.clientX;
    pt.y = event.clientY;
    const local = pt.matrixTransform(this.editorSvg.getScreenCTM().inverse());
    return { x: local.x, y: local.y };
  }

  nearestSnap(point) {
    let best = null;
    let bestDist = Math.min(SNAP_RADIUS, SNAP_FRACTION_OF_SPACING / this.state.grid);
    this.snapTargets.forEach(({ p }) => {
      const { x, y } = barycentricToCartesian(p);
      const dist = Math.hypot(x - point.x, y - point.y);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    });
    return best;
  }

  /**
   * Select the span of the clicked line between its nearest junctions.
   * Clicking an already-selected span widens the selection to the whole line.
   */
  selectAt(point) {
    let hit = null;
    let bestDist = Math.max(LINE_HIT_RADIUS, this.lineWidth / 2);
    this.segments.forEach(({ start, end }, index) => {
      const { distance, t } = projectOntoSegment(point, barycentricToCartesian(start), barycentricToCartesian(end));
      if (distance < bestDist) {
        hit = { index, t };
        bestDist = distance;
      }
    });
    if (!hit) {
      return null;
    }
    const cuts = junctionParams(this.segments)[hit.index];
    const t0 = Math.max(...cuts.filter((t) => t <= hit.t));
    const t1 = Math.min(...cuts.filter((t) => t >= hit.t));
    const source = this.segments[hit.index].source;
    const current = this.selected;
    if (current && current.source === source && current.t0 === t0 && current.t1 === t1) {
      return { source, t0: 0, t1: 1 };
    }
    return { source, t0, t1 };
  }

  deleteSelection() {
    const { source, t0, t1 } = this.selected;
    const [start, end] = this.state.strokes[source];
    const remaining = [];
    if (t0 > 1e-6) {
      remaining.push([{ ...start }, lerpBary(start, end, t0)]);
    }
    if (t1 < 1 - 1e-6) {
      remaining.push([lerpBary(start, end, t1), { ...end }]);
    }
    this.pushHistory();
    this.state.strokes.splice(source, 1, ...remaining);
    this.selected = null;
    this.refresh();
  }

  handlePointerDown(event) {
    if (event.button !== 0) {
      return;
    }
    const point = this.toLocal(event);
    const selecting = this.mode === 'select' || event.altKey;
    const snap = selecting ? null : this.nearestSnap(point);

    if (!snap) {
      this.pending = null;
      this.selected = this.selectAt(point);
      this.renderSegments();
      this.renderInteraction();
      return;
    }

    this.selected = null;
    if (this.pending && !samePoint(this.pending, snap)) {
      this.addStroke(this.pending, snap);
      this.pending = snap;
      this.renderInteraction();
      return;
    }
    this.dragStart = snap;
    this.editorSvg.setPointerCapture(event.pointerId);
    this.renderSegments();
    this.renderInteraction();
  }

  handlePointerMove(event) {
    this.cursor = this.toLocal(event);
    this.hover = this.mode === 'select' || event.altKey ? null : this.nearestSnap(this.cursor);
    this.renderInteraction();
  }

  setMode(mode) {
    this.mode = mode;
    this.pending = null;
    this.hover = null;
    this.drawButton.classList.toggle('active', mode === 'draw');
    this.selectButton.classList.toggle('active', mode === 'select');
    this.hint.textContent =
      mode === 'draw'
        ? 'Drag between dots to draw a line, or click dots one after another to chain lines. Esc stops a chain; hold Option to select.'
        : 'Click a line to select the part between junctions; click again for the whole line. Delete removes it.';
    this.renderInteraction();
  }

  handlePointerUp(event) {
    if (!this.dragStart) {
      return;
    }
    const snap = this.nearestSnap(this.toLocal(event));
    const start = this.dragStart;
    this.dragStart = null;
    if (snap && !samePoint(snap, start)) {
      this.addStroke(start, snap);
      this.pending = null;
    } else {
      // A click without dragging starts (or cancels) a chain from this dot.
      this.pending = this.pending && samePoint(this.pending, start) ? null : start;
    }
    this.renderInteraction();
  }

  handleKeyDown(event) {
    if (
      !this.keyboardEnabled ||
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLSelectElement ||
      event.target.isContentEditable
    ) {
      return;
    }
    if (event.key === 'Escape') {
      this.pending = null;
      this.selected = null;
      this.renderSegments();
      this.renderInteraction();
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && this.selected !== null) {
      event.preventDefault();
      this.deleteSelection();
    } else if (event.key === 'z' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      this.undo();
    } else if ((event.key === 'v' || event.key === 'd') && !event.metaKey && !event.ctrlKey) {
      this.setMode(event.key === 'v' ? 'select' : 'draw');
    }
  }

  addStroke(start, end) {
    const exists = this.segments.some(
      (seg) =>
        (samePoint(seg.start, start) && samePoint(seg.end, end)) ||
        (samePoint(seg.start, end) && samePoint(seg.end, start)),
    );
    if (exists) {
      return;
    }
    this.pushHistory();
    this.state.strokes.push([{ ...start }, { ...end }]);
    this.refresh();
  }

  /** A copy of the pattern: symmetry, snap grid, and source strokes. */
  getPattern() {
    return JSON.parse(JSON.stringify(this.state));
  }

  /** Replace the pattern (undoable). A missing grid keeps the current one. */
  loadPattern({ symmetry, grid, strokes }) {
    this.pushHistory();
    this.state = {
      symmetry: SYMMETRIES[symmetry] ? symmetry : 'kaleidoscope',
      grid: GRID_SIZES.includes(grid) ? grid : this.state.grid,
      strokes: strokes.map(([p, q]) => [{ ...p }, { ...q }]),
    };
    this.pending = null;
    this.selected = null;
    this.syncControls();
    this.refresh();
  }

  /** Draw pattern lines at their printed width, as a fraction of the face edge. */
  setLineWidth(fraction) {
    const width = Math.min(0.08, Math.max(0.006, fraction));
    this.lineWidth = width;
    this.editorSvg.style.setProperty('--line-width', width);
    this.neighborSvg.style.setProperty('--line-width', width);
  }

  /** Color each expanded segment (same order as `segments`), or null for the default. */
  setLineColors(colors) {
    this.lineColors = colors;
    this.renderSegments();
  }

  /** Show a clearance message (or hide it with null); `warn` styles it as a warning. */
  setClearance(message, warn = false) {
    this.clearanceNote.hidden = !message;
    this.clearanceNote.textContent = message ?? '';
    this.clearanceNote.dataset.tone = warn ? 'warn' : 'ok';
  }

  setConnectivity(pieces) {
    this.connectivityNote.hidden = !pieces;
    this.connectivityNote.dataset.tone = pieces > 1 ? 'warn' : 'ok';
    if (pieces === 0) {
      this.connectivityNote.textContent = '';
    } else if (pieces === 1) {
      this.connectivityNote.textContent = 'Prints as one connected piece.';
    } else {
      this.connectivityNote.textContent =
        `Prints as ${pieces} separate pieces — some lines don't touch the rest. ` +
        'Woven closed loops can still interlock like chain mail, but loose pieces that ' +
        "aren't caught by the weave will fall out.";
    }
  }

  pushHistory() {
    this.history.push(JSON.stringify(this.state));
    if (this.history.length > 100) {
      this.history.shift();
    }
  }

  undo() {
    if (this.pending) {
      this.pending = null;
      this.renderInteraction();
      return;
    }
    const snapshot = this.history.pop();
    if (!snapshot) {
      return;
    }
    this.state = JSON.parse(snapshot);
    this.selected = null;
    this.syncControls();
    this.refresh();
  }

  clear() {
    if (!this.state.strokes.length) {
      return;
    }
    this.pushHistory();
    this.state.strokes = [];
    this.pending = null;
    this.selected = null;
    this.refresh();
  }

  emitChange() {
    this.persist();
    if (typeof this.onChange === 'function') {
      this.onChange({ connections: this.segments.map(({ start, end }) => ({ start, end })) });
    }
  }

  serialize() {
    return { version: 2, ...this.state };
  }

  loadData(data) {
    if (data?.version !== 2 || !Array.isArray(data.strokes)) {
      return false;
    }
    this.state = {
      symmetry: SYMMETRIES[data.symmetry] ? data.symmetry : 'kaleidoscope',
      grid: GRID_SIZES.includes(data.grid) ? data.grid : 6,
      strokes: data.strokes.map(([p, q]) => [{ ...p }, { ...q }]),
    };
    return true;
  }

  persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.serialize()));
    } catch {
      // Storage may be unavailable (private mode); persisting is best-effort.
    }
  }

  restoreFromStorage() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        this.loadData(JSON.parse(raw));
      } else {
        this.state.strokes = PRESETS.lineSphere.strokes.map(([p, q]) => [{ ...p }, { ...q }]);
        this.state.grid = PRESETS.lineSphere.grid;
      }
    } catch {
      // Ignore corrupt saved state.
    }
  }

  exportJson() {
    const blob = new Blob([JSON.stringify(this.serialize(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'sphere-pattern.json';
    link.click();
    URL.revokeObjectURL(url);
  }

  async importJsonFile() {
    const file = this.fileInput.files?.[0];
    this.fileInput.value = '';
    if (!file) {
      return;
    }
    try {
      this.pushHistory();
      if (!this.loadData(JSON.parse(await file.text()))) {
        throw new Error('Unsupported pattern file');
      }
      this.syncControls();
      this.refresh();
    } catch {
      this.history.pop();
      window.alert('Could not read that file as a saved pattern.');
    }
  }
}

function makeSelect(options) {
  const select = document.createElement('select');
  options.forEach(({ value, label }) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
  });
  return select;
}

function labelled(text, control) {
  const label = document.createElement('label');
  label.textContent = text;
  label.appendChild(control);
  return label;
}

function makeButton(label, onClick, { icon: iconName, className } = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  if (className) {
    button.className = className;
  }
  button.innerHTML = iconName ? icon(iconName) : '';
  if (label) {
    const text = document.createElement('span');
    text.textContent = label;
    button.append(text);
  }
  button.addEventListener('click', onClick);
  return button;
}

function svgEl(tag, attrs = {}) {
  return setAttrs(document.createElementNS(SVG_NS, tag), attrs);
}

function setAttrs(el, attrs) {
  Object.entries(attrs).forEach(([key, value]) => el.setAttribute(key, value));
  return el;
}

function trianglePoints(points) {
  return points.map(({ x, y }) => `${x},${y}`).join(' ');
}

function cartLine(start, end, className) {
  return svgEl('line', { x1: start.x, y1: start.y, x2: end.x, y2: end.y, class: className });
}

function baryLine(p, q, className) {
  return cartLine(barycentricToCartesian(p), barycentricToCartesian(q), className);
}

function projectOntoSegment(point, p1, p2) {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const t = Math.max(0, Math.min(1, ((point.x - p1.x) * dx + (point.y - p1.y) * dy) / (dx * dx + dy * dy)));
  return { distance: Math.hypot(point.x - (p1.x + t * dx), point.y - (p1.y + t * dy)), t };
}

function reflectAcrossLine(point, p1, p2) {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const t = ((point.x - p1.x) * dx + (point.y - p1.y) * dy) / (dx * dx + dy * dy);
  return { x: 2 * (p1.x + t * dx) - point.x, y: 2 * (p1.y + t * dy) - point.y };
}