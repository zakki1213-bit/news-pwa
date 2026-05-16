import fs from 'node:fs/promises';

const WORKER_URL = 'https://news-summarizer.zakki1213.workers.dev';
const WORKER_ORIGIN = 'https://zakki1213-bit.github.io';
const HOURS_WINDOW = parseInt(process.env.EDITION_HOURS || '12', 10);
const ARTICLES_PER_TOPIC = parseInt(process.env.ARTICLES_PER_TOPIC || '8', 10);
const TIMEOUT_MS = 180000;        // 単一コールはGeminiが長文を吐くので余裕を持つ
const RETRY_WAIT_MS = 60000;      // 429時のリトライ前待機
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
    try { data = JSON.parse(text); } catch { data = { ok: false, message: text.slice(0, 300) }; }
    if (!res.ok) data.ok = false;
    return data;
  } finally {
    clearTimeout(tm);
  }
}

async function callWorkerWithRetry(payload, label, maxRetries = 2) {
  console.log(`→ ${label}`);
  for (let i = 0; i <= maxRetries; i++) {
    const res = await callWorkerOnce(payload);
    if (res.ok) return res;
    const isRate = /\b429\b|RESOURCE_EXHAUSTED/i.test(res.message || '');
    console.warn(`  ! 試行${i + 1}失敗: ${(res.message || '').slice(0, 150)}`);
    if (i < maxRetries && isRate) {
      console.log(`  ↻ ${RETRY_WAIT_MS / 1000}秒待ってリトライ`);
      await sleep(RETRY_WAIT_MS);
    } else {
      return res;
    }
  }
}

function makeRef(a) {
  return { title: a.title, url: a.url, source: a.source, topicId: a.topicId };
}

// タイトルを正規化して比較しやすくする
function normTitle(t) {
  return String(t || '')
    .toLowerCase()
    .replace(/[\s\-－—\|｜·・,．。、！？\!\?\(\)\[\]【】「」『』"'`]+/g, '')
    .trim();
}

// 文字バイグラム集合
function bigramSet(s) {
  const out = new Set();
  for (let i = 0; i < s.length - 1; i++) out.add(s.substr(i, 2));
  return out;
}
function bigramSim(a, b) {
  const A = bigramSet(normTitle(a));
  const B = bigramSet(normTitle(b));
  if (!A.size || !B.size) return 0;
  let common = 0;
  for (const x of A) if (B.has(x)) common++;
  return common / Math.min(A.size, B.size);
}

// 候補から類似タイトルを1本に絞る（バイグラム類似度70%以上を重複と判定）
function dedupeCandidates(arr, threshold = 0.7) {
  const out = [];
  for (const a of arr) {
    const dup = out.some((b) => bigramSim(a.title, b.title) >= threshold);
    if (!dup) out.push(a);
  }
  return out;
}

// 過去N編集で取り上げた URL・タイトルを取得
async function getPreviouslyFeatured(currentDate, currentKind, maxEditions = 4) {
  const titles = [];
  const urls = new Set();
  try {
    const idxRaw = await fs.readFile('editions/index.json', 'utf8');
    const idx = JSON.parse(idxRaw);
    const recent = (idx.editions || [])
      .filter((e) => !(e.date === currentDate && e.type === currentKind))
      .slice(0, maxEditions);
    for (const e of recent) {
      try {
        const ed = JSON.parse(await fs.readFile(`editions/${e.file}`, 'utf8'));
        if (ed.topStory) {
          titles.push(ed.topStory.title);
          if (ed.topStory.references?.[0]?.url) urls.add(ed.topStory.references[0].url);
        }
        for (const m of ed.midStories || []) {
          titles.push(m.title);
          if (m.references?.[0]?.url) urls.add(m.references[0].url);
        }
        for (const b of ed.briefs || []) {
          titles.push(b.title);
          if (b.url) urls.add(b.url);
        }
      } catch {}
    }
  } catch {}
  return { titles, urls };
}

function filterAgainstPrevious(candidates, prev, threshold = 0.6) {
  return candidates.filter((c) => {
    if (prev.urls.has(c.url)) return false;
    for (const t of prev.titles) {
      if (bigramSim(c.title, t) >= threshold) return false;
    }
    return true;
  });
}

function aggregatePreferences(votes) {
  const topics = {};
  const sources = {};
  for (const v of Object.values(votes || {})) {
    const sign = v.vote === 'up' ? 1 : (v.vote === 'down' ? -1 : 0);
    if (!sign) continue;
    if (v.topicName) topics[v.topicName] = (topics[v.topicName] || 0) + sign;
    if (v.source)    sources[v.source]   = (sources[v.source]   || 0) + sign;
  }
  return { topics, sources };
}

async function main() {
  const { dateStr, jst } = nowJSTParts();
  const editionLabel = KIND === 'evening' ? '夕刊' : '朝刊';
  console.log(`=== ${dateStr} ${editionLabel} 生成開始（単一コール方式）===`);

  const newsRaw = await fs.readFile('news.json', 'utf8');
  const news = JSON.parse(newsRaw);
  const cutoff = Date.now() - HOURS_WINDOW * 3600 * 1000;
  const recent = news.items.filter((it) => it.pubDate >= cutoff);
  console.log(`直近${HOURS_WINDOW}時間の記事: ${recent.length}件`);

  // 候補を作る（トピックごとに最大ARTICLES_PER_TOPIC件、最新順）→ 類似削除 → 過去編集と重複除外
  const rawCandidates = [];
  for (const t of news.topics) {
    const sorted = recent.filter((it) => it.topicId === t.id).sort((a, b) => b.pubDate - a.pubDate).slice(0, ARTICLES_PER_TOPIC);
    rawCandidates.push(...sorted);
  }
  const deduped = dedupeCandidates(rawCandidates);
  const prev = await getPreviouslyFeatured(dateStr, KIND, 4);
  const candidates = filterAgainstPrevious(deduped, prev);
  console.log(`候補記事: raw=${rawCandidates.length} → 類似削除後 ${deduped.length} → 既出除外後 ${candidates.length}（過去${prev.urls.size}URL、${prev.titles.length}タイトル参照）`);

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

  // 投票履歴から好み集計
  let preferences = null;
  try {
    const vraw = await fs.readFile('paper/votes.json', 'utf8');
    const vdata = JSON.parse(vraw);
    preferences = aggregatePreferences(vdata.votes || {});
    const tCount = Object.keys(preferences.topics).length;
    const sCount = Object.keys(preferences.sources).length;
    console.log(`好み集計: トピック${tCount}件、出典${sCount}件の評価`);
  } catch {
    console.log('好み: votes.jsonなし（フラットに生成）');
  }

  // 一括生成
  const res = await callWorkerWithRetry(
    { type: 'edition_oneshot', kind: KIND, date: dateStr, articles: articlesForApi, preferences },
    `紙面一括生成（候補${articlesForApi.length}件）`
  );

  if (!res.ok) {
    console.error('紙面生成失敗。終了。');
    process.exit(1);
  }

  // articleIdx の重複を後処理で排除（Gemini が守らなかった場合のsafety net）
  const usedIdx = new Set();
  if (res.top && typeof res.top.articleIdx === 'number') usedIdx.add(res.top.articleIdx);
  res.mid = (res.mid || []).filter((s) => {
    if (typeof s.articleIdx !== 'number') return false;
    if (usedIdx.has(s.articleIdx)) return false;
    usedIdx.add(s.articleIdx);
    return true;
  });
  res.briefs = (res.briefs || []).filter((s) => {
    if (typeof s.articleIdx !== 'number') return false;
    if (usedIdx.has(s.articleIdx)) return false;
    usedIdx.add(s.articleIdx);
    return true;
  });
  console.log(`重複排除後: mid=${res.mid.length}本、briefs=${res.briefs.length}本`);

  // 組み立て
  const topArticle = res.top && candidates[res.top.articleIdx];
  const topStory = (res.top && topArticle) ? {
    title: res.top.title,
    body: res.top.body,
    topicId: topArticle.topicId,
    topicName: topArticle.topicName,
    color: topArticle.topicColor,
    references: [makeRef(topArticle)],
  } : null;

  const midStories = (res.mid || []).map((s) => {
    const a = candidates[s.articleIdx];
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

  const briefs = (res.briefs || []).map((s) => {
    const a = candidates[s.articleIdx];
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

  // 写真取得（top + mid のOG画像を並列）
  console.log('→ OG画像取得（top + mid）');
  async function fetchOg(url) {
    if (!url) return null;
    try {
      const r = await callWorkerOnce({ type: 'fetch_meta', url });
      return (r && r.ok) ? (r.ogImage || null) : null;
    } catch { return null; }
  }
  // 並列フェッチ → 結果を配列で受け取り → 同期的に代入
  const ogUrls = [];
  ogUrls.push(topStory && topArticle?.url ? topArticle.url : null);
  midStories.forEach((m, i) => {
    const a = candidates[(res.mid || [])[i]?.articleIdx];
    ogUrls.push(a?.url || null);
  });
  const ogResults = await Promise.all(ogUrls.map((u) => u ? fetchOg(u) : Promise.resolve(null)));
  // 代入
  if (topStory && ogResults[0]) topStory.ogImage = ogResults[0];
  for (let i = 0; i < midStories.length; i++) {
    const og = ogResults[i + 1];
    if (og) midStories[i].ogImage = og;
  }
  const ogCount = ogResults.filter(Boolean).length;
  console.log(`  OG画像取得: ${ogCount}/${ogUrls.filter(Boolean).length}件 (top=${!!ogResults[0]})`);

  const edition = {
    type: KIND,
    date: dateStr,
    generatedAt: jst.toISOString().replace('Z', '+09:00'),
    lead: res.lead || '',
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
  console.log(`完了: lead=${edition.lead ? 'あり' : 'なし'} / トップ=${topStory ? 'あり' : 'なし'} / 中段${midStories.length}本 / ベタ${briefs.length}本`);
}

main().catch((e) => { console.error(e); process.exit(1); });
