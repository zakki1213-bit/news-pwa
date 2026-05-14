import fs from 'node:fs/promises';

const WORKER_URL = 'https://news-summarizer.zakki1213.workers.dev';
const WORKER_ORIGIN = 'https://zakki1213-bit.github.io';
const HOURS_WINDOW = parseInt(process.env.EDITION_HOURS || '12', 10);
const ARTICLES_PER_TOPIC = parseInt(process.env.ARTICLES_PER_TOPIC || '8', 10);
const TIMEOUT_MS = 120000;
const BETWEEN_CALLS_MS = 20000;
const RETRY_WAIT_MS = 35000;
const KIND = process.env.EDITION_KIND === 'evening' ? 'evening' : 'morning';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function nowJSTParts() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const d = String(jst.getUTCDate()).padStart(2, '0');
  return { dateStr: `${y}-${m}-${d}`, jst };
}

async function callWorkerOnce(payload) {
  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': WORKER_ORIGIN },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { ok: false, message: text.slice(0, 200) }; }
    if (!res.ok) data.ok = false;
    return data;
  } finally {
    clearTimeout(tm);
  }
}

async function callWorker(payload, label) {
  console.log(`→ ${label}`);
  let res = await callWorkerOnce(payload);
  if (!res.ok && /\b429\b|RESOURCE_EXHAUSTED/i.test(res.message || '')) {
    console.log(`  ↻ 429 → ${RETRY_WAIT_MS / 1000}秒待ってリトライ`);
    await sleep(RETRY_WAIT_MS);
    res = await callWorkerOnce(payload);
  }
  if (!res.ok) console.warn(`  ! 失敗: ${(res.message || '').slice(0, 200)}`);
  return res;
}

function makeRef(a) {
  return { title: a.title, url: a.url, source: a.source, topicId: a.topicId };
}

async function main() {
  const { dateStr, jst } = nowJSTParts();
  const editionLabel = KIND === 'evening' ? '夕刊' : '朝刊';
  console.log(`=== ${dateStr} ${editionLabel} 生成開始 ===`);

  const newsRaw = await fs.readFile('news.json', 'utf8');
  const news = JSON.parse(newsRaw);
  const cutoff = Date.now() - HOURS_WINDOW * 3600 * 1000;
  const recent = news.items.filter((it) => it.pubDate >= cutoff);
  console.log(`直近${HOURS_WINDOW}時間の記事: ${recent.length}件`);

  // 候補を作る（トピックごとに最大ARTICLES_PER_TOPIC件、最新順）
  const candidates = [];
  for (const t of news.topics) {
    const sorted = recent.filter((it) => it.topicId === t.id).sort((a, b) => b.pubDate - a.pubDate).slice(0, ARTICLES_PER_TOPIC);
    candidates.push(...sorted);
  }
  console.log(`候補記事: ${candidates.length}件（各トピック最大${ARTICLES_PER_TOPIC}件）`);

  if (candidates.length < 5) {
    console.error('候補が少なすぎます。終了。');
    process.exit(0);
  }

  const articlesForApi = candidates.map((a) => ({
    title: a.title,
    source: a.source,
    snippet: a.snippet || a.summary || '',
    topicName: a.topicName,
  }));

  // 1) curate
  const curate = await callWorker({ type: 'edition_curate', articles: articlesForApi }, 'curate（記事選定）');
  if (!curate.ok) { console.error('curate失敗。終了。'); process.exit(1); }
  console.log(`  top=[${curate.top}], mid=[${curate.mid.join(',')}], briefs=[${curate.briefs.join(',')}]`);

  // 2) top writeup
  await sleep(BETWEEN_CALLS_MS);
  const topArticle = candidates[curate.top];
  const topRes = await callWorker(
    { type: 'edition_writeup', length: 'long', articles: [{ title: topArticle.title, source: topArticle.source, snippet: topArticle.snippet, topicName: topArticle.topicName }] },
    'top（一面トップ執筆）'
  );

  // 3) mid writeup
  await sleep(BETWEEN_CALLS_MS);
  const midArticles = curate.mid.map((i) => candidates[i]).filter(Boolean);
  const midRes = await callWorker(
    { type: 'edition_writeup', length: 'medium', articles: midArticles.map((a) => ({ title: a.title, source: a.source, snippet: a.snippet, topicName: a.topicName })) },
    `mid（中段${midArticles.length}本執筆）`
  );

  // 4) briefs writeup
  await sleep(BETWEEN_CALLS_MS);
  const briefArticles = curate.briefs.map((i) => candidates[i]).filter(Boolean);
  const briefRes = await callWorker(
    { type: 'edition_writeup', length: 'short', articles: briefArticles.map((a) => ({ title: a.title, source: a.source, snippet: a.snippet, topicName: a.topicName })) },
    `briefs（ベタ${briefArticles.length}本執筆）`
  );

  // 5) lead
  await sleep(BETWEEN_CALLS_MS);
  let lead = '';
  if (topRes.ok && (topRes.stories || []).length > 0) {
    const leadRes = await callWorker(
      {
        type: 'edition_lead',
        kind: KIND,
        date: dateStr,
        topStory: topRes.stories[0],
        midStories: (midRes.ok && midRes.stories) || [],
      },
      'lead（リード執筆）'
    );
    if (leadRes.ok) lead = leadRes.lead || '';
  }

  // assemble
  const topStory = (topRes.ok && topRes.stories?.[0]) ? {
    title: topRes.stories[0].title,
    body: topRes.stories[0].body,
    topicId: topArticle.topicId,
    topicName: topArticle.topicName,
    color: topArticle.topicColor,
    references: [makeRef(topArticle)],
  } : null;

  const midStories = (midRes.ok ? midRes.stories : []).map((s, i) => {
    const a = midArticles[i];
    if (!a) return null;
    return {
      title: s.title,
      body: s.body,
      topicId: a.topicId,
      topicName: a.topicName,
      color: a.topicColor,
      references: [makeRef(a)],
    };
  }).filter(Boolean);

  const briefs = (briefRes.ok ? briefRes.stories : []).map((s, i) => {
    const a = briefArticles[i];
    if (!a) return null;
    return {
      title: s.title,
      body: s.body,
      topicId: a.topicId,
      topicName: a.topicName,
      color: a.topicColor,
      url: a.url,
      source: a.source,
    };
  }).filter(Boolean);

  const edition = {
    type: KIND,
    date: dateStr,
    generatedAt: jst.toISOString().replace('Z', '+09:00'),
    lead,
    topStory,
    midStories,
    briefs,
  };

  await fs.mkdir('editions', { recursive: true });
  const filename = `editions/${dateStr}-${KIND}.json`;
  await fs.writeFile(filename, JSON.stringify(edition, null, 2));
  console.log(`保存: ${filename}`);

  let index = { editions: [] };
  try {
    const raw = await fs.readFile('editions/index.json', 'utf8');
    index = JSON.parse(raw);
  } catch {}
  index.editions = (index.editions || []).filter((e) => !(e.date === dateStr && e.type === KIND));
  index.editions.unshift({
    type: KIND,
    date: dateStr,
    generatedAt: edition.generatedAt,
    file: `${dateStr}-${KIND}.json`,
  });
  index.editions = index.editions.slice(0, 60);
  await fs.writeFile('editions/index.json', JSON.stringify(index, null, 2));
  console.log(`一覧更新: ${index.editions.length}件`);
  console.log(`完了: トップ${topStory ? 'あり' : 'なし'} / 中段${midStories.length}本 / ベタ${briefs.length}本`);
}

main().catch((e) => { console.error(e); process.exit(1); });
