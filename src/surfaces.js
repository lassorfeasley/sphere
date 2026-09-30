import { createGeodesicSphere, withoutFaces } from './geodesic.js';

// Bases whose triangles fan around polygon face centers, listing the center
// first. Unsubdivided, a pattern mirrored down each triangle's center line
// meets itself across every edge, so each polygon can carry any mirrored
// design. `center` is the polygon the editor shows, `neighbors` the polygons
// around its edges in order, and `open` lists polygons left without pattern.
// `split` means wedges facing an open polygon can take a design of their own.
const FACE_LAYOUTS = {
  'truncated icosahedron': { center: 6, neighbors: [5, 6, 5, 6, 5, 6] },
  'pentakis dodecahedron': { center: 5, neighbors: [5, 5, 5, 5, 5] },
  'tetrakis hexahedron': { center: 4, neighbors: [4, 4, 4, 4] },
};

/**
 * Surfaces a pattern can be projected onto. Each one declares the controls
 * it needs (rendered in the Surface section), builds its triangulated base
 * mesh, and summarizes itself for the gallery and the surface readout.
 * Pattern stamping works per triangle, so a surface only has to supply
 * triangles; the projection and printing steps currently assume a sphere.
 */
export const SURFACES = {
  geodesic: {
    label: 'Geodesic sphere',
    defaults: { base: 'icosahedron', frequency: 1, pentagons: true },
    controls: [
      {
        key: 'base',
        type: 'tiles',
        label: 'Base polyhedron',
        options: [
          { value: 'icosahedron', label: 'Icosahedron', detail: '20 faces' },
          { value: 'octahedron', label: 'Octahedron', detail: '8 faces' },
          { value: 'pentakis dodecahedron', label: 'Pentakis', detail: '60 faces' },
          { value: 'tetrakis hexahedron', label: 'Tetrakis', detail: '24 faces' },
          { value: 'truncated icosahedron', label: 'Soccer ball', detail: '32 faces' },
        ],
      },
      {
        key: 'frequency',
        type: 'segmented',
        label: 'Frequency',
        options: [1, 2, 3, 4, 5, 6].map((n) => ({ value: n, label: String(n) })),
      },
      {
        key: 'pentagons',
        type: 'toggle',
        label: 'Pattern in pentagons',
        hint: 'Off leaves the pentagons open; lines reaching them end at their edges.',
        when: ({ base }) => base === 'truncated icosahedron',
      },
    ],
    createGeometry: ({ base, frequency }, radius) => createGeodesicSphere({ base, frequency, radius }),
    // The faces the pattern is stamped on: all of them unless some are left
    // open. With open pentagons, hexagon wedges facing a pentagon are
    // variant 1 and can carry their own design.
    patternGeometry: (geometry, { base, pentagons }) => {
      if (base !== 'truncated icosahedron' || pentagons) {
        return geometry;
      }
      const open = withoutFaces(geometry, 5);
      open.userData.faceVariant = open.userData.faceOuterSides.map((sides) => (sides === 5 ? 1 : 0));
      return open;
    },
    describe: ({ base, frequency }) => {
      const faces = { icosahedron: 20, octahedron: 8, 'pentakis dodecahedron': 60, 'tetrakis hexahedron': 24 }[base];
      const name = base === 'truncated icosahedron' ? 'soccer' : base.split(' ')[0];
      return {
        short: `${name[0].toUpperCase()}${name.slice(1)} · f${frequency}`,
        faces: faces ? faces * frequency * frequency : frequency === 1 ? 32 : 180 * frequency * frequency,
      };
    },
    faceLayout: ({ base, frequency, pentagons }) => {
      const layout = frequency === 1 ? FACE_LAYOUTS[base] : null;
      if (!layout) {
        return null;
      }
      return base === 'truncated icosahedron' && !pentagons ? { ...layout, open: [5], split: true } : layout;
    },
  },
};

export const getSurface = (id) => SURFACES[id] ?? SURFACES.geodesic;
