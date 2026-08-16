"""
K-Ball / 15-Ball Rotation - Score-Sheet Drawing Primitives

Shared drawing module used by every paper-score-sheet build script.
Provides pure-black-on-white drawing primitives + the top-level
draw_scoresheet() function that lays out one complete blank sheet
at a given (left, top, width, height).

This is not a runnable script - it's imported by:
  * build_paper_sheet.py       (one full sheet per letter page)
  * build_paper_sheet_2up.py   (two side-by-side sheets per landscape page)

The sheet is self-teaching: it has a HOW TO SCORE mini-instructions strip
and a K-BALL RULES SUMMARY block with a QR to the WPA rules PDF, so no
separate annotated "guide" PDF is required.
"""
from __future__ import annotations
import os, sys
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch

# Print colors: pure black on white. Grays only for very light backgrounds
# that copy well (>= 90% white). We avoid mid-grays entirely.
BLACK = (0, 0, 0)
WHITE = (1, 1, 1)
NEAR_WHITE = (0.96, 0.96, 0.96)   # for filled-cell backgrounds
LINE = 0.6
LINE_MED = 1.0
LINE_STRONG = 1.6

PAGE_W, PAGE_H = letter  # 612 x 792
MARGIN = 0.5 * inch

FONT_BODY = "Helvetica"
FONT_BOLD = "Helvetica-Bold"

def draw_star(c, x, y, r):
    """Draw a solid black 5-point star centered at (x,y)."""
    import math
    p = c.beginPath()
    pts = []
    for i in range(10):
        ang = -math.pi/2 + i * math.pi/5
        rr = r if i % 2 == 0 else r * 0.45
        pts.append((x + math.cos(ang)*rr, y + math.sin(ang)*rr))
    p.moveTo(*pts[0])
    for pt in pts[1:]:
        p.lineTo(*pt)
    p.close()
    c.setFillColorRGB(*BLACK)
    c.drawPath(p, fill=1, stroke=0)

def draw_qr(c, x, y_bottom, size_pt, data):
    """Draw a QR code as filled rectangles at the given canvas position.

    (x, y_bottom) is the bottom-left corner of the QR square. `size_pt` is
    the outer edge length in points. Uses medium error correction; auto-
    sizes the version to fit `data`. Returns the number of modules per side
    so callers can lay out captions relative to the true QR size.
    """
    try:
        import qrcode
        from qrcode.constants import ERROR_CORRECT_M
    except ImportError:
        # Draw a placeholder if qrcode isn't installed on the build machine.
        c.setStrokeColorRGB(*BLACK); c.setLineWidth(0.6)
        c.rect(x, y_bottom, size_pt, size_pt, stroke=1, fill=0)
        c.setFont(FONT_BODY, 5)
        c.drawCentredString(x + size_pt/2, y_bottom + size_pt/2, "QR")
        return 0
    q = qrcode.QRCode(version=None, box_size=1, border=0,
                      error_correction=ERROR_CORRECT_M)
    q.add_data(data); q.make(fit=True)
    m = q.get_matrix()
    n = len(m)
    module = size_pt / n
    c.setFillColorRGB(*BLACK)
    c.setStrokeColorRGB(*BLACK)
    for r, row in enumerate(m):
        # y coordinate for this row's TOP
        py = y_bottom + (n - r) * module
        # Coalesce contiguous filled modules in this row into a single rect
        # to keep the PDF light.
        col = 0
        while col < n:
            if not row[col]:
                col += 1; continue
            start = col
            while col < n and row[col]:
                col += 1
            run = col - start
            c.rect(x + start * module, py - module,
                   run * module, module, stroke=0, fill=1)
    return n


def draw_ball(c, x, y, num, filled=False, r=5.4):
    """Ball marker: filled black circle with white number, or outlined circle with black number.

    The outlined variant is meant to be MARKED INSIDE by the scorer (dot, slash,
    or X). That means the circle should be visibly larger than the numeral so
    there is room for the mark; we cap the numeral size below the radius rather
    than letting it grow proportionally.
    """
    c.setLineWidth(0.9)
    c.setStrokeColorRGB(*BLACK)
    if filled:
        c.setFillColorRGB(*BLACK)
        c.circle(x, y, r, stroke=1, fill=1)
        c.setFillColorRGB(*WHITE)
    else:
        c.setFillColorRGB(*WHITE)
        c.circle(x, y, r, stroke=1, fill=1)
        c.setFillColorRGB(*BLACK)
    # Numeral stays small so a hand mark fits comfortably inside the circle.
    # Floor 5.3pt so single digits stay legible; ceiling ~7.5pt so a 10pt+
    # circle still reads as "empty circle with a small number in it".
    num_size = min(7.5, max(5.3, r * 0.85))
    c.setFont(FONT_BOLD, num_size)
    c.drawCentredString(x, y - num_size * 0.32, str(num))

# ---------- responsive sheet geometry ----------
# Fixed sizes for every non-rack region. The rack grid absorbs any leftover
# space so the sheet always fills its bounding box exactly with no clipping.
SHEET_PAD          = 8      # inner padding inside the outer border
SHEET_TITLE_H      = 24     # big title (subtitle retired; HOW TO SCORE covers the formulas)
SHEET_INSTR_H      = 52     # 6-step mini-instructions strip (self-contained sheet)
SHEET_INSTR_MARGIN = 6      # breathing room on each side of the strip
SHEET_INSTR_GAP    = 10     # gap between strip and rules block (reclaimed from subtitle)
SHEET_RULES_H      = 78     # rules-comparison block + QR to WPA rules PDF
SHEET_RULES_GAP    = 10     # gap between rules block and player-header card
SHEET_PHDR_H       = 46     # PLAYER A/B name+goal card
SHEET_PHDR_GAP     = 8
SHEET_RACK_HDR_H   = 14     # "RACK / PLAYER A / PLAYER B" column header
SHEET_STATS_HDR_H  = 20     # 2-line plain-English label strip (above racks)
SHEET_TOTALS_HDR_H = 20     # two clear rows: player tag, then column labels
SHEET_TOTALS_H     = 0.42 * inch
SHEET_TOTALS_GAP   = 4      # gap between racks and totals labels
SHEET_WIN_GAP      = 6      # gap between totals and winner row
SHEET_WIN_H        = 0.42 * inch
NUM_RACKS          = 4
SHEET_RACK_H_MIN   = 30.5   # each rack row (min); grows to fill available height

def sheet_min_height(with_instructions=True):
    """Minimum height the score sheet needs to render without clipping.

    The mini-instructions strip AND the rules-comparison block are
    included by default (self-contained blank sheet). When the sheet
    is embedded inside the annotated guide, the surrounding callouts
    already teach these steps, so both are omitted.
    """
    extras = 0
    if with_instructions:
        extras += SHEET_INSTR_H + SHEET_INSTR_GAP
        extras += SHEET_RULES_H + SHEET_RULES_GAP
    return (2*SHEET_PAD + SHEET_TITLE_H + extras
            + SHEET_PHDR_H
            + 8 + SHEET_RACK_HDR_H + SHEET_STATS_HDR_H
            + NUM_RACKS * SHEET_RACK_H_MIN
            + SHEET_TOTALS_GAP + SHEET_TOTALS_HDR_H + SHEET_TOTALS_H
            + SHEET_WIN_GAP + SHEET_WIN_H)

def draw_scoresheet(c, left, top, width, height, with_instructions=True):
    """The empty score sheet region (for hand-filling).

    Layout is fully responsive: rack row height grows to consume any extra
    vertical space so the content fills `height` without clipping. Requires
    at least `sheet_min_height(with_instructions)` of vertical room; raises
    if given less.
    """
    min_h = sheet_min_height(with_instructions=with_instructions)
    if height < min_h:
        raise ValueError(
            f"draw_scoresheet: height={height:.1f}pt is below min {min_h:.1f}pt"
        )

    # Outer heavy black border
    c.setStrokeColorRGB(*BLACK)
    c.setLineWidth(LINE_STRONG)
    c.rect(left, top - height, width, height, stroke=1, fill=0)

    pad = SHEET_PAD
    x0 = left + pad
    y0 = top - pad
    inner_w = width - 2*pad

    # Compute rack_h so all rows fit the requested height exactly.
    extras_reserve = 0
    if with_instructions:
        extras_reserve += SHEET_INSTR_H + SHEET_INSTR_GAP
        extras_reserve += SHEET_RULES_H + SHEET_RULES_GAP
    fixed_h = (SHEET_TITLE_H + extras_reserve
               + SHEET_PHDR_H + 8
               + SHEET_RACK_HDR_H + SHEET_STATS_HDR_H
               + SHEET_TOTALS_GAP + SHEET_TOTALS_HDR_H + SHEET_TOTALS_H
               + SHEET_WIN_GAP + SHEET_WIN_H)
    avail_for_racks = (height - 2*pad) - fixed_h
    rack_h = avail_for_racks / NUM_RACKS

    # === Title bar (inside the sheet) ===
    # Subtitle retired: RACK TOTAL / GAME SUBTOTAL formulas moved to the
    # HOW TO SCORE strip (steps 4 & 5) so they aren't duplicated. The
    # Columbia Cue Club branding lives in the footer of each build script.
    c.setFont(FONT_BOLD, 12)
    c.setFillColorRGB(*BLACK)
    c.drawCentredString(left + width/2, y0 - 14, "15-BALL ROTATION (K-BALL) - MATCH SCORE SHEET")
    y0 -= SHEET_TITLE_H

    # === Mini-instructions strip (self-contained sheet) ===
    # Six one-liners, so a first-time scorer can fill this sheet without
    # needing the separate guide. Kept short by design; use two hairline
    # columns of three steps each. Skipped when the sheet is embedded in
    # the annotated guide - the callouts there already say the same thing.
    if with_instructions:
        instr_top = y0
        instr_h = SHEET_INSTR_H
        # Inset the strip so it doesn't crowd the outer sheet border.
        strip_x = x0 + SHEET_INSTR_MARGIN
        strip_w = inner_w - 2 * SHEET_INSTR_MARGIN
        c.setLineWidth(LINE)
        c.setStrokeColorRGB(*BLACK)
        c.rect(strip_x, instr_top - instr_h, strip_w, instr_h, stroke=1, fill=0)
        # Interior padding inside the strip so text doesn't hug the frame.
        inner_pad_x = 10
        inner_pad_top = 12
        # Section label in the top-left corner of the strip.
        c.setFont(FONT_BOLD, 7); c.setFillColorRGB(*BLACK)
        c.drawString(strip_x + inner_pad_x, instr_top - 10, "HOW TO SCORE")
        instr_steps = [
            (1, "Fill NAME and check goal (25 rec / 50 pro)."),
            (2, "Mark each ball's circle when pocketed - OR write count in BALLS MADE."),
            (3, "Write # of fouls per rack in FOULS."),
            (4, "RACK TOTAL = BALLS MADE - fouls."),
            (5, "GAME SUBTOTAL = last SUBTOTAL + this RACK TOTAL."),
            (6, "First to goal wins. Check WINNER, both sign."),
        ]
        col_gap = 18
        col_w = (strip_w - col_gap - 2 * inner_pad_x) / 2
        step_line_h = (instr_h - inner_pad_top - 10) / 3   # 3 rows per column
        step_top = instr_top - inner_pad_top - 6           # first step line below section label
        for i, (n, body) in enumerate(instr_steps):
            col = i // 3
            row = i % 3
            sx = strip_x + inner_pad_x + col * (col_w + col_gap)
            sy = step_top - row * step_line_h
            c.setFont(FONT_BOLD, 7); c.setFillColorRGB(*BLACK)
            c.drawString(sx, sy - 6, f"{n}.")
            c.setFont(FONT_BODY, 7)
            c.drawString(sx + 10, sy - 6, body)
        # Advance past the strip AND the breathing gap before the rules block.
        y0 -= SHEET_INSTR_H + SHEET_INSTR_GAP

    # === Rules-comparison block + WPA rules QR (self-contained sheet) ===
    # A two-column block:
    #   Left:  K-BALL rules summary + micro-comparison to 10-ball and 14.1
    #          (the two WPA disciplines K-Ball borrows from).
    #   Right: QR code jumping straight to the WPA 10-Ball section, with
    #          a plain-text URL below for people who prefer to type it.
    # The block is skipped when the sheet is embedded in the annotated
    # guide (with_instructions=False) so the guide's callouts drive the
    # explanation instead.
    if with_instructions:
        rules_top = y0
        rules_h = SHEET_RULES_H
        rules_x = x0 + SHEET_INSTR_MARGIN
        rules_w = inner_w - 2 * SHEET_INSTR_MARGIN
        c.setLineWidth(LINE)
        c.setStrokeColorRGB(*BLACK)
        c.rect(rules_x, rules_top - rules_h, rules_w, rules_h,
               stroke=1, fill=0)
        inner_pad_x = 10
        inner_pad_top = 10

        # --- Right column: QR + URLs ---
        # Right-align the QR block so caption text has room on the left.
        qr_size = 58
        qr_x = rules_x + rules_w - inner_pad_x - qr_size
        qr_y_bottom = rules_top - inner_pad_top - qr_size
        draw_qr(c, qr_x, qr_y_bottom, qr_size,
                "https://wpapool.com/wp-content/uploads/2026/01/2026.01.02-WPA-Rules.pdf#page=24")
        # Caption directly under the QR.
        c.setFont(FONT_BOLD, 6.5); c.setFillColorRGB(*BLACK)
        c.drawCentredString(qr_x + qr_size/2, qr_y_bottom - 8, "Scan: WPA 10-Ball rules")
        c.setFont(FONT_BODY, 5.5); c.setFillColorRGB(*BLACK)
        c.drawCentredString(qr_x + qr_size/2, qr_y_bottom - 15, "wpapool.com/rules/")

        # --- Left column: rules summary ---
        # Reserve space for the QR + a small gap.
        left_x = rules_x + inner_pad_x
        left_w = qr_x - left_x - 10

        # Title line
        c.setFont(FONT_BOLD, 8.5); c.setFillColorRGB(*BLACK)
        c.drawString(left_x, rules_top - inner_pad_top - 4, "K-BALL RULES SUMMARY")
        # Underlying idea
        c.setFont(FONT_BODY, 7); c.setFillColorRGB(*BLACK)
        line_y = rules_top - inner_pad_top - 14
        c.drawString(left_x, line_y,
                     "K-Ball is a house mashup of 10-Ball (rotation, lowest-ball-first) and 14.1 Continuous Pool (1 pt/ball, race to N).")
        line_y -= 9
        c.drawString(left_x, line_y,
                     "Hit the lowest-numbered ball first (rotation). Any ball pocketed legally scores 1 point. First to the goal wins.")
        line_y -= 9
        c.drawString(left_x, line_y,
                     "Fouls (-1 pt each): scratch, no rail after contact, wrong-ball-first, jump-shot on cue ball, ball off table.")
        line_y -= 12

        # Micro-comparison table: 3 rows x 4 cols
        c.setFont(FONT_BOLD, 6.5); c.setFillColorRGB(*BLACK)
        col_labels = ["", "BALLS", "WIN CONDITION", "CALL SHOTS?"]
        # Column x positions inside left column
        col_x = [
            left_x,
            left_x + 62,
            left_x + 108,
            left_x + 232,
        ]
        for cx, lbl in zip(col_x, col_labels):
            c.drawString(cx, line_y, lbl)
        line_y -= 8
        c.setFont(FONT_BOLD, 6.5)
        rows = [
            ("K-Ball", "1-15", "first to race-to-N goal", "No (rotation only)"),
            ("10-Ball", "1-10", "legally pocket the 10", "Yes"),
            ("14.1",    "1-15", "first to race-to-N goal", "Yes"),
        ]
        c.setFont(FONT_BODY, 6.5); c.setFillColorRGB(*BLACK)
        for name, balls, win, call in rows:
            c.setFont(FONT_BOLD, 6.5); c.setFillColorRGB(*BLACK)
            c.drawString(col_x[0], line_y, name)
            c.setFont(FONT_BODY, 6.5); c.setFillColorRGB(*BLACK)
            c.drawString(col_x[1], line_y, balls)
            c.drawString(col_x[2], line_y, win)
            c.drawString(col_x[3], line_y, call)
            line_y -= 7.5

        y0 -= SHEET_RULES_H + SHEET_RULES_GAP

    # === Player header row (blank lines for name/goal) ===
    y_ph = y0
    ph_h = SHEET_PHDR_H
    gap = SHEET_PHDR_GAP
    pcard_w = (inner_w - gap) / 2
    for i, label in enumerate(["PLAYER A", "PLAYER B"]):
        px = x0 + i * (pcard_w + gap)
        c.setLineWidth(LINE_MED)
        c.rect(px, y_ph - ph_h, pcard_w, ph_h, stroke=1, fill=0)
        c.setFont(FONT_BOLD, 7); c.drawString(px + 6, y_ph - 10, label)
        # Name: blank line
        c.setFont(FONT_BOLD, 8); c.drawString(px + 6, y_ph - 22, "NAME:")
        c.setLineWidth(0.8)
        c.line(px + 40, y_ph - 23, px + pcard_w - 8, y_ph - 23)
        # Goal: 25 / 50 / Other checkboxes
        c.drawString(px + 6, y_ph - 37, "GOAL:")
        cx = px + 40
        for lbl in ["25", "50"]:
            c.rect(cx, y_ph - 42, 8, 8, stroke=1, fill=0)
            c.setFont(FONT_BODY, 8); c.drawString(cx + 12, y_ph - 40, lbl)
            c.setFont(FONT_BOLD, 8)
            cx += 30
        c.rect(cx, y_ph - 42, 8, 8, stroke=1, fill=0)
        c.setFont(FONT_BODY, 8); c.drawString(cx + 12, y_ph - 40, "OTHER:")
        c.setLineWidth(0.8); c.line(cx + 43, y_ph - 41, px + pcard_w - 8, y_ph - 41)
    y0 = y_ph - ph_h - 8

    # === Rack grid ===
    rack_col_w = 22
    side_w = (inner_w - rack_col_w) / 2
    stats_strip_w = 116  # 29pt/column fits 2-line labels (BALLS MADE, RACK TOTAL, GAME SUBTOTAL)
    balls_w = side_w - stats_strip_w
    # Ball grid: two tight rows. Row 1 = balls 1-8 (8 cells across); Row 2 =
    # balls 9-15 (7 balls, centered by shifting half a cell right so the
    # visual weight stays balanced under the top row).
    ball_cols = 8
    ball_rows = 2
    ball_cell_w = balls_w / ball_cols
    # Row spacing pulls the two rows together so the balls almost touch.
    # Effective row spacing = ball_cell_h * ROW_PACK, where < 1.0 means rows
    # overlap vertically. Tuned so a 12pt-radius circle nearly kisses.
    BALL_ROW_PACK = 0.68

    # Column header row (RACK / PLAYER A / PLAYER B)
    c.setFont(FONT_BOLD, 7)
    c.setFillColorRGB(*BLACK)
    c.drawCentredString(x0 + rack_col_w / 2, y0 - 10, "RACK")
    c.drawCentredString(x0 + rack_col_w + side_w / 2, y0 - 10, "PLAYER A")
    c.drawCentredString(x0 + rack_col_w + side_w + side_w / 2, y0 - 10, "PLAYER B")
    y0 -= SHEET_RACK_HDR_H

    # Stats-strip label row - two-line plain-English labels above each column.
    # Line 1 / Line 2 stacked so labels are readable at 5th-grade level and
    # nothing overlaps the tight column widths.
    stats_hdr_y = y0
    n_stats = 4
    stat_w = stats_strip_w / n_stats
    # (line1, line2) per column. Empty line2 = single-line label centered vertically.
    stat_labels = [("BALLS", "MADE"), ("FOULS", ""), ("RACK", "TOTAL"), ("GAME", "SUBTOTAL")]
    c.setFont(FONT_BOLD, 5.5)
    for side_i in range(2):
        strip_x = x0 + rack_col_w + side_i * side_w + balls_w
        for si in range(n_stats):
            sx = strip_x + si * stat_w
            l1, l2 = stat_labels[si]
            if l2:
                c.drawCentredString(sx + stat_w/2, stats_hdr_y - 8, l1)
                c.drawCentredString(sx + stat_w/2, stats_hdr_y - 15, l2)
            else:
                c.drawCentredString(sx + stat_w/2, stats_hdr_y - 12, l1)
    y0 -= SHEET_STATS_HDR_H

    # Racks - ball circles scale with cell size so the sheet fills whatever
    # vertical room is available (single-page = big circles for hand marking).
    # With 2 tightly-packed rows we get more vertical breathing room per
    # cell, so circles cap at 12pt and the extra height becomes padding
    # above/below each row.
    ball_cell_h = (rack_h - 4) / ball_rows
    # Radius cap raised to 14pt now that we only have 2 rows and each row
    # gets more vertical breathing room. Horizontal share also grew after
    # trimming stats_strip_w from 128 -> 116pt.
    # Radius cap raised to 14pt for a 2-row layout. Horizontal factor 0.48
    # (up from 0.42) since 8-across leaves cells narrower - we want the balls
    # to nearly touch horizontally too.
    ball_radius = min(14.0, ball_cell_h * 0.42, ball_cell_w * 0.48)
    for r in range(NUM_RACKS):
        r_top = y0 - r * rack_h
        r_bot = r_top - rack_h

        # Rack label cell
        c.setLineWidth(LINE_MED)
        c.rect(x0, r_bot, rack_col_w, rack_h, stroke=1, fill=0)
        c.setFont(FONT_BOLD, 16)
        c.drawCentredString(x0 + rack_col_w/2, r_bot + rack_h/2 - 5, str(r+1))

        # Both sides
        for side_i in range(2):
            side_x = x0 + rack_col_w + side_i * side_w
            c.setLineWidth(LINE_MED)
            c.rect(side_x, r_bot, side_w, rack_h, stroke=1, fill=0)

            # 15 ball circles arranged as two tight rows:
            #   Row 1: balls 1..8  (full 8-col row)
            #   Row 2: balls 9..15 (7 balls; shift right half a cell to center)
            # Rows are packed tighter than a full ball_cell_h using BALL_ROW_PACK
            # so the two rows visually belong together as one rack marker.
            row_pitch = ball_cell_h * BALL_ROW_PACK
            # Center the whole 2-row block within the rack side vertically.
            rack_content_h = row_pitch + 2 * ball_radius
            top_pad = (rack_h - rack_content_h) / 2
            row1_y = r_top - top_pad - ball_radius
            row2_y = row1_y - row_pitch
            for i in range(15):
                if i < 8:
                    col = i          # 0..7 across
                    bx = side_x + col * ball_cell_w + ball_cell_w/2
                    by = row1_y
                else:
                    # Row 2: 7 balls, indices 8..14 (labels 9..15).
                    # Shift right by half a cell so 7 balls span cols 0.5..6.5,
                    # visually centered under the 8-wide top row.
                    col = (i - 8)
                    bx = side_x + (col + 0.5) * ball_cell_w + ball_cell_w/2
                    by = row2_y
                draw_ball(c, bx, by, i+1, filled=False, r=ball_radius)

            # Stats strip - vertical divider + 4 cells (no label inside cells)
            strip_x = side_x + balls_w
            c.setLineWidth(LINE)
            c.line(strip_x, r_bot, strip_x, r_top)

            # Editable BALLS/FOULS = solid; calculated NET/RUN = dashed.
            editable = [True, True, False, False]
            for si in range(n_stats):
                sx = strip_x + si * stat_w
                if editable[si]:
                    c.setDash(); c.setLineWidth(LINE_MED)
                else:
                    c.setDash(2, 2); c.setLineWidth(LINE)
                c.rect(sx + 1, r_bot + 2, stat_w - 2, rack_h - 4, stroke=1, fill=0)
                c.setDash()

    y0 -= NUM_RACKS * rack_h

    # === Totals row (empty) ===
    #
    # Totals are stripped down to just FINAL GAME TOTAL - the one number that
    # decides the match. HIGH RUN and per-match FOULS totals were removed:
    # they don't affect the outcome and were distracting from the number that
    # does. Per-rack FOULS still live in the rack grid above and roll into
    # RACK TOTAL / GAME SUBTOTAL as expected.
    y0 -= SHEET_TOTALS_GAP
    tot_h = SHEET_TOTALS_H
    tot_hdr_y = y0
    c.setFont(FONT_BOLD, 6.5); c.setFillColorRGB(*BLACK)
    c.drawString(x0, tot_hdr_y - 6, "PLAYER TOTALS")
    c.setFont(FONT_BOLD, 6)
    c.drawRightString(x0 + inner_w, tot_hdr_y - 6, "left card = PLAYER A   -   right card = PLAYER B")

    # Full-page-wide cards, one big centered FINAL GAME TOTAL label + cell.
    tcard_w = (inner_w - gap) / 2
    label_y = tot_hdr_y - 8
    c.setFont(FONT_BOLD, 8)
    for i in range(2):
        tx = x0 + i * (tcard_w + gap)
        c.drawCentredString(tx + tcard_w / 2, label_y - 8, "FINAL GAME TOTAL")
    y0 -= SHEET_TOTALS_HDR_H

    # Single big thick-bordered cell per card (no more 3-column split).
    tot_row_y = y0
    cell_h = tot_h - 8
    cell_w = tcard_w - 24  # generous padding inside each card
    for i in range(2):
        tx = x0 + i * (tcard_w + gap)
        c.setLineWidth(LINE_MED)
        c.rect(tx, tot_row_y - tot_h, tcard_w, tot_h, stroke=1, fill=0)
        cx = tx + (tcard_w - cell_w) / 2
        cy = tot_row_y - tot_h + 4
        c.setLineWidth(LINE_STRONG)
        c.rect(cx, cy, cell_w, cell_h, stroke=1, fill=0)

    y0 = tot_row_y - tot_h - SHEET_WIN_GAP

    # === Winner + Signatures row ===
    win_h = SHEET_WIN_H
    c.setFont(FONT_BOLD, 8); c.setFillColorRGB(*BLACK)
    c.drawString(x0, y0 - 8, "WINNER:")
    # Two checkboxes
    wx = x0 + 55
    for label in ["PLAYER A", "PLAYER B"]:
        c.setLineWidth(LINE_MED)
        c.rect(wx, y0 - 14, 10, 10, stroke=1, fill=0)
        c.setFont(FONT_BODY, 8); c.drawString(wx + 14, y0 - 11, label)
        c.setFont(FONT_BOLD, 8)
        wx += 90

    # Signatures - two blank lines on the right, labels UNDER the lines with
    # comfortable spacing so nothing collides with anything else.
    sig_end_x = x0 + inner_w
    sig_line_w = 96
    sig_gap = 12
    sig_b_x = sig_end_x - sig_line_w
    sig_a_x = sig_b_x - sig_gap - sig_line_w
    c.setFont(FONT_BOLD, 7); c.setFillColorRGB(*BLACK)
    # "SIGNATURES:" label - place it to the left of the lines with room to breathe.
    c.drawString(sig_a_x - 74, y0 - 11, "SIGNATURES:")
    c.setLineWidth(0.9)
    c.line(sig_a_x, y0 - 14, sig_a_x + sig_line_w, y0 - 14)
    c.line(sig_b_x, y0 - 14, sig_b_x + sig_line_w, y0 - 14)
    c.setFont(FONT_BODY, 6)
    c.drawCentredString(sig_a_x + sig_line_w/2, y0 - 24, "PLAYER A")
    c.drawCentredString(sig_b_x + sig_line_w/2, y0 - 24, "PLAYER B")

