# Geodesic Sphere Studio

Design line patterns on one triangle, replicate them across an entire geodesic
sphere, and export a watertight STL you can 3D print.

This is a browser-based reimagining of a SketchUp workflow: instead of
projecting designs onto component parts of a geodesic sphere by hand, you draw
in a small 2D editor and the app handles the replication, spherical
projection, and solid modeling.

## Quick start

```bash
npm install
npm run dev
```

Open the printed local URL. Draw in the square editor on the right, then use
the **3D Print** folder in the control panel to generate and export a solid.

## How it works

1. **Draw one motif.** The square "quad editor" has snap anchors along its
   edges. Click two anchors to connect them; click a line's midpoint to split
   it and route through a new interior anchor. `Undo`, `Clear`, and
   `Delete`/`Backspace` (after selecting a line) do what you'd expect.
2. **Tessellate into a triangle.** The chosen tessellation (Tri Fan, Striped,
   Hex Fan) maps your quad drawing into a fan of quads inside one equilateral
   triangle — shown live in the triangle preview.
3. **Replicate across the sphere.** The triangle pattern is stamped onto every
   face of the geodesic sphere in barycentric coordinates, then resampled and
   projected onto the smooth sphere surface.
4. **Generate a solid.** Every projected segment becomes a capsule-shaped
   strut. The whole lattice is extracted as one level set of a signed distance
   field using [Manifold](https://github.com/elalish/manifold), so the result
   is guaranteed watertight and slices cleanly.
5. **Export STL.** Binary STL, written in millimeters at the diameter you set.

### Mirror mode and edge continuity

The **Mirror** checkbox adds a reflected copy of every stroke. Combined with
the 3-fold symmetry of the quad fan, this gives the triangle pattern full
dihedral (D3) symmetry — which guarantees strokes line up across shared edges
of adjacent faces, no matter how the faces are oriented. The dim "ghost"
triangles in the preview show the pattern on the three neighboring faces so
you can check continuity while you draw.

### Designing for printability

- **Connectivity:** the exported solid is only printable as one piece if the
  pattern forms a connected network. Strokes that end at quad edges join up
  with their neighbors; isolated motifs in the middle of a quad become
  floating islands. Use the ghost preview to check.
- **Strut diameter:** 2–3 mm prints reliably in FDM at 80 mm sphere diameter.
- **Detail (mm):** the approximate output triangle edge length. Lower values
  give smoother struts and bigger files. 1.0 mm is a good default; drop to
  0.5 mm for a final export.

### Saving work

The pattern autosaves to `localStorage` and survives reloads. Use
**Save**/**Load** in the template toolbar to export or import a pattern as
JSON.

## Project layout

| File | Purpose |
| --- | --- |
| `src/geodesic.js` | Geodesic sphere construction (icosahedron/octahedron, class-I subdivision) |
| `src/templateSpace.js` | Template triangle math: barycentric transforms, tessellation quads, mirroring |
| `src/templateEditor.js` | The 2D pattern editor UI (quad editor, triangle preview, persistence) |
| `src/patternMapper.js` | Stamps the pattern onto mesh faces as flat line segments (dome view) |
| `src/projection.js` | Resamples and projects the pattern onto the sphere; dedupes segments |
| `src/solid.js` | SDF strut lattice → watertight mesh via manifold-3d |
| `src/stl.js` | Binary STL serialization and download |
| `src/main.js` | Scene setup, GUI, and wiring |
| `scripts/smoke-solid.mjs` | Node smoke test of the full geometry → solid → STL pipeline |

## Roadmap ideas

- Shell-with-holes mode: treat the pattern as closed regions and pierce a
  thickened spherical shell (the Manifold dependency already supports the
  booleans this needs).
- Variable strut thickness per stroke.
- Non-geodesic target surfaces: the pattern already lives in per-triangle
  barycentric space, so any triangulated mesh can be stamped — the main work
  is choosing consistent face orientations on irregular meshes.
- Run solid generation in a Web Worker so the UI never blocks on large
  exports.
