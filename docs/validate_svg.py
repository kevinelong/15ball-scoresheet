"""
Validate the generated 15-Ball Rotation score-sheet SVG.

Checks:
  1. File exists at assets/print/15-ball-rotation-score-sheet.inkscape.svg
  2. Well-formed XML (xml.etree.ElementTree parse)
  3. Root element is <svg> in the SVG namespace
  4. viewBox is "0 0 612 792"
  5. Required layer IDs are present

Run:
    python3 docs/validate_svg.py
Exit code 0 = all checks pass; non-zero = failure.
"""
from __future__ import annotations
import os
import sys
import xml.etree.ElementTree as ET

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SVG_FILE  = os.path.join(REPO_ROOT, "assets", "print",
                         "15-ball-rotation-score-sheet.inkscape.svg")

REQUIRED_LAYER_IDS = [
    "layer-header",
    "layer-player-info",
    "layer-rack-1",
    "layer-rack-2",
    "layer-rack-3",
    "layer-rack-4",
    "layer-instructions",
    "layer-totals",
    "layer-signatures",
    "layer-footer",
]

NS_SVG = "http://www.w3.org/2000/svg"

ERRORS: list[str] = []


def check(cond: bool, msg: str) -> None:
    if cond:
        print(f"  PASS  {msg}")
    else:
        print(f"  FAIL  {msg}")
        ERRORS.append(msg)


def main() -> int:
    print(f"Validating: {SVG_FILE}\n")

    # 1. File exists
    check(os.path.isfile(SVG_FILE), "SVG file exists")
    if not os.path.isfile(SVG_FILE):
        print("\n1 error – aborting (file missing)")
        return 1

    # 2. Well-formed XML
    try:
        tree = ET.parse(SVG_FILE)
        root = tree.getroot()
        check(True, "SVG is well-formed XML")
    except ET.ParseError as exc:
        check(False, f"SVG is well-formed XML  ({exc})")
        print(f"\n{len(ERRORS)} error(s) – aborting (parse failed)")
        return 1

    # 3. Root is <svg>
    check(root.tag == f"{{{NS_SVG}}}svg",
          f"Root element is SVG <svg> (found {root.tag!r})")

    # 4. viewBox
    vb = root.get("viewBox", "")
    check(vb == "0 0 612 792",
          f'viewBox="0 0 612 792" (found "{vb}")')

    # 5. Required layer IDs
    all_ids = {el.get("id") for el in tree.iter()}
    for lid in REQUIRED_LAYER_IDS:
        check(lid in all_ids, f'Layer ID "{lid}" exists')

    print()
    if ERRORS:
        print(f"{len(ERRORS)} error(s):")
        for e in ERRORS:
            print(f"  - {e}")
        return 1
    else:
        print("All checks passed.")
        return 0


if __name__ == "__main__":
    sys.exit(main())
