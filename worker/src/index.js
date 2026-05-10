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
      // Resolve Google News URL to actual article URL if needed
      const resolvedUrl = await resolveGoogleNewsUrl(url);

      // Fetch article HTML (follow redirects)
      const articleRes = await fetchWithTimeout(resolvedUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
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
      const ogImage = extractOgImage(html, articleRes.url || resolvedUrl);

      if (text.length < MIN_CHARS) {
        return json({
          ok: false,
          reason: 'too_short',
          message: '本文を取得できませんでした（有料記事や動的読み込みの可能性があります）',
          ogImage,
        }, 200, cors);
      }

      // Summarize with Gemini
      const summary = await callGemini(text.slice(0, MAX_INPUT_CHARS), env.GEMINI_API_KEY);
      return json({
        ok: true,
        summary,
        ogImage,
        charsUsed: Math.min(text.length, MAX_INPUT_CHARS),
      }, 200, cors);

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

async function resolveGoogleNewsUrl(url) {
  if (!/^https?:\/\/news\.google\.com\/(rss\/)?articles\//.test(url)) return url;
  try {
    const pageRes = await fetchWithTimeout(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept-Language': 'ja,en;q=0.5',
      },
      redirect: 'follow',
    });
    if (!pageRes.ok) return url;
    const html = await pageRes.text();
    const tsM = html.match(/data-n-a-ts="(\d+)"/);
    const sgM = html.match(/data-n-a-sg="([^"]+)"/);
    const idM = html.match(/data-n-a-id="([^"]+)"/);
    if (!tsM || !sgM || !idM) return url;
    const id = idM[1], ts = Number(tsM[1]), sg = sgM[1];

    const innerJson = JSON.stringify([
      'garturlreq',
      [['X','X',['X','X'],null,null,1,1,'US:en',null,1,null,null,null,null,null,0,1],
       'X','X',1,[1,1,1],1,1,null,0,0,null,0],
      id, ts, sg,
    ]);
    const reqArr = [[['Fbv4je', innerJson, null, 'generic']]];
    const body = 'f.req=' + encodeURIComponent(JSON.stringify(reqArr));

    const batchRes = await fetchWithTimeout('https://news.google.com/_/DotsSplashUi/data/batchexecute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body,
    });
    if (!batchRes.ok) return url;
    const text = await batchRes.text();
    // Response: )]}'\n[["wrb.fr","Fbv4je","[\"garturlres\",\"<URL>\",1,...]",...]]
    const m = text.match(/\\"garturlres\\",\\"(https?:[^\\]+)\\"/);
    if (m && m[1]) return m[1];
    return url;
  } catch {
    return url;
  }
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

// 汎用アイコン（Googleニュース、はてなfavicon等）はマガジン用には使えないので除外
function isGenericIconUrl(u) {
  if (!u) return true;
  return /favicon\.|news\.google\.com\/favicon|googleusercontent\.com\/(news|s2\/favicons)|st-hatena\.com\/favicon|apple-touch-icon|\/icon-?\d+x\d+\.|gstatic\.com\/news/i.test(u);
}

function extractOgImage(html, baseUrl) {
  const patterns = [
    /<meta[^>]+property=["']og:image:secure_url["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image:secure_url["']/i,
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) {
      let u = m[1].trim()
        .replace(/&amp;/g, '&')
        .replace(/&#x2F;/gi, '/')
        .replace(/&quot;/g, '"');
      if (u.startsWith('//')) u = 'https:' + u;
      else if (u.startsWith('/') && baseUrl) {
        try { u = new URL(u, baseUrl).toString(); } catch {}
      }
      if (isGenericIconUrl(u)) continue;
      return u;
    }
  }
  return null;
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
    `以下のニュース記事の内容を、日本語で 3〜5段落の読み物に書き直してください。

書き方の指示：
- 1段落目: リード。何が起きたか・どんなニュースかを簡潔に
- 2〜3段落目: 詳細・背景・関係者・具体的な数値や事実
- 最後の段落: 影響、今後の見通し、注目すべきポイント
- 自然で読みやすい文体、客観的、推測や憶測は書かない
- 元記事の文章をそのままコピーせず、自分の言葉で書く（言い換え）
- 各段落は2〜4文程度
- 全体で400〜700文字程度
- 段落と段落の間は空行（\\n\\n）で区切る
- 箇条書きや見出しは使わない

記事本文：
${text}`;

  const res = await fetch(`${GEMINI_ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 2048,
        thinkingConfig: { thinkingBudget: 0 },
      },
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
