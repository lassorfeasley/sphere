// Spacings (percent of the line) the faint gridlines step through, picked
// so roughly this many fit across the ruler.
const GRID_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20];
const GRID_LINES = 8;
// Within this many pixels of the needle, dragging snaps onto a tick.
const SNAP_PX = 7;
// A press that moves less than this is a click, not a drag.
const CLICK_PX = 4;
const MIN_SPAN = 2;
const MAX_SPAN = 100;

const TICK_STYLES = {
  crossing: { color: '#ffd166', height: 0.62, width: 2.5 },
  midpoint: { color: '#ff7fd0', height: 0.46, width: 2.5 },
  minor: { color: 'rgba(236, 238, 242, 0.45)', height: 0.26, width: 1 },
};

/**
 * A wide tape-measure scale for the loop's position along its line, floating
 * over the viewport. The tape slides under a fixed needle in the middle (the
 * loop): drag it or scroll on it to move the loop, click a tick to jump
 * there, and pinch or Ctrl-scroll to zoom. Arrow keys jump between ticks,
 * Shift+arrows nudge by 0.1%. Ticks are crossings (yellow), points halfway
 * between crossings (pink), and other handy stops (faint); dragging snaps
 * onto them (hold Alt to move freely). Stretches where the loop doesn't fit
 * are tinted.
 *
 * `onInput(percent)` fires at most once per frame while the value changes;
 * `onActivity()` fires on every interaction.
 */
export class PositionRuler {
  constructor(parent, { onInput, onActivity } = {}) {
    this.onInput = onInput;
    this.onActivity = onActivity;
    this.value = 0;
    this.span = 16;
    this.closed = false;
    this.ticks = [];
    this.bands = null;
    this.pending = null;

    this.el = document.createElement('div');
    this.el.className = 'position-ruler';
    this.el.hidden = true;
    this.el.tabIndex = 0;
    this.el.setAttribute('role', 'slider');
    this.el.setAttribute('aria-label', 'Loop position');
    this.el.title =
      'Drag or scroll to move the loop along its line; click a tick to jump to it. ' +
      'Pinch or Ctrl-scroll to zoom. Arrow keys jump between ticks, Shift+arrows nudge.';
    this.canvas = document.createElement('canvas');
    this.readout = document.createElement('div');
    this.readout.className = 'position-ruler-readout';
    this.el.append(this.readout, this.canvas);
    parent.append(this.el);

    this.listen();
    new ResizeObserver(() => this.draw()).observe(this.el);
  }

  /** `ticks`: [{ value (percent), kind: 'crossing' | 'midpoint' | 'minor' }]; `bands`: [[from, to]] percent where the loop fits. */
  setData({ value, ticks, bands, closed }) {
    this.ticks = [...ticks].sort((a, b) => a.value - b.value);
    this.bands = bands;
    this.closed = closed;
    this.setValue(value);
  }

  setValue(value) {
    if (this.drag) {
      return;
    }
    this.value = value;
    this.draw();
  }

  show(visible) {
    if (this.el.hidden === !visible) {
      return;
    }
    this.el.hidden = !visible;
    if (visible) {
      this.draw();
    }
  }

  // Percent per pixel at the current zoom.
  get scale() {
    return this.span / Math.max(1, this.canvas.clientWidth);
  }

  normalize(value) {
    return this.closed ? ((value % 100) + 100) % 100 : Math.min(100, Math.max(0, value));
  }

  /** Signed distance (percent) from the needle to `value`, the short way round on a closed line. */
  offset(value) {
    let d = value - this.value;
    if (this.closed) {
      d = ((((d + 50) % 100) + 100) % 100) - 50;
    }
    return d;
  }

  set(value, { snap = false } = {}) {
    let next = this.normalize(value);
    if (snap) {
      const reach = SNAP_PX * this.scale;
      const previous = this.value;
      this.value = next;
      const nearest = this.nearestTick(0, reach);
      this.value = previous;
      if (nearest) {
        next = nearest.value;
      }
    }
    if (next === this.value) {
      return;
    }
    this.value = next;
    this.draw();
    this.emit();
  }

  /** The tick nearest `atOffset` (percent from the needle) within `reach`, or null. */
  nearestTick(atOffset, reach) {
    let best = null;
    this.ticks.forEach((tick) => {
      const distance = Math.abs(this.offset(tick.value) - atOffset);
      if (distance <= reach && (!best || distance < best.distance)) {
        best = { ...tick, distance };
      }
    });
    return best;
  }

  /** The next tick past the needle in `direction` (±1). */
  stepTick(direction) {
    let best = null;
    this.ticks.forEach((tick) => {
      const d = this.offset(tick.value) * direction;
      if (d > 1e-6 && (!best || d < best.d)) {
        best = { tick, d };
      }
    });
    return best?.tick ?? null;
  }

  emit() {
    if (this.pending !== null) {
      this.pending = this.value;
      return;
    }
    this.pending = this.value;
    requestAnimationFrame(() => {
      const value = this.pending;
      this.pending = null;
      this.onInput?.(Number(value.toFixed(3)));
    });
  }

  listen() {
    const { el } = this;
    el.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) {
        return;
      }
      el.setPointerCapture(event.pointerId);
      el.focus({ preventScroll: true });
      this.drag = { x: event.clientX, start: this.value, moved: false };
      this.onActivity?.();
    });
    el.addEventListener('pointermove', (event) => {
      const { drag } = this;
      if (!drag) {
        return;
      }
      const dx = event.clientX - drag.x;
      if (!drag.moved && Math.abs(dx) < CLICK_PX) {
        return;
      }
      drag.moved = true;
      this.set(drag.start - dx * this.scale, { snap: !event.altKey });
      this.onActivity?.();
    });
    const release = (event) => {
      const { drag } = this;
      this.drag = null;
      if (drag && !drag.moved && event.type === 'pointerup') {
        const rect = this.canvas.getBoundingClientRect();
        const atOffset = (event.clientX - rect.left - rect.width / 2) * this.scale;
        const tick = this.nearestTick(atOffset, 10 * this.scale);
        this.set(tick ? tick.value : this.value + atOffset);
      }
      this.onActivity?.();
    };
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        if (event.ctrlKey) {
          this.span = Math.min(MAX_SPAN, Math.max(MIN_SPAN, this.span * Math.exp(event.deltaY * 0.01)));
          this.draw();
        } else {
          const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
          this.set(this.value + delta * this.scale, { snap: !event.altKey });
        }
        this.onActivity?.();
      },
      { passive: false },
    );
    el.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
        return;
      }
      event.preventDefault();
      const direction = event.key === 'ArrowRight' ? 1 : -1;
      if (event.shiftKey) {
        this.set(this.value + 0.1 * direction);
      } else {
        const tick = this.stepTick(direction);
        if (tick) {
          this.set(tick.value);
        }
      }
      this.onActivity?.();
    });
  }

  draw() {
    if (this.el.hidden) {
      return;
    }
    const { canvas } = this;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) {
      return;
    }
    const ratio = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const center = width / 2;
    const scale = this.scale;
    const xOf = (offset) => center + offset / scale;
    const baseline = height - 18;
    const half = this.span / 2;

    // Every copy of a position visible on screen (a closed line repeats).
    const visible = (value, fn) => {
      const shifts = this.closed ? [-100, 0, 100] : [0];
      shifts.forEach((shift) => {
        const offset = value + shift - this.value;
        if (offset >= -half - 1 && offset <= half + 1) {
          fn(offset);
        }
      });
    };

    // Past the ends of an open line.
    if (!this.closed) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
      const start = xOf(-this.value);
      const end = xOf(100 - this.value);
      if (start > 0) {
        ctx.fillRect(0, 0, start, height);
      }
      if (end < width) {
        ctx.fillRect(end, 0, width - end, height);
      }
    }

    // Tint where the loop doesn't fit.
    if (this.bands) {
      const blocked = [];
      let at = 0;
      [...this.bands]
        .sort((a, b) => a[0] - b[0])
        .forEach(([from, to]) => {
          if (from > at) {
            blocked.push([at, from]);
          }
          at = Math.max(at, to);
        });
      if (at < 100) {
        blocked.push([at, 100]);
      }
      ctx.fillStyle = 'rgba(255, 178, 122, 0.12)';
      blocked.forEach(([from, to]) => {
        (this.closed ? [-100, 0, 100] : [0]).forEach((shift) => {
          ctx.fillRect(xOf(from + shift - this.value), 6, (to - from) / scale, baseline - 6);
        });
      });
    }

    // Gridlines with percent labels.
    const step = GRID_STEPS.find((s) => this.span / s <= GRID_LINES * 1.5) ?? 20;
    ctx.font = '10.5px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    const first = Math.floor((this.value - half) / step) * step;
    for (let v = first; v <= this.value + half + step; v += step) {
      const x = xOf(v - this.value);
      const shown = this.closed ? ((v % 100) + 100) % 100 : v;
      if (!this.closed && (v < -1e-9 || v > 100 + 1e-9)) {
        continue;
      }
      ctx.fillStyle = 'rgba(236, 238, 242, 0.14)';
      ctx.fillRect(Math.round(x), 6, 1, baseline - 6);
      ctx.fillStyle = 'rgba(236, 238, 242, 0.5)';
      ctx.fillText(`${Number(shown.toFixed(1))}%`, x, height - 4);
    }

    // Baseline.
    ctx.fillStyle = 'rgba(236, 238, 242, 0.3)';
    ctx.fillRect(0, baseline, width, 1);

    // Ticks, faint ones first.
    const order = { minor: 0, midpoint: 1, crossing: 2 };
    [...this.ticks]
      .sort((a, b) => order[a.kind] - order[b.kind])
      .forEach((tick) => {
        const style = TICK_STYLES[tick.kind];
        visible(tick.value, (offset) => {
          const x = xOf(offset);
          const tall = (baseline - 6) * style.height;
          ctx.fillStyle = style.color;
          ctx.fillRect(x - style.width / 2, baseline - tall, style.width, tall);
          if (tick.kind !== 'minor') {
            ctx.beginPath();
            ctx.arc(x, baseline - tall, 3.5, 0, Math.PI * 2);
            ctx.fill();
          }
        });
      });

    // Needle: the loop.
    const onTick = this.nearestTick(0, 1e-3);
    ctx.fillStyle = onTick && onTick.kind !== 'minor' ? '#5ce08a' : '#8ae5ff';
    ctx.fillRect(center - 1, 0, 2, baseline + 4);
    ctx.beginPath();
    ctx.moveTo(center - 6, 0);
    ctx.lineTo(center + 6, 0);
    ctx.lineTo(center, 7);
    ctx.fill();

    const label = onTick?.kind === 'crossing' ? ' · on a crossing' : onTick?.kind === 'midpoint' ? ' · halfway between crossings' : '';
    this.readout.textContent = `${this.value.toFixed(1)}%${label}`;
    this.readout.classList.toggle('centered', Boolean(label));
    this.el.setAttribute('aria-valuenow', this.value.toFixed(1));
  }
}
