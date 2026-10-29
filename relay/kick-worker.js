// 건반 내비 "변환 바로 시작" 중계기 — Cloudflare Workers(무료)에 붙여 넣어 쓴다. docs/OMR_FAST.md
// 앱이 악보를 올린 직후 이 주소로 POST 하면, GitHub Actions 의 omr.yml(무료 Audiveris 변환)을 즉시 실행시킨다.
// 비밀값 GH_TOKEN: 이 저장소만, "Actions: Read and write" 권한만 준 GitHub fine-grained 토큰 (Worker 설정의 Secret 으로만 넣는다)
const REPO = "luckydodo777/curly-octo-sniffle";
const ALLOWED = ["https://luckydodo777.github.io"];
let last = 0; // 같은 서버 인스턴스에서 20초 안의 중복 요청은 한 번으로 친다

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED.includes(origin) ? origin : ALLOWED[0],
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Content-Type": "application/json",
    };
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (req.method !== "POST") return new Response(JSON.stringify({ ok: true, hint: "건반 내비 변환 중계기" }), { headers: cors });
    if (!ALLOWED.includes(origin)) return new Response(JSON.stringify({ ok: false, error: "origin" }), { status: 403, headers: cors });
    if (!env.GH_TOKEN) return new Response(JSON.stringify({ ok: false, error: "GH_TOKEN 비밀값이 없어요" }), { status: 500, headers: cors });
    if (Date.now() - last < 20000) return new Response(JSON.stringify({ ok: true, skipped: true }), { headers: cors });
    last = Date.now();
    const r = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/omr.yml/dispatches`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "gunban-kick" },
      body: JSON.stringify({ ref: "main" }),
    });
    const ok = r.status === 204;
    return new Response(JSON.stringify({ ok, status: r.status }), { status: ok ? 200 : 502, headers: cors });
  },
};
