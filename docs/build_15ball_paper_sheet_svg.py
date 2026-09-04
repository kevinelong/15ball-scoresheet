"""
15-Ball Rotation Paper Score Sheet – SVG generator
====================================================

Produces assets/print/15-ball-rotation-score-sheet.inkscape.svg

Pure stdlib Python (xml.etree.ElementTree) – no third-party dependencies.

Run:
    python3 docs/build_15ball_paper_sheet_svg.py

Layout faithfully follows _scoresheet_draw.py:
  * US Letter portrait (8.5 × 11 in) → viewBox="0 0 612 792" (1 pt = 1 SVG unit)
  * Inkscape namespace + named layers with stable IDs
  * Four rack rows; each rack has Player A (left) and Player B (right) panels
  * Each panel: ball-grid (3 rows × 5 balls = 15) + score-fields strip
  * Totals: High Run, Final Game Total, Fouls
  * Large signature areas; winner checkboxes

Durable changes belong here, not in manual SVG edits – see assets/print/README.md.
"""
from __future__ import annotations
import math
import os
import xml.etree.ElementTree as ET
from xml.dom import minidom

# ---------------------------------------------------------------------------
# Namespaces
# ---------------------------------------------------------------------------
NS_SVG    = "http://www.w3.org/2000/svg"
NS_XLINK  = "http://www.w3.org/1999/xlink"
NS_INK    = "http://www.inkscape.org/namespaces/inkscape"
NS_SP     = "http://sodipodi.sourceforge.net/DTD/sodipodi-0.0.dtd"
NS_DC     = "http://purl.org/dc/elements/1.1/"
NS_CC     = "http://creativecommons.org/ns#"
NS_RDF    = "http://www.w3.org/1999/02/22-rdf-syntax-ns#"

ET.register_namespace("",          NS_SVG)
ET.register_namespace("xlink",     NS_XLINK)
ET.register_namespace("inkscape",  NS_INK)
ET.register_namespace("sodipodi",  NS_SP)
ET.register_namespace("dc",        NS_DC)
ET.register_namespace("cc",        NS_CC)
ET.register_namespace("rdf",       NS_RDF)


def _q(ns: str, tag: str) -> str:
    return f"{{{ns}}}{tag}"


def _ink(attr: str) -> str:
    return _q(NS_INK, attr)


def _sp(attr: str) -> str:
    return _q(NS_SP, attr)


# ---------------------------------------------------------------------------
# Page / margin constants  (points: 1 in = 72 pt)
# ---------------------------------------------------------------------------
PAGE_W = 612          # 8.5 in
PAGE_H = 792          # 11 in
MARGIN = 36           # 0.5 in

# ---------------------------------------------------------------------------
# Section heights  (match _scoresheet_draw.py where relevant)
# ---------------------------------------------------------------------------
SHEET_PAD        = 8
SHEET_TITLE_H    = 24
SHEET_INSTR_H    = 52
SHEET_INSTR_GAP  = 10
SHEET_RULES_H    = 80   # extra height to accommodate slop-rule text wrapping
SHEET_RULES_GAP  = 6
SHEET_PHDR_H     = 46
SHEET_PHDR_GAP   = 8
RACK_HDR_H       = 14
STATS_HDR_H      = 0    # stats labels live inside each score-fields strip
NUM_RACKS        = 4
TOTALS_GAP       = 4
TOTALS_H         = 30
WIN_GAP          = 6
WIN_H            = 26
FOOTER_H         = 14

# ---------------------------------------------------------------------------
# Visual style
# ---------------------------------------------------------------------------
STROKE   = "black"
SW_STRONG = "1.6"
SW_MED    = "1.0"
SW_THIN   = "0.6"
SW_BALL   = "0.9"

FONT      = "Helvetica, Arial, sans-serif"

# ---------------------------------------------------------------------------
# SVG element helpers (all tags fully qualified in SVG namespace)
# ---------------------------------------------------------------------------

def _sub(parent: ET.Element, tag: str, **attrs) -> ET.Element:
    el = ET.SubElement(parent, _q(NS_SVG, tag))
    for k, v in attrs.items():
        el.set(k.replace("__", ":").replace("_", "-"), str(v))
    return el


def _layer(parent: ET.Element, layer_id: str, label: str) -> ET.Element:
    g = ET.SubElement(parent, _q(NS_SVG, "g"))
    g.set("id", layer_id)
    g.set(_ink("label"), label)
    g.set(_ink("groupmode"), "layer")
    return g


def _group(parent: ET.Element, gid: str, label: str = "") -> ET.Element:
    g = ET.SubElement(parent, _q(NS_SVG, "g"))
    g.set("id", gid)
    if label:
        g.set(_ink("label"), label)
    return g


def _rect(parent, x, y, w, h, *, fill="none", stroke=STROKE,
          sw=SW_MED, dash="", extra=None) -> ET.Element:
    el = ET.SubElement(parent, _q(NS_SVG, "rect"))
    el.set("x", f"{x:.2f}"); el.set("y", f"{y:.2f}")
    el.set("width", f"{w:.2f}"); el.set("height", f"{h:.2f}")
    style = f"fill:{fill};stroke:{stroke};stroke-width:{sw}"
    if dash:
        style += f";stroke-dasharray:{dash}"
    el.set("style", style)
    if extra:
        for k, v in extra.items():
            el.set(k, v)
    return el


def _circle(parent, cx, cy, r, *, fill="white", stroke=STROKE,
             sw=SW_BALL) -> ET.Element:
    el = ET.SubElement(parent, _q(NS_SVG, "circle"))
    el.set("cx", f"{cx:.3f}"); el.set("cy", f"{cy:.3f}")
    el.set("r", f"{r:.3f}")
    el.set("style", f"fill:{fill};stroke:{stroke};stroke-width:{sw}")
    return el


def _line(parent, x1, y1, x2, y2, *, stroke=STROKE, sw=SW_THIN) -> ET.Element:
    el = ET.SubElement(parent, _q(NS_SVG, "line"))
    el.set("x1", f"{x1:.2f}"); el.set("y1", f"{y1:.2f}")
    el.set("x2", f"{x2:.2f}"); el.set("y2", f"{y2:.2f}")
    el.set("style", f"stroke:{stroke};stroke-width:{sw}")
    return el


def _text(parent, x, y, content, *, size=7.0, bold=False,
          anchor="start", fill="black") -> ET.Element:
    el = ET.SubElement(parent, _q(NS_SVG, "text"))
    el.set("x", f"{x:.2f}"); el.set("y", f"{y:.2f}")
    weight = "bold" if bold else "normal"
    el.set("style",
           f"font-size:{size}pt;font-family:{FONT};"
           f"font-weight:{weight};fill:{fill};text-anchor:{anchor}")
    el.text = content
    return el


# ---------------------------------------------------------------------------
# Ball circle with number
# ---------------------------------------------------------------------------

def _ball(parent: ET.Element, elem_id: str, cx: float, cy: float,
          num: int, r: float = 9.0) -> ET.Element:
    """Outlined writable ball circle with centred numeral."""
    g = _group(parent, elem_id)
    _circle(g, cx, cy, r, fill="white", sw=SW_BALL)
    num_size = min(7.5, max(5.3, r * 0.85))
    t = ET.SubElement(g, _q(NS_SVG, "text"))
    t.set("x", f"{cx:.3f}")
    t.set("y", f"{cy + num_size * 0.38:.3f}")
    t.set("style", (
        f"font-size:{num_size:.1f}pt;font-family:{FONT};"
        f"font-weight:bold;fill:black;text-anchor:middle"
    ))
    t.text = str(num)
    return g


# ---------------------------------------------------------------------------
# Score-fields strip  (Rack Total / Fouls / Running Total)
# ---------------------------------------------------------------------------

def _score_fields(parent: ET.Element, strip_id: str,
                  x: float, y: float, w: float, h: float) -> ET.Element:
    """Three labelled score boxes stacked inside (x, y, w, h)."""
    g = _group(parent, strip_id)
    _rect(g, x, y, w, h, sw=SW_MED)
    entries = [("RACK", "TOTAL"), ("FOULS", ""), ("RUNNING", "TOTAL")]
    n = len(entries)
    cell_h = h / n
    lbl_w  = w * 0.55
    box_w  = w - lbl_w - 4
    for i, (l1, l2) in enumerate(entries):
        cy = y + i * cell_h
        if i > 0:
            _line(g, x, cy, x + w, cy, sw=SW_THIN)
        mid_y = cy + cell_h / 2
        if l2:
            _text(g, x + 3, mid_y - 2,  l1, size=5, bold=True)
            _text(g, x + 3, mid_y + 5,  l2, size=5, bold=True)
        else:
            _text(g, x + 3, mid_y + 2,  l1, size=5, bold=True)
        _rect(g, x + lbl_w, cy + 3, box_w, cell_h - 6, sw=SW_MED)
    return g


# ---------------------------------------------------------------------------
# One rack row
# ---------------------------------------------------------------------------

def _rack_row(parent: ET.Element, rack_num: int,
              x0: float, y: float, total_w: float, rack_h: float) -> ET.Element:
    """Full rack row: label column + Player A panel + Player B panel."""
    layer_id = f"layer-rack-{rack_num}"
    g = _layer(parent, layer_id, f"Rack {rack_num}")

    label_col_w = 22.0
    panel_w     = (total_w - label_col_w) / 2

    # Rack number label cell
    _rect(g, x0, y, label_col_w, rack_h, sw=SW_MED)
    t = ET.SubElement(g, _q(NS_SVG, "text"))
    t.set("x", f"{x0 + label_col_w / 2:.2f}")
    t.set("y", f"{y + rack_h / 2 + 6:.2f}")
    t.set("style", (
        f"font-size:16pt;font-family:{FONT};"
        f"font-weight:bold;fill:black;text-anchor:middle"
    ))
    t.text = str(rack_num)

    score_strip_w = 58.0
    balls_area_w  = panel_w - score_strip_w
    cols, rows_b  = 5, 3
    cell_w = balls_area_w / cols
    cell_h = rack_h / rows_b
    ball_r = min(cell_w * 0.42, cell_h * 0.38, 9.0)

    for side_i, side_letter in enumerate(["a", "b"]):
        px      = x0 + label_col_w + side_i * panel_w
        side_id = f"rack-{rack_num}-player-{side_letter}"
        sg      = _group(g, side_id)

        # Panel border
        _rect(sg, px, y, panel_w, rack_h, sw=SW_MED)

        # Ball grid
        bg = _group(sg, f"{side_id}-ball-grid")
        ball_num = 1
        for row in range(rows_b):
            for col in range(cols):
                bx = px + col * cell_w + cell_w / 2
                by = y  + row * cell_h + cell_h / 2
                _ball(bg, f"{side_id}-ball-{ball_num:02d}", bx, by,
                      ball_num, r=ball_r)
                ball_num += 1

        # Score fields
        sf_x = px + balls_area_w
        _line(sg, sf_x, y, sf_x, y + rack_h, sw=SW_THIN)
        _score_fields(sg, f"{side_id}-score-fields",
                      sf_x, y, score_strip_w, rack_h)

    return g


# ---------------------------------------------------------------------------
# Main builder
# ---------------------------------------------------------------------------

def build_svg() -> str:
    """Construct the full SVG and return it as a UTF-8 string."""

    root = ET.Element(_q(NS_SVG, "svg"))
    root.set("width",   "612pt")
    root.set("height",  "792pt")
    root.set("viewBox", "0 0 612 792")
    root.set("version", "1.1")
    root.set("id", "svg-15ball-scoresheet")

    # --- Inkscape namedview ---
    nv = ET.SubElement(root, _q(NS_SP, "namedview"))
    nv.set("id", "namedview1")
    nv.set("pagecolor", "#ffffff")
    nv.set("bordercolor", "#666666")
    nv.set("borderopacity", "1.0")
    nv.set(_ink("pageopacity"), "0.0")
    nv.set(_ink("document-units"), "pt")
    nv.set(_ink("current-layer"), "layer-header")
    nv.set("showgrid", "false")
    nv.set(_sp("docname"), "15-ball-rotation-score-sheet.inkscape.svg")
    ip = ET.SubElement(nv, _q(NS_INK, "page"))
    ip.set("id", "page1")
    ip.set("x", "0"); ip.set("y", "0")
    ip.set("width", "612"); ip.set("height", "792")

    # --- RDF metadata ---
    meta = ET.SubElement(root, _q(NS_SVG, "metadata"))
    meta.set("id", "metadata1")
    rdf = ET.SubElement(meta, _q(NS_RDF, "RDF"))
    work = ET.SubElement(rdf, _q(NS_CC, "Work"))
    work.set(_q(NS_RDF, "about"), "")
    fmt = ET.SubElement(work, _q(NS_DC, "format"))
    fmt.text = "image/svg+xml"
    title_m = ET.SubElement(work, _q(NS_DC, "title"))
    title_m.text = "15-Ball Rotation Blank Score Sheet"
    creator_m = ET.SubElement(work, _q(NS_DC, "creator"))
    creator_ag = ET.SubElement(creator_m, _q(NS_CC, "Agent"))
    creator_title = ET.SubElement(creator_ag, _q(NS_DC, "title"))
    creator_title.text = "docs/build_15ball_paper_sheet_svg.py"

    # ---------------------------------------------------------------------------
    # Geometry
    # ---------------------------------------------------------------------------
    pad     = SHEET_PAD
    x0      = MARGIN + pad
    inner_w = PAGE_W - 2 * MARGIN - 2 * pad

    # Compute rack_h so everything fits on the page
    fixed_h = (SHEET_TITLE_H
               + SHEET_INSTR_H + SHEET_INSTR_GAP
               + SHEET_RULES_H + SHEET_RULES_GAP
               + SHEET_PHDR_H  + SHEET_PHDR_GAP + 8
               + RACK_HDR_H
               + TOTALS_GAP + TOTALS_H
               + WIN_GAP + WIN_H
               + FOOTER_H)
    avail = PAGE_H - 2 * MARGIN - 2 * pad - fixed_h
    rack_h = max(54.0, avail / NUM_RACKS)

    sheet_h = (2 * pad + fixed_h + NUM_RACKS * rack_h)
    sheet_h = min(sheet_h, PAGE_H - 2 * MARGIN)

    # White background
    bg = ET.SubElement(root, _q(NS_SVG, "rect"))
    bg.set("id", "background")
    bg.set("x", "0"); bg.set("y", "0")
    bg.set("width", "612"); bg.set("height", "792")
    bg.set("style", "fill:white;stroke:none")

    # Outer sheet border
    _rect(root, MARGIN, MARGIN,
          PAGE_W - 2 * MARGIN, sheet_h,
          sw=SW_STRONG, extra={"id": "sheet-border"})

    # Running y cursor (top of current section, SVG y increases downward)
    y = MARGIN + pad

    # ===========================================================================
    # layer-header
    # ===========================================================================
    lhdr = _layer(root, "layer-header", "Header")
    _text(lhdr, PAGE_W / 2, y + 15,
          "15-BALL ROTATION - MATCH SCORE SHEET",
          size=12, bold=True, anchor="middle")
    y += SHEET_TITLE_H

    # ===========================================================================
    # layer-instructions  (HOW TO SCORE strip)
    # ===========================================================================
    linstr = _layer(root, "layer-instructions", "Instructions")
    ix  = x0 + 6
    iw  = inner_w - 12
    _rect(linstr, ix, y, iw, SHEET_INSTR_H, sw=SW_THIN)
    _text(linstr, ix + 10, y + 10, "HOW TO SCORE", size=7, bold=True)
    _text(linstr, ix + iw - 10, y + 10,
          "Required at Columbia Cue Club tournaments. Mark opponent's balls as a courtesy.",
          size=6, anchor="end")

    steps = [
        (1, "Fill NAME; check goal (25 rec / 50 pro)."),
        (2, "MARK each ball's circle as it drops (mandatory)."),
        (3, "RECONCILE every rack: 15 marks total, no dupes."),
        (4, "RACK TOTAL = # marks - FOULS. Tally optional."),
        (5, "RUNNING TOTAL = last RUNNING + RACK TOTAL."),
        (6, "First to goal wins. Check WINNER; both sign."),
    ]
    col_gap  = 18
    col_w    = (iw - col_gap - 20) / 2
    step_h   = (SHEET_INSTR_H - 18) / 3
    step_top = y + 18
    for i, (n, body) in enumerate(steps):
        col = i // 3;  row = i % 3
        sx  = ix + 10 + col * (col_w + col_gap)
        sy  = step_top + row * step_h + 6
        _text(linstr, sx,      sy, f"{n}.", size=7, bold=True)
        _text(linstr, sx + 10, sy, body,    size=7)
    y += SHEET_INSTR_H + SHEET_INSTR_GAP

    # ===========================================================================
    # layer-rules  (Rules summary block)
    # ===========================================================================
    lrules = _layer(root, "layer-rules", "Rules Summary")
    rx = x0 + 6
    rw = inner_w - 12
    _rect(lrules, rx, y, rw, SHEET_RULES_H, sw=SW_THIN)
    ip2 = 10

    # QR placeholder (right column)
    qr_size = 44.0
    qr_x    = rx + rw - ip2 - qr_size
    qr_y    = y + ip2
    _rect(lrules, qr_x, qr_y, qr_size, qr_size, sw=SW_THIN,
          extra={"id": "qr-placeholder"})
    _text(lrules, qr_x + qr_size / 2, qr_y + qr_size / 2 - 3,
          "QR", size=7, anchor="middle")
    _text(lrules, qr_x + qr_size / 2, qr_y + qr_size / 2 + 6,
          "Rules", size=6, anchor="middle")
    _text(lrules, qr_x + qr_size / 2, qr_y + qr_size + 8,
          "Scan: full 15-Ball rules", size=5.5, bold=True, anchor="middle")

    # Left column: rules text
    lx  = rx + ip2
    lly = y + ip2 + 6
    _text(lrules, lx, lly, "15-BALL ROTATION RULES SUMMARY", size=8, bold=True)
    lly += 11

    rule_lines = [
        (True,
         "BALL IN HAND every inning. No safeties – incoming player always places cue ball anywhere."),
        (False,
         "Rack: 1 at apex on foot spot, 8 in center, others random. Break with cue ball above the head string."),
        (False,
         "Hit lowest ball first, then CALL ball + pocket. Uncalled makes are spotted."),
        (False,
         "Slop/non-called balls score only on the break, or when made along with a legally called ball in its called pocket."),
        (False,
         "Otherwise, the non-scoring ball is spotted on the long string from the foot spot toward the foot rail;"),
        (False,
         "it scores no points and ends the shooter's inning."),
        (False,
         "Fouls (−1 pt, score can go negative): scratch, no-rail, wrong-ball-first, ball off table, scoop-jump."),
        (False,
         "First to goal wins. Balls on break count for breaker (spotted on break foul). Play passes after break."),
    ]
    max_lx = qr_x - 8
    for bold, txt in rule_lines:
        _text(lrules, lx, lly, txt, size=6.5, bold=bold)
        lly += 8.5
    y += SHEET_RULES_H + SHEET_RULES_GAP

    # ===========================================================================
    # layer-player-info  (Name / Goal cards)
    # ===========================================================================
    lpi = _layer(root, "layer-player-info", "Player Info")
    gap      = SHEET_PHDR_GAP
    pcard_w  = (inner_w - gap) / 2

    for i, label in enumerate(["PLAYER A", "PLAYER B"]):
        px   = x0 + i * (pcard_w + gap)
        side = "a" if i == 0 else "b"
        cg   = _group(lpi, f"player-{side}-card")
        _rect(cg, px, y, pcard_w, SHEET_PHDR_H, sw=SW_MED)
        _text(cg, px + 6, y + 10,   label,  size=7,  bold=True)
        _text(cg, px + 6, y + 22,   "NAME:", size=8, bold=True)
        _line(cg, px + 40, y + 23, px + pcard_w - 8, y + 23, sw="0.8")
        _text(cg, px + 6, y + 37,   "GOAL:", size=8, bold=True)
        cx_box = px + 40
        for lbl in ["25", "50"]:
            _rect(cg, cx_box, y + 28, 8, 8, sw=SW_MED)
            _text(cg, cx_box + 12, y + 36, lbl, size=8)
            cx_box += 30
        _rect(cg, cx_box, y + 28, 8, 8, sw=SW_MED)
        _text(cg, cx_box + 12, y + 36, "OTHER:", size=8)
        _line(cg, cx_box + 50, y + 35, px + pcard_w - 8, y + 35, sw="0.8")
    y += SHEET_PHDR_H + 8

    # Column header row (RACK / PLAYER A / PLAYER B)
    lch  = _layer(root, "layer-column-headers", "Column Headers")
    lcw  = 22.0
    sw   = (inner_w - lcw) / 2
    _text(lch, x0 + lcw / 2,          y + 10, "RACK",     size=7, bold=True, anchor="middle")
    _text(lch, x0 + lcw + sw / 2,     y + 10, "PLAYER A", size=7, bold=True, anchor="middle")
    _text(lch, x0 + lcw + sw + sw / 2, y + 10, "PLAYER B", size=7, bold=True, anchor="middle")
    y += RACK_HDR_H

    # ===========================================================================
    # layer-rack-1 through layer-rack-4
    # ===========================================================================
    for rack_num in range(1, NUM_RACKS + 1):
        _rack_row(root, rack_num, x0, y, inner_w, rack_h)
        y += rack_h

    # ===========================================================================
    # layer-totals
    # ===========================================================================
    y += TOTALS_GAP
    ltot = _layer(root, "layer-totals", "Totals")
    _text(ltot, x0, y + 6, "PLAYER TOTALS", size=6.5, bold=True)
    _text(ltot, x0 + inner_w, y + 6,
          "left card = PLAYER A   –   right card = PLAYER B",
          size=6, anchor="end")

    tcard_w = (inner_w - gap) / 2
    ty      = y + 10
    for i in range(2):
        tx    = x0 + i * (tcard_w + gap)
        tcg   = _group(ltot, f"totals-player-{'a' if i == 0 else 'b'}")
        _rect(tcg, tx, ty, tcard_w, TOTALS_H, sw=SW_MED)
        cell_labels = ["HIGH RUN", "FINAL GAME TOTAL", "FOULS"]
        cell_w      = (tcard_w - 4) / len(cell_labels)
        for ci, clbl in enumerate(cell_labels):
            cx2 = tx + 2 + ci * cell_w
            _rect(tcg, cx2, ty + 2, cell_w - 2, TOTALS_H - 4, sw=SW_STRONG)
            _text(tcg, cx2 + cell_w / 2, ty + 10, clbl,
                  size=5, bold=True, anchor="middle")
    y += 10 + TOTALS_H + WIN_GAP

    # ===========================================================================
    # layer-signatures
    # ===========================================================================
    lsig = _layer(root, "layer-signatures", "Signatures")
    _text(lsig, x0, y + 10, "WINNER:", size=8, bold=True)
    wx = x0 + 55
    for wlabel in ["PLAYER A", "PLAYER B"]:
        _rect(lsig, wx, y + 2, 10, 10, sw=SW_MED)
        _text(lsig, wx + 14, y + 11, wlabel, size=8)
        wx += 90

    sig_end_x  = x0 + inner_w
    sig_line_w = 96.0
    sig_gap2   = 12.0
    sig_b_x    = sig_end_x - sig_line_w
    sig_a_x    = sig_b_x - sig_gap2 - sig_line_w
    _text(lsig, sig_a_x - 74, y + 10, "SIGNATURES:", size=7, bold=True)
    _line(lsig, sig_a_x, y + 14, sig_a_x + sig_line_w, y + 14, sw="0.9")
    _line(lsig, sig_b_x, y + 14, sig_b_x + sig_line_w, y + 14, sw="0.9")
    _text(lsig, sig_a_x + sig_line_w / 2, y + 24, "PLAYER A",
          size=6, anchor="middle")
    _text(lsig, sig_b_x + sig_line_w / 2, y + 24, "PLAYER B",
          size=6, anchor="middle")
    y += WIN_H

    # ===========================================================================
    # layer-footer
    # ===========================================================================
    lfoot = _layer(root, "layer-footer", "Footer")
    _text(lfoot, MARGIN, PAGE_H - MARGIN + 6,
          "ColumbiaCueClub.com  \u2013  15-Ball Rotation blank score sheet",
          size=6.5)
    _text(lfoot, PAGE_W - MARGIN, PAGE_H - MARGIN + 6,
          "Blank Sheet v2", size=6.5, anchor="end")

    # ---------------------------------------------------------------------------
    # Serialise to pretty-printed SVG string
    # ---------------------------------------------------------------------------
    raw = ET.tostring(root, encoding="unicode", xml_declaration=False)
    dom = minidom.parseString(f'<?xml version="1.0"?>{raw}')
    pretty = dom.toprettyxml(indent="  ", encoding=None)
    lines = pretty.splitlines()
    if lines and lines[0].startswith("<?xml"):
        lines[0] = '<?xml version="1.0" encoding="UTF-8" standalone="no"?>'
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
HERE      = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(HERE)
OUT_DIR   = os.path.join(REPO_ROOT, "assets", "print")
OUT_FILE  = os.path.join(OUT_DIR, "15-ball-rotation-score-sheet.inkscape.svg")


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    svg_text = build_svg()
    with open(OUT_FILE, "w", encoding="utf-8") as fh:
        fh.write(svg_text)
    print(f"Wrote {OUT_FILE}")


if __name__ == "__main__":
    main()
