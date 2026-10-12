"""
14.1 Straight Pool - Score-Sheet Drawing Primitives

A copy of _scoresheet_draw.py with the discipline swapped: same pure-black-on-white
primitives and the same responsive layout, but a straight-pool rack, a continuous
RUNNING TOTAL instead of 15-Ball's per-game subtotal, eight racks (a match to 100
needs them) and 14.1's own rules summary.

Differences from the 15-Ball sheet, all of them consequences of the discipline:

  * 14 ball circles per rack, in two rows of seven. The 15th ball of a rack is left
    on the table as the break ball, so it is never marked.
  * RUNNING TOTAL replaces GAME SUBTOTAL: straight pool is one continuous score, so
    each rack adds to the total before it.
  * Eight racks, not four: 8 x 14 = 112 balls, enough for the usual targets of 75
    and 100. (A match to 150 needs a second sheet.)
  * The goal boxes are 75 / 100, straight pool's usual club and pro targets, rather
    than 15-Ball's 25 / 50.
  * The rules block is two columns again, abbreviated rules on the left and a QR to
    docs/141-rules.pdf on the right - the WPA game written out plainly, the same
    pairing the 15-Ball sheet uses.

Imported by:
  * build_141_paper_sheet.py       (one full sheet per letter page)
  * build_141_paper_sheet_2up.py   (two side-by-side sheets per landscape page)
"""
from __future__ import annotations
from reportlab.lib.units import inch

# Print colors: pure black on white. Grays only for very light backgrounds
# that copy well (>= 90% white). We avoid mid-grays entirely.
BLACK = (0, 0, 0)
WHITE = (1, 1, 1)
LINE = 0.6
LINE_MED = 1.0
LINE_STRONG = 1.6

PAGE_W, PAGE_H = 612, 792   # letter, in points
MARGIN = 0.5 * inch

FONT_BODY = "Helvetica"
FONT_BOLD = "Helvetica-Bold"

# The QR on the sheet points at the club's own 14.1 rules PDF, the same way the
# 15-Ball sheet's QR points at docs/15ball-rules.pdf.
RULES_PDF_URL = "https://kevinelong.github.io/15ball-scoresheet/docs/141-rules.pdf"


def draw_qr(c, x, y_bottom, size_pt, data):
    """Draw a QR code as filled rectangles at the given canvas position.

    (x, y_bottom) is the bottom-left corner of the QR square; `size_pt` its edge in
    points. Uses medium error correction and auto-sizes the version to fit `data`,
    so a long URL is absorbed rather than silently truncated. Copied from the
    15-Ball shared module so both sheets draw their codes identically.
    """
    try:
        import qrcode
        from qrcode.constants import ERROR_CORRECT_M
    except ImportError as exc:
        # Do NOT degrade to a placeholder box: the 15-Ball sheet in this repository shipped
        # one for months (a square reading "QR") because the build machine had no qrcode
        # module, and nothing about the page looked wrong. A sheet that cannot carry a
        # working code should fail its build instead.
        raise RuntimeError(
            "qrcode is not installed, so this sheet would print a placeholder instead of a "
            "scannable code. Run: python -m pip install qrcode"
        ) from exc
    q = qrcode.QRCode(version=None, box_size=1, border=2,
                      error_correction=ERROR_CORRECT_M)
    q.add_data(data)
    q.make(fit=True)
    m = q.get_matrix()
    n = len(m)
    module = size_pt / n
    c.setFillColorRGB(*BLACK)
    c.setStrokeColorRGB(*BLACK)
    for r, row in enumerate(m):
        py = y_bottom + (n - r) * module
        # Coalesce contiguous filled modules in this row into a single rect
        # to keep the PDF light.
        col = 0
        while col < n:
            if not row[col]:
                col += 1
                continue
            start = col
            while col < n and row[col]:
                col += 1
            run = col - start
            c.rect(x + start * module, py - module, run * module, module, stroke=0, fill=1)
    return n


def draw_ball(c, x, y, num, filled=False, r=5.4):
    """Ball marker: filled black circle with white number, or outlined circle to mark inside.

    The outlined variant is meant to be MARKED INSIDE by the scorer (dot, slash or X), so
    the circle stays visibly larger than the numeral.
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
    num_size = min(7.5, max(5.3, r * 0.85))
    c.setFont(FONT_BOLD, num_size)
    c.drawCentredString(x, y - num_size * 0.32, str(num))


def _fits(c, text, size, limit, what, bold=False):
    """Build-time guard: a fixed line that does not fit its column is a printed defect.

    The sheet is generated, so a line that overruns its box is caught here rather than
    found on paper after the copies are printed.
    """
    width = c.stringWidth(text, FONT_BOLD if bold else FONT_BODY, size)
    if width > limit:
        raise ValueError(
            f"{what}: {width:.0f}pt of text does not fit {limit:.0f}pt - {text!r}"
        )


# ---------- responsive sheet geometry ----------
# Fixed sizes for every non-rack region. The rack grid absorbs any leftover space so
# the sheet fills its bounding box exactly, with no clipping.
SHEET_PAD          = 8      # inner padding inside the outer border
SHEET_TITLE_H      = 24     # big title
SHEET_INSTR_H      = 52     # 6-step mini-instructions strip (self-contained sheet)
SHEET_INSTR_MARGIN = 6      # breathing room on each side of the strip
SHEET_INSTR_GAP    = 10     # gap between strip and rules block
SHEET_RULES_H      = 74     # 14.1 rules summary + QR to the rules PDF (title + 5 lines)
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
NUM_RACKS          = 8      # 14 balls a rack: eight covers a match to 100
BALLS_PER_RACK     = 14     # the 15th ball stays out as the break ball
SHEET_RACK_H_MIN   = 22.0   # each rack row (min); grows to fill available height


def sheet_min_height(with_instructions=True):
    """Minimum height the score sheet needs to render without clipping."""
    extras = 0
    if with_instructions:
        extras += SHEET_INSTR_H + SHEET_INSTR_GAP
        extras += SHEET_RULES_H + SHEET_RULES_GAP
    return (2 * SHEET_PAD + SHEET_TITLE_H + extras
            + SHEET_PHDR_H
            + 8 + SHEET_RACK_HDR_H + SHEET_STATS_HDR_H
            + NUM_RACKS * SHEET_RACK_H_MIN
            + SHEET_TOTALS_GAP + SHEET_TOTALS_HDR_H + SHEET_TOTALS_H
            + SHEET_WIN_GAP + SHEET_WIN_H)


def draw_scoresheet(c, left, top, width, height, with_instructions=True):
    """The empty score sheet region (for hand-filling), laid out responsively."""
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
    inner_w = width - 2 * pad

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
    avail_for_racks = (height - 2 * pad) - fixed_h
    rack_h = avail_for_racks / NUM_RACKS

    # === Title bar ===
    c.setFont(FONT_BOLD, 12)
    c.setFillColorRGB(*BLACK)
    c.drawCentredString(left + width / 2, y0 - 14, "14.1 STRAIGHT POOL - MATCH SCORE SHEET")
    y0 -= SHEET_TITLE_H

    # === Mini-instructions strip ===
    if with_instructions:
        instr_top = y0
        instr_h = SHEET_INSTR_H
        strip_x = x0 + SHEET_INSTR_MARGIN
        strip_w = inner_w - 2 * SHEET_INSTR_MARGIN
        c.setLineWidth(LINE)
        c.setStrokeColorRGB(*BLACK)
        c.rect(strip_x, instr_top - instr_h, strip_w, instr_h, stroke=1, fill=0)
        inner_pad_x = 10
        inner_pad_top = 12
        c.setFont(FONT_BOLD, 7)
        c.setFillColorRGB(*BLACK)
        c.drawString(strip_x + inner_pad_x, instr_top - 10, "HOW TO SCORE")
        c.setFont(FONT_BODY, 6)
        c.drawRightString(
            strip_x + strip_w - inner_pad_x, instr_top - 10,
            "Required at Columbia Cue Club tournaments. Mark opponent's balls as a courtesy.",
        )
        instr_steps = [
            (1, "Fill NAME; check goal (75 rec / 100 pro)."),
            (2, "MARK each ball's circle as it drops (mandatory)."),
            (3, "RECONCILE every rack: 14 marks, no dupes, then re-rack."),
            (4, "RACK TOTAL = # marks - FOULS."),
            (5, "RUNNING TOTAL = last TOTAL + RACK TOTAL."),
            (6, "First to goal wins. Check WINNER; both sign."),
        ]
        col_gap = 18
        col_w = (strip_w - col_gap - 2 * inner_pad_x) / 2
        step_line_h = (instr_h - inner_pad_top - 10) / 3
        step_top = instr_top - inner_pad_top - 6
        for i, (n, body) in enumerate(instr_steps):
            col = i // 3
            row = i % 3
            sx = strip_x + inner_pad_x + col * (col_w + col_gap)
            sy = step_top - row * step_line_h
            _fits(c, body, 7, col_w - 12, f"step {n}")
            c.setFont(FONT_BOLD, 7)
            c.setFillColorRGB(*BLACK)
            c.drawString(sx, sy - 6, f"{n}.")
            c.setFont(FONT_BODY, 7)
            c.drawString(sx + 10, sy - 6, body)
        y0 -= SHEET_INSTR_H + SHEET_INSTR_GAP

    # === 14.1 rules summary + QR to our own 14.1 rules PDF ===
    # Two columns, the same shape as the 15-Ball sheet:
    #   Left:  the abbreviated rules, enough to score a match without the book.
    #   Right: QR to docs/141-rules.pdf (the WPA game written out plainly), captioned.
    # The block is skipped when the sheet is embedded in an annotated guide.
    if with_instructions:
        rules_top = y0
        rules_h = SHEET_RULES_H
        rules_x = x0 + SHEET_INSTR_MARGIN
        rules_w = inner_w - 2 * SHEET_INSTR_MARGIN
        c.setLineWidth(LINE)
        c.setStrokeColorRGB(*BLACK)
        c.rect(rules_x, rules_top - rules_h, rules_w, rules_h, stroke=1, fill=0)
        inner_pad_x = 10
        inner_pad_top = 8

        # --- Right column: QR + URL, pointing at our own 14.1 rules PDF ---
        # Sized and spaced to actually scan off paper: the 62-character URL needs a
        # version-5 code, and with the two-module quiet zone a 52pt square gives it
        # about 5px per module at 300dpi. Smaller than this and it stops decoding.
        caption_h = 8
        qr_size = min(SHEET_RULES_H - 2 * inner_pad_top - caption_h, 52)
        qr_x = rules_x + rules_w - inner_pad_x - qr_size
        qr_y_bottom = rules_top - inner_pad_top - qr_size
        draw_qr(c, qr_x, qr_y_bottom, qr_size, RULES_PDF_URL)
        caption = "Scan: full 14.1 rules"
        # Guard against the QR's own column, not the wider rules column: the caption is
        # right-aligned under the code, so anything wider would reach into the rules text.
        _fits(c, caption, 6.5, qr_size + 20, "qr caption", bold=True)
        c.setFont(FONT_BOLD, 6.5)
        c.setFillColorRGB(*BLACK)
        c.drawRightString(rules_x + rules_w - inner_pad_x, qr_y_bottom - caption_h + 1, caption)

        # --- Left column: the abbreviated rules ---
        left_x = rules_x + inner_pad_x
        left_w = qr_x - left_x - 10
        title = "14.1 STRAIGHT POOL RULES SUMMARY"
        _fits(c, title, 8.5, left_w, "rules title", bold=True)
        c.setFont(FONT_BOLD, 8.5)
        c.setFillColorRGB(*BLACK)
        c.drawString(left_x, rules_top - inner_pad_top - 4, title)

        line_y = rules_top - inner_pad_top - 13
        signature = "EVERY ball is one point; a foul costs one point, so the score can go negative."
        _fits(c, signature, 7, left_w, "signature rule", bold=True)
        c.setFont(FONT_BOLD, 7)
        c.drawString(left_x, line_y, signature)
        line_y -= 9
        c.setFont(FONT_BODY, 7)
        for txt in [
            "Continuous: the total carries rack to rack - the first to the goal wins.",
            "14 balls down and the rack is re-racked; the 15th stays as the break ball.",
            "Call the ball and pocket. A miss is not a foul: the inning just ends.",
            "Fouls: scratch, no rail, ball off the table. A breaking foul costs two.",
        ]:
            _fits(c, txt, 7, left_w, "rules line")
            c.drawString(left_x, line_y, txt)
            line_y -= 9

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
        c.setFont(FONT_BOLD, 7)
        c.drawString(px + 6, y_ph - 10, label)
        c.setFont(FONT_BOLD, 8)
        c.drawString(px + 6, y_ph - 22, "NAME:")
        c.setLineWidth(0.8)
        c.line(px + 40, y_ph - 23, px + pcard_w - 8, y_ph - 23)
        c.drawString(px + 6, y_ph - 37, "GOAL:")
        cx = px + 40
        for lbl in ["75", "100"]:
            c.rect(cx, y_ph - 42, 8, 8, stroke=1, fill=0)
            c.setFont(FONT_BODY, 8)
            c.drawString(cx + 12, y_ph - 40, lbl)
            c.setFont(FONT_BOLD, 8)
            cx += 34
        c.rect(cx, y_ph - 42, 8, 8, stroke=1, fill=0)
        c.setFont(FONT_BODY, 8)
        c.drawString(cx + 12, y_ph - 40, "OTHER:")
        c.setLineWidth(0.8)
        c.line(cx + 47, y_ph - 41, px + pcard_w - 8, y_ph - 41)
    y0 = y_ph - ph_h - 8

    # === Rack grid ===
    rack_col_w = 22
    side_w = (inner_w - rack_col_w) / 2
    stats_strip_w = 116  # 29pt/column fits the two-line labels
    balls_w = side_w - stats_strip_w
    ball_cols = 7        # 14 balls a rack: two rows of seven
    ball_rows = 2
    ball_cell_w = balls_w / ball_cols
    BALL_ROW_PACK = 0.68

    c.setFont(FONT_BOLD, 7)
    c.setFillColorRGB(*BLACK)
    c.drawCentredString(x0 + rack_col_w / 2, y0 - 10, "RACK")
    c.drawCentredString(x0 + rack_col_w + side_w / 2, y0 - 10, "PLAYER A")
    c.drawCentredString(x0 + rack_col_w + side_w + side_w / 2, y0 - 10, "PLAYER B")
    y0 -= SHEET_RACK_HDR_H

    stats_hdr_y = y0
    n_stats = 4
    stat_w = stats_strip_w / n_stats
    stat_labels = [("BALLS", "MADE"), ("FOULS", ""), ("RACK", "TOTAL"), ("RUNNING", "TOTAL")]
    c.setFont(FONT_BOLD, 5.5)
    for label in stat_labels:
        for word in label:
            _fits(c, word, 5.5, stat_w, "stats header", bold=True)
    for side_i in range(2):
        strip_x = x0 + rack_col_w + side_i * side_w + balls_w
        for si in range(n_stats):
            sx = strip_x + si * stat_w
            l1, l2 = stat_labels[si]
            if l2:
                c.drawCentredString(sx + stat_w / 2, stats_hdr_y - 8, l1)
                c.drawCentredString(sx + stat_w / 2, stats_hdr_y - 15, l2)
            else:
                c.drawCentredString(sx + stat_w / 2, stats_hdr_y - 12, l1)
    y0 -= SHEET_STATS_HDR_H

    ball_cell_h = (rack_h - 4) / ball_rows
    ball_radius = min(14.0, ball_cell_h * 0.42, ball_cell_w * 0.48)
    for r in range(NUM_RACKS):
        r_top = y0 - r * rack_h
        r_bot = r_top - rack_h

        c.setLineWidth(LINE_MED)
        c.rect(x0, r_bot, rack_col_w, rack_h, stroke=1, fill=0)
        c.setFont(FONT_BOLD, 16)
        c.drawCentredString(x0 + rack_col_w / 2, r_bot + rack_h / 2 - 5, str(r + 1))

        for side_i in range(2):
            side_x = x0 + rack_col_w + side_i * side_w
            c.setLineWidth(LINE_MED)
            c.rect(side_x, r_bot, side_w, rack_h, stroke=1, fill=0)

            # 14 circles in two rows of seven: one per ball of the rack that can be made.
            row_pitch = ball_cell_h * BALL_ROW_PACK
            rack_content_h = row_pitch + 2 * ball_radius
            top_pad = (rack_h - rack_content_h) / 2
            row1_y = r_top - top_pad - ball_radius
            for i in range(BALLS_PER_RACK):
                col = i % ball_cols
                by = row1_y - (i // ball_cols) * row_pitch
                bx = side_x + col * ball_cell_w + ball_cell_w / 2
                draw_ball(c, bx, by, i + 1, filled=False, r=ball_radius)

            # Stats strip - vertical divider + 4 cells (no label inside cells)
            strip_x = side_x + balls_w
            c.setLineWidth(LINE)
            c.line(strip_x, r_bot, strip_x, r_top)

            # Editable BALLS/FOULS = solid; calculated RACK TOTAL/RUNNING TOTAL = dashed.
            editable = [True, True, False, False]
            for si in range(n_stats):
                sx = strip_x + si * stat_w
                if editable[si]:
                    c.setDash()
                    c.setLineWidth(LINE_MED)
                else:
                    c.setDash(2, 2)
                    c.setLineWidth(LINE)
                c.rect(sx + 1, r_bot + 2, stat_w - 2, rack_h - 4, stroke=1, fill=0)
                c.setDash()

    y0 -= NUM_RACKS * rack_h

    # === Totals row ===
    y0 -= SHEET_TOTALS_GAP
    tot_h = SHEET_TOTALS_H
    tot_hdr_y = y0
    c.setFont(FONT_BOLD, 6.5)
    c.setFillColorRGB(*BLACK)
    c.drawString(x0, tot_hdr_y - 6, "PLAYER TOTALS")
    c.setFont(FONT_BOLD, 6)
    c.drawRightString(x0 + inner_w, tot_hdr_y - 6, "left card = PLAYER A   -   right card = PLAYER B")

    tcard_w = (inner_w - gap) / 2
    label_y = tot_hdr_y - 8
    c.setFont(FONT_BOLD, 8)
    for i in range(2):
        tx = x0 + i * (tcard_w + gap)
        c.drawCentredString(tx + tcard_w / 2, label_y - 8, "FINAL MATCH TOTAL")
    y0 -= SHEET_TOTALS_HDR_H

    tot_row_y = y0
    cell_h = tot_h - 8
    cell_w = tcard_w - 24
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
    c.setFont(FONT_BOLD, 8)
    c.setFillColorRGB(*BLACK)
    c.drawString(x0, y0 - 8, "WINNER:")
    wx = x0 + 55
    for label in ["PLAYER A", "PLAYER B"]:
        c.setLineWidth(LINE_MED)
        c.rect(wx, y0 - 14, 10, 10, stroke=1, fill=0)
        c.setFont(FONT_BODY, 8)
        c.drawString(wx + 14, y0 - 11, label)
        c.setFont(FONT_BOLD, 8)
        wx += 90

    sig_end_x = x0 + inner_w
    sig_line_w = 96
    sig_gap = 12
    sig_b_x = sig_end_x - sig_line_w
    sig_a_x = sig_b_x - sig_gap - sig_line_w
    c.setFont(FONT_BOLD, 7)
    c.setFillColorRGB(*BLACK)
    c.drawString(sig_a_x - 74, y0 - 11, "SIGNATURES:")
    c.setLineWidth(0.9)
    c.line(sig_a_x, y0 - 14, sig_a_x + sig_line_w, y0 - 14)
    c.line(sig_b_x, y0 - 14, sig_b_x + sig_line_w, y0 - 14)
    c.setFont(FONT_BODY, 6)
    c.drawCentredString(sig_a_x + sig_line_w / 2, y0 - 24, "PLAYER A")
    c.drawCentredString(sig_b_x + sig_line_w / 2, y0 - 24, "PLAYER B")
