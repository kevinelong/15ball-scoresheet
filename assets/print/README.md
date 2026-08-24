# assets/print – Printable Score-Sheet Assets

## Files

| File | Description |
|------|-------------|
| `15-ball-rotation-score-sheet.inkscape.svg` | **Generated** blank printable 15-Ball Rotation score sheet (US Letter portrait, SVG). |
| `README.md` | This file. |

---

## Regenerating the SVG

The SVG is **generated output** – do not hand-edit it.  
All durable changes belong in the generator:

```
python3 docs/build_15ball_paper_sheet_svg.py
```

No third-party dependencies are required (pure stdlib Python ≥ 3.8).

---

## Validating the SVG

```
python3 docs/validate_svg.py
```

Exit code `0` = all checks pass. The validator confirms:

1. The file exists.
2. It is well-formed XML.
3. The root element is `<svg>` in the SVG namespace.
4. `viewBox="0 0 612 792"` (US Letter portrait in points).
5. All required layer IDs are present (see below).

---

## Layer / Group ID Conventions

The SVG uses Inkscape layers (`inkscape:groupmode="layer"`) with stable IDs so
automated tools and scripts can reliably locate any region.

### Top-level layers

| ID | Contents |
|----|----------|
| `layer-header` | Title text |
| `layer-instructions` | HOW TO SCORE strip |
| `layer-rules` | 15-Ball Rotation rules summary block |
| `layer-player-info` | Player A / Player B name+goal cards |
| `layer-column-headers` | RACK / PLAYER A / PLAYER B column labels |
| `layer-rack-1` … `layer-rack-4` | One full rack row each |
| `layer-totals` | High Run, Final Game Total, Fouls cells |
| `layer-signatures` | Winner checkboxes + signature lines |
| `layer-footer` | Site credit + version tag |

### Inside each rack layer (`layer-rack-N`)

```
layer-rack-1
  rack-1-player-a          ← Player A panel group
    rack-1-player-a-ball-grid
      rack-1-player-a-ball-01  …  rack-1-player-a-ball-15
    rack-1-player-a-score-fields
  rack-1-player-b          ← Player B panel group
    rack-1-player-b-ball-grid
      rack-1-player-b-ball-01  …  rack-1-player-b-ball-15
    rack-1-player-b-score-fields
```

**Ball grid:** 3 rows × 5 columns = 15 outlined circles per player per rack.  
**Score fields:** Rack Total, Fouls, Running Total (right-side strip).

---

## Layout Summary

- **Page size:** US Letter portrait – `width="612pt" height="792pt"` with `viewBox="0 0 612 792"`.
- **Coordinate system:** 1 SVG unit = 1 typographic point (1 in = 72 pt).
- Player A is on the **left** half of every rack row; Player B is on the **right**.
- Ball circles are outlined (writable) – mark with a dot, slash, or ×.
- Score boxes: Rack Total, Fouls, Running Total per player per rack.
- Totals row: **High Run**, **Final Game Total**, **Fouls** per player.
- Large signature area with Player A and Player B lines.

---

## Scoring Instruction Text (verbatim)

> Slop/non-called balls score only on the break, or when made along with a
> legally called ball in its called pocket. Otherwise, the non-scoring ball is
> spotted on the long string from the foot spot toward the foot rail; it scores
> no points and ends the shooter's inning.

---

## Rule: Durable Changes Belong in the Generator

**Never edit the SVG directly** for structural changes.  
Edit `docs/build_15ball_paper_sheet_svg.py`, re-run it, and commit both the
updated generator and the regenerated SVG together.

Minor Inkscape-only tweaks (e.g., adjusting a single text label for a one-off
print run) are acceptable in the SVG, but will be overwritten on the next
`python3 docs/build_15ball_paper_sheet_svg.py` run.
