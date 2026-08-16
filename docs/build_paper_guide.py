"""
K-Ball / 15-Ball Rotation - Paper Score-Sheet Guide (B&W, print-first)

Photocopy-friendly one-page 8.5x11 letter PDF. Pure black on white; no
color reliance. Designed to be printed on plain paper, filled by hand
with a pen, and photocopied back into the tournament binder.

Distinct from docs/build_guide.py (which is the on-screen / app-linked
color version). This paper version has:
  * Empty cells (nothing pre-filled) - a real blank score sheet
  * Numbered callouts pointing at each region
  * Explicit "fill this in by hand" cues (empty lines, __ blanks)
  * No small light grays - anything meaningful is pure black
  * A thicker black grid so a fax/photocopy still reads cleanly

Run: python3 docs/build_paper_guide.py
Output: docs/paper-score-sheet-guide.pdf
"""
from __future__ import annotations
import os, sys
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch

OUT = os.path.join(os.path.dirname(__file__), "paper-score-sheet-guide.pdf")

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
SHEET_TITLE_H      = 24     # big title
SHEET_SUBTITLE_H   = 14     # subtitle line
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

def sheet_min_height():
    """Minimum height the score sheet needs to render without clipping."""
    return (2*SHEET_PAD + SHEET_TITLE_H + SHEET_SUBTITLE_H + SHEET_PHDR_H
            + 8 + SHEET_RACK_HDR_H + SHEET_STATS_HDR_H
            + NUM_RACKS * SHEET_RACK_H_MIN
            + SHEET_TOTALS_GAP + SHEET_TOTALS_HDR_H + SHEET_TOTALS_H
            + SHEET_WIN_GAP + SHEET_WIN_H)

def draw_scoresheet(c, left, top, width, height):
    """The empty score sheet region (for hand-filling).

    Layout is fully responsive: rack row height grows to consume any extra
    vertical space so the content fills `height` without clipping. Requires
    at least `sheet_min_height()` of vertical room; raises if given less.
    """
    min_h = sheet_min_height()
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
    fixed_h = (SHEET_TITLE_H + SHEET_SUBTITLE_H + SHEET_PHDR_H + 8
               + SHEET_RACK_HDR_H + SHEET_STATS_HDR_H
               + SHEET_TOTALS_GAP + SHEET_TOTALS_HDR_H + SHEET_TOTALS_H
               + SHEET_WIN_GAP + SHEET_WIN_H)
    avail_for_racks = (height - 2*pad) - fixed_h
    rack_h = avail_for_racks / NUM_RACKS

    # === Title bar (inside the sheet) ===
    c.setFont(FONT_BOLD, 12)
    c.setFillColorRGB(*BLACK)
    c.drawCentredString(left + width/2, y0 - 14, "15-BALL ROTATION (K-BALL) - MATCH SCORE SHEET")
    y0 -= SHEET_TITLE_H
    c.setFont(FONT_BODY, 8)
    c.drawCentredString(left + width/2, y0 - 2, "Columbia Cue Club   -   RACK TOTAL = balls made - fouls   -   GAME SUBTOTAL runs like a checkbook balance")
    y0 -= SHEET_SUBTITLE_H

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
    stats_strip_w = 128  # 32pt/column fits 2-line labels (BALLS MADE, RACK TOTAL, GAME SUBTOTAL)
    balls_w = side_w - stats_strip_w
    ball_cols = 5
    ball_rows = 3
    ball_cell_w = balls_w / ball_cols

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
    ball_cell_h = (rack_h - 4) / ball_rows
    ball_radius = min(12.0, ball_cell_h * 0.40, ball_cell_w * 0.40)
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

            # 15 ball circles - centered in the ball area
            for i in range(15):
                col = i % ball_cols
                row = i // ball_cols
                bx = side_x + col * ball_cell_w + ball_cell_w/2
                by = r_top - row * ball_cell_h - ball_cell_h/2 - 1
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
    y0 -= SHEET_TOTALS_GAP
    tot_h = SHEET_TOTALS_H
    # "PLAYER TOTALS" section label sits above the cards in its own strip so
    # nothing touches the card borders below. Two-strip layout:
    #   strip 1: "PLAYER TOTALS" section title on the left, "A / B" hint right
    #   strip 2: 2-line column labels above each of the 3 columns
    tot_hdr_y = y0
    c.setFont(FONT_BOLD, 6.5); c.setFillColorRGB(*BLACK)
    c.drawString(x0, tot_hdr_y - 6, "PLAYER TOTALS")
    c.setFont(FONT_BOLD, 6)
    c.drawRightString(x0 + inner_w, tot_hdr_y - 6, "left card = PLAYER A   -   right card = PLAYER B")

    # Bottom totals cards get the full page width so single-line labels fit
    # comfortably. No two-line stacking needed here (unlike the tight per-rack
    # stats strip above).
    tcard_w = (inner_w - gap) / 2
    col_w_labels = (tcard_w - 12) / 3
    tot_labels = ["HIGH RUN", "FOULS", "FINAL GAME TOTAL"]
    label_y = tot_hdr_y - 8
    c.setFont(FONT_BOLD, 7)
    for i in range(2):
        tx = x0 + i * (tcard_w + gap)
        for j, lbl in enumerate(tot_labels):
            cx = tx + 6 + j * col_w_labels
            c.drawCentredString(cx + col_w_labels/2, label_y - 8, lbl)
    y0 -= SHEET_TOTALS_HDR_H

    tot_row_y = y0
    for i in range(2):
        tx = x0 + i * (tcard_w + gap)
        c.setLineWidth(LINE_MED)
        c.rect(tx, tot_row_y - tot_h, tcard_w, tot_h, stroke=1, fill=0)
        col_w = (tcard_w - 12) / 3
        for j, (is_edit, is_final) in enumerate([
            (True,  False),   # HIGH RUN - editable
            (False, False),   # FOULS    - calc
            (False, True),    # FINAL    - key output, thick border
        ]):
            cx = tx + 6 + j * col_w
            cy = tot_row_y - tot_h + 4
            cell_h = tot_h - 8
            if is_edit:
                c.setDash(); c.setLineWidth(LINE_MED)
            elif is_final:
                c.setDash(); c.setLineWidth(LINE_STRONG)
            else:
                c.setDash(2, 2); c.setLineWidth(LINE)
            c.rect(cx + 2, cy, col_w - 4, cell_h, stroke=1, fill=0)
            c.setDash()

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

def draw_callout(c, num, x, y, tw):
    """Draw a numbered marker circle at (x,y). Solid black circle w/ white number."""
    r = 8
    c.setStrokeColorRGB(*BLACK); c.setFillColorRGB(*BLACK)
    c.setLineWidth(1.0)
    c.circle(x, y, r, stroke=1, fill=1)
    c.setFillColorRGB(*WHITE); c.setFont(FONT_BOLD, 8.5)
    c.drawCentredString(x, y - 3, str(num))
    c.setFillColorRGB(*BLACK)

def wrap_text(c, text, x, y, w, font=FONT_BODY, size=8, leading=10):
    """Very small text wrapper."""
    from reportlab.pdfbase.pdfmetrics import stringWidth
    words = text.split()
    line = ""
    yy = y
    for w_ in words:
        cand = line + (" " if line else "") + w_
        if stringWidth(cand, font, size) <= w:
            line = cand
        else:
            c.setFont(font, size); c.drawString(x, yy, line)
            yy -= leading
            line = w_
    if line:
        c.setFont(font, size); c.drawString(x, yy, line)
        yy -= leading
    return yy

def main():
    build(OUT)

def build(out_path):
    c = canvas.Canvas(out_path, pagesize=letter)
    c.setAuthor("Perplexity Computer")
    c.setTitle("K-Ball Paper Score-Sheet Guide (B&W, printable)")
    c.setSubject("Print-first, photocopy-friendly, hand-fillable guide for the K-Ball paper score sheet.")
    c.setCreator("kball-scoresheet docs/build_paper_guide.py")

    # === Top title bar (B&W: thick black border, no fill) ===
    top_bar_h = 0.55 * inch
    bar_y = PAGE_H - MARGIN - top_bar_h
    c.setStrokeColorRGB(*BLACK); c.setLineWidth(LINE_STRONG)
    c.rect(MARGIN, bar_y, PAGE_W - 2*MARGIN, top_bar_h, stroke=1, fill=0)
    c.setFont(FONT_BOLD, 16); c.setFillColorRGB(*BLACK)
    c.drawString(MARGIN + 10, bar_y + top_bar_h - 20, "K-BALL PAPER SCORE-SHEET GUIDE")
    c.setFont(FONT_BODY, 8.5)
    c.drawString(MARGIN + 10, bar_y + 8, "Columbia Cue Club  -  Print this sheet, fill by hand, photocopy for records.")
    c.setFont(FONT_BOLD, 8.5)
    c.drawRightString(PAGE_W - MARGIN - 10, bar_y + 8, "ColumbiaCueClub.com")

    # === Score sheet region ===
    sheet_top = bar_y - 12
    sheet_w = PAGE_W - 2 * MARGIN
    sheet_h = 5.3 * inch
    sheet_left = MARGIN
    draw_scoresheet(c, sheet_left, sheet_top, sheet_w, sheet_h)

    sheet_bottom = sheet_top - sheet_h

    # === Callouts on the sheet ===
    # Coordinates chosen to point at the empty cells in the blank sheet.
    # (fx, fy) are fractions relative to the sheet's inner content region.
    sheet_inner_left = sheet_left + 8
    sheet_inner_top = sheet_top - 8
    sheet_inner_w = sheet_w - 16
    sheet_inner_h = sheet_h - 16
    def anchor(fx, fy):
        return (sheet_inner_left + fx * sheet_inner_w,
                sheet_inner_top  - fy * sheet_inner_h)

    callouts = [
        (1, "Write player name & mark goal box",  0.22, 0.16),
        (2, "Mark each ball as it's pocketed",    0.30, 0.36),
        (3, "Write # of fouls this rack",                    0.62, 0.42),
        (4, "RACK TOTAL = balls made - fouls",               0.72, 0.42),
        (5, "GAME SUBTOTAL = last SUBTOTAL + this RACK",     0.94, 0.42),
        (6, "Enter High Run at end of match",                0.16, 0.86),
        (7, "Check winner + both sign",           0.10, 0.98),
        (8, "Photocopy for records; original to Bracket Desk", 0.60, 0.98),
    ]
    for (n, _t, fx, fy) in callouts:
        px, py = anchor(fx, fy)
        draw_callout(c, n, px, py, 0)

    # === Callout descriptions (bottom half of page, 2 x 4 grid) ===
    co_top = sheet_bottom - 12
    co_bottom = MARGIN + 0.28 * inch
    co_h_total = co_top - co_bottom
    col_gap = 10
    col_w = (sheet_w - col_gap) / 2
    row_gap = 6
    row_h = (co_h_total - 3*row_gap) / 4

    for i, (n, title, _fx, _fy) in enumerate(callouts):
        col = i % 2
        row = i // 2
        bx = MARGIN + col * (col_w + col_gap)
        by = co_top - row * (row_h + row_gap)
        # Card box (white with black outline)
        c.setLineWidth(LINE_MED); c.setStrokeColorRGB(*BLACK); c.setFillColorRGB(*WHITE)
        c.rect(bx, by - row_h, col_w, row_h, stroke=1, fill=0)
        # Numbered marker
        draw_callout(c, n, bx + 14, by - 14, 0)
        # Title
        c.setFont(FONT_BOLD, 9.5); c.setFillColorRGB(*BLACK)
        c.drawString(bx + 30, by - 15, title)
        # Body text - short explanation
        bodies = {
            1: "Write the player's name on the NAME line. Check the 25 (rec) or 50 (pro) box, or write a custom goal on OTHER.",
            2: "When a player pockets a ball, mark inside its circle in that rack row (a dot, slash, or X - whatever's fastest). Empty circle = not pocketed. Balls are worth 1 point each.",
            3: "Write the number of fouls that player committed during this rack in the FOULS cell. Foul = -1 point.",
            4: "RACK TOTAL at the end of each rack: count the balls you marked, subtract fouls, write the result. Like one line's amount in a checkbook.",
            5: "GAME SUBTOTAL = the previous rack's GAME SUBTOTAL + this rack's RACK TOTAL. First rack: GAME SUBTOTAL = RACK TOTAL. It's a running balance, like a checkbook. First player to their goal wins.",
            6: "HIGH RUN = the most balls marked in a single rack for that player. Write once, at end of match.",
            7: "Check WINNER box for the player who reached their goal first. Both players sign to certify.",
            8: "Keep a photocopy in the match binder; the paper original goes to the Bracket Desk for entry into the app.",
        }
        wrap_text(c, bodies[n], bx + 30, by - 28, col_w - 40, size=7.7, leading=9.4)

    # Footer
    c.setFont(FONT_BODY, 7); c.setFillColorRGB(*BLACK)
    c.drawString(MARGIN, MARGIN - 4,
                 "Solid borders = you write here.   Dashed borders = calculated (you also compute these by hand).   Thick border = final total.")
    c.drawRightString(PAGE_W - MARGIN, MARGIN - 4, "Paper Score-Sheet Guide v1")

    c.showPage()
    c.save()
    print(f"Wrote {out_path}")

if __name__ == "__main__":
    main()
