import {
  barycentricToCartesian,
  getTessellationOptions,
  getTessellationQuads,
  mirrorBarycentric,
  quadUvToBarycentric,
  templateTriangle,
} from './templateSpace.js';

const DEFAULT_TESSELLATION = 'triforce';
const STORAGE_KEY = 'sphere-template-v1';
const SVG_NS = 'http://www.w3.org/2000/svg';

// Preview viewBox is sized to fit the template triangle plus the three
// mirrored ghost neighbors that visualize continuity across face edges.
const PREVIEW_VIEWBOX = '-0.55 -0.05 2.1 1.85';

export class TemplateEditor {
  constructor(rootEl, { onChange } = {}) {
    this.rootEl = rootEl;
    this.onChange = onChange;
    this.state = {
      tessellation: DEFAULT_TESSELLATION,
      mirror: true,
      quadSegments: [],
    };

    this.buildUI();
    this.setupPreview();

    this.quadEditor = new QuadEditor(this.quadEditorRoot, {
      onChange: (segments) => {
        this.state.quadSegments = segments;
        this.updatePreview();
        this.emitChange();
      },
    });

    this.undoButton.addEventListener('click', () => this.quadEditor.undo());
    this.clearButton.addEventListener('click', () => this.quadEditor.clear());
    this.saveButton.addEventListener('click', () => this.exportJson());
    this.loadButton.addEventListener('click', () => this.fileInput.click());
    this.fileInput.addEventListener('change', () => this.importJsonFile());

    this.restoreFromStorage();

    this.updatePreview();
    this.emitChange();
  }

  buildUI() {
    const toolbar = document.createElement('div');
    toolbar.className = 'template-toolbar';

    const tessLabel = document.createElement('label');
    tessLabel.textContent = 'Tessellation';
    this.tessSelect = document.createElement('select');
    getTessellationOptions().forEach(({ value, label }) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      this.tessSelect.appendChild(option);
    });
    this.tessSelect.value = DEFAULT_TESSELLATION;
    this.tessSelect.addEventListener('change', () => {
      this.state.tessellation = this.tessSelect.value;
      this.updatePreview();
      this.emitChange();
    });
    tessLabel.appendChild(this.tessSelect);

    const mirrorLabel = document.createElement('label');
    mirrorLabel.className = 'mirror-toggle';
    this.mirrorCheckbox = document.createElement('input');
    this.mirrorCheckbox.type = 'checkbox';
    this.mirrorCheckbox.checked = this.state.mirror;
    this.mirrorCheckbox.addEventListener('change', () => {
      this.state.mirror = this.mirrorCheckbox.checked;
      this.updatePreview();
      this.emitChange();
    });
    mirrorLabel.append(this.mirrorCheckbox, document.createTextNode('Mirror'));
    mirrorLabel.title =
      'Adds a mirrored copy of every stroke. Mirrored patterns are guaranteed to connect across face edges.';

    this.undoButton = this.makeButton('Undo');
    this.clearButton = this.makeButton('Clear');
    this.saveButton = this.makeButton('Save');
    this.loadButton = this.makeButton('Load');

    this.fileInput = document.createElement('input');
    this.fileInput.type = 'file';
    this.fileInput.accept = 'application/json,.json';
    this.fileInput.style.display = 'none';

    toolbar.append(
      tessLabel,
      mirrorLabel,
      this.undoButton,
      this.clearButton,
      this.saveButton,
      this.loadButton,
      this.fileInput,
    );

    const layout = document.createElement('div');
    layout.className = 'template-layout';

    this.quadEditorRoot = document.createElement('div');
    this.quadEditorRoot.id = 'quad-editor-root';

    this.previewRoot = document.createElement('div');
    this.previewRoot.id = 'triangle-preview-root';

    layout.append(this.quadEditorRoot, this.previewRoot);
    this.rootEl.append(toolbar, layout);
  }

  setupPreview() {
    this.previewSvg = document.createElementNS(SVG_NS, 'svg');
    this.previewSvg.setAttribute('viewBox', PREVIEW_VIEWBOX);
    this.previewSvg.setAttribute('id', 'triangle-preview');

    this.ghostLayer = document.createElementNS(SVG_NS, 'g');

    const outline = document.createElementNS(SVG_NS, 'polygon');
    outline.setAttribute('points', templateTriangle.map(({ x, y }) => `${x},${y}`).join(' '));
    outline.setAttribute('fill', 'rgba(255,255,255,0.01)');
    outline.setAttribute('stroke', 'rgba(255,255,255,0.18)');
    outline.setAttribute('stroke-width', '0.005');

    this.quadLayer = document.createElementNS(SVG_NS, 'g');
    this.patternLayer = document.createElementNS(SVG_NS, 'g');

    this.previewSvg.append(this.ghostLayer, outline, this.quadLayer, this.patternLayer);
    this.previewRoot.appendChild(this.previewSvg);
  }

  updatePreview() {
    const quads = getTessellationQuads(this.state.tessellation);
    this.quadLayer.innerHTML = '';
    quads.forEach((quad) => {
      const polygon = document.createElementNS(SVG_NS, 'polygon');
      polygon.setAttribute(
        'points',
        quad.corners.map(({ cartesian }) => `${cartesian.x},${cartesian.y}`).join(' '),
      );
      polygon.setAttribute('fill', 'rgba(157, 222, 255, 0.05)');
      polygon.setAttribute('stroke', 'rgba(255, 255, 255, 0.1)');
      polygon.setAttribute('stroke-width', '0.004');
      this.quadLayer.appendChild(polygon);
    });

    const connections = this.buildTriangleConnections();

    this.patternLayer.innerHTML = '';
    connections.forEach((segment) => {
      const start = barycentricToCartesian(segment.start);
      const end = barycentricToCartesian(segment.end);
      this.patternLayer.appendChild(makeSvgLine(start, end, '#fef4b4', 0.005));
    });

    this.renderGhosts(connections);
  }

  /**
   * Draw mirrored copies of the pattern across each triangle edge — this is
   * what the pattern looks like on the three adjacent faces of the mesh, so
   * strokes that meet a ghost stroke at the edge will flow continuously on
   * the sphere.
   */
  renderGhosts(connections) {
    this.ghostLayer.innerHTML = '';
    const [a, b, c] = templateTriangle;
    const edges = [
      [a, b],
      [b, c],
      [c, a],
    ];

    edges.forEach(([p1, p2]) => {
      const ghostOutline = document.createElementNS(SVG_NS, 'polygon');
      ghostOutline.setAttribute(
        'points',
        templateTriangle
          .map((vertex) => {
            const r = reflectAcrossLine(vertex, p1, p2);
            return `${r.x},${r.y}`;
          })
          .join(' '),
      );
      ghostOutline.setAttribute('fill', 'none');
      ghostOutline.setAttribute('stroke', 'rgba(255,255,255,0.07)');
      ghostOutline.setAttribute('stroke-width', '0.004');
      this.ghostLayer.appendChild(ghostOutline);

      connections.forEach((segment) => {
        const start = reflectAcrossLine(barycentricToCartesian(segment.start), p1, p2);
        const end = reflectAcrossLine(barycentricToCartesian(segment.end), p1, p2);
        this.ghostLayer.appendChild(makeSvgLine(start, end, 'rgba(254, 244, 180, 0.22)', 0.004));
      });
    });
  }

  buildTriangleConnections() {
    const segments = this.state.quadSegments;
    if (!segments.length) {
      return [];
    }
    const quads = getTessellationQuads(this.state.tessellation);
    const mapped = [];
    quads.forEach((quad) => {
      segments.forEach((segment) => {
        const start = quadUvToBarycentric(quad, segment.start.uv);
        const end = quadUvToBarycentric(quad, segment.end.uv);
        mapped.push({
          id: `${segment.id}-${quad.id}`,
          start,
          end,
        });
        if (this.state.mirror) {
          mapped.push({
            id: `${segment.id}-${quad.id}-m`,
            start: mirrorBarycentric(start),
            end: mirrorBarycentric(end),
          });
        }
      });
    });
    return mapped;
  }

  emitChange() {
    this.persist();
    if (typeof this.onChange !== 'function') {
      return;
    }
    const connections = this.buildTriangleConnections();
    this.onChange({ connections });
  }

  serialize() {
    return {
      version: 1,
      tessellation: this.state.tessellation,
      mirror: this.state.mirror,
      quad: this.quadEditor.serialize(),
    };
  }

  loadData(data) {
    if (!data || typeof data !== 'object') {
      return false;
    }
    if (data.tessellation && getTessellationOptions().some(({ value }) => value === data.tessellation)) {
      this.state.tessellation = data.tessellation;
      this.tessSelect.value = data.tessellation;
    }
    this.state.mirror = data.mirror !== false;
    this.mirrorCheckbox.checked = this.state.mirror;
    this.quadEditor.load(data.quad);
    this.state.quadSegments = this.quadEditor.getSegments();
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
      if (!raw) {
        return;
      }
      this.loadData(JSON.parse(raw));
    } catch {
      // Ignore corrupt saved state.
    }
  }

  exportJson() {
    const blob = new Blob([JSON.stringify(this.serialize(), null, 2)], {
      type: 'application/json',
    });
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
      const data = JSON.parse(await file.text());
      if (this.loadData(data)) {
        this.updatePreview();
        this.emitChange();
      }
    } catch {
      window.alert('Could not read that file as a saved pattern.');
    }
  }

  makeButton(label) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    return button;
  }
}

class QuadEditor {
  constructor(rootEl, { onChange }) {
    this.rootEl = rootEl;
    this.onChange = onChange;
    this.state = {
      selectedAnchorId: null,
      selectedConnectionId: null,
      connections: [],
    };
    this.baseAnchors = createSquareAnchors();
    this.dynamicAnchors = new Map();
    this.midpointAnchors = new Map();
    this.history = [];

    this.handleKeyDown = (event) => {
      if ((event.key === 'Delete' || event.key === 'Backspace') && this.state.selectedConnectionId) {
        this.deleteSelectedConnection();
      }
    };

    this.buildUI();
    this.render();
    window.addEventListener('keydown', this.handleKeyDown);
  }

  buildUI() {
    this.svg = document.createElementNS(SVG_NS, 'svg');
    this.svg.setAttribute('viewBox', '0 0 1 1');
    this.svg.setAttribute('id', 'quad-editor');

    const border = document.createElementNS(SVG_NS, 'rect');
    border.setAttribute('x', '0');
    border.setAttribute('y', '0');
    border.setAttribute('width', '1');
    border.setAttribute('height', '1');
    border.setAttribute('rx', '0.04');
    border.setAttribute('ry', '0.04');
    border.setAttribute('fill', 'rgba(255,255,255,0.02)');
    border.setAttribute('stroke', 'rgba(255,255,255,0.2)');
    border.setAttribute('stroke-width', '0.01');

    this.overlayLines = document.createElementNS(SVG_NS, 'g');
    this.connectionLayer = document.createElementNS(SVG_NS, 'g');
    this.midpointLayer = document.createElementNS(SVG_NS, 'g');
    this.anchorLayer = document.createElementNS(SVG_NS, 'g');

    this.svg.append(border, this.overlayLines, this.connectionLayer, this.midpointLayer, this.anchorLayer);
    this.renderGuides();
    this.rootEl.appendChild(this.svg);
  }

  renderGuides() {
    this.overlayLines.innerHTML = '';
    for (let i = 1; i < 4; i += 1) {
      const t = i / 4;
      const hLine = makeSvgLine({ x: 0, y: t }, { x: 1, y: t }, 'rgba(255,255,255,0.05)', 0.004);
      const vLine = makeSvgLine({ x: t, y: 0 }, { x: t, y: 1 }, 'rgba(255,255,255,0.05)', 0.004);
      this.overlayLines.append(hLine, vLine);
    }
  }

  render() {
    this.renderConnections();
    this.renderAnchors();
  }

  renderConnections() {
    this.connectionLayer.innerHTML = '';
    this.midpointLayer.innerHTML = '';
    this.midpointAnchors.clear();

    this.state.connections.forEach((connection) => {
      const line = makeSvgLine(
        { x: connection.start.uv.u, y: connection.start.uv.v },
        { x: connection.end.uv.u, y: connection.end.uv.v },
        '#fef4b4',
        0.012,
      );
      line.classList.add('connection-line');
      if (connection.id === this.state.selectedConnectionId) {
        line.classList.add('selected');
      }
      line.addEventListener('click', (event) => {
        event.stopPropagation();
        this.handleConnectionSelection(connection.id);
      });
      this.connectionLayer.appendChild(line);

      const midpointId = `mid-${connection.id}`;
      const uv = {
        u: (connection.start.uv.u + connection.end.uv.u) / 2,
        v: (connection.start.uv.v + connection.end.uv.v) / 2,
      };
      this.midpointAnchors.set(midpointId, { id: midpointId, uv, connectionId: connection.id });

      const circle = document.createElementNS(SVG_NS, 'circle');
      circle.setAttribute('cx', uv.u);
      circle.setAttribute('cy', uv.v);
      circle.setAttribute('r', '0.012');
      circle.classList.add('mid-point');
      circle.addEventListener('click', (event) => {
        event.stopPropagation();
        this.handleAnchorSelection(midpointId);
      });
      this.midpointLayer.appendChild(circle);
    });
  }

  renderAnchors() {
    this.anchorLayer.innerHTML = '';
    [...this.baseAnchors.values(), ...this.dynamicAnchors.values()].forEach((anchor) => {
      const circle = document.createElementNS(SVG_NS, 'circle');
      circle.setAttribute('cx', anchor.uv.u);
      circle.setAttribute('cy', anchor.uv.v);
      circle.setAttribute('r', anchor.type === 'base' ? '0.0125' : '0.014');
      circle.classList.add(anchor.type === 'base' ? 'edge-point' : 'anchor-point');
      if (anchor.id === this.state.selectedAnchorId) {
        circle.classList.add('active');
      }
      circle.addEventListener('click', (event) => {
        event.stopPropagation();
        this.handleAnchorSelection(anchor.id);
      });
      this.anchorLayer.appendChild(circle);
    });
  }

  handleAnchorSelection(anchorId) {
    // Clicking a midpoint splits its connection and promotes the midpoint to
    // a real anchor. That mutates connections, so snapshot history first. If
    // another anchor was already selected, connect it to the new anchor.
    if (this.midpointAnchors.has(anchorId)) {
      const previousId = this.state.selectedAnchorId;
      this.pushHistory();
      const anchor = this.getAnchor(anchorId);
      if (!anchor) {
        this.history.pop();
        return;
      }
      const previous = previousId ? this.getAnchor(previousId) : null;
      if (previous && previous.id !== anchor.id) {
        this.state.connections.push({
          id: `seg-${Date.now()}-${this.state.connections.length}`,
          start: cloneAnchor(previous),
          end: cloneAnchor(anchor),
        });
        this.state.selectedAnchorId = null;
      }
      this.render();
      this.emitChange();
      return;
    }

    const anchor = this.getAnchor(anchorId);
    if (!anchor) {
      return;
    }

    if (!this.state.selectedAnchorId) {
      this.state.selectedAnchorId = anchor.id;
      this.renderAnchors();
      return;
    }

    if (this.state.selectedAnchorId === anchor.id) {
      this.state.selectedAnchorId = null;
      this.state.selectedConnectionId = null;
      this.renderAnchors();
      return;
    }

    const previous = this.getAnchor(this.state.selectedAnchorId);
    if (!previous) {
      this.state.selectedAnchorId = anchor.id;
      this.renderAnchors();
      return;
    }

    if (previous.edge !== null && anchor.edge !== null && previous.edge === anchor.edge) {
      this.state.selectedAnchorId = anchor.id;
      this.renderAnchors();
      return;
    }

    this.pushHistory();
    this.state.connections.push({
      id: `seg-${Date.now()}-${this.state.connections.length}`,
      start: cloneAnchor(previous),
      end: cloneAnchor(anchor),
    });
    this.state.selectedAnchorId = null;
    this.state.selectedConnectionId = null;
    this.render();
    this.emitChange();
  }

  handleConnectionSelection(connectionId) {
    if (this.state.selectedConnectionId === connectionId) {
      this.state.selectedConnectionId = null;
    } else {
      this.state.selectedConnectionId = connectionId;
      this.state.selectedAnchorId = null;
    }
    this.renderConnections();
  }

  promoteMidpoint(midpointId) {
    const meta = this.midpointAnchors.get(midpointId);
    if (!meta) {
      return null;
    }
    const index = this.state.connections.findIndex((conn) => conn.id === meta.connectionId);
    if (index === -1) {
      return null;
    }
    const connection = this.state.connections[index];
    const anchorId = `anchor-${meta.connectionId}`;
    const anchor = {
      id: anchorId,
      type: 'interior',
      edge: null,
      uv: meta.uv,
    };
    this.dynamicAnchors.set(anchorId, anchor);

    const first = {
      id: `${connection.id}-a`,
      start: cloneAnchor(connection.start),
      end: cloneAnchor(anchor),
    };
    const second = {
      id: `${connection.id}-b`,
      start: cloneAnchor(anchor),
      end: cloneAnchor(connection.end),
    };

    this.state.connections.splice(index, 1, first, second);
    this.midpointAnchors.delete(midpointId);
    this.state.selectedAnchorId = anchorId;
    return anchor;
  }

  getAnchor(anchorId) {
    if (this.baseAnchors.has(anchorId)) {
      return this.baseAnchors.get(anchorId);
    }
    if (this.dynamicAnchors.has(anchorId)) {
      return this.dynamicAnchors.get(anchorId);
    }
    if (this.midpointAnchors.has(anchorId)) {
      return this.promoteMidpoint(anchorId);
    }
    return null;
  }

  deleteSelectedConnection() {
    if (!this.state.selectedConnectionId) {
      return;
    }
    this.pushHistory();
    this.state.connections = this.state.connections.filter(({ id }) => id !== this.state.selectedConnectionId);
    this.state.selectedConnectionId = null;
    this.render();
    this.emitChange();
  }

  pushHistory() {
    this.history.push({
      connections: this.state.connections.map(cloneConnection),
      dynamicAnchors: [...this.dynamicAnchors.values()].map(cloneAnchor),
    });
    if (this.history.length > 100) {
      this.history.shift();
    }
  }

  undo() {
    if (this.state.selectedAnchorId) {
      this.state.selectedAnchorId = null;
      this.renderAnchors();
      return;
    }
    const snapshot = this.history.pop();
    if (!snapshot) {
      return;
    }
    this.state.connections = snapshot.connections.map(cloneConnection);
    this.dynamicAnchors = new Map(snapshot.dynamicAnchors.map((anchor) => [anchor.id, cloneAnchor(anchor)]));
    this.state.selectedAnchorId = null;
    this.state.selectedConnectionId = null;
    this.render();
    this.emitChange();
  }

  clear() {
    if (!this.state.connections.length && !this.dynamicAnchors.size) {
      return;
    }
    this.pushHistory();
    this.state.connections = [];
    this.state.selectedAnchorId = null;
    this.state.selectedConnectionId = null;
    this.dynamicAnchors.clear();
    this.render();
    this.emitChange();
  }

  getSegments() {
    return this.state.connections.map((connection) => ({
      id: connection.id,
      start: { uv: { ...connection.start.uv } },
      end: { uv: { ...connection.end.uv } },
    }));
  }

  serialize() {
    return {
      connections: this.state.connections.map(cloneConnection),
      dynamicAnchors: [...this.dynamicAnchors.values()].map(cloneAnchor),
    };
  }

  load(data) {
    this.state.connections = Array.isArray(data?.connections)
      ? data.connections.map(cloneConnection)
      : [];
    this.dynamicAnchors = new Map(
      (Array.isArray(data?.dynamicAnchors) ? data.dynamicAnchors : []).map((anchor) => [
        anchor.id,
        cloneAnchor(anchor),
      ]),
    );
    this.state.selectedAnchorId = null;
    this.state.selectedConnectionId = null;
    this.history = [];
    this.render();
  }

  emitChange() {
    if (typeof this.onChange === 'function') {
      this.onChange(this.getSegments());
    }
  }
}

function createSquareAnchors(divisions = 4) {
  const anchors = new Map();
  const edges = [
    { id: 'top', start: { u: 0, v: 0 }, end: { u: 1, v: 0 } },
    { id: 'right', start: { u: 1, v: 0 }, end: { u: 1, v: 1 } },
    { id: 'bottom', start: { u: 1, v: 1 }, end: { u: 0, v: 1 } },
    { id: 'left', start: { u: 0, v: 1 }, end: { u: 0, v: 0 } },
  ];

  edges.forEach((edge, edgeIndex) => {
    for (let i = 0; i <= divisions; i += 1) {
      const t = i / divisions;
      const uv = {
        u: edge.start.u * (1 - t) + edge.end.u * t,
        v: edge.start.v * (1 - t) + edge.end.v * t,
      };
      const id = `edge-${edge.id}-${i}`;
      anchors.set(id, {
        id,
        type: 'base',
        edge: edgeIndex,
        uv,
      });
    }
  });

  return anchors;
}

function cloneAnchor(anchor) {
  return {
    id: anchor.id,
    type: anchor.type,
    edge: anchor.edge ?? null,
    uv: { ...anchor.uv },
  };
}

function cloneConnection(connection) {
  return {
    id: connection.id,
    start: cloneAnchor(connection.start),
    end: cloneAnchor(connection.end),
  };
}

function makeSvgLine(start, end, stroke, strokeWidth) {
  const line = document.createElementNS(SVG_NS, 'line');
  line.setAttribute('x1', start.x);
  line.setAttribute('y1', start.y);
  line.setAttribute('x2', end.x);
  line.setAttribute('y2', end.y);
  line.setAttribute('stroke', stroke);
  line.setAttribute('stroke-width', strokeWidth);
  line.setAttribute('stroke-linecap', 'round');
  return line;
}

function reflectAcrossLine(point, p1, p2) {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const lengthSq = dx * dx + dy * dy;
  const t = ((point.x - p1.x) * dx + (point.y - p1.y) * dy) / lengthSq;
  const projX = p1.x + t * dx;
  const projY = p1.y + t * dy;
  return { x: 2 * projX - point.x, y: 2 * projY - point.y };
}
