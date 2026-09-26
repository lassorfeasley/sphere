import { createGeodesicSphere } from './geodesic.js';

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
    defaults: { base: 'icosahedron', frequency: 1 },
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
        ],
      },
      {
        key: 'frequency',
        type: 'segmented',
        label: 'Frequency',
        options: [1, 2, 3, 4, 5, 6].map((n) => ({ value: n, label: String(n) })),
      },
    ],
    createGeometry: ({ base, frequency }, radius) => createGeodesicSphere({ base, frequency, radius }),
    describe: ({ base, frequency }) => {
      const faces = { icosahedron: 20, octahedron: 8, 'pentakis dodecahedron': 60, 'tetrakis hexahedron': 24 }[base] ?? 20;
      const name = base.split(' ')[0];
      return {
        short: `${name[0].toUpperCase()}${name.slice(1)} · f${frequency}`,
        faces: faces * frequency * frequency,
      };
    },
  },
};

export const getSurface = (id) => SURFACES[id] ?? SURFACES.geodesic;
