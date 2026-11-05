#!/usr/bin/env python3
# font_subset_lopdf のテスト用に、合成した小さな TrueType (glyf) フォントを作る。
#   pip install fonttools && python3 make_mock_cid_font.py
# グリフごとに形 (輪郭) と送り幅が異なるので、サブセット化のあとで、グリフが取り違えられて
# いないことを、輪郭と幅の比較だけで確かめられる。
#   gid 0       .notdef
#   gid 1..8    A..H: 単純な多角形 (頂点数・大きさが違う)
#   gid 9       I: 合成グリフ (gid 1 と gid 2 を並べたもの)。サブセットに gid 1・2 が必要
#   gid 10..59  G10..G59: 容量を稼ぐための多角形
# 送り幅は 500 + 10 * gid。
import math
import sys

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen


def polygon(gid):
    n = 3 + gid % 6
    r = 150 + (gid * 7) % 300
    pts = []
    for i in range(n):
        a = 2 * math.pi * i / n
        pts.append((int(250 + r * math.cos(a)), int(350 + r * math.sin(a))))
    return pts


def build(path):
    names = [".notdef"] + list("ABCDEFGH") + ["I"] + [f"G{i}" for i in range(10, 60)]
    fb = FontBuilder(1000, isTTF=True)
    fb.setupGlyphOrder(names)
    fb.setupCharacterMap({0x41 + i: names[1 + i] for i in range(9)})
    glyphs = {}
    for gid, name in enumerate(names):
        pen = TTGlyphPen(glyphs)
        if name == "I":
            pen.addComponent("A", (1, 0, 0, 1, 0, 0))
            pen.addComponent("B", (1, 0, 0, 1, 500, 0))
        else:
            pts = polygon(gid) if gid else [(50, 0), (450, 0), (450, 700), (50, 700)]
            pen.moveTo(pts[0])
            for p in pts[1:]:
                pen.lineTo(p)
            pen.closePath()
        glyphs[name] = pen.glyph()
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics({n: (500 + 10 * i, 0) for i, n in enumerate(names)})
    fb.setupHorizontalHeader(ascent=800, descent=-200)
    fb.setupNameTable({"familyName": "MockCid", "styleName": "Regular"})
    fb.setupOS2()
    fb.setupPost()
    fb.save(path)


if __name__ == "__main__":
    build(sys.argv[1] if len(sys.argv) > 1 else "mock_cid.ttf")
