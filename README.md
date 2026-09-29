# SightLine

**How much overlooking there is between two windows, and how much an intervention removes,
from an IFC model, in the browser.**

Pick a window on one building and a window on the other. SightLine draws the sight lines
between the two openings, paints the parts of each room that can be seen from the other
window, and measures how much of a standing person is visible at the worst spot. Add a
comparison (a second IFC with a screen, a fin or a changed window, or the same model with
elements omitted) and it runs the same pair again, gives the numbers side by side, and fades
between the two results from a camera angle you lock in.

It measures **how much** overlooking there is, particularly at oblique angles, not whether
it occurs (the 21 m / 11 m type tests).

> Indicative design aid. Measures geometric visibility between two openings in the model; it
> does not assess privacy standards or planning policy compliance.

Forked from [SunForm](https://github.com/JakeWhiteArchitecture/SunForm): one `index.html`,
Three.js r128, web-ifc 0.0.77 (the version CladForge runs), SunForm's BVH, its Web Worker
ray casting, `subdivideToMaxEdge` and its colour ramp.

## Using it

1. **Model.** Drop the IFC with both buildings in it. IfcSpaces are not needed (see *How it
   works*); where they exist they add the room names and the percentage figures.
2. **Comparison (optional).** *Upload here* a second IFC of the same scheme, or *click here to
   omit elements from the model* and click the elements to leave out. **A is always the
   existing, B always with the intervention**: an uploaded comparison is B; with the omit
   route the model as uploaded is B and the version with the elements left out is A. Both
   labels can be edited.
3. **Windows.** Pick Window 1 and Window 2 (an IfcWindow or a glazed IfcDoor). SightLine
   outlines each aperture and, if there is an IfcSpace behind it, names the room. Picks are kept by
   GlobalId, so the same windows are found in an uploaded comparison; one that is missing is
   reported, with a button to pick it again in the comparison.
4. **Run.** Both directions, for the model and the comparison.
5. **View.** Orbit to a view (or press *Suggested view*), press **Lock view**, then fade
   between A and B with the buttons at the bottom of the view. The numbers table highlights
   whichever is showing.

*Save session* downloads the picks, the omit list, labels, settings and the locked view as
JSON; *Open session* restores them on the model (matched by GlobalId). Picks are also kept
in the browser per file name and offered back when the same file is loaded again.

## How it works

- **Aperture.** The picked window's extent in its own wall plane, as a rectangle, on the
  plane through the centreline of its frame depth. The wall plane is the horizontal direction
  across which the window element is thinnest. The normal points out of the room, towards the
  other window.
- **Surfaces.** Found from the model, not from a room. Lines run from a spread of points on one
  aperture through a 50 mm grid on the other; every line that gets through unblocked lands on
  the first surface beyond the opening. Those surfaces (floor, walls, ceiling, and furniture
  where it is modelled) are cut up to 100 mm wherever a point on them could be seen from the
  viewing aperture through the other, which is worked out exactly, so the far edge of a visible
  patch is not left to chance. Up-facing surfaces count as floor (cills and table tops too),
  down-facing as ceiling, the rest as walls. The opening's own jambs, head and cill are not
  measured.
- **Blockers.** Every element except the two picked windows and anything omitted. Reveals,
  cills, heads and every other window block. Volumes are never drawn and never block:
  IfcSpace, IfcSpatialZone, IfcExternalSpatialElement, openings and virtual elements are
  hidden automatically.
- **IfcSpaces (optional).** If there is one behind a window, it names the room, is shown as a
  faint ghost (with a toggle), and supplies the room's floor and surface areas for the
  "% of floor / walls / ceiling" figures. Without one those figures are left out.
- **Visibility.** Viewer points on a 100 mm grid over one aperture. A surface point is seen
  from a viewer point when the segment between them passes through the other aperture and
  nothing blocks it. Each point gets the share of viewer points that see it, and is painted
  as a 10 mm skin coloured by that share.
- **Person.** Standing positions are found from the model: a 250 mm grid over the plan
  footprint of the sight lines, on the room side of the window and in line of sight of it,
  with a floor found by dropping a line down and clear head-room. Points every 50 mm up to
  1.70 m are tested the same way. The visible length and its kind (head down, feet up, middle
  band or whole person) are reported at the worst position, which is marked in the view with
  a figure, the visible part highlighted and dimensioned.
- **Hit-and-miss interventions.** "Visible" means seen from at least one point of the window,
  the worst case. A louvre or a perforated screen leaves that almost unchanged, so the table
  also gives the weighted figures: the visible area with each spot counted by the share of the
  window that sees it, the area seen from at least half the window, a person figure weighted
  the same way, and the average visible length at the worst position. The painted colours
  are the same share.
- **Deadline.** The run is stopped cleanly at 60 s (setting), with a warning saying how far
  it got. Stage times are logged to the console.

All settings (grids, person height, height step, deadline) are under *Settings*.

## Running locally

```bash
pip install -r requirements.txt
python app.py            # http://localhost:8080
```

or serve the folder with any static server (`python -m http.server 8080`), or open
`index.html` directly.

## Tests

```bash
node --test tests/core.test.js
```

The core (geometry, visibility, person measure, numbers) is the
`<script id="sightline-core">` block in `index.html`, which the Web Worker also runs. The tests
read that block straight out of the page and check it against the tests in the requirements:
the square-on projection by hand, an oblique window, a screen between the windows, a deeper
reveal, the three person cases, omitting, and deadline 0, plus furniture as a real surface,
a model with no IfcSpaces, and a louvre screen against the weighted figures.

`tests/e2e.js` drives the whole page in Chromium through Playwright on the models from
`tools/make_test_ifc.py` (in `test-models/`): it picks the windows by clicking them, runs,
adds an uploaded comparison, checks GlobalId matching and the missing-window prompt, locks the
view and fades, uses the omit route, and checks the deadline warning.

```bash
python tools/make_test_ifc.py      # needs ifcopenshell; test-models/ is already committed
python -m http.server 8080 &
node tests/e2e.js                  # VENDOR_DIR=... where the CDNs are blocked (see the file)
```

## Limitations

- Only the picked pair of windows is considered; other windows in the rooms are not.
- Frames and glazing bars are not modelled (the picked windows are ignored entirely), so
  results are slightly conservative.
- Standing positions stand on whatever surface is found below the window's height, so a
  modelled table top or shelf can be stood on. Rooms that are not in line of sight of the
  window at the window's height (round a corner) are not covered.
- No IFC, DXF or image export: the 3D view and the numbers are the outputs.

## Project layout

| Path                     | Purpose                                                        |
| ------------------------ | -------------------------------------------------------------- |
| `index.html`             | The whole application (UI, rendering, analysis core)           |
| `app.py`                 | Minimal Flask server that serves `index.html`                  |
| `tests/core.test.js`     | Node tests of the analysis core                                |
| `tests/e2e.js`           | Browser test through Playwright                                |
| `tools/make_test_ifc.py` | Builds the test IFC models                                     |
| `test-models/`           | Two facing buildings, plus screen, oblique, deep-reveal, new-window and no-IfcSpaces variants |

## License

Released under the [MIT License](LICENSE). Copyright (c) 2026 Jake White Architecture.
