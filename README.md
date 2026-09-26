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

Open the printed local URL. The window has three parts:

- **Left sidebar:** the surface (base polyhedron, frequency, diameter),
  struts, weave, hanging loop, appearance and quality settings, with
  **Generate solid** and **Export STL** pinned at the bottom. Sections
  collapse, and every setting is remembered across reloads.
- **Viewport:** a toolbar switches between *Faceted*, *Sphere*, and *Solid*
  views (picking *Solid* generates the printable mesh if needed), resets the
  camera, hides both panels (`F`), and opens the **Gallery** (`G`). Status
  messages appear in the bottom-left corner.
- **Pattern panel (right):** the triangle editor.

The **Gallery** has starter designs (Line Sphere, Soccer Ball, Honeycomb, …)
and your own saved designs, each with a rendered thumbnail. *Save current
design* stores the pattern, surface, color, and print settings together;
starters replace only the pattern and surface.

## How it works

1. **Draw on one triangle.** Drag between snap dots (a triangular grid, plus
   line endpoints and crossings) to draw a line, or click dots in sequence to
   chain lines. Open the Gallery for a quick starting point; the *Line
   Sphere* starter recreates the original SketchUp line sphere from a single
   stroke on an icosahedron at frequency 1. Lines
   are drawn at their printed width, and a note under the editor says whether
   the design prints as one connected piece.
   Clicking a line selects the part between the nearest junctions (click
   again for the whole line); `Delete` removes it. The matching cylinders
   are highlighted on the sphere, and *Show surface* hides the sphere surface
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

With round struts, *Weave crossings* makes lines pass over and under each
other like a basket weave. Every line is traced across the whole sphere,
straight through each place where lines cross, and over/under is chosen so
it alternates along every line. Where three or four lines cross at a single
point they stack at evenly spaced heights instead of merging. Each strand's height eases smoothly
between crossings and returns to the sphere at line ends and at junctions
where lines meet without passing straight through. Crossing strands press into each other and
are joined with a smooth fillet, like soft hoses under tension, so the print
stays in one piece. Where crossings are close together the weave gets
shallower, so no strand bends tighter than three strut radii.

*Over / under run* sets the weave rhythm: 1 is a plain weave (over one, under
one), 2 a twill (over two, under two), and so on. With *Strands touch* on,
*Tension* (0–1) sets how hard crossing
strands press together: at 0 they just touch; at 1 they sink 70% into each
other. Turn *Strands touch* off to set a *Minimum gap* between
crossing strands instead. Crossings much closer together than that spacing (tight knots) are
stacked as one cluster, each strand holding its own level through it, so
the gap holds even in dense knots of crossings (at the cost of strands
moving further off the sphere there). Under the editor, the app reports the
closest gap it actually measured between separate strands, away from
junctions, and how far strands move off the sphere to keep clear; lines
that pass close without crossing are flagged there too. Separated strands only join where lines meet at
junctions, so the connectivity note counts pieces accordingly — closed loops
woven through each other still interlock like chain mail, but loose pieces
can fall out. *Thickness* (Struts section) sets
the strut diameter.

### Hanging simulation

*Simulate hanging* (Hanging section) hangs the ornament from its loop: the
piece carrying the loop stays put and every other piece drops under gravity
as a rigid body of round struts until it rests on the struts holding it up.
Pieces whose struts overlap in the design fuse when printed, so they are
welded together first. When everything settles the status line reports how
far the loose pieces moved from their designed position and how many fall
out entirely; click again to reset. Gravity always points down the screen,
so orbiting the view is like turning the ornament in your hand: the loose
pieces re-settle toward the new "down". Spin is paused while hanging. Inertia is approximated and friction is
simple damping, so treat the numbers as a guide to how loose a design is,
not an exact prediction.

### Smoothing

- *Joint fillet* (0–3) sets the size of the fillet wherever cylinders
  meet or cross: 1.5 strut radii per unit, so up to 4.5. Large values
  web neighboring strands together near junctions. While you edit, the Sphere view
  shows plain cylinders; once edits pause, a coarse solid (with fillets) is
  built in a background worker and swapped in, with a *Smoothing…* badge
  while it builds. Turn off *Smooth preview* (Appearance) to keep the
  cylinders. When *Color separate pieces* is coloring a multi-piece design,
  the cylinders stay so each piece keeps its color.
- *Corner rounding* rounds every corner where a line changes direction
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

### Base polyhedra

Every base is triangle-faced, so the same one-triangle editor drives them
all, and kaleidoscope symmetry keeps lines continuous across edges even on
non-equilateral faces (the pattern just stretches slightly).

- **Icosahedron** (20 faces) and **octahedron** (8): 5-fold and 4-fold
  vertices respectively.
- **Pentakis dodecahedron** (60 near-equilateral faces): 5-fold rosettes at
  12 points and 6-fold at 20. *Honeycomb* on it makes a soccer ball.
- **Tetrakis hexahedron** (24 faces, a cube with a pyramid on each face):
  cube-like symmetry with 4-fold centers. *Honeycomb* on it makes squares
  among hexagons.

On the two kis bases, each triangle's first corner is the face center, so
designs using *Rotate* or no symmetry are oriented consistently around it.

### Designing for printability

- **Connectivity:** the exported solid is only printable as one piece if the
  pattern forms a connected network. Strokes that end at quad edges join up
  with their neighbors; isolated motifs in the middle of a quad become
  floating islands. Use the ghost preview to check.
- **Color separate pieces:** when a design prints as more than one piece, each
  separate piece gets its own color on the sphere, and editor lines take the
  color of their piece on one face, so disconnected strokes stand out.
- **Connectivity:** the note under the editor counts separate pieces. Lines
  only count as joined where they meet or cross, so lines that merely pass
  close to each other are reported as separate even if the struts touch.
- **Strut size:** flat bands around 2.4 mm wide × 3 mm deep (or 2–3 mm round
  struts) print reliably in FDM at 60–80 mm diameter.
- **Solid detail** (Quality section): the approximate output triangle edge length. Lower values
  give smoother struts and bigger files. 1.0 mm is a good default; drop to
  0.5 mm for a final export.

### Saving work

The pattern and all settings autosave to `localStorage` and survive reloads.
Save whole designs to the Gallery to keep several around, or use **Export
JSON** / **Import JSON** under the pattern editor to move a pattern between
browsers.

## Project layout

| File | Purpose |
| --- | --- |
| `src/geodesic.js` | Geodesic sphere construction (icosahedron, octahedron, pentakis dodecahedron, tetrakis hexahedron; class-I subdivision) |
| `src/templateSpace.js` | Template triangle math: barycentric transforms, symmetry groups, snap lattice, presets |
| `src/templateEditor.js` | The 2D triangle pattern editor (drawing, neighbor preview, persistence) |
| `src/patternMapper.js` | Stamps the pattern onto mesh faces as flat line segments (dome view) |
| `src/projection.js` | Projects the pattern and the geodesic faces onto the sphere; dedupes segments |
| `src/solid.js` | SDF strut lattice (band or round profile, hanging loop) → watertight mesh via manifold-3d |
| `src/solidWorker.js`, `src/solidClient.js` | Runs solid builds in a Web Worker (cancellable) for the smooth preview and Generate solid |
| `src/tubes.js` | Solid strut preview for the Sphere display mode |
| `src/connectivity.js` | Counts how many separate pieces a pattern prints as |
| `src/weave.js` | Traces lines into strands and assigns alternating over/under heights |
| `src/hangSim.js` | Rigid-body simulation of loose pieces hanging from the loop |
| `src/stl.js` | Binary STL serialization and download |
| `src/surfaces.js` | Registry of target surfaces: their controls, base mesh, and summary |
| `src/printSettings.js` | Print defaults and pure helpers turning print settings into weave options and strut profiles |
| `src/gallery.js` | Gallery overlay, starter designs, saved designs, and thumbnail rendering |
| `src/ui/controls.js` | Sidebar control kit: sections, toggles, sliders, segmented controls, tiles, swatches, buttons |
| `src/ui/icons.js` | Inline SVG icons |
| `src/main.js` | Scene setup, panels, and wiring |
| `scripts/smoke-solid.mjs` | Node smoke test of the full geometry → solid → STL pipeline |

## Roadmap ideas

- Shell-with-holes mode: treat the pattern as closed regions and pierce a
  thickened spherical shell (the Manifold dependency already supports the
  booleans this needs).
- Variable strut thickness per stroke.
- Non-geodesic target surfaces: the pattern already lives in per-triangle
  barycentric space, so any triangulated mesh can be stamped — the main work
  is choosing consistent face orientations on irregular meshes. New surfaces
  register in `src/surfaces.js` (the Surface section shows a shape picker
  once there is more than one); projection, the sunken preview surface, and
  the solid's hanging loop still assume a sphere.
