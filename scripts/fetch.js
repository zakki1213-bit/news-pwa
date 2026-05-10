import Parser from 'rss-parser';
import fs from 'node:fs/promises';

const RETENTION_DAYS = 30;
const SNIPPET_MAX = 220;
const TIMEOUT_MS = 15000;

const parser = new Parser({
  timeout: TIMEOUT_MS,
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; NewsPWA/1.0; +https://github.com/zakki1213-bit/news-pwa)'
  },
  customFields: {
    item: [
      ['media:thumbnail', 'mediaThumbnail', { keepArray: false }],
      ['media:content', 'mediaContent', { keepArray: false }],
      ['enclosure', 'enclosure']
    ]
  }
});

function stripHtml(s) {
  return String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function pickImage(item) {
  // 1. enclosure (image)
  if (item.enclosure?.url && (item.enclosure.type || '').startsWith('image/')) {
    return item.enclosure.url;
  }
  // 2. media:thumbnail / media:content
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
  // 3. <img> in content / content:encoded
  const html = item['content:encoded'] || item.content || item.summary || '';
  const m = String(html).match(/<img[^>]+src=["']([^"']+)["']/i);
  if (m) return m[1];
  return null;
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
    const items = (res.items || []).map((it) => ({
      url: it.link,
      title: stripHtml(it.title || '(no title)'),
      snippet: pickSnippet(it),
      image: pickImage(it),
      pubDate: pickDate(it),
      source: feed.name,
      topicId: topic.id,
      topicName: topic.name,
      topicColor: topic.color
    })).filter((x) => x.url);
    console.log(`OK  ${topic.name} / ${feed.name}: ${items.length} items`);
    return items;
  } catch (err) {
    console.warn(`ERR ${topic.name} / ${feed.name}: ${err.message}`);
    return [];
  }
}

async function main() {
  const cfgRaw = await fs.readFile('feeds.json', 'utf8');
  const cfg = JSON.parse(cfgRaw);

  const cutoff = Date.now() - RETENTION_DAYS * 86400 * 1000;
  const map = new Map();

  for (const topic of cfg.topics) {
    const tasks = topic.feeds.map((f) => fetchOne(topic, f));
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

  const out = {
    generatedAt: new Date().toISOString(),
    retentionDays: RETENTION_DAYS,
    topics: cfg.topics.map((t) => ({ id: t.id, name: t.name, color: t.color })),
    items
  };

  await fs.writeFile('news.json', JSON.stringify(out));
  console.log(`Saved news.json: ${items.length} items`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
