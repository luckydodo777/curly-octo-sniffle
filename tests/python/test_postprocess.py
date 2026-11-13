"""omr/postprocess.py 단위 테스트 (합성 MusicXML만 사용 — 저작권 악보 없음)
실행: python -m unittest discover -s tests/python -v
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "omr"))
import postprocess as pp  # noqa: E402

HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">\n'


def note(step="C", dur=1, voice=1, staff=1, chord=False):
    return (f"<note>{'<chord/>' if chord else ''}<pitch><step>{step}</step><octave>4</octave></pitch>"
            f"<duration>{dur}</duration><voice>{voice}</voice><staff>{staff}</staff></note>")


def score(measures, parts=1, defaults=""):
    plist = "".join(f'<score-part id="P{i + 1}"><part-name>P</part-name></score-part>' for i in range(parts))
    body = "".join(f'<part id="P{i + 1}">{"".join(measures)}</part>' for i in range(parts))
    return f"{HEAD}<score-partwise version=\"4.0\">{defaults}<part-list>{plist}</part-list>{body}</score-partwise>"


def meas(n, content, attrs="", implicit=False, extra=""):
    imp = ' implicit="yes"' if implicit else ""
    return f'<measure number="{n}"{imp}{extra}>{attrs}{content}</measure>'


def times(xml):
    root, _ = pp.load(xml)
    return [[pp.declared_time(m) for m in pp.measures(p)] for p in pp.parts(root)]


class FixTime(unittest.TestCase):
    def run_fix(self, xml, compound=False):
        root, head = pp.load(xml)
        fixes = pp.fix_time(root, compound)
        return pp.dump(root, head), fixes

    def test_pickup_keeps_4_4(self):  # GPT 재현 1
        xml = score([meas(0, note(dur=1), "<attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>", implicit=True)])
        out, fixes = self.run_fix(xml)
        self.assertEqual(fixes, [])
        self.assertEqual(times(out)[0][0], (4, 4))
        self.assertIn('implicit="yes"', out)

    def test_pickup_then_body_with_missing_time(self):
        ms = [meas(0, note(dur=1), "<attributes><divisions>1</divisions></attributes>", implicit=True)]
        ms += [meas(i, note(dur=1) * 3) for i in range(1, 6)]
        out, fixes = self.run_fix(score(ms))
        self.assertEqual(len(fixes), 1)
        self.assertEqual((fixes[0]["kind"], fixes[0]["suggest"]), ("inserted", "3/4"))  # 못갖춘마디 1박은 통계에서 빠짐

    def test_declared_time_is_not_changed(self):
        att = "<attributes><divisions>2</divisions><time><beats>3</beats><beat-type>8</beat-type></time></attributes>"
        ms = [meas(1, note(dur=12), att)] + [meas(i, note(dur=12)) for i in range(2, 7)]
        out, fixes = self.run_fix(score(ms), compound=True)
        self.assertEqual(times(out)[0][0], (3, 8))  # 적힌 기호는 그대로
        self.assertEqual(fixes[0]["kind"], "candidate")
        self.assertEqual((fixes[0]["declared"], fixes[0]["suggest"]), ("3/8", "12/8"))

    def test_missing_time_inserted_in_all_parts_after_key(self):
        att = "<attributes><divisions>1</divisions><key><fifths>-1</fifths></key><staves>2</staves></attributes>"
        ms = [meas(1, note(dur=4), att)] + [meas(i, note(dur=4)) for i in range(2, 5)]
        out, fixes = self.run_fix(score(ms, parts=2))
        self.assertEqual([t[0] for t in times(out)], [(4, 4), (4, 4)])
        self.assertLess(out.index("</key>"), out.index("<time>"))
        self.assertLess(out.index("<time>"), out.index("<staves>"))

    def test_compound_needs_evidence(self):
        ms = [meas(1, note(dur=3), "<attributes><divisions>1</divisions></attributes>")] + [meas(i, note(dur=3)) for i in range(2, 5)]
        self.assertEqual(self.run_fix(score(ms))[1][0]["suggest"], "3/4")
        self.assertEqual(self.run_fix(score(ms), compound=True)[1][0]["suggest"], "6/8")

    def test_divisions_change_and_backup(self):
        m1 = meas(1, note(dur=4) + "<backup><duration>4</duration></backup>" + note(dur=4, voice=2), "<attributes><divisions>1</divisions></attributes>")
        m2 = meas(2, note(dur=16), "<attributes><divisions>4</divisions></attributes>")
        m3 = meas(3, note(dur=8) + note(dur=8))
        out, fixes = self.run_fix(score([m1, m2, m3, meas(4, note(dur=16))]))
        self.assertEqual(fixes[0]["suggest"], "4/4")

    def test_namespaced_xml(self):
        xml = '<score-partwise xmlns="http://example.com/mx"><part id="P1"><measure number="1"><attributes><divisions>1</divisions></attributes>' + note(dur=2) * 2 + "</measure>" + ('<measure number="2">' + note(dur=4) + "</measure>") * 3 + "</part></score-partwise>"
        out, fixes = self.run_fix(xml)
        self.assertEqual(fixes[0]["kind"], "inserted")
        self.assertIn("beats>4<", out)


class Tempos(unittest.TestCase):
    DEFAULTS = ("<defaults><page-layout><page-height>2000</page-height><page-width>1500</page-width>"
                "<page-margins type=\"both\"><left-margin>100</left-margin><right-margin>100</right-margin>"
                "<top-margin>100</top-margin><bottom-margin>100</bottom-margin></page-margins></page-layout></defaults>")

    def build(self):
        def pr(new_page=False, top=None, dist=None):
            a = ' new-page="yes"' if new_page else ' new-system="yes"'
            sl = "<system-layout><system-margins><left-margin>0</left-margin><right-margin>0</right-margin></system-margins>"
            sl += f"<top-system-distance>{top}</top-system-distance>" if top is not None else f"<system-distance>{dist}</system-distance>"
            sl += "</system-layout><staff-layout number=\"2\"><staff-distance>60</staff-distance></staff-layout>"
            return f"<print{a}>{sl}</print>"
        att = "<attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves></attributes>"
        ms = [meas(1, note(dur=4), pr(top=100).replace(' new-system="yes"', "") + att, extra=' width="650"'),
              meas(2, note(dur=4), "", extra=' width="650"'),
              meas(3, note(dur=4), pr(dist=200), extra=' width="430"'),
              meas(4, note(dur=4), "", extra=' width="430"'),
              meas(5, note(dur=4), "", extra=' width="440"'),
              meas(6, note(dur=4), pr(new_page=True, top=100), extra=' width="1300"')]
        return score(ms, defaults=self.DEFAULTS)

    def test_layout(self):
        root, _ = pp.load(self.build())
        pw, ph, lay = pp.layout(root)
        self.assertEqual((pw, ph), (1500, 2000))
        self.assertEqual([l[0] for l in lay], [0, 0, 0, 0, 0, 1])
        self.assertEqual(lay[0][1], 200)            # 위 여백 100 + 첫 줄 거리 100
        self.assertEqual(lay[2][1], 200 + 140 + 200)  # 줄 높이(40*2+60) + 줄 간격
        self.assertEqual((lay[3][3], lay[3][4]), (530, 960))

    def test_find_and_place(self):
        bbox = ('<page width="750" height="1000">'
                '<word xMin="60" yMin="80" xMax="70" yMax="90">q.</word><word xMin="72" yMin="80" xMax="78" yMax="90">=</word>'
                '<word xMin="80" yMin="80" xMax="95" yMax="90">81</word>'
                '<word xMin="300" yMin="240" xMax="330" yMax="250">=96</word>'
                '<word xMin="300" yMin="500" xMax="330" yMax="510">p=3</word></page>'
                '<page width="750" height="1000"><word xMin="400" yMin="60" xMax="420" yMax="70">h=60</word></page>')
        found, sizes = pp.find_tempos(bbox)
        self.assertEqual([(f[0], f[3], f[5], f[6]) for f in found], [(0, 121.5, True, 81), (0, 96.0, False, 96), (1, 120.0, False, 60)])
        root, head = pp.load(self.build())
        rep = pp.place_tempos(root, found, sizes)
        # (60,80)pt→(120,160)tenths: 1번째 줄 1마디 / (300,240)→(600,480): 2번째 줄(위 540)의 2번째 마디=4 / 2쪽 (800,120) → 6마디
        self.assertEqual(rep, [("1", 121.5), ("4", 96.0), ("6", 120.0)])
        out = pp.dump(root, head)
        m1 = out[out.index('<measure number="1"'):out.index('<measure number="2"')]
        self.assertLess(m1.index("</attributes>"), m1.index("<direction"))
        self.assertIn("<beat-unit-dot />", m1.replace("<beat-unit-dot/>", "<beat-unit-dot />"))
        self.assertIn('tempo="121.5"', m1)
        self.assertIn("<beat-unit>half</beat-unit>", out)


class Misc(unittest.TestCase):
    def test_title(self):
        root, _ = pp.load(score([meas(1, note())]).replace("<part-list>", "<work><work-title>Untitled Score</work-title></work><part-list>"))
        pp.set_title(root, "내 곡")
        self.assertEqual(pp.find_path(root, "work", "work-title").text, "내 곡")
        root, _ = pp.load(score([meas(1, note())]).replace("<part-list>", "<work><work-title>Real</work-title></work><part-list>"))
        pp.set_title(root, "x")
        self.assertEqual(pp.find_path(root, "work", "work-title").text, "Real")

    def test_polish_keeps_doctype_and_reports(self):
        ms = [meas(1, note(dur=4), "<attributes><divisions>1</divisions></attributes>")] + [meas(i, note(dur=4)) for i in range(2, 5)]
        out, rep = pp.polish(score(ms), "x.png", "곡")
        self.assertTrue(out.startswith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE score-partwise'))
        self.assertEqual(rep["notes"][0]["m"], 0)
        self.assertIn("4/4", rep["notes"][0]["text"])

    def test_interline(self):
        w, h = 200, 400
        rows = []
        for y in range(h):
            line = any(y == top + k * 10 for top in (50, 200) for k in range(5))
            rows.append(bytes([0 if line and 20 <= x < 180 else 255 for x in range(w)]))
        self.assertAlmostEqual(pp.interline_from_gray(b"".join(rows), w, h), 10.0)
        self.assertIsNone(pp.interline_from_gray(bytes([255]) * (w * h), w, h))

    def test_pick_dpi(self):
        self.assertEqual(pp.pick_dpi(21.0, (8.5, 11)), 300)
        self.assertEqual(pp.pick_dpi(17.9, (8.5, 11)), 400)
        self.assertEqual(pp.pick_dpi(10.0, (8.5, 11)), 450)   # 목표는 720이지만 2천만 화소 한도로 잘림
        self.assertEqual(pp.pick_dpi(None, None), 300)


if __name__ == "__main__":
    unittest.main()
