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
    """Ball marker: filled black circle with white number, or outlined circle with black number."""
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
    c.setFont(FONT_BOLD, 6.2)
    c.drawCentredString(x, y - 2.0, str(num))

def draw_scoresheet(c, left, top, width, height):
    """The empty score sheet region (for hand-filling)."""
    # Outer heavy black border
    c.setStrokeColorRGB(*BLACK)
    c.setLineWidth(LINE_STRONG)
    c.rect(left, top - height, width, height, stroke=1, fill=0)

    # Sheet inner padding
    pad = 8
    x0 = left + pad
    y0 = top - pad
    inner_w = width - 2*pad

    # === Title bar (inside the sheet) ===
    c.setFont(FONT_BOLD, 12)
    c.setFillColorRGB(*BLACK)
    c.drawCentredString(left + width/2, y0 - 12, "15-BALL ROTATION (K-BALL) - MATCH SCORE SHEET")
    y0 -= 24
    c.setFont(FONT_BODY, 8)
    c.drawCentredString(left + width/2, y0, "Columbia Cue Club   -   Rack Net = Balls - Fouls   -   Running = sum of Rack Nets")
    y0 -= 12

    # === Player header row (blank lines for name/goal) ===
    y_ph = y0
    ph_h = 0.55 * inch
    gap = 8
    pcard_w = (inner_w - gap) / 2
    for i, label in enumerate(["PLAYER A", "PLAYER B"]):
        px = x0 + i * (pcard_w + gap)
        c.setLineWidth(LINE_MED)
        c.rect(px, y_ph - ph_h, pcard_w, ph_h, stroke=1, fill=0)
        c.setFont(FONT_BOLD, 7); c.drawString(px + 6, y_ph - 10, label)
        # Name: blank line
        c.setFont(FONT_BOLD, 8); c.drawString(px + 6, y_ph - 24, "NAME:")
        c.setLineWidth(0.8)
        c.line(px + 40, y_ph - 25, px + pcard_w - 8, y_ph - 25)
        # Goal: 25 / 50 / Other checkboxes
        c.drawString(px + 6, y_ph - 40, "GOAL:")
        cx = px + 40
        for lbl in ["25", "50"]:
            c.rect(cx, y_ph - 46, 10, 10, stroke=1, fill=0)
            c.setFont(FONT_BODY, 8); c.drawString(cx + 14, y_ph - 43, lbl)
            c.setFont(FONT_BOLD, 8)
            cx += 32
        c.rect(cx, y_ph - 46, 10, 10, stroke=1, fill=0)
        c.setFont(FONT_BODY, 8); c.drawString(cx + 14, y_ph - 43, "OTHER:")
        c.setLineWidth(0.8); c.line(cx + 45, y_ph - 45, px + pcard_w - 8, y_ph - 45)
    y0 = y_ph - ph_h - 8

    # === Rack grid ===
    # Layout: RACK column (left), PLAYER A ball grid + Balls/Fouls/RackNet/Running, then PLAYER B same
    NUM_RACKS = 4
    rack_col_w = 22
    side_w = (inner_w - rack_col_w) / 2

    # Ball grid: 5 cols x 3 rows = 15 balls; then a stats strip below the grid
    #   |--- 5 cols of balls ---|--- stats strip (Balls/Fouls/RackNet/Running) ---|
    stats_strip_w = 78
    balls_w = side_w - stats_strip_w
    ball_cols = 5
    ball_rows = 3
    ball_cell_w = balls_w / ball_cols
    ball_cell_h = 14
    rack_h = ball_rows * ball_cell_h + 4  # a hair of padding

    # Column header row
    hdr_h = 14
    c.setFont(FONT_BOLD, 7)
    c.setFillColorRGB(*BLACK)
    c.drawString(x0 + 2, y0 - 10, "RACK")
    c.drawString(x0 + rack_col_w + 4, y0 - 10, "PLAYER A")
    c.drawString(x0 + rack_col_w + side_w + 4, y0 - 10, "PLAYER B")
    y0 -= hdr_h

    # Racks
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
            # side outer
            c.setLineWidth(LINE_MED)
            c.rect(side_x, r_bot, side_w, rack_h, stroke=1, fill=0)

            # 15 ball circles in 3 rows x 5 cols, empty (to be filled by hand)
            for i in range(15):
                col = i % ball_cols
                row = i // ball_cols
                bx = side_x + col * ball_cell_w + ball_cell_w/2
                by = r_top - row * ball_cell_h - ball_cell_h/2 - 1
                draw_ball(c, bx, by, i+1, filled=False, r=5.0)

            # Stats strip (right side): 4 boxes stacked in 2x2 for compactness OR side-by-side
            strip_x = side_x + balls_w
            c.setLineWidth(LINE)
            c.line(strip_x, r_bot, strip_x, r_top)

            # 4 mini cells side-by-side inside the strip
            n_stats = 4
            stat_w = stats_strip_w / n_stats
            stat_labels = ["BALLS", "FOULS", "NET", "RUN"]
            # Editable vs calculated: BALLS and FOULS are what the scorer writes;
            # NET and RUN are calculated. Show that difference with a solid border
            # (write here) vs a dashed border (calculated).
            editable = [True, True, False, False]
            for si in range(n_stats):
                sx = strip_x + si * stat_w
                # Cell
                if editable[si]:
                    c.setDash()  # solid
                    c.setLineWidth(LINE_MED)
                else:
                    c.setDash(2, 2)
                    c.setLineWidth(LINE)
                c.rect(sx + 1, r_bot + 2, stat_w - 2, rack_h - 4, stroke=1, fill=0)
                c.setDash()
                # Label at top of cell
                c.setFont(FONT_BOLD, 5.5)
                c.setFillColorRGB(*BLACK)
                c.drawCentredString(sx + stat_w/2, r_top - 6, stat_labels[si])

    y0 -= NUM_RACKS * rack_h

    # === Totals row (empty) ===
    y0 -= 8
    tot_h = 0.44 * inch
    tot_row_y = y0
    c.setFont(FONT_BOLD, 7); c.setFillColorRGB(*BLACK)
    c.drawString(x0, tot_row_y + 2, "PLAYER TOTALS")

    tcard_w = (inner_w - gap) / 2
    for i, label in enumerate(["PLAYER A", "PLAYER B"]):
        tx = x0 + i * (tcard_w + gap)
        c.setLineWidth(LINE_MED)
        c.rect(tx, tot_row_y - tot_h, tcard_w, tot_h, stroke=1, fill=0)
        # 3 columns: HIGH RUN (editable) | FOULS (calc) | FINAL (calc, but the KEY output)
        col_w = (tcard_w - 12) / 3
        for j, (col_label, is_edit, is_final) in enumerate([
            ("HIGH RUN", True,  False),
            ("FOULS",    False, False),
            ("FINAL",    False, True),
        ]):
            cx = tx + 6 + j * col_w
            cy = tot_row_y - tot_h + 6
            cell_h = tot_h - 10
            if is_edit:
                c.setDash(); c.setLineWidth(LINE_MED)
                c.rect(cx + 2, cy, col_w - 4, cell_h, stroke=1, fill=0)
            elif is_final:
                # emphasize with thick solid border (this is the key output)
                c.setDash(); c.setLineWidth(LINE_STRONG)
                c.rect(cx + 2, cy, col_w - 4, cell_h, stroke=1, fill=0)
            else:
                c.setDash(2, 2); c.setLineWidth(LINE)
                c.rect(cx + 2, cy, col_w - 4, cell_h, stroke=1, fill=0)
            c.setDash()
            c.setFont(FONT_BOLD, 5.5)
            c.drawCentredString(cx + col_w/2, cy + cell_h + 2, col_label)
        # Player letter tag
        c.setFont(FONT_BOLD, 6); c.drawRightString(tx + tcard_w - 4, tot_row_y + 2, label)

    y0 = tot_row_y - tot_h - 10

    # === Winner + Signatures row ===
    win_h = 0.34 * inch
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

    # Signatures - two blank lines on the right
    sig_end_x = x0 + inner_w
    sig_line_w = 88
    sig_gap = 10
    sig_b_x = sig_end_x - sig_line_w
    sig_a_x = sig_b_x - sig_gap - sig_line_w
    c.setFont(FONT_BOLD, 7); c.setFillColorRGB(*BLACK)
    c.drawString(sig_a_x - 68, y0 - 8, "SIGNATURES:")
    c.setLineWidth(0.9)
    c.line(sig_a_x, y0 - 12, sig_a_x + sig_line_w, y0 - 12)
    c.line(sig_b_x, y0 - 12, sig_b_x + sig_line_w, y0 - 12)
    c.setFont(FONT_BODY, 6)
    c.drawString(sig_a_x, y0 - 22, "PLAYER A")
    c.drawString(sig_b_x, y0 - 22, "PLAYER B")

    y0 -= win_h + 6

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
    c = canvas.Canvas(OUT, pagesize=letter)
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
        (2, "Circle each ball as it's pocketed",  0.30, 0.36),
        (3, "Write # of fouls this rack",         0.62, 0.42),
        (4, "Net = balls circled - fouls",        0.72, 0.42),
        (5, "Running = last Running + this Net",  0.94, 0.42),
        (6, "Enter High Run at end of match",     0.16, 0.86),
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
            2: "When a player pockets a ball, circle its number in that rack row. Empty circle = not pocketed. Balls are worth 1 point each.",
            3: "Write the number of fouls that player committed during this rack in the FOULS cell. Foul = -1 point.",
            4: "Compute NET at the end of each rack: count circled balls, subtract fouls, write the result in the NET cell.",
            5: "RUNNING = the previous rack's RUNNING + this rack's NET. First rack: RUNNING = NET. First to their goal wins.",
            6: "HIGH RUN = the most balls circled in a single rack for that player. Write once, at end of match.",
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
    print(f"Wrote {OUT}")

if __name__ == "__main__":
    main()
