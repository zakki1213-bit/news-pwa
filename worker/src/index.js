// News summarizer Worker
// - Receives { url } from PWA
// - Fetches the article (following redirects, including Google News)
// - Extracts main content
// - If content < MIN_CHARS, returns error (no speculative summary)
// - Else: calls Gemini and returns summary

const ALLOWED_ORIGINS = [
  'https://zakki1213-bit.github.io',
];

const MIN_CHARS = 500;
const MAX_INPUT_CHARS = 30000;
const FETCH_TIMEOUT_MS = 12000;

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_ENDPOINT =
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const isAllowed = ALLOWED_ORIGINS.includes(origin);

    const cors = {
      'Access-Control-Allow-Origin': isAllowed ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }
    if (request.method !== 'POST') {
      return json({ error: 'method_not_allowed' }, 405, cors);
    }
    if (!isAllowed) {
      return json({ error: 'forbidden', message: 'Origin not allowed' }, 403, cors);
    }

    let url;
    try {
      const body = await request.json();
      url = body.url;
    } catch {
      return json({ error: 'invalid_json' }, 400, cors);
    }
    if (!url || typeof url !== 'string' || !/^https?:\/\//.test(url)) {
      return json({ error: 'invalid_url' }, 400, cors);
    }

    try {
      // Fetch article HTML (follow redirects)
      const articleRes = await fetchWithTimeout(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; NewsPWA-Summarizer/1.0)',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ja,en;q=0.5',
        },
        redirect: 'follow',
      });

      if (!articleRes.ok) {
        return json({
          ok: false,
          reason: 'fetch_failed',
          message: `本文を取得できませんでした (HTTP ${articleRes.status})`,
        }, 200, cors);
      }

      const html = await articleRes.text();
      const text = extractMainContent(html);

      if (text.length < MIN_CHARS) {
        return json({
          ok: false,
          reason: 'too_short',
          message: '本文を取得できませんでした（有料記事や動的読み込みの可能性があります）',
        }, 200, cors);
      }

      // Summarize with Gemini
      const summary = await callGemini(text.slice(0, MAX_INPUT_CHARS), env.GEMINI_API_KEY);
      return json({ ok: true, summary, charsUsed: Math.min(text.length, MAX_INPUT_CHARS) }, 200, cors);

    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      return json({ ok: false, reason: 'internal_error', message: msg }, 500, cors);
    }
  },
};

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

async function fetchWithTimeout(url, opts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function extractMainContent(html) {
  // Remove non-content tags
  let cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ');

  // Prefer <article> or <main>
  const a = cleaned.match(/<article\b[\s\S]*?<\/article>/i);
  const m = cleaned.match(/<main\b[\s\S]*?<\/main>/i);
  const target = (a && a[0].length > 800) ? a[0]
                : (m && m[0].length > 800) ? m[0]
                : cleaned;

  // Strip tags & decode common entities
  const text = target
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
  return text;
}

async function callGemini(text, apiKey) {
  if (!apiKey) throw new Error('GEMINI_API_KEY が設定されていません');

  const prompt =
    `以下のニュース記事の本文を、日本語で3〜5項目の箇条書きで要約してください。
- 各項目は1文で簡潔に
- 事実のみ。推測・憶測・「とのことです」のような伝聞表現は避ける
- 重要な数値・固有名詞は省かない
- 各項目の先頭に「・」を付ける

記事本文：
${text}`;

  const res = await fetch(`${GEMINI_ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 800 },
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Gemini API ${res.status}: ${detail.slice(0, 200)}`);
  }
  const data = await res.json();
  const out = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!out) throw new Error('Gemini から要約を取得できませんでした');
  return out.trim();
}
