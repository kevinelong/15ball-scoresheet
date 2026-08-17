"""
Build the 15-Ball Rotation score-sheet guide PDF.
Layout: 8.5x11" portrait. Top ~55% is a filled sample sheet; bottom is callouts.
"""
import os
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

# ---------------- Font registration ----------------
FONT_DIR = "/tmp/15ball_fonts"
os.makedirs(FONT_DIR, exist_ok=True)

def _download(url, dest):
    import urllib.request
    if not os.path.exists(dest):
        urllib.request.urlretrieve(url, dest)

FONT_URLS = {
    "InterRegular":  "https://raw.githubusercontent.com/google/fonts/main/ofl/inter/Inter%5Bslnt%2Cwght%5D.ttf",
    "InterBold":     "https://raw.githubusercontent.com/google/fonts/main/ofl/inter/Inter%5Bslnt%2Cwght%5D.ttf",
    "InterSemiBold": "https://raw.githubusercontent.com/google/fonts/main/ofl/inter/Inter%5Bslnt%2Cwght%5D.ttf",
    "DMSansBold":    "https://raw.githubusercontent.com/google/fonts/main/ofl/dmsans/DMSans%5Bopsz%2Cwght%5D.ttf",
}
try:
    for name, url in FONT_URLS.items():
        path = os.path.join(FONT_DIR, f"{name}.ttf")
        _download(url, path)
        pdfmetrics.registerFont(TTFont(name, path))
    FONT_BODY = "InterRegular"
    FONT_BOLD = "InterBold"
    FONT_SEMI = "InterSemiBold"
    FONT_DISPLAY = "DMSansBold"
except Exception as e:
    print(f"Font download failed ({e}); falling back to Helvetica")
    FONT_BODY = "Helvetica"
    FONT_BOLD = "Helvetica-Bold"
    FONT_SEMI = "Helvetica-Bold"
    FONT_DISPLAY = "Helvetica-Bold"

# ---------------- Palette ----------------
NAVY = (24/255, 43/255, 92/255)
NAVY_DK = (14/255, 27/255, 60/255)
RED  = (198/255, 40/255, 45/255)
LINE = (198/255, 200/255, 210/255)
LINE_STRONG = (60/255, 68/255, 88/255)
INK = (24/255, 27/255, 40/255)
MUTED = (100/255, 108/255, 128/255)
SOFT_BG = (247/255, 248/255, 252/255)
GOLD_BG = (255/255, 247/255, 230/255)
GOLD_BORDER = (216/255, 155/255, 61/255)
GOLD_INK = (122/255, 74/255, 0/255)
BALL_ON = (12/255, 78/255, 84/255)
CALLOUT_BG = (255/255, 249/255, 220/255)
CALLOUT_BORDER = (191/255, 149/255, 45/255)

# ---------------- Sample game data ----------------
# Alice (25 goal, wins) vs Bob (25 goal). Race to 25.
# Rack: (balls_on_A, fouls_A, balls_on_B, fouls_B)
# CRITICAL: sample must model correct reconciliation - in every rack,
# A + B marks equal all 15 balls with NO ball marked twice. Rack ends
# when 15-ball falls; match ends when a player reaches target (25 here).
RACKS = [
    ([4,6,8,10,12,14,15],   0, [1,2,3,5,7,9,11,13],        1),  # A:7-0=7, run 7  ;  B:8-1=7, run 7
    ([1,3,5,7,9,11,13,15],  1, [2,4,6,8,10,12,14],         0),  # A:8-1=7, run 14 ;  B:7-0=7, run 14
    ([2,4,6,8,10,12,14,15], 0, [1,3,5,7,9,11,13],          1),  # A:8-0=8, run 22 ;  B:7-1=6, run 20
    ([1,3,15],              0, [2,4,5,6,7,8,9,10,11,12,13,14], 0),  # A:3-0=3, run 25 WIN ;  B:12, run 32
]

# ---------------- Layout ----------------
PAGE_W, PAGE_H = letter
MARGIN = 0.5 * inch

def build(out_path):
    c = canvas.Canvas(out_path, pagesize=letter)
    c.setTitle("15-Ball Rotation Score-Sheet Guide")
    c.setAuthor("Perplexity Computer")
    c.setSubject("Columbia Cue Club - How to fill out the 15-Ball Rotation score sheet")

    draw_page_header(c)
    sheet_bounds = draw_sample_sheet(c)
    draw_callouts(c, sheet_bounds)
    draw_footer(c)

    c.showPage()
    c.save()

# ---------------- Header ----------------
def draw_page_header(c):
    # Title bar
    c.setFillColorRGB(*NAVY)
    c.rect(0, PAGE_H - 0.7*inch, PAGE_W, 0.7*inch, fill=1, stroke=0)

    c.setFillColorRGB(1,1,1)
    c.setFont(FONT_DISPLAY, 20)
    c.drawString(MARGIN, PAGE_H - 0.46*inch, "15-Ball Rotation \u2014 Score-Sheet Guide")

    c.setFont(FONT_BODY, 9.5)
    c.setFillColorRGB(0.85, 0.87, 0.95)
    c.drawString(MARGIN, PAGE_H - 0.62*inch, "Columbia Cue Club  \u2022  Printable one-page reference")

    c.setFont(FONT_BODY, 9)
    c.setFillColorRGB(0.85, 0.87, 0.95)
    c.drawRightString(PAGE_W - MARGIN, PAGE_H - 0.46*inch, "ColumbiaCueClub.com")
    # Sheet-math tagline is on the sheet itself in the subtitle; keep the top header clean.

# ---------------- Helpers ----------------
def draw_star(c, cx, cy, r):
    """Draw a 5-point star centered at (cx, cy) with outer radius r."""
    import math
    p = c.beginPath()
    for i in range(10):
        angle = -math.pi/2 + i * math.pi/5
        rr = r if i % 2 == 0 else r * 0.4
        x = cx + rr * math.cos(angle)
        y = cy + rr * math.sin(angle)
        if i == 0: p.moveTo(x, y)
        else: p.lineTo(x, y)
    p.close()
    c.drawPath(p, fill=1, stroke=0)

# ---------------- Sample sheet ----------------
def draw_sample_sheet(c):
    """Draw a filled sample 15-Ball Rotation sheet in the top ~55% of the page.
    Returns (x, y, w, h) bounds so callouts can point at things."""
    top    = PAGE_H - 0.85*inch
    left   = MARGIN
    width  = PAGE_W - 2*MARGIN
    # Header + players + 4 racks + totals + winner. Compact.
    height = 5.35 * inch
    bottom = top - height

    # Outer card
    c.setStrokeColorRGB(*LINE_STRONG); c.setLineWidth(1.2)
    c.setFillColorRGB(1,1,1)
    c.roundRect(left, bottom, width, height, 6, stroke=1, fill=1)

    # === Sheet title bar ===
    y = top - 0.3*inch
    c.setFillColorRGB(*NAVY)
    c.setFont(FONT_DISPLAY, 12)
    c.drawCentredString(left + width/2, y, "15-Ball Rotation")
    y -= 0.16*inch
    c.setFillColorRGB(*MUTED)
    c.setFont(FONT_SEMI, 8)
    # Draw two star shapes flanking "MATCH SCORE SHEET"
    draw_star(c, left + width/2 - 62, y + 3, 4)
    draw_star(c, left + width/2 + 62, y + 3, 4)
    c.drawCentredString(left + width/2, y, "MATCH SCORE SHEET")

    # === Players row (compressed) ===
    y_players = top - 0.75*inch
    pcard_h = 0.42*inch
    gap = 0.15*inch
    pcard_w = (width - 3*gap) / 2  # left/right cards with gap between and outer padding
    px_left = left + gap
    px_right = left + width - gap - pcard_w

    for (px, name, goal_selected) in [
        (px_left,  "Alice",  25),
        (px_right, "Bob",    25),
    ]:
        c.setStrokeColorRGB(*LINE)
        c.setFillColorRGB(*SOFT_BG)
        c.roundRect(px, y_players - pcard_h, pcard_w, pcard_h, 3, stroke=1, fill=1)

        c.setFillColorRGB(*MUTED); c.setFont(FONT_SEMI, 7)
        c.drawString(px + 8, y_players - 12, "PLAYER: ")
        c.setFillColorRGB(*INK); c.setFont(FONT_BOLD, 12)
        c.drawString(px + 42, y_players - 13, name)

        # Goal pills
        c.setFillColorRGB(*MUTED); c.setFont(FONT_SEMI, 6.5)
        c.drawString(px + 8, y_players - 25, "GOAL:")
        px_g = px + 38
        for val in (25, 50):
            selected = (val == goal_selected)
            c.setFillColorRGB(*NAVY) if selected else c.setFillColorRGB(1,1,1)
            c.setStrokeColorRGB(*NAVY); c.setLineWidth(0.7)
            c.roundRect(px_g, y_players - 32, 22, 12, 2, stroke=1, fill=1)
            c.setFillColorRGB(1,1,1) if selected else c.setFillColorRGB(*NAVY)
            c.setFont(FONT_BOLD, 8)
            c.drawCentredString(px_g + 11, y_players - 30, str(val))
            px_g += 26

    # === Rack column header (RACK | PLAYER A | PLAYER B) ===
    hdr_y = y_players - pcard_h - 0.15*inch
    c.setFont(FONT_SEMI, 8); c.setFillColorRGB(*MUTED)
    rack_col_w = 0.35*inch
    side_w = (width - rack_col_w) / 2
    c.drawCentredString(left + rack_col_w/2,          hdr_y, "RACK")
    c.drawCentredString(left + rack_col_w + side_w/2, hdr_y, "PLAYER A")
    c.drawCentredString(left + rack_col_w + side_w + side_w/2, hdr_y, "PLAYER B")

    # Racks
    racks_top = hdr_y - 0.12*inch
    rack_h = 0.58*inch
    running_a = 0
    running_b = 0

    for i, (balls_a, fouls_a, balls_b, fouls_b) in enumerate(RACKS):
        r_top = racks_top - i * rack_h
        r_bot = r_top - rack_h
        # Rack row separator
        c.setStrokeColorRGB(*LINE); c.setLineWidth(0.4)
        c.line(left, r_bot, left + width, r_bot)
        # rack number
        c.setFont(FONT_DISPLAY, 20); c.setFillColorRGB(*NAVY)
        c.drawCentredString(left + rack_col_w/2, r_bot + 0.18*inch, str(i+1))
        # A side
        net_a = len(balls_a) - fouls_a
        running_a += net_a
        draw_rack_side(c, left + rack_col_w, r_bot, side_w, rack_h, balls_a, fouls_a, net_a, running_a)
        # B side
        net_b = len(balls_b) - fouls_b
        running_b += net_b
        # Vertical divider between A and B
        c.setStrokeColorRGB(*LINE_STRONG); c.setLineWidth(0.6)
        c.line(left + rack_col_w + side_w, r_bot, left + rack_col_w + side_w, r_top)
        draw_rack_side(c, left + rack_col_w + side_w, r_bot, side_w, rack_h, balls_b, fouls_b, net_b, running_b)

    # === Totals row ===
    #
    # Only FINAL GAME TOTAL lives in the totals card. HIGH RUN and FOULS
    # totals were removed - neither affects the outcome and they were
    # distracting from the one number that does. Per-rack FOULS still
    # live in the rack grid above and roll into RACK TOTAL / GAME SUBTOTAL.
    tot_top = racks_top - 4*rack_h - 0.14*inch
    c.setFont(FONT_SEMI, 7); c.setFillColorRGB(*MUTED)
    c.drawString(left + 6, tot_top, "PLAYER TOTALS")
    tot_top -= 0.22*inch
    tot_h = 0.42*inch
    tot_row_y = tot_top
    tcard_w = (width - gap) / 2
    for (tx, label, final_total) in [
        (left,              "PLAYER A", running_a),
        (left + tcard_w + gap, "PLAYER B", running_b),
    ]:
        c.setStrokeColorRGB(*LINE)
        c.setFillColorRGB(*SOFT_BG)
        c.roundRect(tx, tot_row_y - tot_h, tcard_w, tot_h, 3, stroke=1, fill=1)
        # Player tag on the right, well above the cell.
        c.setFont(FONT_SEMI, 6.5); c.setFillColorRGB(*NAVY)
        c.drawRightString(tx + tcard_w - 4, tot_row_y + 8, label)

        # One centered cell: FINAL GAME TOTAL (highlighted).
        val_cell_h = 20
        cell_w = tcard_w - 24
        cx = tx + (tcard_w - cell_w) / 2
        cy = tot_row_y - tot_h + 6
        # Column label (above the cell)
        c.setFillColorRGB(*MUTED); c.setFont(FONT_SEMI, 6.5)
        c.drawCentredString(cx + cell_w / 2, cy + val_cell_h + 2, "FINAL GAME TOTAL")
        # Highlighted cell
        c.setFillColorRGB(*NAVY); c.setStrokeColorRGB(*NAVY)
        c.roundRect(cx, cy, cell_w, val_cell_h, 3, stroke=1, fill=1)
        c.setFillColorRGB(1, 1, 1)
        c.setFont(FONT_BOLD, 13)
        c.drawCentredString(cx + cell_w / 2, cy + 6, str(final_total))

    # === Winner + signatures row ===
    win_y = tot_row_y - tot_h - 0.14*inch
    c.setFont(FONT_SEMI, 7); c.setFillColorRGB(*MUTED)
    c.drawString(left + 6, win_y, "WINNER:")
    # Winner: Alice
    winner_x = left + 52
    c.setFillColorRGB(*RED); c.setStrokeColorRGB(*RED)
    c.roundRect(winner_x, win_y - 5, 60, 14, 3, stroke=1, fill=1)
    # Filled dot indicator
    c.setFillColorRGB(1,1,1)
    c.circle(winner_x + 8, win_y + 2, 3, stroke=0, fill=1)
    c.setFillColorRGB(1,1,1); c.setFont(FONT_BOLD, 8)
    c.drawString(winner_x + 15, win_y - 1, "ALICE")

    # Runner-up (unselected)
    c.setStrokeColorRGB(*LINE); c.setFillColorRGB(1,1,1)
    c.roundRect(winner_x + 66, win_y - 5, 60, 14, 3, stroke=1, fill=1)
    # Empty circle
    c.setStrokeColorRGB(*MUTED); c.setLineWidth(0.8); c.setFillColorRGB(1,1,1)
    c.circle(winner_x + 74, win_y + 2, 3, stroke=1, fill=1)
    c.setFillColorRGB(*MUTED); c.setFont(FONT_SEMI, 8)
    c.drawString(winner_x + 81, win_y - 1, "Bob")

    # Signatures right-aligned
    sig_end_x = left + width - 6
    sig_line_w = 62
    sig_gap = 8
    sig_b_x = sig_end_x - sig_line_w
    sig_a_x = sig_b_x - sig_gap - sig_line_w
    c.setFont(FONT_SEMI, 6.5); c.setFillColorRGB(*MUTED)
    c.drawString(sig_a_x - 55, win_y, "SIGNATURES:")
    c.setStrokeColorRGB(*LINE_STRONG); c.setLineWidth(0.4)
    c.line(sig_a_x, win_y - 2, sig_a_x + sig_line_w, win_y - 2)
    c.line(sig_b_x, win_y - 2, sig_b_x + sig_line_w, win_y - 2)
    c.setFillColorRGB(*INK); c.setFont(FONT_BODY, 7.5)
    c.drawString(sig_a_x + 3, win_y - 1, "A. Miller")
    c.drawString(sig_b_x + 3, win_y - 1, "B. Chen")
    c.setFillColorRGB(*MUTED); c.setFont(FONT_SEMI, 6)
    c.drawString(sig_a_x, win_y - 12, "PLAYER A")
    c.drawString(sig_b_x, win_y - 12, "PLAYER B")

    return (left, bottom, width, height)

def draw_rack_side(c, x, y, w, h, balls, fouls, net, running):
    """Draw one side (Player A or B) of a rack: balls grid + Balls Made / Fouls / Rack Total / Game Subtotal column."""
    # Left area = ball buttons (5x3 grid). Right area = 4 stat cells
    stats_w = 1.05*inch  # wide enough to fit "GAME SUBTOTAL" without clipping into the value
    balls_area_w = w - stats_w - 12  # padding
    balls_area_x = x + 6
    balls_area_y_top = y + h - 6
    balls_area_h = h - 10

    cols = 5
    rows = 3
    cell_w = balls_area_w / cols
    cell_h = balls_area_h / rows
    btn_size = min(cell_w, cell_h) - 2.5
    for n in range(1, 16):
        row = (n - 1) // cols
        col = (n - 1) % cols
        cx = balls_area_x + col * cell_w + cell_w/2
        cy = balls_area_y_top - row * cell_h - cell_h/2
        on = n in balls
        if on:
            c.setFillColorRGB(*BALL_ON); c.setStrokeColorRGB(*BALL_ON)
        else:
            c.setFillColorRGB(1,1,1); c.setStrokeColorRGB(*LINE)
        c.setLineWidth(0.5)
        c.circle(cx, cy, btn_size/2, stroke=1, fill=1)
        c.setFont(FONT_BOLD, 6.5)
        c.setFillColorRGB(1,1,1) if on else c.setFillColorRGB(*INK)
        c.drawCentredString(cx, cy - 2, str(n))

    # Stats: 4 cells (Balls Made, Fouls, Rack Total, Game Subtotal)
    stats_x = x + w - stats_w - 4
    stat_h = (h - 8) / 4
    stat_gap = 1.5
    for i, (lbl, val, kind) in enumerate([
        ("BALLS MADE",    len(balls), "plain"),
        ("FOULS",         fouls,      "plain"),
        ("RACK TOTAL",    net,        "gold"),
        ("GAME SUBTOTAL", running,    "navy"),
    ]):
        sy = y + h - 4 - (i+1)*stat_h - i*stat_gap
        # Cell
        if kind == "gold":
            c.setFillColorRGB(*GOLD_BG); c.setStrokeColorRGB(*GOLD_BORDER)
        elif kind == "navy":
            c.setFillColorRGB(*NAVY); c.setStrokeColorRGB(*NAVY)
        else:
            c.setFillColorRGB(1,1,1); c.setStrokeColorRGB(*LINE)
        c.setLineWidth(0.55)
        c.roundRect(stats_x, sy, stats_w, stat_h - 1, 2, stroke=1, fill=1)
        # Label (top-left)
        c.setFont(FONT_SEMI, 5.3)
        if kind == "navy":
            c.setFillColorRGB(0.85, 0.87, 0.95)
        else:
            c.setFillColorRGB(*MUTED)
        c.drawString(stats_x + 4, sy + stat_h - 8, lbl)
        # Value (right-aligned, big)
        c.setFont(FONT_BOLD, 10)
        if kind == "gold":
            c.setFillColorRGB(*GOLD_INK)
        elif kind == "navy":
            c.setFillColorRGB(1,1,1)
        else:
            c.setFillColorRGB(*INK)
        c.drawRightString(stats_x + stats_w - 5, sy + 2, str(val))

# ---------------- Callouts ----------------
CALLOUTS = [
    # (num, title, body, anchor_x_frac, anchor_y_frac)
    # anchor frac is relative to sheet bounds
    (1, "Player name & goal",
     "Enter the player's name; select 25 (rec) or 50 (pro), or type a custom goal.",
     0.16, 0.85),
    (2, "MARK specific balls (mandatory)",
     "Mark each ball's numbered circle on the player who pocketed it. Tallies alone "
     "do not count. Marking your opponent's balls for them is a courtesy.",
     0.25, 0.68),
    (3, "Record fouls per rack",
     "Enter foul count for this rack in the FOULS cell. Bob committed 1 foul in Rack 1.",
     0.75, 0.65),
    (4, "RECONCILE at the end of every rack",
     "Both players confirm together: the two sides' marks must total 15 and no ball "
     "may be marked on both sides. Required at Columbia Cue Club tournaments.",
     0.50, 0.58),
    (5, "RACK TOTAL = marks \u2212 fouls",
     "Count the marks that rack (a running BALLS MADE tally is optional) and subtract "
     "fouls. Alice R1: 7 \u2212 0 = 7. Bob R1: 8 \u2212 1 = 7. Scores can go negative.",
     0.35, 0.52),
    (6, "GAME SUBTOTAL is a running balance",
     "Cumulative sum of Rack Totals so far, like a checkbook balance. Alice: 7, 14, 22, 25. First to the goal wins.",
     0.85, 0.36),
    (7, "Final Total = winning line",
     "The last GAME SUBTOTAL is the FINAL GAME TOTAL. Alice reached 25 in Rack 4 to win "
     "the match; play stops the instant the target is met, even if the rack is unfinished.",
     0.30, 0.15),
    (8, "Pick the winner",
     "Only one radio can be selected. Selecting a winner also updates the bracket.",
     0.15, 0.05),
    (9, "Both players sign",
     "Both players sign to confirm the score sheet is agreed. Then Save Result.",
     0.72, 0.05),
]

def draw_callouts(c, sheet_bounds):
    sx, sy, sw, sh = sheet_bounds

    # Callout region: bottom ~40% of page, below the sheet
    top = sy - 0.15*inch
    bottom = MARGIN + 0.35*inch  # leave room for footer
    left = MARGIN
    width = PAGE_W - 2*MARGIN
    height = top - bottom

    # Draw markers on the sheet
    for num, title, body, ax, ay in CALLOUTS:
        cx = sx + ax * sw
        cy = sy + ay * sh
        c.setFillColorRGB(*RED); c.setStrokeColorRGB(1,1,1); c.setLineWidth(1.2)
        c.circle(cx, cy, 8, stroke=1, fill=1)
        c.setFillColorRGB(1,1,1); c.setFont(FONT_BOLD, 9)
        c.drawCentredString(cx, cy - 3, str(num))

    # Layout callouts in a 2-column x 4-row grid
    cols = 2
    rows = (len(CALLOUTS) + cols - 1) // cols
    col_gap = 0.15*inch
    row_gap = 0.06*inch
    cell_w = (width - col_gap*(cols-1)) / cols
    cell_h = (height - row_gap*(rows-1)) / rows

    for idx, (num, title, body, ax, ay) in enumerate(CALLOUTS):
        col = idx % cols
        row = idx // cols
        x = left + col * (cell_w + col_gap)
        y = top - (row + 1) * cell_h - row * row_gap

        # Card
        c.setFillColorRGB(*CALLOUT_BG); c.setStrokeColorRGB(*CALLOUT_BORDER); c.setLineWidth(0.6)
        c.roundRect(x, y, cell_w, cell_h, 4, stroke=1, fill=1)

        # Number badge
        c.setFillColorRGB(*RED); c.setStrokeColorRGB(*RED)
        c.circle(x + 14, y + cell_h - 14, 9, stroke=1, fill=1)
        c.setFillColorRGB(1,1,1); c.setFont(FONT_BOLD, 10)
        c.drawCentredString(x + 14, y + cell_h - 17, str(num))

        # Title
        c.setFillColorRGB(*INK); c.setFont(FONT_BOLD, 10.5)
        c.drawString(x + 30, y + cell_h - 15, title)

        # Body (wrap)
        c.setFillColorRGB(*INK); c.setFont(FONT_BODY, 8.8)
        wrap_text(c, body, x + 30, y + cell_h - 30, cell_w - 36, 10.5, FONT_BODY, 8.8)

def wrap_text(c, text, x, y, max_w, line_h, font_name, font_size):
    """Simple greedy word wrap using pdfmetrics.stringWidth."""
    words = text.split()
    lines = []
    cur = []
    for w in words:
        candidate = " ".join(cur + [w])
        if pdfmetrics.stringWidth(candidate, font_name, font_size) <= max_w:
            cur.append(w)
        else:
            if cur: lines.append(" ".join(cur))
            cur = [w]
    if cur: lines.append(" ".join(cur))
    for i, ln in enumerate(lines):
        c.drawString(x, y - i*line_h, ln)

# ---------------- Footer ----------------
def draw_footer(c):
    c.setStrokeColorRGB(*LINE); c.setLineWidth(0.5)
    c.line(MARGIN, MARGIN + 0.25*inch, PAGE_W - MARGIN, MARGIN + 0.25*inch)

    c.setFont(FONT_BODY, 7.5); c.setFillColorRGB(*MUTED)
    c.drawString(MARGIN, MARGIN + 0.10*inch,
                 "This is the one correct way to use the sheet and is required at Columbia Cue Club tournaments.")
    c.drawRightString(PAGE_W - MARGIN, MARGIN + 0.10*inch,
                      "Score-Sheet Guide v2")


if __name__ == "__main__":
    out = "/home/user/workspace/kball-scoresheet/docs/15ball-guide.pdf"
    build(out)
    print(f"Wrote {out}")
