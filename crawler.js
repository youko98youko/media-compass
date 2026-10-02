// 既存メディアの簡易クロール（STEP 0-2 既存メディア理解／3.2）
// サイトURLから記事一覧（sitemap優先・なければトップページのリンク）を取得し、
// 代表的な記事のタイトル・見出し構成を取得する。プロトタイプ用の簡易実装。
const dns = require('dns').promises;
const net = require('net');
const cheerio = require('cheerio');

const UA = 'MediaCompassBot/0.1 (+prototype; site analysis)';
const MAX_SAMPLE_PAGES = 20;
const MAX_URLS = 2000;
const CONCURRENCY = 4;
const TOTAL_BUDGET_MS = 45000;

// ---- SSRF対策：公開サイトのみ取得する（内部ネットワーク・localhost等は拒否） ----
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
    return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
  }
  return true;
}

async function assertPublicUrl(u) {
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('http/https以外のURLは取得できません');
  if (u.port && !['80', '443'].includes(u.port)) throw new Error('標準ポート以外のURLは取得できません');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new Error('公開されているサイトのみ分析できます');
  }
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('公開されているサイトのみ分析できます');
}

async function fetchText(url, { timeoutMs = 8000, maxBytes = 1500000 } = {}) {
  let current = new URL(url);
  for (let hop = 0; hop < 4; hop++) {
    await assertPublicUrl(current);
    const res = await fetch(current, {
      redirect: 'manual',
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location'), current);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get('content-type') || '';
    if (!/(html|xml|text\/plain)/i.test(type)) throw new Error(`対象外のコンテンツ形式（${type || '不明'}）`);
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      chunks.push(value);
      if (size > maxBytes) { reader.cancel().catch(() => {}); break; }
    }
    return { text: Buffer.concat(chunks).toString('utf-8'), finalUrl: current.toString() };
  }
  throw new Error('リダイレクトが多すぎます');
}

function normalizeSiteUrl(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('サイトURLが未入力です');
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  return new URL(s);
}

// ---- robots.txt ----
function parseRobots(text) {
  const disallow = [];
  const sitemaps = [];
  let applies = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (key === 'user-agent') applies = m[2].trim() === '*';
    else if (key === 'disallow' && applies && m[2].trim()) disallow.push(m[2].trim());
    else if (key === 'sitemap') sitemaps.push(m[2].trim());
  }
  return { disallow, sitemaps };
}

// ---- sitemap ----
const SKIP_SITEMAP = /(category|tag|author|page|product|taxonomy|attachment|image|video)/i;
const PREFER_SITEMAP = /(post|article|blog|news|column|entry)/i;

async function readSitemap(url, depth, urls, notes) {
  if (urls.length >= MAX_URLS) return;
  let text;
  try { ({ text } = await fetchText(url, { timeoutMs: 10000, maxBytes: 4000000 })); } catch (e) { return; }
  const $ = cheerio.load(text, { xmlMode: true });
  const children = $('sitemapindex > sitemap > loc').map((_, el) => $(el).text().trim()).get();
  if (children.length && depth < 2) {
    const ordered = [...children].sort((a, b) => (PREFER_SITEMAP.test(b) ? 1 : 0) - (PREFER_SITEMAP.test(a) ? 1 : 0))
      .filter((c) => !SKIP_SITEMAP.test(c) || PREFER_SITEMAP.test(c)).slice(0, 8);
    for (const c of ordered) await readSitemap(c, depth + 1, urls, notes);
    return;
  }
  $('urlset > url').each((_, el) => {
    if (urls.length >= MAX_URLS) return;
    urls.push({ url: $(el).find('loc').first().text().trim(), lastmod: $(el).find('lastmod').first().text().trim() || null });
  });
}

const NON_ARTICLE = /(\/(category|categories|tag|tags|author|authors|page|feed|wp-content|wp-json|wp-admin|search|cart|checkout|login|contact|privacy|company|about|inquiry|sitemap)(\/|$)|\.(jpg|jpeg|png|gif|webp|svg|pdf|zip|css|js|xml|ico)(\?|$)|[?&](s|p|page_id|paged)=)/i;

function isArticleLike(u, origin) {
  let x;
  try { x = new URL(u); } catch { return false; }
  if (x.host !== origin.host) return false;
  const path = x.pathname.replace(/\/+$/, '');
  if (!path || path === '') return false;
  if (NON_ARTICLE.test(x.pathname + x.search)) return false;
  return true;
}

function cleanTitle(t) {
  return String(t || '').replace(/\s+/g, ' ').replace(/\s*[|｜–—]\s*[^|｜–—]{1,30}$/, '').trim();
}

function extractPage(html, url) {
  const $ = cheerio.load(html);
  $('script,style,noscript,nav,header,footer,aside').remove();
  const title = cleanTitle($('meta[property="og:title"]').attr('content') || $('title').first().text() || $('h1').first().text());
  const description = ($('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || '').trim().slice(0, 160);
  const texts = (sel, n) => $(sel).map((_, el) => $(el).text().replace(/\s+/g, ' ').trim()).get().filter((s) => s && s.length < 120).slice(0, n);
  const main = $('article').length ? $('article').first() : $('main').length ? $('main').first() : $('body');
  const chars = main.text().replace(/\s+/g, ' ').trim().length;
  return { url, title, description, h2: texts('h2', 12), h3: texts('h3', 8), chars };
}

async function pool(items, size, fn, deadline) {
  const results = [];
  let i = 0;
  const workers = Array.from({ length: size }, async () => {
    while (i < items.length && Date.now() < deadline) {
      const item = items[i++];
      results.push(await fn(item));
    }
  });
  await Promise.all(workers);
  return results.filter(Boolean);
}

// メイン：サイトを簡易クロールして結果を返す。失敗時は { ok:false, error } を返す（例外は投げない）。
async function crawlSite(siteUrl) {
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const notes = [];
  let origin;
  try {
    origin = normalizeSiteUrl(siteUrl);
  } catch (e) {
    return { ok: false, error: e.message };
  }

  // 入力されたURL自体（トップ・カテゴリページ等）を起点にする（到達確認とリンク収集）
  // 例：https://example.com/media/archives/category/foo → 「/media」配下の記事を対象にする
  const segs = origin.pathname.split('/').filter(Boolean);
  const basePrefix = segs[0] ? `/${segs[0]}/` : null;
  // カテゴリ/アーカイブ等の手前までを「メディアの範囲」とする（例：/seomaster/daily_news/）
  const cut = segs.findIndex((x) => /^(archives|category|categories|tag|tags|page|author)$/i.test(x));
  const scopeSegs = cut > 0 ? segs.slice(0, cut) : cut === -1 && segs.length >= 2 ? segs.filter((x) => !/\.html?$/i.test(x)) : [];
  const scopePrefix = scopeSegs.length >= 2 ? `/${scopeSegs.join('/')}/` : null;
  let home;
  try {
    home = await fetchText(origin.href);
    origin = new URL(home.finalUrl);
  } catch (e) {
    return { ok: false, error: `サイトにアクセスできませんでした（${e.message}）` };
  }

  // robots.txt
  let robots = { disallow: [], sitemaps: [] };
  try { robots = parseRobots((await fetchText(`${origin.origin}/robots.txt`, { timeoutMs: 5000, maxBytes: 200000 })).text); } catch (e) { /* なくても続行 */ }
  const allowed = (u) => {
    const p = new URL(u).pathname;
    return !robots.disallow.some((d) => p.startsWith(d));
  };

  // 記事URLの収集：sitemap優先、なければトップページのリンク
  const entries = [];
  const sitemapCandidates = [...new Set([...robots.sitemaps, ...(basePrefix ? [`${origin.origin}${basePrefix}sitemap.xml`, `${origin.origin}${basePrefix}wp-sitemap.xml`] : []), `${origin.origin}/sitemap.xml`, `${origin.origin}/wp-sitemap.xml`, `${origin.origin}/sitemap_index.xml`])];
  let discoveredBy = 'sitemap';
  for (const sm of sitemapCandidates) {
    await readSitemap(sm, 0, entries, notes);
    if (entries.length) break;
  }
  if (!entries.length) {
    discoveredBy = 'links';
    const $ = cheerio.load(home.text);
    const seen = new Set();
    $('a[href]').each((_, el) => {
      try {
        const u = new URL($(el).attr('href'), origin);
        u.hash = '';
        if (!seen.has(u.href)) { seen.add(u.href); entries.push({ url: u.href, lastmod: null }); }
      } catch { /* 不正なhrefは無視 */ }
    });
    notes.push('sitemapが見つからなかったため、トップページのリンクから記事を推定しました（記事数は実際より少なく出る可能性があります）');
  }

  const seenUrl = new Set();
  let articles = entries.filter((e) => {
    if (seenUrl.has(e.url) || !isArticleLike(e.url, origin) || !allowed(e.url)) return false;
    seenUrl.add(e.url);
    return true;
  });
  // サブディレクトリ運用のメディアは、そのディレクトリ配下の記事に絞る
  for (const prefix of [scopePrefix, basePrefix]) {
    if (!prefix) continue;
    const scoped = articles.filter((e) => new URL(e.url).pathname.startsWith(prefix));
    if (scoped.length >= 3) { articles = scoped; break; }
  }
  // メディアのトップページ自体は記事ではない
  articles = articles.filter((e) => ![scopePrefix, basePrefix].includes(new URL(e.url).pathname.replace(/\/?$/, '/')) && !/\/index\.html?$/.test(e.url));
  if (!articles.length) {
    return { ok: false, error: '記事ページを見つけられませんでした。sitemapが公開されていないか、サイトの構造が簡易クロールに対応していない可能性があります' };
  }

  // 新しい順（lastmodがあれば）に代表記事をサンプリングして取得
  const sorted = [...articles].sort((a, b) => (b.lastmod || '').localeCompare(a.lastmod || ''));
  const sample = sorted.slice(0, MAX_SAMPLE_PAGES);
  const pages = await pool(sample, CONCURRENCY, async (e) => {
    try {
      const { text, finalUrl } = await fetchText(e.url, { timeoutMs: 8000 });
      const p = extractPage(text, finalUrl);
      p.lastmod = e.lastmod;
      return p.title ? p : null;
    } catch { return null; }
  }, deadline);

  if (!pages.length) return { ok: false, error: '記事ページの内容を取得できませんでした' };
  if (pages.every((p) => !p.h2.length)) notes.push('見出し(H2)が取得できませんでした。JavaScriptで描画されるサイトの場合、見出し構成は分析に反映されません');
  if (pages.length < sample.length) notes.push(`${sample.length}本中${pages.length}本のみ取得できました`);

  return { ok: true, origin: origin.origin, discoveredBy, articlesCount: articles.length, sampledCount: pages.length, pages, notes };
}

module.exports = { crawlSite };
