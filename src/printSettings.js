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
  crossingSmoothing: 0.5,
  bendMm: 3,
  loop: false,
  // The loop's centerline peak above the strand, the angle it leaves the
  // strand at (past 90° it curls into a ring), and where it sits: on the
  // strand passing nearest the anchor direction (the loop strand index breaks
  // ties where strands cross), at a fraction along it, or nearest the anchor
  // when the fraction is negative.
  // A curl instead crosses over itself into a round loop, and the angle is
  // that of its legs; its rounding is the length over which its bends ease in.
  loopHeightMm: 12,
  loopAngle: 40,
  loopCurl: true,
  loopRoundingMm: 4,
  loopAnchor: [0, 1, 0],
  loopStrand: -1,
  loopAlong: -1,
  detailMm: 0.8,
};

// Slack strands never bend tighter than this many strut radii; taut ones
// wrap as tightly as the taut limit around the strands they cross.
const MIN_BEND_RADII = 3;
const TAUT_MIN_BEND_RADII = 1;
const minBendRadii = (p) =>
  MIN_BEND_RADII + (TAUT_MIN_BEND_RADII - MIN_BEND_RADII) * (p.strandsTouch ? p.tension : 0);

/** Scene units per millimeter for a surface of the given scene radius. */
export const sceneScale = (p, radius) => radius / (p.diameterMm / 2);

/**
 * Bring print settings saved before the unified profile up to date: round
 * struts become equal width and height, flat bands a nearly square-edged
 * profile (bands never wove, so weaving stays off for them). Crossings
 * used to share the joint fillet, so they start out matching it.
 */
export const migratePrint = (saved) => {
  if (!saved) {
    return saved;
  }
  let print = saved;
  if (print.widthMm === undefined) {
    if (print.profile === 'band') {
      print = { ...print, widthMm: print.bandWidthMm ?? 2.4, heightMm: print.bandDepthMm ?? 3, roundness: 0.15, weave: false };
    } else if (print.strutMm !== undefined) {
      print = { ...print, widthMm: print.strutMm, heightMm: print.strutMm, roundness: 1 };
    }
  }
  if (print.crossingSmoothing === undefined && print.jointSmoothing !== undefined) {
    print = { ...print, crossingSmoothing: print.jointSmoothing };
  }
  const anchor = print.loopAnchor;
  if (anchor !== undefined && !(Array.isArray(anchor) && anchor.length === 3 && anchor.every(Number.isFinite) && anchor.some(Boolean))) {
    const { loopAnchor, ...rest } = print;
    print = rest;
  }
  return print;
};

export const weaving = (p) => p.weave;
export const gapMode = (p) => weaving(p) && !p.strandsTouch;

// Tension 0 leaves crossing strands just touching (centerlines one diameter
// apart); tension 1 presses them 40% into each other, keeping enough weave
// to show the taut runs between crossings. Returns each strand's rise or dip
// as a fraction of the strut diameter.
// With Strands Touch off, centerlines separate by one diameter plus the gap.
const weaveFraction = (p) =>
  p.strandsTouch ? 0.5 - 0.2 * p.tension : 0.5 + p.crossingGapMm / (2 * p.heightMm);

// Pressed strands swell beside the crossing by this fraction of how deep they
// overlap, so they read as soft tubes squeezed together rather than solids
// passing through each other; more so the tauter they are. Unwoven strands
// share one level and would swell at every crossing, so only the weave presses.
const PRESS_SWELL = [0.3, 0.8];
export const pressSwell = (p) =>
  weaving(p) && p.strandsTouch ? PRESS_SWELL[0] + (PRESS_SWELL[1] - PRESS_SWELL[0]) * p.tension : 0;

// Smoothing 1 gives a fillet of 1.5 strut radii where strands meet,
// measured on the strut's thinner side.
const blendRadiusMm = (p, smoothing) => smoothing * 1.5 * (strutThicknessMm(p) / 2);

// A fillet wider than the crossing gap would bridge it, so cap it there.
export const effectiveBlendMm = (p) =>
  gapMode(p) ? Math.min(blendRadiusMm(p, p.jointSmoothing), p.crossingGapMm) : blendRadiusMm(p, p.jointSmoothing);

// The crossing fillet blends lines that merge where they cross. Woven
// strands pass over and under instead: touching ones meet in a pressed
// groove, and ones kept a gap apart must not be bridged.
export const crossingBlendMm = (p) => (weaving(p) ? 0 : blendRadiusMm(p, p.crossingSmoothing));

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
    minBendRadius: gapMode(p) ? 0 : minBendRadii(p) * (p.heightMm / 2) * scale,
    bendRadius: p.bendMm * scale,
    loop: p.loop ? loopOptions(p, scale) : null,
    crossingsTouch: !weaving(p) || p.strandsTouch,
    run: p.weaveRun,
    // Only touching strands pull taut; a kept gap stays a soft wave.
    taut: weaving(p) && p.strandsTouch ? p.tension : 0,
    minSeparation: gapMode(p) ? (p.heightMm + p.crossingGapMm) * scale : 0,
  };
};

// The loop's fillets never bend tighter than one strut thickness, and a
// ring's legs keep a small gap where they cross under it.
const LOOP_NECK_GAP_MM = 0.6;
// Loops snap to the nearest line; only mention it when they land farther away.
const LOOP_FAR_MM = 4;

const loopOptions = (p, scale) => ({
  height: p.loopHeightMm * scale,
  angle: (p.loopAngle * Math.PI) / 180,
  curl: p.loopCurl,
  rounding: p.loopRoundingMm * scale,
  anchor: p.loopAnchor,
  strand: p.loopStrand,
  along: p.loopAlong,
  minBend: strutThicknessMm(p) * scale,
  neck: (Math.max(p.widthMm, p.heightMm) + LOOP_NECK_GAP_MM) * scale,
});

/**
 * Plain-language summary of a placed loop (from `buildWovenSegments`): its
 * shape and the ribbon it takes, noting when it had to change to fit.
 */
export const describeLoop = (p, loop, scale) => {
  if (!loop) {
    return 'No room for a loop. Lower the height or raise the steepness.';
  }
  const mm = (v) => (v / scale).toFixed(1);
  const angle = Math.round((loop.angle * 180) / Math.PI);
  const thickness = strutThicknessMm(p) * scale;
  const shape =
    loop.curl || loop.angle > Math.PI / 2
      ? `${mm(loop.height)} mm tall, ${mm(2 * loop.topRadius - thickness)} mm opening.`
      : `${mm(loop.height)} mm tall, ${mm(loop.height - thickness)} mm ribbon gap.`;
  const notes = [shape];
  if (loop.bent) {
    notes.push('Follows the bends of the line.');
  }
  if (loop.adjusted) {
    const lower = loop.height / scale < p.loopHeightMm - 0.05;
    notes.push(`Made ${lower ? 'lower' : 'steeper'} (${angle}°) to fit.`);
  } else if (Math.abs(angle - p.loopAngle) >= 1) {
    notes.push(
      loop.curl
        ? `Steepness held at ${angle}° (curls climb 20°–60°).`
        : `Steepness held at ${angle}°; raise the height for a rounder ring.`,
    );
  }
  if (loop.curl && loop.height / scale > p.loopHeightMm + 0.05) {
    notes.push(`Raised to ${mm(loop.height)} mm to fit the curl.`);
  }
  if (loop.moved) {
    notes.push(`Moved to the nearest line with room, ${mm(loop.offset)} mm away.`);
  } else if (loop.offset / scale > LOOP_FAR_MM) {
    notes.push(`Moved ${mm(loop.offset)} mm along to fit.`);
  }
  return notes.join(' ');
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
