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
  work as an accordion (one open at a time), and every setting is remembered
  across reloads.
- **Viewport:** a toolbar switches between *Faceted*, *Sphere*, and *Solid*
  views (picking *Solid* generates the printable mesh if needed), toggles pan
  mode (`P`, left-drag pans instead of orbiting), resets the camera, collapses the left (`[`) or right (`]`) panel or hides both (`F`), and opens the **Gallery** (`G`). Status
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
4. **Generate a solid.** Every projected segment becomes a strut centered on
   the line. Its cross-section is a rounded rectangle set in the Struts
   section: *Width* across the surface, *Height* out from it, and
   *Roundness* from 0 (square edges) to 1 (fully rounded, so a circle when
   width equals height and a pill shape otherwise). The *Round*, *Oval*, and
   *Band* shape buttons are quick presets for common combinations. The
   optional hanging loop always grows out of the pattern itself (see
   below).

   Settings and designs saved before the unified profile load as the
   closest match: round struts keep their thickness as width and height,
   and flat bands become a *Band* profile with weaving off. Bands are now
   centered on the line rather than sitting flush below the sphere
   surface, so their outer faces stand half a band height further out.

### Woven crossings

*Weave crossings* makes lines pass over and under each
other like a basket weave. Every line is traced across the whole sphere,
straight through each place where lines cross, and over/under is chosen so
it alternates along every line. Where three or four lines cross at a single
point they stack at evenly spaced heights instead of merging. Each strand's height eases smoothly
between crossings and returns to the sphere at line ends and at junctions
where lines meet without passing straight through. Crossing strands press into each other,
flattening where they meet and bulging sideways like soft hoses, so the print
stays in one piece. Where crossings are close together the weave gets
shallower, so no strand bends tighter than the minimum bend (three strut
radii when slack, down to one at full tension).

*Over / under run* sets the weave rhythm: 1 is a plain weave (over one, under
one), 2 a twill (over two, under two), and so on. With *Strands touch* on,
*Tension* (0–1) makes the strands behave like stretched elastic. At 0 they
just touch and ease over each other in a soft wave. Raising it pulls them
taut: they run straight between crossings and do their bending right at
each crossing, wrapping tightly over the strand beneath or dipping sharply
under the one above. They also press harder together, up to 40% overlap,
and bulge more where they press. This is real geometry through the whole
strut, not a surface effect. Turn *Strands touch* off to set a *Minimum gap* between
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

### Hanging loop

*Hanging loop* (Hanging section) lifts a stretch of one line of the main
piece off the sphere, so the loop is part of the pattern rather than a
separate ring. Seen from the side, the line leaves the surface on a
fillet, arcs over the top, and lands again the same way, meeting the line
smoothly at both feet. *Height* sets how far its centerline rises above
the line. *Steepness* sets the angle it leaves the line at: low angles
make a long, gentle rise, 90° gives steep sides, and past 90° the sides
lean outward so the line curls into a closed ring. Steepness also sets the
loop's footprint along the line (height ÷ tan(steepness ÷ 2)). The *Bump*,
*Arch*, and *Ring* buttons are presets (45°, 90°, 150°; *Ring* also raises
the height to at least 12 mm so the ring opens up). A ring's steepness is
capped so its two legs stay apart where they cross under it.

*Curl* is a different shape: the line climbs out at the steepness angle
(20° to 60°), runs once around a perfect circle, and comes back down across
its own way up, like a looped ribbon. Where the legs cross, one strut
thickness above the line, they pass side by side with a small gap. To make
room, the loop tilts slightly sideways, so it is round seen face-on and a
gentle coil seen edge-on. *Rounding* sets how gradually it eases into each
bend (where it leaves the line and where the legs meet the circle), so the
bends flow instead of switching sharply from straight to curved. Very large
rounding on a small curl also softens the circle itself. Around any loop,
the strut's height follows the loop rather than always pointing away from
the sphere, so flat bands don't twist where the loop stands upright. The
circle takes whatever height the legs leave;
if the height is too small for a circle at least one strut thick, the curl
is raised to fit.

The loop sits on one line of the main piece, by default the one passing
nearest the top. *Pick a line* lets you choose another: the line nearest the
pointer lights up, and a click puts the loop on it at the nearest point (a
drag still orbits; Esc cancels). *Position* then slides the loop along that
line. Its ticks mark the line's crossings (tall) and the points halfway
between crossings, corners, and line ends (short), and a drag snaps to them.
The shaded stretches of the slider are where the loop has room, and it
moves to the nearest of them when set elsewhere. Hovering the slider
highlights the line. *Top* puts the loop back at the top.

The loop needs a straight stretch with no line ends or corners sharper than
20°. If no straight stretch is long enough, it follows the bends of the line
and keeps only its middle straight. If the chosen line is too short even
for that, the loop moves to the nearest line with room. If it still doesn't fit, it is made
steeper (up to 90°) and then lower. The note under the controls describes
the loop as built, including the room left for a ribbon or the ring's
opening, and says whenever it had to change or landed away from where it
was placed.

### Hanging simulation

*Simulate hanging* (Hanging section) hangs the ornament from its loop,
first turning it so the loop points up the screen: the
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

### Strut finish

*Strut finish* (Appearance) previews the struts and solid in plastic or a
metal (silver, gold, rose gold, brass, copper, bronze, stainless steel,
titanium, gunmetal), lit by a studio environment so the metals reflect.
*Polish* runs from matte (0) through satin and polished to a mirror (1). It
is only a preview: the exported STL is unchanged. With *Color separate
pieces* on, a multi-piece design tints the metal by piece.

### Smoothing

- *Joint fillet* (0–3) sets the size of the fillet at junctions, where three
  or more lines meet and end: 1.5 strut radii per unit, so up to 4.5. Large
  values web neighboring strands together. Many patterns have no junctions
  (every meeting is a crossing), in which case it has no effect and its hint
  says so.
- *Crossing fillet* (Weave section, same scale) sets the fillet where lines
  cross and merge, as *Joint fillet* does where they meet. It only applies
  with *Weave crossings* off; woven strands pass over and under instead,
  meeting in a pressed groove when they touch. The Sphere view always shows
  plain struts; fillets, pressing and swell appear only in the solid you
  generate.
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
- **Strut size:** 2–3 mm round struts, or bands around 2.4 mm wide × 3 mm
  high, print reliably in FDM at 60–80 mm diameter. The woven height of a
  strand follows *Height*, so flat ovals weave more shallowly.
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
| `src/solid.js` | SDF strut lattice (rounded-rectangle profile) → watertight mesh via manifold-3d |
| `src/solidWorker.js`, `src/solidClient.js` | Runs solid builds in a Web Worker (cancellable) for the smooth preview and Generate solid |
| `src/tubes.js` | Solid strut preview for the Sphere display mode |
| `src/connectivity.js` | Counts how many separate pieces a pattern prints as |
| `src/weave.js` | Traces lines into strands, assigns alternating over/under heights, and grows the hanging loop out of one strand |
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
  loop placement still assume a sphere.
