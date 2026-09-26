import { icon } from './icons.js';

const SECTION_STORAGE_KEY = 'sphere-ui-sections';

function el(tag, className, html) {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (html !== undefined) {
    node.innerHTML = html;
  }
  return node;
}

function readSections() {
  try {
    return JSON.parse(localStorage.getItem(SECTION_STORAGE_KEY)) ?? {};
  } catch {
    return {};
  }
}

function writeSection(id, open) {
  try {
    localStorage.setItem(SECTION_STORAGE_KEY, JSON.stringify({ ...readSections(), [id]: open }));
  } catch {
    // Remembering open sections is best-effort.
  }
}

/** Coalesce bursts of input (slider drags) into at most one call per frame. */
function perFrame(fn) {
  let queued = false;
  return () => {
    if (queued) {
      return;
    }
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn();
    });
  };
}

const decimalsOf = (step) => (String(step).split('.')[1] ?? '').length;

class Control {
  constructor(root) {
    this.el = root;
  }

  show(visible = true) {
    this.el.hidden = !visible;
    return this;
  }

  refresh() {}
}

/** Wraps a control with a label above and an optional hint below. */
function field(label, body, hint) {
  const wrap = el('div', 'field');
  if (label) {
    const text = el('div', 'field-label');
    text.textContent = label;
    wrap.append(text);
  }
  wrap.append(body);
  const hintEl = el('p', 'field-hint');
  hintEl.hidden = !hint;
  hintEl.textContent = hint ?? '';
  wrap.append(hintEl);
  return { wrap, hintEl };
}

function withHint(control, hintEl) {
  control.setHint = (text) => {
    hintEl.hidden = !text;
    hintEl.textContent = text ?? '';
  };
  return control;
}

/**
 * A column of controls bound to plain objects. Every group shares its root's
 * control list, so `refresh()` on any group re-reads every bound value.
 */
export class ControlGroup {
  constructor(root, owner = null) {
    this.el = root;
    this.frame = root;
    this.owner = owner ?? this;
    if (!owner) {
      this.all = [];
    }
  }

  add(control) {
    this.el.appendChild(control.el);
    this.owner.all.push(control);
    control.refresh();
    return control;
  }

  refresh() {
    this.owner.all.forEach((control) => control.refresh());
  }

  /** Runs a control's callback, then the root's `onAnyChange` hook. */
  changed(onChange, value) {
    onChange?.(value);
    this.owner.onAnyChange?.();
  }

  show(visible = true) {
    this.frame.hidden = !visible;
    return this;
  }

  /** A group rendering into an existing element, refreshed with this one. */
  group(root) {
    return new ControlGroup(root, this.owner);
  }

  /** Lay the next controls out side by side. */
  inline() {
    const row = el('div', 'inline-row');
    this.el.appendChild(row);
    return new ControlGroup(row, this.owner);
  }

  /** A collapsible section; its open state is remembered across reloads. */
  section(title, { id = title, open = true } = {}) {
    const isOpen = readSections()[id] ?? open;
    const section = el('section', 'panel-section');
    const header = el('button', 'section-header', `<span>${title}</span>${icon('chevron')}`);
    header.type = 'button';
    header.setAttribute('aria-expanded', String(isOpen));
    const body = el('div', 'section-body');
    section.classList.toggle('collapsed', !isOpen);
    section.append(header, body);
    header.addEventListener('click', () => {
      const collapsed = section.classList.toggle('collapsed');
      header.setAttribute('aria-expanded', String(!collapsed));
      writeSection(id, !collapsed);
    });
    this.el.appendChild(section);
    const group = new ControlGroup(body, this.owner);
    group.frame = section;
    return group;
  }

  toggle(obj, key, { label, hint, onChange } = {}) {
    const button = el('button', 'toggle', `<span class="toggle-label"></span><span class="switch"><span class="switch-thumb"></span></span>`);
    button.type = 'button';
    button.setAttribute('role', 'switch');
    button.querySelector('.toggle-label').textContent = label;
    const { wrap, hintEl } = field(null, button, hint);
    const control = withHint(new Control(wrap), hintEl);
    control.refresh = () => button.setAttribute('aria-checked', String(Boolean(obj[key])));
    button.addEventListener('click', () => {
      obj[key] = !obj[key];
      control.refresh();
      this.changed(onChange, obj[key]);
    });
    return this.add(control);
  }

  /**
   * A slider over [min, max] with a text box beside it. The box accepts any
   * value within `limits` (defaults to the slider range), so typed values
   * can go past the slider's ends.
   */
  slider(obj, key, { label, min, max, step = 1, unit = '', hint, limits = [min, max], integer = false, onChange } = {}) {
    const decimals = decimalsOf(step);
    const [lo, hi] = limits;
    // Typed values keep up to 3 decimals; on-step values show the step's precision.
    const format = (v) => {
      const fixed = v.toFixed(decimals);
      return Math.abs(Number(fixed) - v) < 1e-9 ? fixed : String(Number(v.toFixed(3)));
    };
    const body = el('div', 'slider-field');
    const head = el('div', 'slider-head');
    const name = el('span', 'field-label');
    name.textContent = label;
    const valueWrap = el('label', 'slider-value');
    const value = el('input');
    value.type = 'text';
    value.inputMode = 'decimal';
    value.setAttribute('aria-label', label);
    valueWrap.append(value);
    if (unit) {
      valueWrap.append(el('span', 'slider-unit', unit));
    }
    head.append(name, valueWrap);
    const range = el('input', 'slider');
    Object.assign(range, { type: 'range', min, max, step });
    range.setAttribute('aria-label', label);
    body.append(head, range);
    const { wrap, hintEl } = field(null, body, hint);
    const control = withHint(new Control(wrap), hintEl);

    const beyondTitle = `Slider covers ${min}–${max}${unit ? ` ${unit}` : ''}; type any value from ${lo} to ${hi}.`;
    valueWrap.title = beyondTitle;

    const fire = perFrame(() => this.changed(onChange, obj[key]));
    const set = (n) => {
      const clamped = Math.min(hi, Math.max(lo, n));
      obj[key] = integer ? Math.round(clamped) : Number(clamped.toFixed(3));
      control.refresh();
      fire();
    };
    control.refresh = () => {
      const v = obj[key];
      range.value = v;
      const fill = Math.min(100, Math.max(0, ((v - min) / (max - min)) * 100));
      range.style.setProperty('--fill', `${fill}%`);
      valueWrap.classList.toggle('beyond', v < min || v > max);
      if (document.activeElement !== value) {
        value.value = format(Number(v));
      }
    };
    range.addEventListener('input', () => set(Number(Number(range.value).toFixed(decimals))));
    value.addEventListener('change', () => {
      const n = parseFloat(value.value);
      if (Number.isFinite(n)) {
        set(n);
      }
      value.value = format(Number(obj[key]));
    });
    value.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        value.blur();
      } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        set(obj[key] + (event.key === 'ArrowUp' ? step : -step) * (event.shiftKey ? 10 : 1));
        value.value = format(Number(obj[key]));
      }
    });
    value.addEventListener('focus', () => value.select());
    return this.add(control);
  }

  segmented(obj, key, { label, options, hint, onChange, className = '' } = {}) {
    const bar = el('div', `segmented ${className}`);
    bar.setAttribute('role', 'radiogroup');
    if (label) {
      bar.setAttribute('aria-label', label);
    }
    const buttons = options.map((option) => {
      const button = el('button', 'segment', `${option.icon ? icon(option.icon) : ''}<span></span>`);
      button.type = 'button';
      button.setAttribute('role', 'radio');
      button.querySelector('span').textContent = option.label;
      if (option.title) {
        button.title = option.title;
      }
      button.addEventListener('click', () => {
        if (obj[key] !== option.value) {
          obj[key] = option.value;
          control.refresh();
          this.changed(onChange, option.value);
        }
      });
      bar.append(button);
      return button;
    });
    const { wrap, hintEl } = field(label, bar, hint);
    const control = withHint(new Control(wrap), hintEl);
    control.refresh = () =>
      buttons.forEach((button, i) => {
        const active = options[i].value === obj[key];
        button.classList.toggle('active', active);
        button.setAttribute('aria-checked', String(active));
      });
    control.setDisabled = (value, disabled) => {
      const i = options.findIndex((option) => option.value === value);
      if (i >= 0) {
        buttons[i].disabled = disabled;
      }
    };
    return this.add(control);
  }

  /** Larger two-line choices laid out in a grid. */
  tiles(obj, key, { label, options, hint, onChange } = {}) {
    const grid = el('div', 'tiles');
    grid.setAttribute('role', 'radiogroup');
    const buttons = options.map((option) => {
      const button = el('button', 'tile', '<span class="tile-title"></span><span class="tile-detail"></span>');
      button.type = 'button';
      button.setAttribute('role', 'radio');
      button.querySelector('.tile-title').textContent = option.label;
      button.querySelector('.tile-detail').textContent = option.detail ?? '';
      button.addEventListener('click', () => {
        if (obj[key] !== option.value) {
          obj[key] = option.value;
          control.refresh();
          this.changed(onChange, option.value);
        }
      });
      grid.append(button);
      return button;
    });
    const { wrap, hintEl } = field(label, grid, hint);
    const control = withHint(new Control(wrap), hintEl);
    control.refresh = () =>
      buttons.forEach((button, i) => {
        const active = options[i].value === obj[key];
        button.classList.toggle('active', active);
        button.setAttribute('aria-checked', String(active));
      });
    return this.add(control);
  }

  swatches(obj, key, { label, colors, onChange } = {}) {
    const row = el('div', 'swatches');
    const buttons = colors.map((color) => {
      const button = el('button', 'swatch');
      button.type = 'button';
      button.style.setProperty('--swatch', color);
      button.title = color;
      button.addEventListener('click', () => {
        obj[key] = color;
        control.refresh();
        this.changed(onChange, color);
      });
      row.append(button);
      return button;
    });
    const custom = el('label', 'swatch swatch-custom');
    custom.title = 'Custom color';
    const picker = el('input');
    picker.type = 'color';
    custom.append(picker);
    row.append(custom);
    const fire = perFrame(() => this.changed(onChange, obj[key]));
    picker.addEventListener('input', () => {
      obj[key] = picker.value;
      control.refresh();
      fire();
    });
    const { wrap, hintEl } = field(label, row);
    const control = withHint(new Control(wrap), hintEl);
    control.refresh = () => {
      const current = String(obj[key]).toLowerCase();
      let matched = false;
      buttons.forEach((button, i) => {
        const active = colors[i].toLowerCase() === current;
        matched ||= active;
        button.classList.toggle('active', active);
      });
      custom.classList.toggle('active', !matched);
      custom.style.setProperty('--swatch', matched ? 'transparent' : current);
      picker.value = current;
    };
    return this.add(control);
  }

  select(obj, key, { label, options, hint, onChange } = {}) {
    const select = el('select', 'select');
    options.forEach(({ value, label: text }) => {
      const option = el('option');
      option.value = value;
      option.textContent = text;
      select.append(option);
    });
    select.addEventListener('change', () => {
      obj[key] = select.value;
      this.changed(onChange, select.value);
    });
    const { wrap, hintEl } = field(label, select, hint);
    const control = withHint(new Control(wrap), hintEl);
    control.refresh = () => {
      select.value = obj[key];
    };
    return this.add(control);
  }

  button({ label, icon: iconName, variant = 'secondary', title, onClick } = {}) {
    const button = el('button', `btn btn-${variant}`);
    button.type = 'button';
    if (title) {
      button.title = title;
    }
    button.addEventListener('click', () => onClick?.());
    const control = new Control(button);
    control.setLabel = (text, nextIcon = iconName) => {
      button.innerHTML = `${nextIcon ? icon(nextIcon) : ''}<span></span>`;
      button.querySelector('span').textContent = text;
    };
    control.setDisabled = (disabled) => {
      button.disabled = disabled;
    };
    control.setBusy = (busy) => {
      button.classList.toggle('busy', busy);
      button.disabled = busy;
    };
    control.setLabel(label);
    return this.add(control);
  }

  /** A line of explanatory text; `tone` is 'ok', 'warn', or undefined. */
  note(text = '', tone) {
    const p = el('p', 'note');
    const control = new Control(p);
    control.set = (message, nextTone) => {
      p.hidden = !message;
      p.textContent = message ?? '';
      p.dataset.tone = nextTone ?? '';
    };
    control.set(text, tone);
    return this.add(control);
  }
}
