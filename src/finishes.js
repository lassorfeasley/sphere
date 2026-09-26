/**
 * Material finishes for the struts. Metal colors approximate each metal's
 * reflectance (sRGB); metals take all their color from reflections, so they
 * need an environment map to read as metal.
 */
export const FINISHES = {
  plastic: { label: 'Plastic', metal: false },
  silver: { label: 'Silver', metal: true, color: '#f4f1ea' },
  gold: { label: 'Gold', metal: true, color: '#ffd27a' },
  roseGold: { label: 'Rose gold', metal: true, color: '#f3b8a0' },
  brass: { label: 'Brass', metal: true, color: '#e6c77a' },
  copper: { label: 'Copper', metal: true, color: '#e9a07a' },
  bronze: { label: 'Bronze', metal: true, color: '#c99a6b' },
  steel: { label: 'Stainless steel', metal: true, color: '#c4c4c2' },
  titanium: { label: 'Titanium', metal: true, color: '#b4ada3' },
  gunmetal: { label: 'Gunmetal', metal: true, color: '#5a5d63' },
};

export const DEFAULT_FINISH = 'plastic';
export const DEFAULT_POLISH = 0.4;

export const isMetal = (finish) => Boolean(FINISHES[finish]?.metal);

/** Polish 0 is fully matte, 1 a mirror; roughness falls fastest near the mirror end. */
export const roughnessFor = (polish) => 0.02 + 0.88 * (1 - polish) ** 1.5;

export const polishName = (polish) => {
  if (polish < 0.25) {
    return 'Matte';
  }
  if (polish < 0.55) {
    return 'Satin';
  }
  return polish < 0.85 ? 'Polished' : 'Mirror';
};

/**
 * Set a MeshStandardMaterial to a finish. Plastic keeps `plasticColor` and
 * only picks up faint reflections as it gets glossier.
 */
export function applyFinish(material, { finish, polish, envMap, plasticColor }) {
  const spec = FINISHES[finish] ?? FINISHES[DEFAULT_FINISH];
  if (plasticColor !== undefined) {
    material.color.set(spec.metal ? spec.color : plasticColor);
  }
  material.metalness = spec.metal ? 1 : 0.1;
  material.roughness = roughnessFor(polish);
  material.envMap = envMap;
  material.envMapIntensity = spec.metal ? 1 : 0.4 * polish ** 2;
  material.needsUpdate = true;
}
