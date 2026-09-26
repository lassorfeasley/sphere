import { Vector3 } from 'three';

// Defaults suit a hanging ornament: round struts about 3.5% of the diameter
// print cleanly in FDM, and woven crossings read like the original SketchUp
// line spheres.
export const DEFAULT_PRINT = {
  diameterMm: 70,
  // Strut cross-section: width across the surface, height out from it, and
  // roundness from 0 (crisp rectangle) to 1 (fully rounded: circle or pill).
  widthMm: 2.5,
  heightMm: 2.5,
  roundness: 1,
  weave: true,
  tension: 0.5,
  weaveRun: 1,
  strandsTouch: true,
  crossingGapMm: 1,
  jointSmoothing: 0.5,
  bendMm: 3,
  loop: true,
  detailMm: 0.8,
};

const LOOP_MAJOR_MM = 3.5;
// The organic loop: a stretch of strand this long rises this high off the
// sphere, leaving room under it for a ribbon.
const ARCH_HEIGHT_MM = 7;
const ARCH_HALF_LENGTH_MM = 10;
// Strands never bend tighter than this many strut radii.
const MIN_BEND_RADII = 3;

/** Scene units per millimeter for a surface of the given scene radius. */
export const sceneScale = (p, radius) => radius / (p.diameterMm / 2);

/**
 * Bring print settings saved before the unified profile up to date: round
 * struts become equal width and height, flat bands a nearly square-edged
 * profile (bands never wove, so weaving stays off for them).
 */
export const migratePrint = (saved) => {
  if (!saved || saved.widthMm !== undefined) {
    return saved;
  }
  if (saved.profile === 'band') {
    return { ...saved, widthMm: saved.bandWidthMm ?? 2.4, heightMm: saved.bandDepthMm ?? 3, roundness: 0.15, weave: false };
  }
  if (saved.strutMm !== undefined) {
    return { ...saved, widthMm: saved.strutMm, heightMm: saved.strutMm, roundness: 1 };
  }
  return saved;
};

export const weaving = (p) => p.weave;
export const gapMode = (p) => weaving(p) && !p.strandsTouch;

// Tension 0 leaves crossing strands just touching (centerlines one diameter
// apart); tension 1 presses them 70% into each other. Returns each strand's
// rise or dip as a fraction of the strut diameter.
// With Strands Touch off, centerlines separate by one diameter plus the gap.
const weaveFraction = (p) =>
  p.strandsTouch ? 0.5 - 0.35 * p.tension : 0.5 + p.crossingGapMm / (2 * p.heightMm);

// Joint Smoothing 1 gives a fillet of 1.5 strut radii where strands meet,
// measured on the strut's thinner side.
const blendRadiusMm = (p) => p.jointSmoothing * 1.5 * (strutThicknessMm(p) / 2);

// A fillet wider than the crossing gap would bridge it, so cap it there.
export const effectiveBlendMm = (p) =>
  gapMode(p) ? Math.min(blendRadiusMm(p), p.crossingGapMm) : blendRadiusMm(p);

/**
 * Strut cross-section in scene units (scale = scene units per millimeter): a
 * rounded rectangle centered on the strand, `halfWidth` across the surface,
 * `halfHeight` out from it, with corners of radius `corner`.
 */
export const strutProfile = (p, scale) => ({
  halfWidth: (p.widthMm / 2) * scale,
  halfHeight: (p.heightMm / 2) * scale,
  corner: p.roundness * (strutThicknessMm(p) / 2) * scale,
});

export const strutThicknessMm = (p) => Math.min(p.widthMm, p.heightMm);

export const strutWidthMm = (p) => p.widthMm;

/** Options for `buildWovenSegments` on a surface of the given scene radius. */
export const weaveOptions = (p, { radius, samples }) => {
  const scale = sceneScale(p, radius);
  return {
    radius,
    samplesPerSegment: samples,
    amplitude: weaving(p) ? weaveFraction(p) * p.heightMm * scale : 0,
    // A minimum gap is a hard requirement, so the weave keeps its full height
    // at every crossing instead of flattening where crossings are close.
    minBendRadius: gapMode(p) ? 0 : MIN_BEND_RADII * (p.heightMm / 2) * scale,
    bendRadius: p.bendMm * scale,
    loop: p.loop ? { height: ARCH_HEIGHT_MM * scale, halfLength: ARCH_HALF_LENGTH_MM * scale } : null,
    crossingsTouch: !weaving(p) || p.strandsTouch,
    run: p.weaveRun,
    minSeparation: gapMode(p) ? (p.heightMm + p.crossingGapMm) * scale : 0,
  };
};

// The separate ring loop is only used when the loop can't grow out of a
// strand, because no free stretch of line is long enough.
export const needsRingLoop = (p, result) => p.loop && !result?.loopPlaced;

/**
 * Place the hanging loop on the pattern point closest to the top, standing
 * up out of the sphere in line with the strut it grows from.
 */
export const hangingLoop = (p, segments, sphereRadius, scale) => {
  let best = -1;
  for (let i = 0; i < segments.length; i += 3) {
    if (best < 0 || segments[i + 1] / Math.hypot(segments[i], segments[i + 1], segments[i + 2]) >
      segments[best + 1] / Math.hypot(segments[best], segments[best + 1], segments[best + 2])) {
      best = i;
    }
  }
  const up = new Vector3().fromArray(segments, best).normalize();
  const partner = best % 6 === 0 ? best + 3 : best - 3;
  const along = new Vector3().fromArray(segments, partner).sub(new Vector3().fromArray(segments, best));
  along.addScaledVector(up, -along.dot(up)).normalize();
  const majorRadius = LOOP_MAJOR_MM * scale;
  const minorRadius = Math.max(1, strutThicknessMm(p) / 2) * scale;
  const baseRadius = new Vector3().fromArray(segments, best).length();
  const center = up.clone().multiplyScalar(Math.max(sphereRadius, baseRadius) + majorRadius - minorRadius);
  const normal = new Vector3().crossVectors(up, along).normalize();
  return { center: center.toArray(), normal: normal.toArray(), majorRadius, minorRadius };
};

/**
 * How far to shrink the preview surface so the struts stand proud of it, as
 * they will in the print: down to the struts' inner face.
 */
export const surfaceInset = (segments, profile, radius) => {
  let lowest = radius;
  for (let i = 0; i < segments.length; i += 3) {
    lowest = Math.min(lowest, Math.hypot(segments[i], segments[i + 1], segments[i + 2]));
  }
  return radius - lowest + profile.halfHeight;
};
