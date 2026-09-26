import { outline } from '../tubes.js';
import { strutProfile } from '../printSettings.js';

// ViewBox layout, in px: the profile is drawn to scale inside a plot area,
// leaving room for the width dimension below and the height dimension at
// the right.
const VIEW_W = 260;
const VIEW_H = 138;
const CX = 112;
const CY = 58;
const MAX_HALF_W = 76;
const MAX_HALF_H = 38;

const fmt = (v) => String(Number(v.toFixed(2)));

/**
 * A live, to-scale drawing of the strut cross-section — the exact faceted
 * outline the struts extrude, sitting on the sphere surface it curves over.
 * Control-compatible: add it to a ControlGroup and any `refresh()` redraws.
 *
 * @param getParams Returns the current print params ({ widthMm, heightMm,
 *   roundness, diameterMm }).
 */
export function createProfilePreview(getParams) {
  const el = document.createElement('div');
  el.className = 'profile-preview';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${VIEW_W} ${VIEW_H}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Strut cross-section preview');
  el.appendChild(svg);

  const refresh = () => {
    const p = getParams();
    const profile = strutProfile(p, 1); // millimeters
    const scale = Math.min(MAX_HALF_W / profile.halfWidth, MAX_HALF_H / profile.halfHeight);
    const halfW = profile.halfWidth * scale;
    const halfH = profile.halfHeight * scale;
    const parts = [];

    // The sphere surface, through the profile's center: the strut stands
    // half out of it, half in. Drawn at the same scale so bigger struts on
    // smaller spheres visibly hug a tighter curve.
    const sphereR = (p.diameterMm / 2) * scale;
    const halfSpan = Math.min(CX - 10, halfW + 42);
    const sag = sphereR - Math.sqrt(Math.max(0, sphereR * sphereR - halfSpan * halfSpan));
    parts.push(
      `<path d="M ${CX - halfSpan} ${CY + sag} A ${sphereR} ${sphereR} 0 0 1 ${CX + halfSpan} ${CY + sag}"
        fill="none" stroke="var(--text-faint)" stroke-width="1" stroke-dasharray="4 4"/>`,
      `<text x="${CX - halfSpan}" y="${CY + sag + 12}" class="pp-faint">surface</text>`,
      `<text x="${CX - halfSpan}" y="${CY + sag - halfH - 6}" class="pp-faint">out</text>`,
    );

    // The cross-section itself: the same faceted outline the geometry
    // extrudes, so corner curvature shows exactly as it will print.
    const points = outline({
      halfWidth: halfW,
      halfHeight: halfH,
      corner: profile.corner * scale,
    });
    const path = points
      .map(({ x, z }, i) => `${i ? 'L' : 'M'} ${(CX + x).toFixed(2)} ${(CY - z).toFixed(2)}`)
      .join(' ');
    parts.push(
      `<path d="${path} Z" fill="var(--accent-soft)" stroke="var(--accent)" stroke-width="1.5" stroke-linejoin="round"/>`,
    );

    // Width dimension below, height dimension at the right.
    const dimY = CY + halfH + 12;
    parts.push(
      `<g class="pp-dim">
        <line x1="${CX - halfW}" y1="${dimY}" x2="${CX + halfW}" y2="${dimY}"/>
        <line x1="${CX - halfW}" y1="${dimY - 3.5}" x2="${CX - halfW}" y2="${dimY + 3.5}"/>
        <line x1="${CX + halfW}" y1="${dimY - 3.5}" x2="${CX + halfW}" y2="${dimY + 3.5}"/>
      </g>`,
      `<text x="${CX}" y="${dimY + 13}" text-anchor="middle" class="pp-label">${fmt(p.widthMm)} mm</text>`,
    );
    const dimX = CX + halfW + 12;
    parts.push(
      `<g class="pp-dim">
        <line x1="${dimX}" y1="${CY - halfH}" x2="${dimX}" y2="${CY + halfH}"/>
        <line x1="${dimX - 3.5}" y1="${CY - halfH}" x2="${dimX + 3.5}" y2="${CY - halfH}"/>
        <line x1="${dimX - 3.5}" y1="${CY + halfH}" x2="${dimX + 3.5}" y2="${CY + halfH}"/>
      </g>`,
      `<text x="${dimX + 6}" y="${CY}" dominant-baseline="middle" class="pp-label">${fmt(p.heightMm)} mm</text>`,
    );

    // The corner radius set by Roundness — the curve the user is tuning.
    const cornerMm = profile.corner;
    if (cornerMm > 0.005) {
      parts.push(
        `<text x="10" y="${VIEW_H - 8}" class="pp-faint">corner r ${fmt(cornerMm)} mm</text>`,
      );
    }

    svg.innerHTML = parts.join('');
  };

  return {
    el,
    refresh,
    show(visible = true) {
      el.hidden = !visible;
      return this;
    },
  };
}
