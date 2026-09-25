# Geodesic Sphere Studio

Design line patterns on one triangle, replicate them across an entire geodesic
sphere, and export a watertight STL you can 3D print — for example as a
hanging ornament.

This is a browser-based reimagining of a SketchUp workflow: instead of
projecting designs onto component parts of a geodesic sphere by hand, you draw
in a small 2D editor and the app handles the replication, spherical
projection, and solid modeling.

## Quick start

```bash
npm install
npm run dev
```

Open the printed local URL. Draw on the triangle editor on the right, then use
the **3D Print** folder in the control panel to generate and export a solid.

## How it works

1. **Draw on one triangle.** Drag between snap dots (a triangular grid, plus
   line endpoints and crossings) to draw a line, or click dots in sequence to
   chain lines. Pick a preset under *Start from* for a quick starting point;
   *Line Sphere* recreates the original SketchUp line sphere from a single
   stroke (and switches the sphere to an icosahedron at frequency 1). Lines
   are drawn at their printed width, and a note under the editor says whether
   the design prints as one connected piece.
   Clicking a line selects the part between the nearest junctions (click
   again for the whole line); `Delete` removes it. The matching cylinders
   are highlighted on the sphere, and *Show Sphere* hides the sphere surface
   so you can see the cylinders on their own. `Undo` / Cmd+Z and
   `Clear` do what you'd expect.
2. **Symmetry does the rest.** In *Kaleidoscope* mode every line is copied
   six ways (three rotations and their mirror images) so the triangle
   pattern is fully symmetric.
3. **Replicate across the sphere.** The triangle pattern is stamped onto every
   face of the geodesic sphere in barycentric coordinates, then resampled and
   projected onto the smooth sphere surface.
4. **Generate a solid.** Every projected segment becomes a strut — either a
   flat band whose outer face is flush with the sphere (the default, like the
   original line spheres) or a round capsule. With round struts, the
   optional hanging loop grows out of the pattern itself: the highest free
   stretch of one line (no line ends or sharp corners) lifts off the sphere
   in a smooth 7 mm arch that a ribbon can pass under. With flat bands, or
   when no stretch is long enough, a small ring is attached at the top
   instead.

### Woven crossings

With round struts, *Weave Crossings* makes lines pass over and under each
other like a basket weave. Every line is traced across the whole sphere,
straight through each place where lines cross, and over/under is chosen so
it alternates along every line. Where three or four lines cross at a single
point they stack at evenly spaced heights instead of merging. Each strand's height eases smoothly
between crossings and returns to the sphere at line ends and at junctions
where lines meet without passing straight through. Crossing strands press into each other and
are joined with a smooth fillet, like soft hoses under tension, so the print
stays in one piece. Where crossings are close together the weave gets
shallower, so no strand bends tighter than three strut radii.

*Over/Under Run* sets the weave rhythm: 1 is a plain weave (over one, under
one), 2 a twill (over two, under two), and so on. With *Strands Touch* on,
*Weave Tension* (0–1) sets how hard crossing
strands press together: at 0 they just touch; at 1 they sink 70% into each
other. Turn *Strands Touch* off to set a *Minimum Gap (mm)* between
crossing strands instead. Crossings much closer together than that spacing (tight knots) are
stacked as one cluster, each strand holding its own level through it, so
the gap holds even in dense knots of crossings (at the cost of strands
moving further off the sphere there). Under the editor, the app reports the
closest gap it actually measured between separate strands, away from
junctions, and how far strands move off the sphere to keep clear; lines
that pass close without crossing are flagged there too. Separated strands only join where lines meet at
junctions, so the connectivity note counts pieces accordingly — closed loops
woven through each other still interlock like chain mail, but loose pieces
can fall out. *Cylinder Radius* sets
the strut thickness.

### Smoothing

- *Joint Smoothing* (0–1) sets the size of the fillet wherever cylinders
  meet or cross, up to 1.5 strut radii. It applies to the generated solid
  (the Sphere preview shows the cylinders without fillets).
- *Bend Smoothing (mm)* rounds every corner where a line changes direction
  into a smooth curve of about that radius, shrunk where the neighboring
  lines are too short. 0 keeps sharp corners. The whole lattice is extracted as one level set of a signed distance
   field using [Manifold](https://github.com/elalish/manifold), so the result
   is guaranteed watertight and slices cleanly.
5. **Export STL.** Binary STL, written in millimeters at the diameter you set.

### Symmetry and edge continuity

Adjacent faces of a geodesic sphere aren't consistently oriented, so a
pattern only lines up across every shared edge if it has the triangle's full
six-fold (D3) symmetry — that's what *Kaleidoscope* mode enforces. *Rotate*
and *Off* are available for experiments, but lines may not meet at face
edges. The "With neighboring faces" preview shows the pattern mirrored onto
the three adjacent faces. In *Sphere* display mode the surface is tiled by
the projected geodesic triangles, so you can see where each copy lands.

### Designing for printability

- **Connectivity:** the exported solid is only printable as one piece if the
  pattern forms a connected network. Strokes that end at quad edges join up
  with their neighbors; isolated motifs in the middle of a quad become
  floating islands. Use the ghost preview to check.
- **Color Pieces:** when a design prints as more than one piece, each
  separate piece gets its own color on the sphere, and editor lines take the
  color of their piece on one face, so disconnected strokes stand out.
- **Connectivity:** the note under the editor counts separate pieces. Lines
  only count as joined where they meet or cross, so lines that merely pass
  close to each other are reported as separate even if the struts touch.
- **Strut size:** flat bands around 2.4 mm wide × 3 mm deep (or 2–3 mm round
  struts) print reliably in FDM at 60–80 mm diameter.
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
| `src/templateSpace.js` | Template triangle math: barycentric transforms, symmetry groups, snap lattice, presets |
| `src/templateEditor.js` | The 2D triangle pattern editor (drawing, neighbor preview, persistence) |
| `src/patternMapper.js` | Stamps the pattern onto mesh faces as flat line segments (dome view) |
| `src/projection.js` | Projects the pattern and the geodesic faces onto the sphere; dedupes segments |
| `src/solid.js` | SDF strut lattice (band or round profile, hanging loop) → watertight mesh via manifold-3d |
| `src/tubes.js` | Solid strut preview for the Sphere display mode |
| `src/connectivity.js` | Counts how many separate pieces a pattern prints as |
| `src/weave.js` | Traces lines into strands and assigns alternating over/under heights |
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
