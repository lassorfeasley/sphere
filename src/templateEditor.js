import {
  barycentricToCartesian,
  getTessellationOptions,
  getTessellationQuads,
  quadUvToBarycentric,
  templateTriangle,
} from './templateSpace.js';

const TRI_HEIGHT = templateTriangle[1].y;
const DEFAULT_TESSELLATION = 'triforce';

export class TemplateEditor {
  constructor(rootEl, { onChange } = {}) {
    this.rootEl = rootEl;
    this.onChange = onChange;
    this.state = {
      tessellation: DEFAULT_TESSELLATION,
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

    this.undoButton = this.makeButton('Undo');
    this.clearButton = this.makeButton('Clear');

    toolbar.append(tessLabel, this.undoButton, this.clearButton);

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
    this.previewSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.previewSvg.setAttribute('viewBox', `0 0 1 ${TRI_HEIGHT}`);
    this.previewSvg.setAttribute('id', 'triangle-preview');

    const outline = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    outline.setAttribute('points', templateTriangle.map(({ x, y }) => `${x},${y}`).join(' '));
    outline.setAttribute('fill', 'rgba(255,255,255,0.01)');
    outline.setAttribute('stroke', 'rgba(255,255,255,0.18)');
    outline.setAttribute('stroke-width', '0.003');

    this.quadLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    this.patternLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');

    this.previewSvg.append(outline, this.quadLayer, this.patternLayer);
    this.previewRoot.appendChild(this.previewSvg);
  }

  updatePreview() {
    const quads = getTessellationQuads(this.state.tessellation);
    this.quadLayer.innerHTML = '';
    quads.forEach((quad) => {
      const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      polygon.setAttribute(
        'points',
        quad.corners.map(({ cartesian }) => `${cartesian.x},${cartesian.y}`).join(' '),
      );
      polygon.setAttribute('fill', 'rgba(157, 222, 255, 0.05)');
      polygon.setAttribute('stroke', 'rgba(255, 255, 255, 0.1)');
      polygon.setAttribute('stroke-width', '0.0025');
      this.quadLayer.appendChild(polygon);
    });

    this.patternLayer.innerHTML = '';
    const connections = this.buildTriangleConnections();
    connections.forEach((segment) => {
      const start = barycentricToCartesian(segment.start);
      const end = barycentricToCartesian(segment.end);
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', start.x);
      line.setAttribute('y1', start.y);
      line.setAttribute('x2', end.x);
      line.setAttribute('y2', end.y);
      line.setAttribute('stroke', '#fef4b4');
      line.setAttribute('stroke-width', '0.0025');
      line.setAttribute('stroke-linecap', 'round');
      this.patternLayer.appendChild(line);
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
        mapped.push({
          id: `${segment.id}-${quad.id}`,
          start: quadUvToBarycentric(quad, segment.start.uv),
          end: quadUvToBarycentric(quad, segment.end.uv),
        });
      });
    });
    return mapped;
  }

  emitChange() {
    if (typeof this.onChange !== 'function') {
      return;
    }
    const connections = this.buildTriangleConnections();
    this.onChange({ connections });
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
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('viewBox', '0 0 1 1');
    this.svg.setAttribute('id', 'quad-editor');

    const border = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    border.setAttribute('x', '0');
    border.setAttribute('y', '0');
    border.setAttribute('width', '1');
    border.setAttribute('height', '1');
    border.setAttribute('rx', '0.04');
    border.setAttribute('ry', '0.04');
    border.setAttribute('fill', 'rgba(255,255,255,0.02)');
    border.setAttribute('stroke', 'rgba(255,255,255,0.2)');
    border.setAttribute('stroke-width', '0.01');

    this.overlayLines = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    this.connectionLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    this.midpointLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    this.anchorLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');

    this.svg.append(border, this.overlayLines, this.connectionLayer, this.midpointLayer, this.anchorLayer);
    this.renderGuides();
    this.rootEl.appendChild(this.svg);
  }

  renderGuides() {
    this.overlayLines.innerHTML = '';
    for (let i = 1; i < 4; i += 1) {
      const t = i / 4;
      const hLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      hLine.setAttribute('x1', 0);
      hLine.setAttribute('y1', t);
      hLine.setAttribute('x2', 1);
      hLine.setAttribute('y2', t);
      hLine.setAttribute('stroke', 'rgba(255,255,255,0.05)');
      hLine.setAttribute('stroke-width', '0.004');
      this.overlayLines.appendChild(hLine);

      const vLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      vLine.setAttribute('x1', t);
      vLine.setAttribute('y1', 0);
      vLine.setAttribute('x2', t);
      vLine.setAttribute('y2', 1);
      vLine.setAttribute('stroke', 'rgba(255,255,255,0.05)');
      vLine.setAttribute('stroke-width', '0.004');
      this.overlayLines.appendChild(vLine);
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
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', connection.start.uv.u);
      line.setAttribute('y1', connection.start.uv.v);
      line.setAttribute('x2', connection.end.uv.u);
      line.setAttribute('y2', connection.end.uv.v);
      line.setAttribute('stroke', '#fef4b4');
      line.setAttribute('stroke-linecap', 'round');
      line.setAttribute('stroke-width', '0.012');
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

      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
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
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
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
    this.state.connections = this.state.connections.filter(({ id }) => id !== this.state.selectedConnectionId);
    this.state.selectedConnectionId = null;
    this.render();
    this.emitChange();
  }

  undo() {
    if (this.state.selectedAnchorId) {
      this.state.selectedAnchorId = null;
      this.renderAnchors();
      return;
    }
    this.state.connections.pop();
    this.state.selectedConnectionId = null;
    this.render();
    this.emitChange();
  }

  clear() {
    this.state.connections = [];
    this.state.selectedAnchorId = null;
    this.state.selectedConnectionId = null;
    this.dynamicAnchors.clear();
    this.render();
    this.emitChange();
  }

  emitChange() {
    if (typeof this.onChange === 'function') {
      this.onChange(
        this.state.connections.map((connection) => ({
          id: connection.id,
          start: { uv: { ...connection.start.uv } },
          end: { uv: { ...connection.end.uv } },
        })),
      );
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
