import fs from 'node:fs/promises';
import path from 'node:path';

const WORKER_URL = 'https://news-summarizer.zakki1213.workers.dev';
const WORKER_ORIGIN = 'https://zakki1213-bit.github.io';
const HOURS_WINDOW = parseInt(process.env.EDITION_HOURS || '12', 10);
const MAX_PER_SECTION = parseInt(process.env.MAX_PER_SECTION || '20', 10);
const TIMEOUT_MS = 60000;
const BETWEEN_CALLS_MS = 20000;   // セクション間の待機
const RETRY_WAIT_MS = 35000;      // 429時のリトライ前待機
const KIND = process.env.EDITION_KIND === 'evening' ? 'evening' : 'morning';

const sleep = ms => new Promise(r => setTimeout(r, ms));

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

// 429時に1回だけ大きく待ってリトライ
async function callWorker(payload) {
  let res = await callWorkerOnce(payload);
  if (!res.ok && /\b429\b|RESOURCE_EXHAUSTED/i.test(res.message || '')) {
    console.log(`  ↻ 429検知 → ${RETRY_WAIT_MS/1000}秒待ってリトライ`);
    await sleep(RETRY_WAIT_MS);
    res = await callWorkerOnce(payload);
  }
  return res;
}

async function main() {
  const { dateStr, jst } = nowJSTParts();
  const editionLabel = KIND === 'evening' ? '夕刊' : '朝刊';
  console.log(`=== ${dateStr} ${editionLabel} 生成開始 ===`);

  const newsRaw = await fs.readFile('news.json', 'utf8');
  const news = JSON.parse(newsRaw);
  const cutoff = Date.now() - HOURS_WINDOW * 3600 * 1000;
  const recent = news.items.filter(it => it.pubDate >= cutoff);
  console.log(`直近${HOURS_WINDOW}時間の記事: ${recent.length} 件`);

  // トピックごとにグルーピング、各最大MAX_PER_SECTION件
  const byTopic = new Map();
  for (const t of news.topics) byTopic.set(t.id, { topic: t, articles: [] });
  for (const it of recent) {
    const g = byTopic.get(it.topicId);
    if (g && g.articles.length < MAX_PER_SECTION) g.articles.push(it);
  }

  // セクション本文生成
  const sections = [];
  const references = [];
  let callIdx = 0;
  for (const t of news.topics) {
    const g = byTopic.get(t.id);
    if (!g || g.articles.length === 0) {
      console.log(`- ${t.name}: 記事なし → スキップ`);
      continue;
    }
    if (callIdx > 0) {
      console.log(`  …${BETWEEN_CALLS_MS/1000}秒待機`);
      await sleep(BETWEEN_CALLS_MS);
    }
    console.log(`- ${t.name}: ${g.articles.length}件で執筆中...`);
    callIdx++;
    const articles = g.articles.map(a => ({
      title: a.title,
      source: a.source,
      snippet: a.snippet || a.summary || '',
      url: a.url,
    }));
    const res = await callWorker({
      type: 'edition_section',
      kind: KIND,
      topicName: t.name,
      articles,
    });
    if (res.ok && res.body) {
      sections.push({
        topicId: t.id,
        topicName: t.name,
        color: t.color,
        body: res.body,
      });
      for (const a of g.articles) {
        references.push({
          topicId: t.id,
          title: a.title,
          source: a.source,
          url: a.url,
        });
      }
    } else {
      console.warn(`  ! 失敗: ${res.message}`);
    }
  }

  // リード（編集後記的）生成
  let lead = '';
  if (sections.length > 0) {
    console.log(`  …${BETWEEN_CALLS_MS/1000}秒待機`);
    await sleep(BETWEEN_CALLS_MS);
    console.log('- リード執筆中...');
    const r = await callWorker({
      type: 'edition_lead',
      kind: KIND,
      date: dateStr,
      sections: sections.map(s => ({ topicName: s.topicName, body: s.body })),
    });
    if (r.ok && r.lead) lead = r.lead;
    else console.warn(`  ! リード失敗: ${r.message}`);
  }

  const edition = {
    type: KIND,
    date: dateStr,
    generatedAt: jst.toISOString().replace('Z', '+09:00'),
    lead,
    sections,
    references,
  };

  // 保存
  await fs.mkdir('editions', { recursive: true });
  const filename = `editions/${dateStr}-${KIND}.json`;
  await fs.writeFile(filename, JSON.stringify(edition, null, 2));
  console.log(`保存: ${filename}`);

  // インデックス更新
  let index = { editions: [] };
  try {
    const raw = await fs.readFile('editions/index.json', 'utf8');
    index = JSON.parse(raw);
  } catch {}
  // 同じ日・同じ種別を除外して追加
  index.editions = index.editions.filter(e => !(e.date === dateStr && e.type === KIND));
  index.editions.unshift({
    type: KIND,
    date: dateStr,
    generatedAt: edition.generatedAt,
    file: `${dateStr}-${KIND}.json`,
  });
  // 最大60件保持（朝夕で30日分）
  index.editions = index.editions.slice(0, 60);
  await fs.writeFile('editions/index.json', JSON.stringify(index, null, 2));
  console.log(`一覧更新: ${index.editions.length} 件`);
}

main().catch(e => { console.error(e); process.exit(1); });
