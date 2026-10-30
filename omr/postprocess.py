"""Audiveris 결과(MusicXML) 다듬기 — 토큰 없는 규칙 기반.

1) PDF 글자층에서 빠르기표(♩.=81 등)를 읽어 해당 마디에 넣는다 (Audiveris는 빠르기표를 못 읽음).
   Sibelius(Opus 글꼴: q=4분음표, e=8분, h=2분)·MuseScore(SMuFL 기호)·유니코드 ♩♪ 를 지원.
   위치는 Audiveris가 내보낸 쪽/줄/마디 배치(page-layout, print, measure width)로 계산한다.
2) 박자가 맞지 않는 마디 목록(앱이 "확인 필요"로 표시)을 만든다.
"""
import re, shutil, subprocess

NOTE_Q = {"q": 1.0, "e": 0.5, "h": 2.0, "x": 0.25, "w": 4.0, "♩": 1.0, "♪": 0.5,
          "": 1.0, "": 0.5, "": 2.0, "": 0.25,       # SMuFL metNote*
          "": 1.0, "": 0.5, "": 2.0, "": 0.25}       # SMuFL note*
DOTS = {".", "", ""}
WORD = re.compile(r'<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)</word>')
PAGE = re.compile(r'<page width="([\d.]+)" height="([\d.]+)">')


def pdf_tempos(pdf_path):
    """[(page_index, x_pt, y_pt, quarter_bpm, unit, dotted, per_minute)]"""
    if not shutil.which("pdftotext"):
        return [], None
    try:
        html = subprocess.run(["pdftotext", "-bbox", pdf_path, "-"], capture_output=True, text=True, timeout=60).stdout
    except Exception:
        return [], None
    out, sizes = [], []
    for pi, chunk in enumerate(html.split("<page ")[1:]):
        m = PAGE.search("<page " + chunk)
        sizes.append((float(m.group(1)), float(m.group(2))) if m else (612.0, 792.0))
        words = [(float(a), float(b), float(c), float(d), t.strip()) for a, b, c, d, t in WORD.findall(chunk)]
        text = " ".join(w[4] for w in words)
        for i, (x0, y0, x1, y1, t) in enumerate(words):
            # 한 단어 안 "q.=81" 또는 "q." "=" "81" 로 나뉜 경우 모두
            seq = "".join(w[4] for w in words[i:i + 3])
            mm = re.match(r"^(.)(\.||)?\s*=\s*(\d{2,3})", seq)
            if not mm or mm.group(1) not in NOTE_Q:
                continue
            pm = int(mm.group(3))
            if not 20 <= pm <= 300:
                continue
            unit = NOTE_Q[mm.group(1)] * (1.5 if mm.group(2) else 1)
            out.append((pi, x0, y0, pm * unit, mm.group(1), bool(mm.group(2)), pm))
    return out, sizes


def layout(xml):
    """마디별 (쪽, 줄 위 y, 줄 아래 y, x시작, x끝) — 단위 tenths"""
    num = lambda pat, s, d=0.0: float(re.search(pat, s).group(1)) if re.search(pat, s) else d
    pw, ph = num(r"<page-width>([\d.]+)", xml, 1), num(r"<page-height>([\d.]+)", xml, 1)
    pl = num(r"<page-margins[^>]*>.*?<left-margin>([\d.]+)", xml) if "<page-margins" in xml else 0
    pt = num(r"<page-margins[^>]*>.*?<top-margin>([\d.]+)", xml) if "<page-margins" in xml else 0
    part = re.search(r"<part id=\"[^\"]+\">(.*?)</part>", xml, re.S)
    if not part:
        return pw, ph, []
    staves = int(num(r"<staves>(\d+)", part.group(1), 1))
    page, y, x, left, sys_h, out = 0, None, 0.0, 0.0, 0.0, []
    staff_dist = 0.0
    for m in re.finditer(r"<measure((?:\s[^>]*)?)>(.*?)</measure>", part.group(1), re.S):
        attrs, body = m.groups()
        w = num(r'width="([\d.]+)"', attrs, 200)
        pr = re.search(r"<print([^>]*)>(.*?)</print>", body, re.S)
        if pr or y is None:
            pa, pb = (pr.group(1), pr.group(2)) if pr else ("", "")
            if 'new-page="yes"' in pa:
                page += 1
                y = None
            lm = num(r"<system-margins>\s*<left-margin>([\d.]+)", pb, left)
            left = lm
            sd = re.search(r"<staff-distance>([\d.]+)", pb)
            staff_dist = float(sd.group(1)) if sd else staff_dist
            if y is None:
                y = pt + num(r"<top-system-distance>([\d.]+)", pb, 0)
            elif 'new-system="yes"' in pa:
                y = y + sys_h + num(r"<system-distance>([\d.]+)", pb, 100)
            sys_h = 40 * staves + staff_dist * (staves - 1)
            x = pl + left
        out.append((page, y, y + sys_h, x, x + w))
        x += w
    return pw, ph, out


def add_tempos(xml, pdf_path):
    """빠르기표를 MusicXML 해당 마디 처음에 넣는다. (xml, [(마디번호, bpm)]) 반환"""
    found, sizes = pdf_tempos(pdf_path)
    if not found:
        return xml, []
    pw, ph, lay = layout(xml)
    if not lay:
        return xml, []
    placed = {}
    for (pi, xp, yp, qbpm, unit, dotted, pm) in found:
        W, H = sizes[pi] if pi < len(sizes) else (612.0, 792.0)
        xt, yt = xp * pw / W, yp * ph / H
        cands = [(i, l) for i, l in enumerate(lay) if l[0] == pi]
        if not cands:
            continue
        # 글자 바로 아래에 있는 줄 (빠르기표는 오선 위에 적힘)
        below = [c for c in cands if c[1][1] >= yt - 20]
        tops = sorted({c[1][1] for c in (below or cands)})
        sy = tops[0] if below else tops[-1]
        row = [c for c in cands if c[1][1] == sy]
        idx = next((i for i, l in row if l[3] - 5 <= xt < l[4]), row[0][0] if xt < row[0][1][3] else row[-1][0])
        if idx not in placed:
            placed[idx] = (qbpm, unit, dotted, pm)
    names = {"q": "quarter", "e": "eighth", "h": "half", "x": "16th", "w": "whole"}
    parts = re.split(r"(<measure(?:\s[^>]*)?>)", xml)
    # 첫 번째 파트의 마디만 센다
    first_part_end = xml.find("</part>")
    res, mi, pos, report = [], -1, 0, []
    for seg in parts:
        pos += len(seg)
        if re.match(r"<measure[\s>]", seg) and pos <= first_part_end + len(seg):
            mi += 1
            res.append(seg)
            if mi in placed:
                qbpm, unit, dotted, pm = placed[mi]
                bu = names.get(next((k for k, v in NOTE_Q.items() if v == (qbpm / pm / (1.5 if dotted else 1)) and k in names), "q"), "quarter")
                res.append(f'<direction placement="above"><direction-type><metronome><beat-unit>{bu}</beat-unit>{"<beat-unit-dot/>" if dotted else ""}'
                           f'<per-minute>{pm}</per-minute></metronome></direction-type><sound tempo="{round(qbpm, 2)}"/></direction>')
                nm = re.search(r'number="([^"]*)"', seg)
                report.append((nm.group(1) if nm else str(mi + 1), round(qbpm, 1)))
        else:
            res.append(seg)
    return "".join(res), report


MEAS = re.compile(r"(<measure(?:\s[^>]*)?>)(.*?)(</measure>)", re.S)


def _content_len(body, div):
    pos = mx = 0.0
    for m in re.finditer(r"<(note|backup|forward)\b[^>]*>(.*?)</\1>", body, re.S):
        tag, b = m.groups()
        du = re.search(r"<duration>(\d+)", b)
        du = int(du.group(1)) if du else 0
        if tag == "backup":
            pos -= du
        elif tag == "forward":
            pos += du
        elif "<chord/>" in b or "<grace" in b:
            continue
        else:
            pos += du
        mx = max(mx, pos)
    return mx / div


def time_for(length_q, compound):
    """마디 길이(4분음표 단위) → (beats, beat_type)"""
    if compound and abs(length_q * 2 - round(length_q * 2)) < 1e-6 and round(length_q * 2) % 3 == 0:
        return int(round(length_q * 2)), 8
    if abs(length_q - round(length_q)) < 1e-6:
        return int(round(length_q)), 4
    if abs(length_q * 2 - round(length_q * 2)) < 1e-6:
        return int(round(length_q * 2)), 8
    return None


def fix_time(xml, compound=False):
    """박자표를 못 읽었거나 잘못 읽은 구간을 실제 마디 길이로 바로잡는다. (xml, [고친 내용]) 반환"""
    part = re.search(r'(<part id="[^"]+">)(.*?)(</part>)', xml, re.S)
    if not part:
        return xml, []
    ms = list(MEAS.finditer(part.group(2)))
    div, info, sections = 1, [], []
    for i, m in enumerate(ms):
        body = m.group(2)
        d = re.search(r"<divisions>(\d+)", body)
        div = int(d.group(1)) if d else div
        t = re.search(r"<time\b[^>]*>\s*<beats>(\d+)</beats>\s*<beat-type>(\d+)</beat-type>", body)
        if i == 0 or t:
            sections.append({"start": i, "time": (int(t.group(1)), int(t.group(2))) if t else None, "lens": []})
        info.append(_content_len(body, div))
        sections[-1]["lens"].append(round(info[-1] * 4) / 4)
    fixes, new_time = [], {}
    for sec in sections:
        lens = [x for x in sec["lens"] if x > 0]
        if not lens:
            continue
        mode = max(set(lens), key=lens.count)
        share = lens.count(mode) / len(lens)
        decl = sec["time"]
        decl_len = decl[0] * 4 / decl[1] if decl else None
        if (decl is None or abs(decl_len - mode) > 1e-6) and share >= 0.4:
            tm = time_for(mode, compound)
            if tm:
                new_time[sec["start"]] = tm
                fixes.append(f"{sec['start'] + 1}번째 마디부터 박자표 {decl[0] if decl else '?'}/{decl[1] if decl else '?'} → {tm[0]}/{tm[1]}")
    if not new_time:
        return xml, []
    out, last = [], 0
    body_all = part.group(2)
    for i, m in enumerate(ms):
        out.append(body_all[last:m.start()])
        head, body, tail = m.groups()
        if i in new_time:
            b, bt = new_time[i]
            tag = f"<time><beats>{b}</beats><beat-type>{bt}</beat-type></time>"
            if re.search(r"<time\b", body):
                body = re.sub(r"<time\b[^>]*>.*?</time>", tag, body, count=1, flags=re.S)
            elif "<attributes>" in body:
                # MusicXML 순서: divisions, key, time, staves, clef
                if re.search(r"</key>", body):
                    body = body.replace("</key>", "</key>" + tag, 1)
                elif re.search(r"</divisions>", body):
                    body = body.replace("</divisions>", "</divisions>" + tag, 1)
                else:
                    body = body.replace("<attributes>", "<attributes>" + tag, 1)
            else:
                p = re.search(r"</print>", body)
                at = p.end() if p else 0
                body = body[:at] + f"<attributes>{tag}</attributes>" + body[at:]
        out.append(head + body + tail)
        last = m.end()
    out.append(body_all[last:])
    return xml[:part.start(2)] + "".join(out) + xml[part.end(2):], fixes


def set_title(xml, title):
    if not title:
        return xml
    t = title.replace("&", "&amp;").replace("<", "&lt;")
    m = re.search(r"<work-title>([^<]*)</work-title>", xml)
    if m and m.group(1).strip() and m.group(1).strip().lower() not in ("title", "untitled", "untitled score"):
        return xml
    if m:
        return xml.replace(m.group(0), f"<work-title>{t}</work-title>", 1)
    return re.sub(r"(<score-partwise\b[^>]*>)", r"\1<work><work-title>" + t + "</work-title></work>", xml, count=1)


def polish(xml, src_path, title=""):
    """Audiveris 결과를 앱에 넣기 전에 다듬는다. (xml, 보고서 dict)"""
    rep = {}
    tempos = []
    if src_path.lower().endswith(".pdf"):
        try:
            xml, tempos = add_tempos(xml, src_path)
        except Exception as e:  # noqa: BLE001
            rep["tempoError"] = str(e)[:200]
    compound = "<beat-unit-dot/>" in xml
    xml, fixes = fix_time(xml, compound)
    xml = set_title(xml, title)
    rep.update({"tempos": tempos, "timeFixes": fixes})
    return xml, rep
