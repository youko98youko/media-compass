// Google Search Console 連携（OAuth 2.0 認可コードフロー＋Search Console API）
// GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET が未設定の間は無効（画面は従来のデモ表示のまま）。
// 取得するのは読み取り専用の権限のみ（webmasters.readonly）。
// ※プロトタイプのため、トークンはサーバーのメモリ上にのみ保持する（本番では暗号化してDBに保存する想定）。
const crypto = require('crypto');

const AUTH_URL = process.env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const REVOKE_URL = process.env.GOOGLE_REVOKE_URL || 'https://oauth2.googleapis.com/revoke';
const GSC_API = process.env.GSC_API_BASE || 'https://www.googleapis.com/webmasters/v3';
const SCOPES = ['https://www.googleapis.com/auth/webmasters.readonly', 'openid', 'email'];

function enabled() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

function redirectUri() {
  return process.env.GOOGLE_REDIRECT_URI || `http://localhost:${process.env.PORT || 3000}/api/gsc/callback`;
}

// CSRF対策：認可リクエストごとに使い捨ての state を発行し、コールバックで照合する
const pendingStates = new Map();
function buildAuthUrl(mediaId) {
  for (const [k, v] of pendingStates) if (v.exp < Date.now()) pendingStates.delete(k);
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, { mediaId, exp: Date.now() + 10 * 60 * 1000 });
  const p = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline', // refresh_token を得るため
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `${AUTH_URL}?${p}`;
}

function consumeState(state) {
  const v = pendingStates.get(state);
  pendingStates.delete(state);
  return v && v.exp >= Date.now() ? v.mediaId : null;
}

async function tokenRequest(params) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, ...params }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google認証エラー: ${data.error_description || data.error || res.status}`);
  return data;
}

function emailFromIdToken(idToken) {
  try {
    return JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf-8')).email || null;
  } catch { return null; }
}

// 認可コードをトークンに交換し、メディアに保存する接続情報を返す
async function exchangeCode(code) {
  const t = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: redirectUri() });
  if (!t.refresh_token) throw new Error('refresh_token が取得できませんでした。Googleアカウントの「サードパーティのアクセス」から一度解除して、もう一度連携してください');
  return {
    tokens: { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Date.now() + (t.expires_in || 3600) * 1000 },
    email: emailFromIdToken(t.id_token),
    siteUrl: null,
    connectedAt: new Date().toISOString(),
  };
}

async function getAccessToken(gsc) {
  if (gsc.tokens.expires_at - 60000 > Date.now()) return gsc.tokens.access_token;
  const t = await tokenRequest({ refresh_token: gsc.tokens.refresh_token, grant_type: 'refresh_token' });
  gsc.tokens.access_token = t.access_token;
  gsc.tokens.expires_at = Date.now() + (t.expires_in || 3600) * 1000;
  return gsc.tokens.access_token;
}

async function gscFetch(gsc, path, body) {
  const token = await getAccessToken(gsc);
  const res = await fetch(`${GSC_API}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Search Console APIエラー(${res.status}): ${data.error?.message || ''}`.trim());
  return data;
}

async function listSites(gsc) {
  const data = await gscFetch(gsc, '/sites');
  return (data.siteEntry || []).filter((s) => s.permissionLevel !== 'siteUnverifiedUser');
}

const stripWww = (h) => h.replace(/^www\./, '');

// 入力されたサイトURLに対応するGSCプロパティを、近い順に並べる
// （URLプレフィックス：入力URLを含む最長のもの → ドメインプロパティ → それ以外）
function rankSites(sites, inputUrl) {
  let host = '';
  let path = '/';
  try {
    const u = new URL(/^https?:\/\//i.test(inputUrl) ? inputUrl : `https://${inputUrl}`);
    host = stripWww(u.hostname);
    path = u.pathname;
  } catch { /* 入力が不正でも一覧は返す */ }

  const scored = sites.map((s) => {
    let score = 0;
    if (s.siteUrl.startsWith('sc-domain:')) {
      const d = stripWww(s.siteUrl.slice('sc-domain:'.length));
      if (host && (host === d || host.endsWith(`.${d}`))) score = 1;
    } else {
      try {
        const u = new URL(s.siteUrl);
        if (stripWww(u.hostname) === host) score = path.startsWith(u.pathname) ? 2 + u.pathname.length / 1000 : 0.5;
      } catch { /* 無視 */ }
    }
    return { ...s, matched: score > 0, score };
  });
  return scored.sort((a, b) => b.score - a.score).map(({ score, ...rest }) => rest);
}

const ymd = (d) => d.toISOString().slice(0, 10);

// 過去28日（GSCのデータは2〜3日遅れるため、終了日は3日前）の検索実績を取得して要約する
async function fetchSummary(gsc) {
  if (!gsc.siteUrl) throw new Error('GSCのサイトが選択されていません');
  const end = new Date(Date.now() - 3 * 86400000);
  const start = new Date(end.getTime() - 27 * 86400000);
  const base = { startDate: ymd(start), endDate: ymd(end) };
  const q = (dimensions, rowLimit) => gscFetch(gsc, `/sites/${encodeURIComponent(gsc.siteUrl)}/searchAnalytics/query`, { ...base, dimensions, rowLimit });
  const [byQuery, byPage, byQueryPage] = await Promise.all([q(['query'], 25), q(['page'], 30), q(['query', 'page'], 250)]);

  const round = (rows, keyNames) => (rows || []).map((r) => {
    const o = { clicks: r.clicks, impressions: r.impressions, ctr: Math.round(r.ctr * 1000) / 10, position: Math.round(r.position * 10) / 10 };
    keyNames.forEach((k, i) => { o[k] = r.keys[i]; });
    return o;
  });

  // カニバリゼーション候補：同じクエリで複数ページが表示されているもの
  const byQ = new Map();
  for (const r of round(byQueryPage.rows, ['query', 'page'])) {
    if (r.impressions < 5) continue;
    if (!byQ.has(r.query)) byQ.set(r.query, []);
    byQ.get(r.query).push(r);
  }
  const cannibal = [...byQ.entries()]
    .filter(([, pages]) => pages.length >= 2)
    .map(([query, pages]) => ({ query, impressions: pages.reduce((n, p) => n + p.impressions, 0), pages: pages.sort((a, b) => b.impressions - a.impressions).slice(0, 4).map((p) => ({ page: p.page, position: p.position, clicks: p.clicks })) }))
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 8);

  return {
    real: true,
    siteUrl: gsc.siteUrl,
    period: `${base.startDate} 〜 ${base.endDate}`,
    topQueries: round(byQuery.rows, ['query']),
    topPages: round(byPage.rows, ['page']),
    cannibalCandidates: cannibal,
  };
}

async function revoke(gsc) {
  try {
    await fetch(REVOKE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: gsc.tokens.refresh_token }),
      signal: AbortSignal.timeout(10000),
    });
  } catch { /* 失敗してもサーバー側のトークンは破棄する */ }
}

module.exports = { enabled, redirectUri, buildAuthUrl, consumeState, exchangeCode, listSites, rankSites, fetchSummary, revoke };
