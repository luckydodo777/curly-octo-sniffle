"""Audiveris 결과(MusicXML) 다듬기 — 토큰 없는 규칙 기반.

원칙 (GPT 검수 #14 반영)
- 악보에 적힌 기호(박자표 등)는 **고치지 않는다.** 근거가 약한 추정은 "확인 필요" 후보로만 보고한다.
- 기호가 아예 없을 때만(예: 첫 마디 박자표를 못 읽음) 마디 길이로 추정해 넣고, 넣었다고 보고한다.
- 못갖춘마디(implicit)·마지막 마디는 박자 추정 통계에서 뺀다.
- XML은 정규식이 아니라 ElementTree 구조로 다룬다(여러 파트·namespace·attributes 순서 대비).

하는 일
1) PDF 글자층에서 빠르기표(♩.=81 등)를 읽어 해당 마디에 넣는다 (Audiveris는 빠르기표를 못 읽음).
   Sibelius(Opus 글꼴: q=4분음표, e=8분, h=2분)·MuseScore(SMuFL 기호)·유니코드 ♩♪ 를 지원.
   위치는 Audiveris가 내보낸 쪽/줄/마디 배치(page-layout, print, measure width)로 계산한다.
2) 박자표가 없으면 추정해 넣고, 적힌 박자표와 마디 길이가 크게 다르면 후보로 보고한다.
3) 제목이 비어 있으면 파일 이름을 넣는다.
4) PDF 첫 쪽의 오선 간격을 재서 Audiveris에 줄 해상도를 고른다.
"""
import re
import shutil
import subprocess
import xml.etree.ElementTree as ET

NOTE_Q = {"q": 1.0, "e": 0.5, "h": 2.0, "x": 0.25, "w": 4.0, "♩": 1.0, "♪": 0.5,
          "": 1.0, "": 0.5, "": 2.0, "": 0.25,       # SMuFL metNote*
          "": 1.0, "": 0.5, "": 2.0, "": 0.25}       # SMuFL note*
UNIT_NAME = {4.0: "whole", 2.0: "half", 1.0: "quarter", 0.5: "eighth", 0.25: "16th"}
WORD = re.compile(r'<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)</word>')
PAGE = re.compile(r'<page width="([\d.]+)" height="([\d.]+)">')
TEMPO_RE = re.compile("^(.)(\\.||)?\\s*=\\s*(\\d{2,3})")


# ---------------- XML 도우미 ----------------
def ln(tag):
    """namespace를 뗀 태그 이름"""
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def kids(el, name):
    return [c for c in el if ln(c.tag) == name]


def kid(el, name):
    for c in el:
        if ln(c.tag) == name:
            return c
    return None


def find_path(el, *names):
    cur = el
    for n in names:
        cur = kid(cur, n) if cur is not None else None
    return cur


def num(el, default=None):
    try:
        return float(el.text.strip()) if el is not None and el.text and el.text.strip() else default
    except ValueError:
        return default


def new_el(root, name):
    """root와 같은 namespace로 요소 만들기"""
    ns = root.tag[1:].split("}")[0] if root.tag.startswith("{") else ""
    return ET.Element(("{%s}" % ns if ns else "") + name)


def load(xml):
    """(root, 머리말) — 머리말(<?xml?>, DOCTYPE)은 그대로 다시 붙인다"""
    i = xml.find("<score-partwise")
    if i < 0:
        i = xml.find("<score-timewise")
    head = xml[:i] if i > 0 else ""
    if head and "<?xml" in head:
        head = re.sub(r"<\?xml[^>]*\?>", '<?xml version="1.0" encoding="UTF-8"?>', head, count=1)
    return ET.fromstring(xml[i if i > 0 else 0:]), head


def dump(root, head):
    return head + ET.tostring(root, encoding="unicode")


def parts(root):
    return kids(root, "part")


def measures(part):
    return kids(part, "measure")


def mlabel(m, i):
    n = m.get("number")
    return n if n else str(i + 1)


# ---------------- 마디 길이 ----------------
def content_len(measure, div):
    """마디 안 음 길이(4분음표 단위)와 바뀐 divisions. backup/forward/chord 기준."""
    pos = mx = 0.0
    for c in measure:
        t = ln(c.tag)
        if t == "attributes":
            d = num(kid(c, "divisions"))
            if d:
                div = d
        elif t in ("backup", "forward"):
            du = num(kid(c, "duration"), 0)
            pos += -du if t == "backup" else du
            pos = max(pos, 0)
        elif t == "note":
            if kid(c, "chord") is not None or kid(c, "grace") is not None or kid(c, "cue") is not None:
                continue
            pos += num(kid(c, "duration"), 0)
        mx = max(mx, pos)
    return mx / div, div


def declared_time(measure):
    at = kid(measure, "attributes")
    tm = kid(at, "time") if at is not None else None
    if tm is None:
        return None
    b, bt = num(kid(tm, "beats")), num(kid(tm, "beat-type"))
    return (int(b), int(bt)) if b and bt else None


def time_for(length_q, compound):
    """마디 길이(4분음표 단위) → (beats, beat_type)"""
    def is_int(x):
        return abs(x - round(x)) < 1e-6
    if compound and is_int(length_q * 2) and round(length_q * 2) % 3 == 0:
        return int(round(length_q * 2)), 8
    if is_int(length_q):
        return int(round(length_q)), 4
    if is_int(length_q * 2):
        return int(round(length_q * 2)), 8
    return None


def set_time(measure, root, beats, beat_type):
    """마디에 박자표 넣기. MusicXML 순서: divisions, key, time, staves, ..."""
    at = kid(measure, "attributes")
    if at is None:
        at = new_el(root, "attributes")
        idx = 0
        for i, c in enumerate(list(measure)):
            if ln(c.tag) == "print":
                idx = i + 1
        measure.insert(idx, at)
    tm = new_el(root, "time")
    b = new_el(root, "beats"); b.text = str(beats)
    bt = new_el(root, "beat-type"); bt.text = str(beat_type)
    tm.extend([b, bt])
    pos = 0
    for i, c in enumerate(list(at)):
        if ln(c.tag) in ("footnote", "level", "divisions", "key"):
            pos = i + 1
    at.insert(pos, tm)


def fix_time(root, compound=False):
    """박자표 점검. 적힌 박자표는 바꾸지 않고, 없을 때만 추정해 넣는다.
    반환: [{"index": 마디순번, "measure": 번호, "kind": "inserted"|"candidate", "declared": "4/4"|None, "suggest": "12/8", "share": 0.7}]"""
    ps = parts(root)
    if not ps:
        return []
    ms = measures(ps[0])
    div, sections, info = 1.0, [], []
    for i, m in enumerate(ms):
        L, div = content_len(m, div)
        tm = declared_time(m)
        if i == 0 or tm:
            sections.append({"start": i, "time": tm, "lens": []})
        last = i == len(ms) - 1
        if m.get("implicit") == "yes" or L <= 0 or (last and len(ms) > 2):
            continue  # 못갖춘마디·빈 마디·마지막 마디는 통계에서 뺀다
        sections[-1]["lens"].append(round(L * 4) / 4)
    out = []
    for sec in sections:
        lens = sec["lens"]
        if not lens:
            continue
        mode = max(sorted(set(lens)), key=lens.count)
        share = lens.count(mode) / len(lens)
        decl = sec["time"]
        decl_len = decl[0] * 4 / decl[1] if decl else None
        if decl and abs(decl_len - mode) < 1e-6:
            continue
        tm = time_for(mode, compound)
        if not tm:
            continue
        i = sec["start"]
        rec = {"index": i, "measure": mlabel(ms[i], i), "declared": f"{decl[0]}/{decl[1]}" if decl else None,
               "suggest": f"{tm[0]}/{tm[1]}", "share": round(share, 2)}
        if decl is None and share >= 0.4:
            for p in ps:  # 모든 파트의 같은 마디에 넣는다
                pm = measures(p)
                if i < len(pm) and declared_time(pm[i]) is None:
                    set_time(pm[i], root, *tm)
            rec["kind"] = "inserted"
            out.append(rec)
        elif decl is not None and share >= 0.6:
            rec["kind"] = "candidate"
            out.append(rec)
    return out


# ---------------- 빠르기표 ----------------
def pdf_text_bbox(pdf_path):
    if not shutil.which("pdftotext"):
        return ""
    try:
        return subprocess.run(["pdftotext", "-bbox", pdf_path, "-"], capture_output=True, text=True, timeout=60).stdout
    except Exception:  # noqa: BLE001
        return ""


def find_tempos(bbox_html):
    """pdftotext -bbox 결과에서 빠르기표 찾기 → ([(쪽, x, y, 4분음표bpm, 단위(4분음표 수), 점, 숫자)], [(쪽 너비, 높이)])"""
    out, sizes = [], []
    for pi, chunk in enumerate(bbox_html.split("<page ")[1:]):
        m = PAGE.search("<page " + chunk)
        sizes.append((float(m.group(1)), float(m.group(2))) if m else (612.0, 792.0))
        words = [(float(a), float(b), t.strip()) for a, b, c, d, t in WORD.findall(chunk)]
        for i, (x0, y0, _t) in enumerate(words):
            seq = "".join(w[2] for w in words[i:i + 3])  # "q.=81" 또는 "q." "=" "81"
            mm = TEMPO_RE.match(seq)
            if not mm or mm.group(1) not in NOTE_Q:
                continue
            pm = int(mm.group(3))
            if not 20 <= pm <= 300:
                continue
            base = NOTE_Q[mm.group(1)]
            dotted = bool(mm.group(2))
            out.append((pi, x0, y0, pm * base * (1.5 if dotted else 1), base, dotted, pm))
    return out, sizes


def layout(root):
    """첫 파트 마디별 (쪽, 줄 위 y, 줄 아래 y, x시작, x끝) — 단위 tenths. 반환 (쪽너비, 쪽높이, 목록)"""
    pl = find_path(root, "defaults", "page-layout")
    pw = num(kid(pl, "page-width"), 1) if pl is not None else 1
    ph = num(kid(pl, "page-height"), 1) if pl is not None else 1
    pmg = kid(pl, "page-margins") if pl is not None else None
    left_m = num(kid(pmg, "left-margin"), 0) if pmg is not None else 0
    top_m = num(kid(pmg, "top-margin"), 0) if pmg is not None else 0
    ps = parts(root)
    if not ps:
        return pw, ph, []
    page, y, x, sys_left, sys_h, staff_dist, staves, out = 0, None, 0.0, 0.0, 0.0, 0.0, 1, []
    for m in measures(ps[0]):
        at = kid(m, "attributes")
        if at is not None and num(kid(at, "staves")):
            staves = int(num(kid(at, "staves")))
        w = float(m.get("width") or 200)
        pr = kid(m, "print")
        if pr is not None or y is None:
            new_page = pr is not None and pr.get("new-page") == "yes"
            new_sys = pr is not None and pr.get("new-system") == "yes"
            if new_page:
                page += 1
                y = None
            sl = find_path(pr, "system-layout") if pr is not None else None
            sys_left = num(find_path(sl, "system-margins", "left-margin"), sys_left) if sl is not None else sys_left
            sd = find_path(pr, "staff-layout", "staff-distance") if pr is not None else None
            staff_dist = num(sd, staff_dist)
            if y is None:
                y = top_m + (num(kid(sl, "top-system-distance"), 0) if sl is not None else 0)
            elif new_sys:
                y = y + sys_h + (num(kid(sl, "system-distance"), 100) if sl is not None else 100)
            sys_h = 40 * staves + staff_dist * (staves - 1)
            x = left_m + sys_left
        out.append((page, y, y + sys_h, x, x + w))
        x += w
    return pw, ph, out


def place_tempos(root, found, sizes):
    """찾은 빠르기표를 마디에 넣는다. 반환 [(마디번호, 4분음표 bpm)]"""
    if not found:
        return []
    pw, ph, lay = layout(root)
    if not lay:
        return []
    placed = {}
    for (pi, xp, yp, qbpm, base, dotted, pm) in found:
        W, H = sizes[pi] if pi < len(sizes) else (612.0, 792.0)
        xt, yt = xp * pw / W, yp * ph / H
        cands = [(i, l) for i, l in enumerate(lay) if l[0] == pi]
        if not cands:
            continue
        below = [c for c in cands if c[1][1] >= yt - 20]  # 빠르기표는 오선 위에 적힘 → 바로 아래 줄
        sy = min(c[1][1] for c in below) if below else max(c[1][1] for c in cands)
        row = [c for c in cands if c[1][1] == sy]
        idx = next((i for i, l in row if l[3] - 5 <= xt < l[4]), row[0][0] if xt < row[0][1][3] else row[-1][0])
        placed.setdefault(idx, (qbpm, base, dotted, pm))
    ms = measures(parts(root)[0])
    report = []
    for idx, (qbpm, base, dotted, pm) in sorted(placed.items()):
        m = ms[idx]
        d = new_el(root, "direction"); d.set("placement", "above")
        dt = new_el(root, "direction-type"); met = new_el(root, "metronome")
        bu = new_el(root, "beat-unit"); bu.text = UNIT_NAME.get(base, "quarter"); met.append(bu)
        if dotted:
            met.append(new_el(root, "beat-unit-dot"))
        per = new_el(root, "per-minute"); per.text = str(pm); met.append(per)
        dt.append(met); d.append(dt)
        snd = new_el(root, "sound"); snd.set("tempo", f"{round(qbpm, 2):g}"); d.append(snd)
        pos = 0
        for i, c in enumerate(list(m)):
            if ln(c.tag) in ("print", "attributes", "barline") and i == pos:
                pos = i + 1
        m.insert(pos, d)
        report.append((mlabel(m, idx), round(qbpm, 1)))
    return report


# ---------------- 제목 ----------------
def set_title(root, title):
    if not title:
        return
    wt = find_path(root, "work", "work-title")
    if wt is not None and (wt.text or "").strip().lower() not in ("", "title", "untitled", "untitled score"):
        return
    if wt is None:
        work = kid(root, "work")
        if work is None:
            work = new_el(root, "work")
            root.insert(0, work)
        wt = new_el(root, "work-title")
        work.append(wt)
    wt.text = title


# ---------------- 전체 ----------------
def polish(xml, src_path, title=""):
    """Audiveris 결과를 앱에 넣기 전에 다듬는다. (xml, 보고서 dict)
    보고서: tempos [(마디, bpm)], timeFixes [...], notes [{"m": 마디순번, "text": 안내}] (앱이 '확인 필요'로 표시)"""
    root, head = load(xml)
    rep = {"tempos": [], "timeFixes": [], "notes": []}
    if src_path.lower().endswith(".pdf"):
        try:
            found, sizes = find_tempos(pdf_text_bbox(src_path))
            rep["tempos"] = place_tempos(root, found, sizes)
        except Exception as e:  # noqa: BLE001
            rep["tempoError"] = str(e)[:200]
    compound = any(ln(e.tag) == "beat-unit-dot" for e in root.iter())
    fixes = fix_time(root, compound)
    rep["timeFixes"] = fixes
    for f in fixes:
        if f["kind"] == "inserted":
            rep["notes"].append({"m": f["index"], "text": f"박자표를 읽지 못해 음 길이로 {f['suggest']}로 추정했어요 (마디의 {int(f['share'] * 100)}%가 이 길이)"})
        else:
            rep["notes"].append({"m": f["index"], "text": f"박자표 확인 필요: 악보 인식은 {f['declared']}, 음 길이로는 {f['suggest']}에 가까워요 (자동으로 바꾸지 않음)"})
    set_title(root, title)
    return dump(root, head), rep


# ---------------- 오선 간격 → 해상도 ----------------
def interline_from_gray(px, w, h):
    """회색조 픽셀(bytes, 한 줄 w개 × h줄)에서 오선 간격(픽셀) 추정. 못 찾으면 None."""
    dark = [sum(1 for b in px[y * w:(y + 1) * w] if b < 128) / w for y in range(h)]
    top = max(dark) if dark else 0
    if top <= 0:
        return None
    lines, run = [], []
    for y, d in enumerate(dark):
        if d > 0.35 * top:
            run.append(y)
        elif run:
            lines.append(sum(run) / len(run))
            run = []
    if run:
        lines.append(sum(run) / len(run))
    diffs = [round(b - a) for a, b in zip(lines, lines[1:]) if 2 < b - a < h * 0.03]
    if len(diffs) < 4:
        return None
    mode = max(sorted(set(diffs)), key=diffs.count)
    near = [d for d in diffs if abs(d - mode) <= 1]
    return sum(near) / len(near)


def read_pgm(raw):
    parts_, i = [], 0
    while len(parts_) < 4:
        while raw[i:i + 1].isspace():
            i += 1
        j = i
        while not raw[j:j + 1].isspace():
            j += 1
        parts_.append(raw[i:j])
        i = j
    if parts_[0] != b"P5":
        return None
    w, h = int(parts_[1]), int(parts_[2])
    return raw[i + 1:i + 1 + w * h], w, h


def staff_interline(pdf_path, dpi=200, max_pages=3):
    """PDF 앞쪽 몇 쪽 중 오선이 보이는 첫 쪽의 오선 간격(픽셀, dpi 기준)과 쪽 크기(인치). 표지는 건너뛴다."""
    if not shutil.which("pdftoppm"):
        return None, None
    size = None
    for page in range(1, max_pages + 1):
        try:
            raw = subprocess.run(["pdftoppm", "-f", str(page), "-l", str(page), "-r", str(dpi), "-gray", pdf_path],
                                 capture_output=True, timeout=60).stdout
        except Exception:  # noqa: BLE001
            return None, size
        if not raw:
            break
        g = read_pgm(raw)
        if not g:
            break
        px, w, h = g
        size = size or (w / dpi, h / dpi)
        il = interline_from_gray(px, w, h)
        if il:
            return il, (w / dpi, h / dpi)
    return None, size


def pick_dpi(il300, size, target=24.0, base=300, max_pixels=20_000_000):
    """300DPI 기준 오선 간격 → Audiveris에 줄 DPI. 이미 충분히 크면 base."""
    if not il300 or il300 >= 21:
        return base
    dpi = base * target / il300
    if size:
        dpi = min(dpi, (max_pixels * 0.97 / (size[0] * size[1])) ** 0.5)
    return int(max(base, min(dpi, 600)) // 25 * 25)


def pick_pdf_dpi(pdf_path, base=300):
    il, size = staff_interline(pdf_path)
    if not il:
        return base, None
    il300 = il * base / 200
    return pick_dpi(il300, size, base=base), round(il300, 1)
