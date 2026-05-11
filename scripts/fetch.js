import Parser from 'rss-parser';
import fs from 'node:fs/promises';

const RETENTION_DAYS = 30;
const SNIPPET_MAX = 220;
const TIMEOUT_MS = 15000;
const WORKER_URL = 'https://news-summarizer.zakki1213.workers.dev';
const WORKER_ORIGIN = 'https://zakki1213-bit.github.io';
const ENRICH_DELAY_MS = 6500;          // 約9 RPM、429回避のため余裕を持たせる
const ENRICH_TIMEOUT_MS = 35000;
const CACHE_PATH = 'enrichment-cache.json';
const ENRICH_TTL_OK_DAYS = 30;
const ENRICH_TTL_FAIL_DAYS = 1;
const MAX_ENRICH_PER_RUN = parseInt(process.env.MAX_ENRICH_PER_RUN || '50', 10);
const ENRICH_MAX_AGE_HOURS = parseInt(process.env.ENRICH_MAX_AGE_HOURS || '3', 10);  // pubDateがこの時間以内の記事のみenrich

const parser = new Parser({
  timeout: TIMEOUT_MS,
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; NewsPWA/1.0; +https://github.com/zakki1213-bit/news-pwa)',
  },
  customFields: {
    item: [
      ['media:thumbnail', 'mediaThumbnail', { keepArray: false }],
      ['media:content', 'mediaContent', { keepArray: false }],
      ['enclosure', 'enclosure'],
    ],
  },
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

function stripHtml(s) {
  return String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function pickImage(item) {
  if (item.enclosure?.url && (item.enclosure.type || '').startsWith('image/')) return item.enclosure.url;
  const mt = item.mediaThumbnail;
  if (mt) {
    if (typeof mt === 'string') return mt;
    if (mt.url) return mt.url;
    if (mt.$ && mt.$.url) return mt.$.url;
  }
  const mc = item.mediaContent;
  if (mc) {
    if (typeof mc === 'string') return mc;
    if (mc.url) return mc.url;
    if (mc.$ && mc.$.url) return mc.$.url;
  }
  const html = item['content:encoded'] || item.content || item.summary || '';
  const m = String(html).match(/<img[^>]+src=["']([^"']+)["']/i);
  return m ? m[1] : null;
}

function pickSnippet(item) {
  let s = item.contentSnippet || item.summary || item.content || '';
  s = stripHtml(s);
  if (s.length > SNIPPET_MAX) s = s.slice(0, SNIPPET_MAX) + '…';
  return s;
}

function pickDate(item) {
  const v = item.isoDate || item.pubDate;
  const t = v ? new Date(v).getTime() : NaN;
  return Number.isFinite(t) ? t : Date.now();
}

async function fetchOne(topic, feed) {
  try {
    const res = await parser.parseURL(feed.url);
    const items = (res.items || []).map(it => ({
      url: it.link,
      title: stripHtml(it.title || '(no title)'),
      snippet: pickSnippet(it),
      image: pickImage(it),
      pubDate: pickDate(it),
      source: feed.name,
      topicId: topic.id,
      topicName: topic.name,
      topicColor: topic.color,
    })).filter(x => x.url);
    console.log(`OK  ${topic.name} / ${feed.name}: ${items.length} items`);
    return items;
  } catch (err) {
    console.warn(`ERR ${topic.name} / ${feed.name}: ${err.message}`);
    return [];
  }
}

async function loadCache() {
  try {
    const raw = await fs.readFile(CACHE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch { return {}; }
}

async function pruneCache(cache) {
  const now = Date.now();
  const cleaned = {};
  for (const [k, v] of Object.entries(cache)) {
    if (!v?.fetchedAt) continue;
    const ttlDays = (v.status === 'ok' || v.status === 'too_short') ? ENRICH_TTL_OK_DAYS : ENRICH_TTL_FAIL_DAYS;
    if (now - v.fetchedAt < ttlDays * 86400 * 1000) cleaned[k] = v;
  }
  return cleaned;
}

async function saveCache(cache) {
  await fs.writeFile(CACHE_PATH, JSON.stringify(cache));
}

async function enrichOne(item) {
  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), ENRICH_TIMEOUT_MS);
  try {
    const res = await fetch(WORKER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': WORKER_ORIGIN,
      },
      body: JSON.stringify({ url: item.url, title: item.title, snippet: item.snippet }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      let body = '';
      try { body = await res.text(); } catch {}
      return { status: 'http_' + res.status, error: body.slice(0, 300), summary: null, ogImage: null, fetchedAt: Date.now() };
    }
    const data = await res.json();
    return {
      status: data.ok ? 'ok' : (data.reason || 'failed'),
      summary: data.ok ? (data.summary || null) : null,
      ogImage: data.ogImage || null,
      fetchedAt: Date.now(),
    };
  } catch (err) {
    return { status: 'error', summary: null, ogImage: null, fetchedAt: Date.now() };
  } finally {
    clearTimeout(tm);
  }
}

async function main() {
  const cfgRaw = await fs.readFile('feeds.json', 'utf8');
  const cfg = JSON.parse(cfgRaw);

  const cutoff = Date.now() - RETENTION_DAYS * 86400 * 1000;
  const map = new Map();

  // 1) RSS取得
  for (const topic of cfg.topics) {
    const tasks = topic.feeds.map(f => fetchOne(topic, f));
    const results = await Promise.all(tasks);
    for (const arr of results) {
      for (const item of arr) {
        if (item.pubDate < cutoff) continue;
        const cur = map.get(item.url);
        if (!cur || cur.pubDate < item.pubDate) map.set(item.url, item);
      }
    }
  }
  const items = [...map.values()].sort((a, b) => b.pubDate - a.pubDate);
  console.log(`[Phase 1] RSS集約完了: ${items.length} items`);

  // 2) Enrichment（要約＋OG画像） - 新しい記事のみ対象
  let cache = await pruneCache(await loadCache());
  const enrichCutoff = Date.now() - ENRICH_MAX_AGE_HOURS * 3600 * 1000;
  const candidates = items.filter(it => !cache[it.url]);
  const toEnrich = candidates.filter(it => it.pubDate >= enrichCutoff).slice(0, MAX_ENRICH_PER_RUN);
  const skippedOld = candidates.length - toEnrich.length;
  console.log(`[Phase 2] Enrichment開始: ${toEnrich.length} items（キャッシュ${Object.keys(cache).length}件、新着のみ最大${MAX_ENRICH_PER_RUN}件/run、過去記事${skippedOld}件は対象外）`);

  let done = 0;
  let aborted = false;
  for (const it of toEnrich) {
    const e = await enrichOne(it);
    // Geminiクォータ枯渇を検知 → 即abort（無駄打ちしない）
    const isRateLimit = e.status?.startsWith('http_5') && /\b429\b|RESOURCE_EXHAUSTED|exceeded.*quota/i.test(e.error || '');
    if (isRateLimit) {
      console.log(`! Gemini APIレート上限を検知。${done}件で中断します（次回スケジュールで再開）`);
      aborted = true;
      break;
    }
    cache[it.url] = e;
    done++;
    if (done % 10 === 0) {
      console.log(`  enriched ${done}/${toEnrich.length} [${e.status}] ${it.title.slice(0, 40)}`);
      await saveCache(cache);
    }
    await sleep(ENRICH_DELAY_MS);
  }
  await saveCache(cache);
  console.log(`[Phase 2] ${aborted ? '中断' : '完了'}: ${done} 件処理`);

  // 3) 各itemにenrichmentを反映
  let okCount = 0, imgCount = 0;
  for (const it of items) {
    const e = cache[it.url];
    if (!e) continue;
    if (e.summary) { it.summary = e.summary; okCount++; }
    if (e.ogImage) { it.ogImage = e.ogImage; imgCount++; }
    if (e.status) it.summaryStatus = e.status;
  }
  console.log(`[Phase 3] 反映完了: 要約 ${okCount}/${items.length}、OG画像 ${imgCount}/${items.length}`);

  const out = {
    generatedAt: new Date().toISOString(),
    retentionDays: RETENTION_DAYS,
    topics: cfg.topics.map(t => ({ id: t.id, name: t.name, color: t.color })),
    items,
  };
  await fs.writeFile('news.json', JSON.stringify(out));
  console.log(`Saved news.json: ${items.length} items`);
}

main().catch(e => { console.error(e); process.exit(1); });
