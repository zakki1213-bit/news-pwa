// News summarizer Worker
// - Receives { url } from PWA
// - Fetches the article (following redirects, including Google News)
// - Extracts main content
// - If content < MIN_CHARS, returns error (no speculative summary)
// - Else: calls Gemini and returns summary

const ALLOWED_ORIGINS = [
  'https://zakki1213-bit.github.io',
];

const MIN_CHARS = 200;       // これ未満ならtitle+snippetをfallback合算
const MIN_TOTAL_CHARS = 30;  // 全合算でもこれ未満なら要約諦め
const MAX_INPUT_CHARS = 30000;
const FETCH_TIMEOUT_MS = 12000;

const GEMINI_MODEL = 'gemini-2.5-flash-lite';
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

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'invalid_json' }, 400, cors);
    }

    // 紙面生成API（新聞紙面型）
    if (body.type === 'edition_oneshot') {
      return await handleEditionOneshot(body, env, cors);
    }
    if (body.type === 'edition_curate') {
      return await handleEditionCurate(body, env, cors);
    }
    if (body.type === 'edition_writeup') {
      return await handleEditionWriteup(body, env, cors);
    }
    if (body.type === 'edition_lead') {
      return await handleEditionLead(body, env, cors);
    }

    // 既存：個別記事の要約
    const url = body.url;
    const title = body.title || '';
    const snippet = body.snippet || '';
    if (!url || typeof url !== 'string' || !/^https?:\/\//.test(url)) {
      return json({ error: 'invalid_url' }, 400, cors);
    }

    try {
      // Resolve Google News URL to actual article URL if needed
      const isGoogleNews = /^https?:\/\/news\.google\.com\//.test(url);
      const resolvedUrl = await resolveGoogleNewsUrl(url);
      const resolvedOk = (resolvedUrl !== url);

      // Fetch article HTML (follow redirects)
      const articleRes = await fetchWithTimeout(resolvedUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ja,en;q=0.5',
        },
        redirect: 'follow',
      });

      // Google News解決失敗時はOG画像も諦める（GoogleのCDNアイコンが返るため）
      const skipOg = isGoogleNews && !resolvedOk;

      let html = '';
      let text = '';
      let ogImage = null;
      if (articleRes.ok) {
        html = await articleRes.text();
        text = extractMainContent(html);
        ogImage = skipOg ? null : extractOgImage(html, articleRes.url || resolvedUrl);
      }

      // 本文が短ければtitle+snippetをfallbackとして合算
      let inputText = text;
      if (inputText.length < MIN_CHARS) {
        const supplement = [title, snippet].filter(Boolean).join('\n');
        if (supplement) inputText = (text + '\n' + supplement).trim();
      }

      if (inputText.length < MIN_TOTAL_CHARS) {
        return json({
          ok: false,
          reason: articleRes.ok ? 'too_short' : 'fetch_failed',
          message: '記事の情報が少なすぎて要約を生成できませんでした',
          ogImage,
        }, 200, cors);
      }

      // Summarize with Gemini
      const summary = await callGemini(
        buildSummaryPrompt(inputText.slice(0, MAX_INPUT_CHARS)),
        env.GEMINI_API_KEY
      );
      return json({
        ok: true,
        summary,
        ogImage,
        charsUsed: Math.min(inputText.length, MAX_INPUT_CHARS),
        usedFallback: text.length < MIN_CHARS,
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
  return /favicon\.|news\.google\.com|googleusercontent\.com|st-hatena\.com|apple-touch-icon|\/icon-?\d+x\d+\.|gstatic\.com\/news|gnews_favicon/i.test(u);
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

// ===== 紙面（新聞紙面型・朝刊・夕刊）生成 =====

// 単一コールで紙面全体を生成（curate+writeup+lead を1回で）
async function handleEditionOneshot(body, env, cors) {
  const { articles, kind, date } = body;
  if (!Array.isArray(articles) || articles.length === 0) {
    return json({ ok: false, message: 'articlesが必要です' }, 400, cors);
  }
  const editionLabel = kind === 'evening' ? '夕刊' : '朝刊';

  const list = articles.map((a, i) =>
    `[${i}] ${a.title} | ${a.topicName || '-'} | ${a.source || '-'} | ${(a.snippet || '').slice(0, 150)}`
  ).join('\n');

  const prompt = `あなたは新聞の編集者です。${date} ${editionLabel}の紙面を作ってください。

以下のニュース記事リストから記事を選んで、それぞれ見出しと本文を書きます。

紙面構成：
- top: 一面トップ 1本（最も重要・話題性の高い記事を大きく扱う）、本文 600〜900字 / 4〜5段落
- mid: 中段 4本（注目記事）、本文 各 250〜350字 / 2〜3段落
- briefs: ベタ 6本（押さえておくべき記事）、本文 各 80〜120字 / 1段落
- lead: 編集後記 80〜120字 / 1段落（紙面全体を俯瞰した導入文）

選定基準：
- 公共性・社会的影響度・速報性
- 教育・商業・AI・北海道の各分野からバランスよく
- 同種・類似ニュースは1本に絞る
- top / mid / briefs で重複しない

執筆ルール：
- 見出しは30字以内、新聞らしい簡潔な表現（センセーショナルにしない）
- 本文の段落間は空行（\\n\\n）で区切る
- 数値や固有名詞は素材から正確に拾う、推測で補わない
- 客観的な文体、箇条書き不可、伝聞語（〜とのこと等）避ける
- 「以下〜」「本稿では〜」のような枕詞は不要

各選定記事は articleIdx で素材リストの番号 [0]〜[${articles.length - 1}] を指してください。

記事リスト：
${list}`;

  const schema = {
    type: 'OBJECT',
    properties: {
      lead: { type: 'STRING' },
      top: {
        type: 'OBJECT',
        properties: {
          articleIdx: { type: 'INTEGER' },
          title: { type: 'STRING' },
          body: { type: 'STRING' },
        },
        required: ['articleIdx', 'title', 'body'],
      },
      mid: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            articleIdx: { type: 'INTEGER' },
            title: { type: 'STRING' },
            body: { type: 'STRING' },
          },
          required: ['articleIdx', 'title', 'body'],
        },
      },
      briefs: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            articleIdx: { type: 'INTEGER' },
            title: { type: 'STRING' },
            body: { type: 'STRING' },
          },
          required: ['articleIdx', 'title', 'body'],
        },
      },
    },
    required: ['lead', 'top', 'mid', 'briefs'],
  };

  try {
    const text = await callGemini(prompt, env.GEMINI_API_KEY, {
      responseSchema: schema,
      maxOutputTokens: 8000,
      temperature: 0.4,
    });
    const data = JSON.parse(text);
    return json({ ok: true, ...data }, 200, cors);
  } catch (err) {
    return json({ ok: false, message: err.message || String(err) }, 500, cors);
  }
}

async function handleEditionCurate(body, env, cors) {
  const { articles } = body;
  if (!Array.isArray(articles) || articles.length === 0) {
    return json({ ok: false, message: 'articlesが必要です' }, 400, cors);
  }
  const list = articles.map((a, i) =>
    `[${i}] ${a.title} | ${a.topicName || '-'} | ${a.source || '-'} | ${(a.snippet || '').slice(0, 120)}`
  ).join('\n');

  const prompt = `あなたは新聞の編集者です。以下のニュース記事リストから、新聞紙面に掲載する記事を選んでください。

選び方：
- top: 最も重要・話題性の高い記事 1本（一面トップ・大きく扱う）
- mid: 注目すべき記事 4本（中段・準トップ扱い、topと重複しない）
- briefs: 押さえておくべき記事 6本（下段ベタ記事、top/midと重複しない）

選定基準：
- 公共性・社会的影響度・速報性
- 教育・商業・AI・北海道の各分野からバランスよく
- 同種・類似ニュースは1本に絞る
- 配列のidx（[0]〜[N]）を返す

記事リスト：
${list}`;

  const schema = {
    type: 'OBJECT',
    properties: {
      top: { type: 'INTEGER' },
      mid: { type: 'ARRAY', items: { type: 'INTEGER' } },
      briefs: { type: 'ARRAY', items: { type: 'INTEGER' } },
    },
    required: ['top', 'mid', 'briefs'],
  };

  try {
    const text = await callGemini(prompt, env.GEMINI_API_KEY, { responseSchema: schema, maxOutputTokens: 800 });
    const data = JSON.parse(text);
    return json({ ok: true, ...data }, 200, cors);
  } catch (err) {
    return json({ ok: false, message: err.message || String(err) }, 500, cors);
  }
}

async function handleEditionWriteup(body, env, cors) {
  const { articles, length } = body;
  if (!Array.isArray(articles) || articles.length === 0) {
    return json({ ok: false, message: 'articlesが必要です' }, 400, cors);
  }
  const spec = ({
    long:   { range: '600〜900字', paragraphs: '4〜5段落', tokens: 2400 },
    medium: { range: '250〜350字', paragraphs: '2〜3段落', tokens: 1200 },
    short:  { range: '80〜120字',  paragraphs: '1段落',     tokens: 600 },
  })[length] || { range: '300字', paragraphs: '2段落', tokens: 1200 };

  const list = articles.map((a, i) =>
    `[${i + 1}]\nタイトル: ${a.title}\n出典: ${a.source || '-'}\nトピック: ${a.topicName || '-'}\n概要: ${a.snippet || '-'}`
  ).join('\n\n');

  const prompt = `あなたは新聞の編集者です。以下の素材記事${articles.length}件について、新聞掲載用に書き直してください。

ルール：
- 必ず素材と同じ順序・同じ件数（${articles.length}件）で書く
- 1記事につき「見出し（30字以内、新聞らしい簡潔な表現）」と「本文（${spec.range}・${spec.paragraphs}）」
- 段落間は空行（\\n\\n）で区切る
- 数値や固有名詞は素材から正確に拾う、推測で補わない
- 客観的な文体、箇条書き不可、伝聞語（〜とのこと等）避ける
- 「以下〜」「本稿では〜」のような枕詞は不要

素材：

${list}`;

  const schema = {
    type: 'OBJECT',
    properties: {
      stories: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            title: { type: 'STRING' },
            body: { type: 'STRING' },
          },
          required: ['title', 'body'],
        },
      },
    },
    required: ['stories'],
  };

  try {
    const text = await callGemini(prompt, env.GEMINI_API_KEY, { responseSchema: schema, maxOutputTokens: spec.tokens * articles.length });
    const data = JSON.parse(text);
    return json({ ok: true, stories: data.stories || [] }, 200, cors);
  } catch (err) {
    return json({ ok: false, message: err.message || String(err) }, 500, cors);
  }
}

async function handleEditionLead(body, env, cors) {
  const { topStory, midStories, kind, date } = body;
  const editionLabel = kind === 'evening' ? '夕刊' : '朝刊';

  const summaries = [];
  if (topStory) summaries.push(`【トップ】${topStory.title}\n${(topStory.body || '').slice(0, 200)}`);
  for (const s of (midStories || [])) {
    summaries.push(`【中段】${s.title}\n${(s.body || '').slice(0, 150)}`);
  }

  const prompt = `あなたは新聞の編集者です。${date} ${editionLabel}のリード（編集後記的な短い導入文）を日本語で書いてください。

ルール：
- 80〜120字、1段落
- 今日のニュース全体を俯瞰し、読者に伝えたい主題やテーマを示す
- 個別事件の詳述ではない
- 箇条書き・見出し・枕詞は使わない

紙面の主要記事：

${summaries.join('\n\n')}`;

  try {
    const text = await callGemini(prompt, env.GEMINI_API_KEY, { maxOutputTokens: 400 });
    return json({ ok: true, lead: text.trim() }, 200, cors);
  } catch (err) {
    return json({ ok: false, message: err.message || String(err) }, 500, cors);
  }
}

// 個別記事要約用のプロンプト構築
function buildSummaryPrompt(text) {
  return `以下のニュース素材を、日本語で読み物として書き直してください。

書き方の指示：
- 情報量に応じて 1〜5段落で書く（素材が短ければ短く、豊富なら3〜5段落）
- 段落の構成：1段落目はリード（何が起きたか）、続く段落で詳細・背景・数値、最後に影響や注目点
- 自然で読みやすい文体、客観的、素材に書かれていない事実は推測で補わない
- 元の文章をそのままコピーせず自分の言葉で書く（言い換え）
- 段落と段落の間は空行（\\n\\n）で区切る
- 箇条書きや見出しは使わない
- 素材が断片的でも、与えられた範囲だけで自然な日本語にまとめる

ニュース素材：
${text}`;
}

async function callGemini(prompt, apiKey, opts = {}) {
  if (!apiKey) throw new Error('GEMINI_API_KEY が設定されていません');

  const generationConfig = {
    temperature: opts.temperature ?? 0.3,
    maxOutputTokens: opts.maxOutputTokens ?? 2048,
    thinkingConfig: { thinkingBudget: 0 },
  };
  if (opts.responseSchema) {
    generationConfig.responseSchema = opts.responseSchema;
    generationConfig.responseMimeType = 'application/json';
  }

  const res = await fetch(`${GEMINI_ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig,
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
