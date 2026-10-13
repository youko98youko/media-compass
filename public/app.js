// メディアコンパス極 ― プロトタイプ フロントエンド
// 本番のUI仕様ではなく、UX検証用の実装です（仕様書「画面一覧・画面遷移」は未定のため仮の画面構成）。

const app = document.getElementById('app');

const state = {
  aiEnabled: false,
  themes: [],
  sessionId: null,
  theme: null,
  availablePrimaryInfo: [],
  missingInfoHint: '',
  hearing: { history: [], question: null, questionNumber: 0, maxQuestions: 3, done: false, loading: false },
  outline: null,
  article: null,
  lastMode: null,
  publishInfo: null,
  screen: 'mediaState',
  fixArticle: null,
  monitoring: null,
  // ここから：起点（メディア状態判定〜方向性設計）用の状態【新設・v2】
  mediaId: null,
  mediaState: null,
  siteUrlInput: '',
  businessInfo: null,
  existingAnalysis: null,
  newHearing: { history: [], question: null, questionNumber: 0, maxQuestions: 4, done: false, loading: false },
  direction: null,
  gscConnected: false,
  gscDemo: false, // デモ連携を選んだか（実際のGoogle連携とは別）
  gscReconnect: false, // 連携済みでも、別のアカウントで連携し直すか
  gscContext: 'analyze', // GSC連携の起点：'analyze'（分析の流れ）| 'settings'（設定画面）
  wordpressConnected: false,
  wordpressReal: false, // 実際のWordPressに接続しているか（デモ接続とは別）
  wordpressSiteUrl: '',
  wpConnectContext: null, // 'publish' | 'settings'
  accountsEnabled: false, // アカウント機能（ローカル版のみ）が使えるか
  user: null, // ログイン中のアカウント { id, username }
  authMode: 'login', // 'login' | 'register'
  measuresFilter: 'all',
  registeredMedia: null, // 選んだ（登録した）メディア { id, name, siteUrl }
  mediaLinks: [], // 登録済みのリンク（記事のボタンのリンク先） { id, label, url }
  mediaDefaultLinkId: null,
  rewriteMeasureId: null, // リライト案の編集中の施策ID
  rewriteArticle: null, // 元の記事 { wpId, title, url }
};

const STEPS = ['テーマ選定', '一次情報', 'AIヒアリング', '記事構成・生成', '装飾・確認', '公開'];
function stepIndexFor(screen) {
  return { dashboard: -1, themeDetail: 0, primaryInfo: 1, hearing: 2, outline: 3, generating: 3, articleEdit: 4, published: 5 }[screen] ?? -1;
}

// ログインの有効期限切れ（未ログイン）を、どの画面の通信でも、共通で扱う：
// サーバーが 401 を返したら、ログイン画面へ戻して案内を出す（各画面で、メッセージが生のまま出ないようにする）。
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const res = await nativeFetch(input, init);
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  if (res.status === 401 && url.startsWith('/api/') && !url.startsWith('/api/auth/')) {
    state.user = null;
    renderAuth('ログインの有効期限が切れました。もう一度ログインしてください');
    const e = new Error('ログインが必要です');
    e.authExpired = true;
    e.handled = true;
    throw e;
  }
  if (res.status === 404 && url.startsWith('/api/')) {
    // サーバーが再起動されると、作業中の内容（メディアの分析・記事作成）は消える。画面に残っていても、案内して最初に戻す
    const data = await res.clone().json().catch(() => ({}));
    if (data.error === 'media profile not found' || data.error === 'session not found') {
      renderWorkLost();
      const e = new Error('作業内容が見つかりません');
      e.authExpired = true; // 画面は切り替え済み。呼び出し元では、追加のエラー表示をしない
      e.handled = true;
      throw e;
    }
  }
  return res;
};

function renderWorkLost() {
  state.screen = 'workLost';
  shell(`
    <div class="wrap" style="max-width:640px;">
      <div class="screen-head">
        <div class="eyebrow">お知らせ</div>
        <h1>作業内容が見つかりませんでした</h1>
      </div>
      <div class="card">
        <div class="missing-box"><div class="h">サーバーが再起動されたため、作業中の内容が消えました</div>メディアの分析や、作成中の記事は、サーバーの再起動で消えます（ログインは、そのままです）。お手数ですが、最初の画面からやり直してください。<br>GSCやWordPressの連携は、保存されているので、もう一度、入力する必要はありません。</div>
        <div class="btn-row"><button class="btn navy" id="work-lost-restart">最初の画面に戻る</button></div>
      </div>
    </div>
  `, { active: false, nav: false });
  document.getElementById('work-lost-restart').addEventListener('click', () => location.reload());
}

async function api(path, opts) {
  let res;
  try {
    res = await fetch(path, {
      method: opts && opts.body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json' },
      body: opts && opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch (networkErr) {
    if (networkErr && networkErr.authExpired) throw networkErr; // ログイン切れ・作業内容の消失は、共通処理で画面を切り替え済み
    throw new Error('NO_SERVER');
  }
  if (res.status === 401) {
    // ログインしていない、または有効期限切れ（サーバー再起動など）。ログイン画面へ戻す
    state.user = null;
    renderAuth('ログインが必要です。ログインしてください');
    const e = new Error('login_required');
    e.authExpired = true;
    throw e;
  }
  if (!res.ok) throw new Error(`API error ${res.status} on ${path}`);
  return res.json();
}

function showFatalError(err) {
  if (err && err.authExpired) return; // ログイン画面に切り替え済み
  const isNoServer = err && err.message === 'NO_SERVER';
  app.innerHTML = `
    <div class="wrap" style="max-width:640px; padding-top:60px;">
      <div class="card" style="border-left:4px solid var(--danger);">
        <h3 style="color:var(--danger);">${isNoServer ? 'サーバーに接続できません' : 'エラーが発生しました'}</h3>
        ${isNoServer ? `
          <p style="font-size:13px; color:var(--sub);">
            このプロトタイプは、HTMLファイルを直接ブラウザで開くだけでは動きません。<br>
            付属のサーバーを起動してから、<b>http://localhost:3000</b> を開いてください。
          </p>
          <div style="background:#f5f7fa; border-radius:8px; padding:12px 14px; font-size:12.5px; font-family:monospace; margin-top:10px; white-space:pre;">cd media-compass-saas-prototype
npm install
npm start</div>
          <p style="font-size:12px; color:var(--sub); margin-top:10px;">起動後、ターミナルに表示される案内の通り <b>http://localhost:3000</b> をブラウザのアドレス欄に入力して開いてください（file:// のままでは動作しません）。</p>
        ` : `<p style="font-size:13px; color:var(--sub);">${esc(err.message || String(err))}</p>`}
        <div class="btn-row"><button class="btn navy" onclick="location.reload()">再読み込み</button></div>
      </div>
    </div>
  `;
}

function toast(msg) {
  let t = document.querySelector('.toast');
  if (!t) {
    t = document.createElement('div');
    t.className = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 2600);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------
// ブラウザの戻る/進むボタン対応【新設】
// 画面が切り替わるたびに、その時点のstateごと履歴に積む。
// popstateで戻ってきたら、そのstateを復元して同じ画面を再描画する（サーバーへの再取得は行わない）。
// ---------------------------------------------------------------
let isRestoringHistory = false;

function pushHistory() {
  if (isRestoringHistory) return;
  const snapshot = JSON.parse(JSON.stringify(state));
  history.pushState({ screen: state.screen, snapshot }, '', location.href);
}

// ---------------------------------------------------------------
// 画像プレースホルダー生成（画像生成APIの代わりの仮実装。UX検証用）
// ---------------------------------------------------------------
const PALETTES = [
  ['#1f3a5f', '#3a6ea5'], ['#b9711f', '#e0a458'], ['#2f6a43', '#5ea87d'],
  ['#5b3a8f', '#8a6bc4'], ['#8f3a4a', '#c46b7b'],
];
function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }
function pickEmoji(alt) {
  const map = [
    [/色|カラー/, '🎨'], [/費用|価格|相場|料金/, '💰'], [/期間|時期|年/, '📅'],
    [/事例|実績|お客様/, '🏠'], [/比較/, '📊'], [/注意|失敗/, '⚠️'],
  ];
  for (const [re, emo] of map) if (re.test(alt)) return emo;
  return '🖼️';
}
function placeholderImageDataUri(alt, w, h) {
  const [c1, c2] = PALETTES[hashStr(alt) % PALETTES.length];
  const emoji = pickEmoji(alt);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/>
    </linearGradient></defs>
    <rect width="${w}" height="${h}" rx="14" fill="url(#g)"/>
    <text x="50%" y="46%" font-size="${Math.min(w, h) * 0.32}" text-anchor="middle" dominant-baseline="middle">${emoji}</text>
    <text x="50%" y="82%" font-size="14" fill="rgba(255,255,255,0.85)" text-anchor="middle" font-family="sans-serif">${esc(alt).slice(0, 28)}</text>
  </svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

// ---------------------------------------------------------------
// 共通シェル
// ---------------------------------------------------------------
function shell(innerHtml, { active = true, nav = true } = {}) {
  const idx = stepIndexFor(state.screen);
  const stepperHtml = active
    ? `<div class="stepper">${STEPS.map((s, i) => `<span class="st ${i < idx ? 'done' : ''} ${i === idx ? 'active' : ''}"><span class="n">${i < idx ? '✓' : i + 1}</span>${s}</span>${i < STEPS.length - 1 ? '<span class="arrow">→</span>' : ''}`).join('')}</div>`
    : '';
  const navHtml = nav ? `
      <div class="nav">
        <span class="${state.screen === 'dashboard' ? 'on' : ''}" data-nav="dashboard">ホーム</span>
        <span class="${state.screen === 'direction' ? 'on' : ''}" data-nav="direction">メディアの方向性</span>
        ${state.accountsEnabled ? `<span class="${['measures', 'auth'].includes(state.screen) ? 'on' : ''}" data-nav="measures">施策管理</span>` : ''}
        <span class="${['articles', 'articlesPick', 'rewriteResult'].includes(state.screen) ? 'on' : ''}" data-nav="monitoring">記事一覧・監視</span>
        <span class="${state.screen === 'settings' ? 'on' : ''}" data-nav="settings">設定</span>
      </div>` : state.accountsEnabled ? `
      <div class="nav">
        <span class="${['measures', 'auth'].includes(state.screen) ? 'on' : ''}" data-nav="measures">施策管理</span>
      </div>` : ''; // 最初の画面などメニューを出さない画面でも、アカウント機能（施策管理）への入口だけは出す
  app.innerHTML = `
    <div class="appbar">
      <span class="brand">メディアコンパス極</span>
      ${navHtml}
      ${state.user ? `<span class="acct">👤 ${esc(state.user.username)} <a href="#" data-logout>ログアウト</a></span>` : ''}
      <span class="mode-badge ${state.aiEnabled ? 'ai' : 'sim'}"><span class="dot"></span>${state.aiEnabled ? 'AI連携中（ChatGPT）' : 'シミュレーションモード'}</span>
    </div>
    ${stepperHtml}
    ${innerHtml}
  `;
  app.querySelectorAll('[data-logout]').forEach((a) => a.addEventListener('click', async (e) => {
    e.preventDefault();
    await fetch('/api/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    location.reload();
  }));
  app.querySelectorAll('[data-nav]').forEach((elm) => {
    elm.addEventListener('click', () => {
      if (elm.dataset.nav === 'dashboard') renderDashboard();
      if (elm.dataset.nav === 'monitoring') (state.accountsEnabled && state.user ? renderArticles() : renderMonitoring()); // ローカル版は、投稿済み記事の一覧とリライト
      if (elm.dataset.nav === 'direction') renderDirectionSummary();
      if (elm.dataset.nav === 'settings') renderSettings();
      if (elm.dataset.nav === 'measures') (state.user ? renderMeasures() : renderAuth());
    });
  });
}

// ---------------------------------------------------------------
// STEP 0-1: メディア状態判定【新設・v2】
// ---------------------------------------------------------------
function renderMediaState() {
  state.screen = 'mediaState';
  shell(`
    <div class="wrap">
      <div class="screen-head">
        <div class="eyebrow">STEP 0-1 ・ メディア状態判定</div>
        <h1>まず、状況を教えてください</h1>
        <p>既存メディアを分析するか、新しくメディアを構築するかによって、この後の進め方が変わります（3.1）。</p>
      </div>
      <div class="card clickable" id="pick-existing">
        <h3>既存メディアを分析する</h3>
        <div style="font-size:12.5px;color:var(--sub);">サイトURL・Google Search Consoleのデータから、現状を分析します。</div>
      </div>
      <div class="card" id="pick-new" style="opacity:.6;cursor:not-allowed;">
        <h3>新しくメディアを構築する <span class="pill grey">準備中</span></h3>
        <div style="font-size:12.5px;color:var(--sub);">事業内容についてAIがヒアリングし、ゼロから方向性を設計します。（既存メディアの構築が終わってから、設計に着手します）</div>
      </div>
      <div style="font-size:11px;color:var(--sub);margin-top:6px;">※新規／既存の判定はユーザーが手動で選択します（自動判定はしません）。</div>
    </div>
  `, { active: false, nav: false });
  document.getElementById('pick-existing').addEventListener('click', () => pickMediaState('existing'));
  document.getElementById('pick-new').addEventListener('click', () => toast('新しくメディアを構築する機能は、準備中です'));
  pushHistory();
}

// ---------------------------------------------------------------
// 既存メディアを分析する：「新たにメディアを登録」／「登録済みのメディア」の2択
// 登録したメディア（名前とサイトURL）は、ログインしているアカウントごとに保存される。
// ---------------------------------------------------------------
let registeredMediaCache = [];
let mediaEditingId = null;
let mediaDeletingId = null;

async function mediaApi(method, path, body) {
  const res = await fetch(path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.error || '処理に失敗しました');
    e.data = data;
    throw e;
  }
  return data;
}

const fieldStyle = 'width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:8px;font-size:13px;font-family:inherit;box-sizing:border-box;';

// 2択の画面
async function renderMediaChoice() {
  state.screen = 'mediaChoice';
  shell(`<div class="wrap"><div class="loading-box"><div class="spinner"></div>読み込み中…</div></div>`, { active: false, nav: false });
  try {
    ({ media: registeredMediaCache } = await mediaApi('GET', '/api/registered-media'));
  } catch (e) {
    if (!e.authExpired) showFatalError(e);
    return;
  }
  const n = registeredMediaCache.length;
  shell(`
    <div class="wrap">
      <div class="screen-head">
        <div class="eyebrow">STEP 0-1 ・ 既存メディアの分析</div>
        <h1>どのメディアを分析しますか？</h1>
        <p>分析するメディア（Webサイト）を、新しく登録するか、登録済みのものから選びます。登録したメディアは、あなたのアカウントに保存されます。</p>
      </div>
      <div class="card clickable" id="choice-new">
        <h3>新たにメディアを登録</h3>
        <div style="font-size:12.5px;color:var(--sub);">メディア名とサイトURLを登録して、分析を始めます。</div>
      </div>
      <div class="card ${n ? 'clickable' : ''}" id="choice-registered" ${n ? '' : 'style="opacity:.6;cursor:not-allowed;"'}>
        <h3>登録済みのメディア <span class="pill ${n ? 'ok' : 'grey'}">${n}件</span></h3>
        <div style="font-size:12.5px;color:var(--sub);">${n ? '登録済みのメディアから選んで、分析を始めます。' : 'まだ登録されたメディアがありません。先に、「新たにメディアを登録」から登録してください。'}</div>
      </div>
      <div class="btn-row"><button class="btn ghost" id="choice-back">← 戻る</button></div>
    </div>
  `, { active: false });
  document.getElementById('choice-new').addEventListener('click', renderMediaRegister);
  document.getElementById('choice-registered').addEventListener('click', () => { if (n) renderMediaList(); else toast('登録済みのメディアはありません'); });
  document.getElementById('choice-back').addEventListener('click', renderMediaState);
  pushHistory();
}

// 新たにメディアを登録する画面
function renderMediaRegister() {
  state.screen = 'mediaRegister';
  shell(`
    <div class="wrap">
      <div class="screen-head">
        <div class="eyebrow">STEP 0-1 ・ 既存メディアの分析</div>
        <h1>新たにメディアを登録</h1>
        <p>分析するメディアの名前と、サイトのURLを登録します。登録後、そのまま分析に進めます。</p>
      </div>
      <div class="card">
        <div class="field-grid">
          <div class="k">メディア名</div><div class="v"><input id="reg-name" type="text" maxlength="60" placeholder="例：DCCがお届けする最新SEOデイリーニュース" style="${fieldStyle}"></div>
          <div class="k">サイトURL</div><div class="v"><input id="reg-url" type="text" placeholder="https://example.co.jp/" style="${fieldStyle}"></div>
        </div>
        <div style="font-size:11px;color:var(--sub);margin:6px 0 4px;">サイトのトップページのURLを入れます。サブディレクトリで運用しているメディアは、そのディレクトリのURL（例：https://example.co.jp/media/）を入れてください。</div>
        <div id="reg-error" style="color:var(--danger);font-size:12.5px;margin:6px 0;"></div>
        <div class="btn-row">
          <button class="btn navy" id="reg-submit">登録して分析へ進む →</button>
          <button class="btn ghost" id="reg-back">← 戻る</button>
        </div>
      </div>
    </div>
  `, { active: false });
  document.getElementById('reg-submit').addEventListener('click', async () => {
    const errEl = document.getElementById('reg-error');
    const btn = document.getElementById('reg-submit');
    errEl.textContent = '';
    btn.disabled = true;
    try {
      const { media } = await mediaApi('POST', '/api/registered-media', { name: document.getElementById('reg-name').value, siteUrl: document.getElementById('reg-url').value });
      await startWithRegistered(media);
    } catch (e) {
      if (e.authExpired) return;
      errEl.textContent = e.message;
      // すでに登録済みのURLなら、そのメディアで分析を始められるようにする
      if (e.data && e.data.existing) {
        errEl.innerHTML = `${esc(e.message)}　<a href="#" id="reg-use-existing">登録済みのこのメディアで分析する</a>`;
        document.getElementById('reg-use-existing').addEventListener('click', (ev) => { ev.preventDefault(); startWithRegistered(e.data.existing); });
      }
    } finally {
      btn.disabled = false;
    }
  });
  document.getElementById('reg-back').addEventListener('click', renderMediaChoice);
  pushHistory();
}

// 登録済みのメディアの一覧（選ぶ・編集・削除）
async function renderMediaList() {
  state.screen = 'mediaList';
  shell(`<div class="wrap"><div class="loading-box"><div class="spinner"></div>読み込み中…</div></div>`, { active: false });
  try {
    ({ media: registeredMediaCache } = await mediaApi('GET', '/api/registered-media'));
  } catch (e) {
    if (!e.authExpired) showFatalError(e);
    return;
  }
  mediaEditingId = null;
  mediaDeletingId = null;
  drawMediaList();
  pushHistory();
}

function drawMediaList() {
  const fmt = (iso) => (iso ? new Date(iso).toLocaleDateString('ja-JP') : '未使用');
  const items = registeredMediaCache.map((m) => {
    if (m.id === mediaEditingId) {
      return `<div class="card" data-id="${m.id}">
        <div class="field-grid">
          <div class="k">メディア名</div><div class="v"><input class="m-edit-name" type="text" maxlength="60" value="${esc(m.name)}" style="${fieldStyle}"></div>
          <div class="k">サイトURL</div><div class="v"><input class="m-edit-url" type="text" value="${esc(m.siteUrl)}" style="${fieldStyle}"></div>
        </div>
        <div class="m-edit-error" style="color:var(--danger);font-size:12.5px;margin:6px 0;"></div>
        <div class="btn-row"><button class="btn navy small" data-act="save">保存</button><button class="btn ghost small" data-act="cancel">キャンセル</button></div>
      </div>`;
    }
    return `<div class="card" data-id="${m.id}">
      <h3>${esc(m.name)}</h3>
      <div style="font-size:12.5px;color:var(--sub);word-break:break-all;">${esc(m.siteUrl)}</div>
      <div style="font-size:11px;color:var(--sub);margin-top:2px;">登録：${esc(fmt(m.createdAt))} ／ 最後に使った日：${esc(fmt(m.lastUsedAt))}</div>
      <div class="btn-row">
        <button class="btn navy small" data-act="use">このメディアを分析する →</button>
        ${m.id === mediaDeletingId
          ? '<span style="font-size:12.5px;color:var(--danger);align-self:center;">このメディアの登録を削除します（WordPressの接続情報も消えます）。</span><button class="btn danger-outline small" data-act="delete-yes">削除する</button><button class="btn ghost small" data-act="delete-no">やめる</button>'
          : '<button class="btn ghost small" data-act="edit">編集</button><button class="btn ghost small" data-act="delete">削除</button>'}
      </div>
    </div>`;
  }).join('');
  shell(`
    <div class="wrap">
      <div class="screen-head">
        <div class="eyebrow">STEP 0-1 ・ 既存メディアの分析</div>
        <h1>登録済みのメディア</h1>
        <p>分析するメディアを選んでください（${registeredMediaCache.length}件）。最後に使ったものが、上に並びます。</p>
      </div>
      ${items || '<div class="card" style="color:var(--sub);font-size:13px;">登録されたメディアがありません。</div>'}
      <div class="btn-row">
        <button class="btn outline" id="list-new">新たにメディアを登録</button>
        <button class="btn ghost" id="list-back">← 戻る</button>
      </div>
    </div>
  `, { active: false });
  document.getElementById('list-new').addEventListener('click', renderMediaRegister);
  document.getElementById('list-back').addEventListener('click', renderMediaChoice);
  app.querySelectorAll('[data-id]').forEach((card) => {
    const id = card.dataset.id;
    const item = registeredMediaCache.find((m) => m.id === id);
    card.querySelectorAll('[data-act]').forEach((el) => el.addEventListener('click', async () => {
      const act = el.dataset.act;
      if (act === 'use') startWithRegistered(item);
      else if (act === 'edit') { mediaEditingId = id; drawMediaList(); }
      else if (act === 'cancel') { mediaEditingId = null; drawMediaList(); }
      else if (act === 'delete') { mediaDeletingId = id; drawMediaList(); }
      else if (act === 'delete-no') { mediaDeletingId = null; drawMediaList(); }
      else if (act === 'delete-yes') {
        try {
          await mediaApi('DELETE', `/api/registered-media/${id}`);
          registeredMediaCache = registeredMediaCache.filter((m) => m.id !== id);
          mediaDeletingId = null;
          toast('メディアの登録を削除しました');
          if (!registeredMediaCache.length) renderMediaChoice();
          else drawMediaList();
        } catch (e) { if (!e.authExpired) toast(e.message); }
      } else if (act === 'save') {
        try {
          const { media } = await mediaApi('PUT', `/api/registered-media/${id}`, { name: card.querySelector('.m-edit-name').value, siteUrl: card.querySelector('.m-edit-url').value });
          registeredMediaCache = registeredMediaCache.map((m) => (m.id === id ? media : m));
          mediaEditingId = null;
          drawMediaList();
          toast('変更を保存しました');
        } catch (e) { if (!e.authExpired) card.querySelector('.m-edit-error').textContent = e.message; }
      }
    }));
  });
}

// 登録済みのメディアで、分析を始める
async function startWithRegistered(media) {
  let data;
  try {
    data = await api('/api/media/state', { body: { mediaState: 'existing', registeredId: media.id } });
  } catch (e) {
    if (!e.authExpired) showFatalError(e);
    return;
  }
  state.mediaId = data.mediaId;
  state.mediaState = 'existing';
  state.registeredMedia = { id: media.id, name: media.name, siteUrl: media.siteUrl };
  state.siteUrlInput = media.siteUrl;
  state.gscConnected = false;
  state.gscDemo = false;
  renderExistingUnderstand();
}

async function pickMediaState(mediaState) {
  // アカウント機能が有効なときは、既存メディアの分析は、「新たにメディアを登録」「登録済みのメディア」の2択から始める
  if (mediaState === 'existing' && state.accountsEnabled && state.user) {
    state.registeredMedia = null;
    renderMediaChoice();
    return;
  }
  let mediaId;
  try {
    ({ mediaId } = await api('/api/media/state', { body: { mediaState } }));
  } catch (err) {
    showFatalError(err);
    return;
  }
  state.mediaId = mediaId;
  state.mediaState = mediaState;
  state.siteUrlInput = '';
  state.registeredMedia = null;
  state.gscConnected = false;
  if (mediaState === 'existing') renderExistingUnderstand();
  else renderNewBusinessForm();
}

// ---------------------------------------------------------------
// STEP 0-2a: メディア理解（既存メディアの場合）【新設・v2】
// ---------------------------------------------------------------
function renderExistingUnderstand() {
  state.screen = 'understandExistingForm';
  const reg = state.registeredMedia;
  shell(`
    <div class="wrap">
      <div class="screen-head">
        <div class="eyebrow">STEP 0-2 ・ メディア理解（既存）</div>
        <h1>既存メディアを分析する</h1>
        <p>${reg ? `対象メディア：<b>${esc(reg.name)}</b>。` : ''}サイトURLをもとに、現状の記事・検索順位・カバレッジ状況を分析します（3.2）。</p>
      </div>
      <div class="card">
        <div class="field-grid">
          <div class="k">サイトURL</div><div class="v"><input id="site-url" type="text" ${reg ? `value="${esc(reg.siteUrl)}" readonly` : ''} placeholder="https://example.co.jp" style="width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:8px;font-size:13px;font-family:inherit;"></div>
        </div>
        <div style="font-size:11px;color:var(--sub);margin:6px 0 12px;">未定：既存記事一覧の取得手段（GSC連携／簡易クロール／手動アップロード／CMS連携のいずれを主手段とするか）</div>
        ${reg ? '<div style="font-size:11.5px;margin:0 0 8px;"><a href="#" id="reselect-media">メディアを選び直す／登録内容を変える</a></div>' : ''}
        <div class="btn-row">
          <button class="btn navy" id="go-analyze-gsc">GSCと連携して分析する →</button>
          <button class="btn outline" id="go-analyze-nogsc">GSCと連携しないで分析する →</button>
        </div>
      </div>
    </div>
  `, { active: false, nav: false });
  const reselect = document.getElementById('reselect-media');
  if (reselect) reselect.addEventListener('click', (e) => { e.preventDefault(); renderMediaChoice(); });
  document.getElementById('go-analyze-gsc').addEventListener('click', async () => {
    state.siteUrlInput = (document.getElementById('site-url').value || '').trim() || 'https://example.co.jp';
    state.gscContext = 'analyze';
    state.gscReconnect = false;
    renderGscConnect(); // 連携済みのアカウントがあれば、「連携済みアカウント」の画面になる
  });
  document.getElementById('go-analyze-nogsc').addEventListener('click', () => {
    state.siteUrlInput = (document.getElementById('site-url').value || '').trim() || 'https://example.co.jp';
    state.gscConnected = false;
    state.gscDemo = false;
    analyzeExisting();
  });
  pushHistory();
}

// すでにGSCと連携済みのアカウントがある場合の、連携画面。
// 連携済みアカウントを表示し、「そのアカウントで進める」ことを前提にする（別のアカウントへの切り替え・解除もできる）。
function renderGscConnected(st) {
  state.screen = 'gscConnect';
  const when = st.connectedAt ? new Date(st.connectedAt).toLocaleDateString('ja-JP') : '';
  shell(`
    <div class="wrap">
      <div class="screen-head">
        <div class="eyebrow">STEP 0-2 ・ メディア理解（既存）</div>
        <h1>Google Search Console は連携済みです</h1>
        <p>連携済みのアカウントで、そのまま進めます。別のアカウントを使いたい場合は、連携し直してください。</p>
      </div>
      <div class="card">
        <div style="display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;margin-bottom:14px;">
          <span style="font-size:22px;">🔎</span>
          <div>
            <div style="font-weight:700;font-size:13.5px;">Google Search Console</div>
            <div style="font-size:11.5px;color:var(--sub);">分析するサイト：${esc(state.siteUrlInput || '')}</div>
          </div>
        </div>
        <div class="info-box" style="margin:10px 0;">
          <div class="h">連携済みアカウント <span class="pill ok">連携済み</span></div>
          ${esc(st.account || '（アカウント名を取得できていません）')}<br>
          ${st.siteUrl ? `前回選んだサイト：${esc(st.siteUrl)}<br>` : ''}
          ${when ? `<span style="font-size:11.5px;color:var(--sub);">連携した日：${esc(when)}</span>` : ''}
        </div>
        <div style="font-size:10.5px;color:var(--sub);margin-bottom:10px;">※読み取り専用の連携です。次の画面で、このアカウントが権限を持つサイトから、分析するサイトを選びます。連携から時間がたつと、Google側の都合で、連携し直しが必要になることがあります。</div>
        <div class="btn-row">
          <button class="btn navy" id="gsc-use-account">このアカウントで進める →</button>
          <button class="btn outline" id="gsc-change-account">別のアカウントで連携し直す</button>
          <button class="btn ghost" id="gsc-unlink">連携を解除する</button>
          <button class="btn ghost" id="gsc-cancel2">← キャンセル</button>
        </div>
      </div>
    </div>
  `, { active: false, nav: false });
  document.getElementById('gsc-use-account').addEventListener('click', () => renderGscSites());
  document.getElementById('gsc-change-account').addEventListener('click', () => { state.gscReconnect = true; renderGscConnect(); });
  document.getElementById('gsc-unlink').addEventListener('click', async () => {
    await api('/api/gsc/disconnect', { body: { mediaId: state.mediaId } });
    state.gscConnected = false;
    state.gscReconnect = false;
    toast('連携を解除しました');
    renderGscConnect();
  });
  document.getElementById('gsc-cancel2').addEventListener('click', () => history.back());
  pushHistory();
}

// GSC連携画面。実際にGoogle Search Consoleと連携する。
// 連携にはGoogle Cloudで発行したOAuthクライアント（クライアントID・シークレット）が必要なため、
// サーバーに設定されていなければ、この画面で入力してもらう。入力しなくても「デモで続ける」で体験できる。
async function renderGscConnect() {
  state.screen = 'gscConnect';
  // すでに連携済みのアカウントがあれば、そのアカウントで進める画面にする（「別のアカウントで連携し直す」を選んだときは、連携のフォーム）
  if (!state.gscReconnect && state.mediaId) {
    try {
      const st = await api('/api/gsc/status', { body: { mediaId: state.mediaId } });
      if (st.connected) { renderGscConnected(st); return; }
    } catch (e) { if (e.authExpired) return; /* 状況が取れなければ、通常の連携画面へ */ }
  }
  let info;
  try {
    info = await api('/api/gsc/info');
  } catch (e) {
    info = { serverConfigured: false, redirectUri: `${location.origin}/api/gsc/callback` };
  }
  const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
  const input = 'width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:8px;font-size:13px;font-family:inherit;box-sizing:border-box;';

  const setup = info.serverConfigured ? `
        <div class="info-box" style="margin:10px 0;">
          <div class="h">連携の流れ</div>「Googleで連携する」を押すとGoogleの認証画面に移動します。Search Consoleの所有者（または権限のあるユーザー）のアカウントでログインし、読み取り専用のアクセスを許可してください。許可後、この画面に戻り、分析するサイトを選びます。
        </div>
        <div style="font-size:10.5px;color:var(--sub);margin-bottom:10px;">※読み取り専用です。サイトの設定やデータを変更することはありません。</div>` : `
        <div class="info-box" style="margin:10px 0;">
          <div class="h">連携に必要な情報</div>Google Cloudで発行する「OAuthクライアント」の、クライアントIDとクライアントシークレットが必要です。まだ発行していない場合は、下の手順で発行してください。
        </div>
        <details style="margin:10px 0;">
          <summary style="cursor:pointer;font-size:12.5px;font-weight:700;color:var(--sub);">発行の手順（約10分）</summary>
          <ol style="font-size:12.5px;line-height:1.8;margin:8px 0 0 18px;padding:0;">
            <li><a href="https://console.cloud.google.com/" target="_blank" rel="noopener">Google Cloud Console</a>でプロジェクトを作成し、「Google Search Console API」を有効にする。</li>
            <li>「APIとサービス」→「OAuth同意画面」を設定する（ユーザーの種類は「外部」。スコープは webmasters.readonly・openid・email。「テストユーザー」に、連携に使うGoogleアカウントを登録）。</li>
            <li>「認証情報」→「認証情報を作成」→「OAuthクライアントID」を選ぶ。種類は「ウェブアプリケーション」。</li>
            <li>「承認済みのリダイレクトURI」に、下の「登録するリダイレクトURI」を<b>そのまま</b>登録する。</li>
            <li>作成後に表示される「クライアントID」と「クライアントシークレット」を、下の欄に入力する。</li>
          </ol>
        </details>
        <div class="k" style="font-size:12.5px;font-weight:700;color:var(--sub);margin:12px 0 4px;">登録するリダイレクトURI（Google Cloudに登録する値）</div>
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;">
          <code id="gsc-redirect" style="flex:1;padding:8px 10px;background:#f5f7fa;border-radius:8px;font-size:12.5px;word-break:break-all;user-select:all;">${esc(info.redirectUri)}</code>
          <button class="btn outline small" id="gsc-copy" type="button">コピー</button>
        </div>
        <div class="field-grid">
          <div class="k">クライアントID</div><div class="v"><input id="gsc-client-id" type="text" autocomplete="off" placeholder="1234567890-xxxx.apps.googleusercontent.com" style="${input}"></div>
          <div class="k">クライアントシークレット</div><div class="v"><input id="gsc-client-secret" type="password" autocomplete="off" placeholder="GOCSPX-xxxx" style="${input}"></div>
        </div>
        <div style="font-size:10.5px;color:var(--sub);margin:8px 0 4px;">※入力した情報は、この連携のためにサーバーのメモリ上にだけ保持します（ブラウザには保存せず、サーバーを再起動すると消えます）。権限は読み取り専用で、サイトの設定やデータは変更しません。</div>
        ${isLocal ? '' : '<div class="missing-box" style="margin:8px 0;"><div class="h">このサイトは誰でもアクセスできる公開環境です</div>クライアントシークレットは秘密の情報です。公開環境での入力はおすすめしません。実際の連携は、ご自身のパソコンで動かすプロトタイプ（localhost:3000）で行ってください。</div>'}`;

  shell(`
    <div class="wrap">
      <div class="screen-head">
        <div class="eyebrow">STEP 0-2 ・ メディア理解（既存）</div>
        <h1>Google Search Console と連携します</h1>
        <p>連携すると、検索クエリ・掲載順位・ページ別の実績などのデータを取得できます。</p>
      </div>
      <div class="card">
        <div style="display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;margin-bottom:14px;">
          <span style="font-size:22px;">🔎</span>
          <div>
            <div style="font-weight:700;font-size:13.5px;">Google Search Console</div>
            <div style="font-size:11.5px;color:var(--sub);">対象サイト：${esc(state.siteUrlInput || 'https://example.co.jp')}</div>
          </div>
        </div>
        <div class="k" style="font-size:12.5px;font-weight:700;color:var(--sub);margin-bottom:6px;">連携すると取得できるデータ</div>
        <ul class="reason-list">
          <li>検索クエリ・クリック数・表示回数・掲載順位（過去28日）</li>
          <li>ページ別の実績、同じクエリで複数ページが表示されている候補（カニバリゼーションの兆候）</li>
        </ul>
        ${setup}
        <div id="gsc-error" style="color:var(--danger);font-size:12.5px;margin:6px 0;"></div>
        <div class="btn-row">
          <button class="btn navy" id="gsc-authorize">Googleで連携する →</button>
          ${info.serverConfigured ? '' : '<button class="btn outline" id="gsc-demo">デモで続ける（実際には連携しない）</button>'}
          <button class="btn ghost" id="gsc-cancel">← キャンセル</button>
        </div>
      </div>
    </div>
  `, { active: false, nav: false });

  const copyBtn = document.getElementById('gsc-copy');
  if (copyBtn) copyBtn.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(info.redirectUri); copyBtn.textContent = 'コピーしました'; } catch (e) { copyBtn.textContent = '選択してコピーしてください'; }
  });
  const demoBtn = document.getElementById('gsc-demo');
  if (demoBtn) demoBtn.addEventListener('click', () => {
    state.gscConnected = true;
    state.gscDemo = true;
    if (state.gscContext === 'settings') renderSettings();
    else analyzeExisting();
  });
  document.getElementById('gsc-authorize').addEventListener('click', async () => {
    const errEl = document.getElementById('gsc-error');
    errEl.textContent = '';
    const clientIdEl = document.getElementById('gsc-client-id');
    const body = { mediaId: state.mediaId };
    if (clientIdEl) {
      body.clientId = clientIdEl.value;
      body.clientSecret = document.getElementById('gsc-client-secret').value;
    }
    // Googleの認証画面へ移動する（戻ってきたとき続きから再開できるよう、必要な状態を保存しておく。シークレットは保存しない）
    try {
      const res = await fetch('/api/gsc/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { errEl.textContent = data.error || '連携を開始できませんでした'; return; }
      sessionStorage.setItem('mcGscReturn', JSON.stringify({ mediaId: state.mediaId, mediaState: state.mediaState, siteUrlInput: state.siteUrlInput, gscContext: state.gscContext }));
      location.href = data.url;
    } catch (err) {
      errEl.textContent = 'サーバーに接続できませんでした';
    }
  });
  document.getElementById('gsc-cancel').addEventListener('click', () => history.back());
  pushHistory();
}

// GSC連携後：分析対象のGSCプロパティ（サイト）を選ぶ
async function renderGscSites() {
  state.screen = 'gscSites';
  shell(`<div class="wrap"><div class="loading-box"><div class="spinner"></div>Search Consoleのサイト一覧を取得しています…</div></div>`, { active: false, nav: false });
  let result;
  try {
    result = await api('/api/gsc/sites', { body: { mediaId: state.mediaId, siteUrl: state.siteUrlInput } });
  } catch (err) {
    renderGscError('サイト一覧を取得できませんでした。もう一度連携してください');
    return;
  }
  const { account, sites, selected } = result;
  const preselect = selected || (sites.find((x) => x.matched) || {}).siteUrl || '';
  const hasMatch = sites.some((x) => x.matched);
  const fromSettings = state.gscContext === 'settings';
  shell(`
    <div class="wrap">
      <div class="screen-head">
        <div class="eyebrow">${fromSettings ? '設定' : 'STEP 0-2 ・ メディア理解（既存）'}</div>
        <h1>分析するサイトを選んでください</h1>
        <p>連携したアカウント${account ? `（${esc(account)}）` : ''}が権限を持つSearch Consoleのサイトです。</p>
      </div>
      <div class="card">
        ${sites.length ? '' : '<div class="missing-box"><div class="h">このアカウントにはSearch Consoleのサイトがありません</div>別のアカウントで連携し直してください。</div>'}
        ${sites.length && !hasMatch ? `<div class="missing-box"><div class="h">入力したサイト（${esc(state.siteUrlInput || '')}）と一致するサイトが見つかりませんでした</div>分析したいサイトを下から選んでください。</div>` : ''}
        ${sites.map((x) => `
          <label style="display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;margin-bottom:8px;cursor:pointer;">
            <input type="radio" name="gsc-site" value="${esc(x.siteUrl)}" ${x.siteUrl === preselect ? 'checked' : ''}>
            <div><div style="font-weight:700;font-size:13px;">${esc(x.siteUrl)} ${x.matched ? '<span class="pill ok">入力サイトと一致</span>' : ''}</div>
            <div style="font-size:11px;color:var(--sub);">権限：${esc(x.permissionLevel)}</div></div>
          </label>`).join('')}
        <div class="btn-row">
          ${sites.length ? `<button class="btn navy" id="gsc-site-go">${fromSettings ? 'このサイトに決定する' : 'このサイトで分析する →'}</button>` : ''}
          <button class="btn ghost" id="gsc-disconnect">連携を解除する</button>
          ${fromSettings ? '<button class="btn ghost" id="gsc-back-settings">← 設定に戻る</button>' : ''}
        </div>
      </div>
    </div>
  `, fromSettings ? { active: false } : { active: false, nav: false });
  const go = document.getElementById('gsc-site-go');
  if (go) go.addEventListener('click', async () => {
    const picked = app.querySelector('input[name="gsc-site"]:checked');
    if (!picked) return;
    await api('/api/gsc/select-site', { body: { mediaId: state.mediaId, siteUrl: picked.value } });
    state.gscConnected = true;
    state.gscDemo = false;
    if (fromSettings) renderSettings();
    else analyzeExisting();
  });
  document.getElementById('gsc-disconnect').addEventListener('click', async () => {
    await api('/api/gsc/disconnect', { body: { mediaId: state.mediaId } });
    state.gscConnected = false;
    if (fromSettings) renderSettings();
    else renderExistingUnderstand();
  });
  const backBtn = document.getElementById('gsc-back-settings');
  if (backBtn) backBtn.addEventListener('click', renderSettings);
  pushHistory();
}

function renderGscError(message) {
  state.screen = 'gscError';
  state.gscErrorMessage = message;
  shell(`
    <div class="wrap">
      <div class="screen-head">
        <div class="eyebrow">STEP 0-2 ・ メディア理解（既存）</div>
        <h1>GSCと連携できませんでした</h1>
      </div>
      <div class="card">
        <div class="missing-box"><div class="h">${esc(message)}</div></div>
        <div class="btn-row">
          <button class="btn navy" id="gsc-retry">もう一度連携する</button>
          <button class="btn outline" id="gsc-skip">${state.gscContext === 'settings' ? '← 設定に戻る' : 'GSCなしで分析する →'}</button>
        </div>
      </div>
    </div>
  `, { active: false, nav: false });
  document.getElementById('gsc-retry').addEventListener('click', () => { state.gscReconnect = true; renderGscConnect(); });
  document.getElementById('gsc-skip').addEventListener('click', () => {
    state.gscConnected = false;
    if (state.gscContext === 'settings') renderSettings();
    else analyzeExisting();
  });
  pushHistory();
}

// Googleの認証画面から戻ってきたとき（?gsc=ok / ?gsc=error）、保存しておいた状態を復元して続きを表示する
function handleGscReturn() {
  const params = new URLSearchParams(location.search);
  const result = params.get('gsc');
  if (!result) return false;
  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem('mcGscReturn') || 'null'); } catch (e) { /* 保存なし */ }
  history.replaceState(null, '', location.pathname);
  if (!saved || !saved.mediaId) return false;
  try { sessionStorage.removeItem('mcGscReturn'); } catch (e) { /* 無視 */ }
  Object.assign(state, saved);
  if (result === 'ok') renderGscSites();
  else renderGscError(params.get('reason') || '連携に失敗しました');
  return true;
}

// WordPress接続画面。実際のWordPressサイトにREST API＋アプリケーションパスワードで接続する（投稿は常に「下書き」）。
// 「設定」画面、または記事の公開時（未接続の場合）から呼ばれる（state.wpConnectContextで分岐：'publish' | 'settings'）
function renderWordpressConnect() {
  state.screen = 'wordpressConnect';
  const isPublish = state.wpConnectContext === 'publish';
  const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
  const input = 'width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:8px;font-size:13px;font-family:inherit;box-sizing:border-box;';
  shell(`
    <div class="wrap">
      <div class="screen-head">
        <div class="eyebrow">${isPublish ? '下書きの投稿に必要な設定' : '設定'}</div>
        <h1>WordPress と接続します</h1>
        <p>${isPublish
          ? '記事をWordPressに下書きとして投稿するには、WordPressサイトとの接続が必要です。'
          : '接続すると、生成した記事を、WordPressに「下書き」として投稿できるようになります（3.17）。'}</p>
      </div>
      <div class="card">
        <div style="display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;margin-bottom:14px;">
          <span style="font-size:22px;">📝</span>
          <div>
            <div style="font-weight:700;font-size:13.5px;">WordPress</div>
            <div style="font-size:11.5px;color:var(--sub);">サイトのURLと、投稿に使うユーザーの情報を入力してください</div>
          </div>
        </div>
        <div class="info-box" style="margin:10px 0;">
          <div class="h">安全のため、投稿は「下書き」までです</div>このアプリから記事を公開することはありません。投稿された下書きを、WordPressの管理画面で確認して、公開してください。
        </div>
        <div class="field-grid" style="margin-bottom:6px;">
          <div class="k">接続方式</div>
          <div class="v" style="font-size:12.5px;line-height:1.7;">
            <label><input type="radio" name="wp-method" value="rest" checked> アプリケーションパスワード（WordPress 5.6以降。おすすめ）</label><br>
            <label><input type="radio" name="wp-method" value="xmlrpc"> ログイン用パスワード（XML-RPC。WordPress 5.6より前の古いサイト向け）</label>
          </div>
        </div>
        <div class="missing-box" id="wp-xmlrpc-note" style="margin:8px 0;" hidden>
          <div class="h">XML-RPC方式を使うときの注意</div>
          このサイトのログイン用パスワードを使います。<b>管理者のアカウントは使わず、このアプリ専用に、権限グループが「投稿者」のユーザーを新しく作って</b>、そのユーザーの情報を入力してください（「寄稿者」では、画像をアップロードできません）。パスワードは、この接続のためにサーバーのメモリ上にだけ保持し、ブラウザには保存しません。
        </div>
        <details style="margin:10px 0;" id="wp-rest-guide">
          <summary style="cursor:pointer;font-size:12.5px;font-weight:700;color:var(--sub);">アプリケーションパスワードの発行手順</summary>
          <ol style="font-size:12.5px;line-height:1.8;margin:8px 0 0 18px;padding:0;">
            <li>WordPressの管理画面に、投稿に使うユーザーでログインする。</li>
            <li>左メニューの「ユーザー」→「プロフィール」を開く。</li>
            <li>下の方の「アプリケーションパスワード」に、名前（例：メディアコンパス極）を入れて「新しいアプリケーションパスワードを追加」を押す。</li>
            <li>表示されたパスワードをコピーして、下の欄に貼り付ける（<b>この画面を閉じると二度と表示されません</b>）。</li>
          </ol>
          <div style="font-size:11.5px;color:var(--sub);margin-top:6px;">※ログイン用のパスワードではなく、ここで発行したアプリケーションパスワードを使います。サイトがHTTPSであること、投稿者以上の権限があることが必要です。見つからない場合は、セキュリティ系のプラグインでREST APIが制限されていないか、確認してください。</div>
        </details>
        <div class="field-grid">
          <div class="k">サイトURL</div><div class="v"><input id="wp-site-url" type="text" value="${esc(state.wordpressSiteUrl || '')}" placeholder="https://example.co.jp" style="${input}"></div>
          <div class="k">ユーザー名</div><div class="v"><input id="wp-username" type="text" autocomplete="off" placeholder="WordPressのユーザー名" style="${input}"></div>
 <div class="k" id="wp-pw-label">アプリケーションパスワード</div><div class="v"><input id="wp-app-password" type="password" autocomplete="off" placeholder="xxxx xxxx xxxx xxxx xxxx xxxx" style="${input}"></div>
        </div>
        <div style="font-size:10.5px;color:var(--sub);margin:8px 0 4px;">※入力した情報は、この接続のためにサーバーのメモリ上にだけ保持します（ブラウザには保存せず、サーバーを再起動すると消えます）。一度接続すると、次回からはこの画面は表示されません。</div>
        ${isLocal ? '' : '<div class="missing-box" style="margin:8px 0;"><div class="h">このサイトは誰でもアクセスできる公開環境です</div>パスワードは秘密の情報です。公開環境での入力はおすすめしません。実際の接続は、ご自身のパソコンで動かすプロトタイプ（localhost:3000）で行ってください。</div>'}
        <div id="wp-error" style="color:var(--danger);font-size:12.5px;margin:6px 0;"></div>
        <div class="btn-row">
          <button class="btn navy" id="wp-authorize">接続して続ける →</button>
          <button class="btn outline" id="wp-demo">デモで続ける（実際には接続しない）</button>
          <button class="btn ghost" id="wp-cancel">← キャンセル</button>
        </div>
      </div>
    </div>
  `, { active: false, nav: false });

  const methodOf = () => (app.querySelector('input[name="wp-method"]:checked') || {}).value || 'rest';
  const applyMethod = () => {
    const x = methodOf() === 'xmlrpc';
    document.getElementById('wp-xmlrpc-note').hidden = !x;
    document.getElementById('wp-rest-guide').hidden = x;
    document.getElementById('wp-pw-label').textContent = x ? 'パスワード（ログイン用）' : 'アプリケーションパスワード';
    document.getElementById('wp-app-password').placeholder = x ? '投稿専用ユーザーのログイン用パスワード' : 'xxxx xxxx xxxx xxxx xxxx xxxx';
  };
  app.querySelectorAll('input[name="wp-method"]').forEach((r) => r.addEventListener('change', applyMethod));

  const afterConnect = () => {
    if (state.wpConnectContext === 'articles') renderArticles();
    else if (isPublish) doPublish();
    else renderSettings();
  };
  document.getElementById('wp-authorize').addEventListener('click', async () => {
    const errEl = document.getElementById('wp-error');
    const btn = document.getElementById('wp-authorize');
    errEl.textContent = '';
    const siteUrl = document.getElementById('wp-site-url').value;
    btn.disabled = true;
    btn.textContent = '接続を確認しています…';
    try {
      const res = await fetch('/api/wordpress/connect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          mediaId: state.mediaId,
          siteUrl,
          method: methodOf(),
          username: document.getElementById('wp-username').value,
          appPassword: document.getElementById('wp-app-password').value,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        errEl.textContent = data.error || '接続できませんでした';
        // サイトがアプリケーションパスワードに対応していない場合は、XML-RPC方式を案内する
        if (methodOf() === 'rest' && /アプリケーションパスワードに対応していない/.test(errEl.textContent)) {
          errEl.textContent += ' → 古いWordPressでも使える「ログイン用パスワード（XML-RPC）」方式を、選び直しました。投稿専用のユーザーを作って、もう一度お試しください。';
          app.querySelector('input[name="wp-method"][value="xmlrpc"]').checked = true;
          applyMethod();
        }
        return;
      }
      state.wordpressSiteUrl = data.siteUrl;
      state.wordpressMethod = data.method;
      state.wordpressConnected = true;
      state.wordpressReal = true;
      afterConnect();
    } catch (err) {
      errEl.textContent = 'サーバーに接続できませんでした';
    } finally {
      btn.disabled = false;
      btn.textContent = '接続して続ける →';
    }
  });
  document.getElementById('wp-demo').addEventListener('click', async () => {
    const url = (document.getElementById('wp-site-url').value || '').trim() || state.wordpressSiteUrl || 'https://example.co.jp';
    state.wordpressSiteUrl = url;
    try {
      await api('/api/media/wordpress-connect', { body: { mediaId: state.mediaId, siteUrl: url } });
    } catch (e) { /* デモでは失敗しても先に進める */ }
    state.wordpressConnected = true;
    state.wordpressReal = false;
    afterConnect();
  });
  document.getElementById('wp-cancel').addEventListener('click', () => history.back());
  pushHistory();
}

async function analyzeExisting(useDemo = false) {
  const siteUrl = state.siteUrlInput || 'https://example.co.jp';
  const withGsc = !!state.gscConnected;
  const withWordpress = !!state.wordpressConnected;
  const loadingMsgs = [];
  if (withGsc) loadingMsgs.push('検索順位・GSCデータ');
  if (withWordpress) loadingMsgs.push('WordPressの記事・見出し構成');
  loadingMsgs.push('サイト構成');
  const crawlNote = state.aiEnabled && !useDemo ? '<br><span style="font-size:11.5px;color:var(--sub);">実際にサイトを巡回して記事を読み取るため、30秒〜1分ほどかかります</span>' : '';
  shell(`<div class="wrap"><div class="loading-box"><div class="spinner"></div>${loadingMsgs.join('・')}を分析しています…${crawlNote}</div></div>`, { active: false, nav: false });
  let analysis, crawlError;
  try {
    ({ analysis, crawlError } = await api('/api/media/understand-existing', { body: { mediaId: state.mediaId, siteUrl, withGsc, withWordpress, useDemo } }));
  } catch (err) {
    showFatalError(err);
    return;
  }
  if (crawlError) {
    renderCrawlError(crawlError);
    return;
  }
  state.existingAnalysis = analysis;
  renderExistingAnalysisResult();
}

function renderCrawlError(message) {
  state.screen = 'crawlError';
  state.crawlErrorMessage = message;
  shell(`
    <div class="wrap">
      <div class="screen-head">
        <div class="eyebrow">STEP 0-2 ・ メディア理解（既存）</div>
        <h1>サイトを分析できませんでした</h1>
      </div>
      <div class="card">
        <div class="missing-box"><div class="h">${esc(message)}</div>URLをご確認のうえ、もう一度お試しください。</div>
        <div class="btn-row">
          <button class="btn navy" id="crawl-retry">← URLを入力し直す</button>
          <button class="btn outline" id="crawl-demo">デモ用の分析結果で続ける →</button>
        </div>
      </div>
    </div>
  `, { active: false, nav: false });
  document.getElementById('crawl-retry').addEventListener('click', renderExistingUnderstand);
  document.getElementById('crawl-demo').addEventListener('click', () => analyzeExisting(true));
  pushHistory();
}

function renderExistingAnalysisResult() {
  state.screen = 'understandExistingResult';
  const analysis = state.existingAnalysis;
  shell(`
    <div class="wrap">
      <div class="screen-head">
        <div class="eyebrow">STEP 0-2 ・ メディア理解（既存）</div>
        <h1>分析結果</h1>
        <p>
          ${analysis.real ? `実際にサイト（${esc(analysis.siteUrl)}）を巡回し、AI（ChatGPT）が分析した結果です。` : 'デモ用の固定データによる分析結果です（シミュレーションモード）。'}
          ${analysis.gsc && analysis.gsc.real ? 'Google Search Consoleの実データも使っています。' : analysis.withGsc ? 'GSC連携の検索クエリはデモ値です。' : 'GSCとは連携していないため、サイトの記事内容のみで分析しています。'}
          ${analysis.withWordpress ? 'WordPressとも接続し、記事の見出し構成まで取得しています。' : ''}
        </p>
      </div>
      <div class="card">
        <div class="field-grid">
          ${analysis.siteSummary ? `<div class="k">メディアの概要</div><div class="v">${esc(analysis.siteSummary)}</div>` : ''}
          ${analysis.industry ? `<div class="k">推定される分野</div><div class="v">${esc(analysis.industry)}</div>` : ''}
          <div class="k">既存記事数</div><div class="v">${analysis.articlesCount}本${analysis.real ? `（サイトの公開情報から推定。うち${analysis.sampledCount}本の内容を分析）` : ''}</div>
          <div class="k">主な検索クエリ</div><div class="v">${analysis.topQueries.length ? analysis.topQueries.map(esc).join(' / ') + (analysis.gsc && analysis.gsc.real ? '' : ' <span class="pill grey">デモ値</span>') : 'GSC未連携のため取得できません'}</div>
        </div>
        ${analysis.gscError ? `<div class="missing-box" style="margin-top:10px;"><div class="h">GSCのデータを取得できませんでした</div>${esc(analysis.gscError)}（GSCなしの分析結果を表示しています）</div>` : ''}
        ${analysis.gsc && analysis.gsc.real ? `
        <div class="k" style="font-size:12.5px;font-weight:700;color:var(--sub);margin:14px 0 6px;">Search Consoleの実績（${esc(analysis.gsc.period)}／${esc(analysis.gsc.siteUrl)}）</div>
        <div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:12px;">
          <tr style="text-align:left;color:var(--sub);"><th style="padding:4px 6px;">検索クエリ</th><th>クリック</th><th>表示回数</th><th>CTR</th><th>平均順位</th></tr>
          ${analysis.gsc.topQueries.slice(0, 10).map((q) => `<tr style="border-top:1px solid var(--line);"><td style="padding:4px 6px;">${esc(q.query)}</td><td>${q.clicks}</td><td>${q.impressions}</td><td>${q.ctr}%</td><td>${q.position}</td></tr>`).join('')}
        </table></div>` : ''}
        ${analysis.topicsCovered && analysis.topicsCovered.length ? `<div class="info-box" style="margin-top:10px;"><div class="h">扱っているテーマ領域</div>${analysis.topicsCovered.map((t) => `${esc(t.name)}${t.articleCount ? `（${esc(t.articleCount)}本）` : ''}`).join(' / ')}</div>` : ''}
        <div class="missing-box" style="margin-top:10px;">
          <div class="h">カニバリゼーションの兆候</div>
          ${analysis.cannibalization.length ? analysis.cannibalization.map((c) => `「${esc(c.topic)}」で複数記事が競合：${c.articles.map(esc).join(' と ')}`).join('<br>') : '明確な兆候は見つかりませんでした'}
        </div>
        <div class="info-box" style="margin-top:10px;">
          <div class="h">カバレッジの傾向</div>${esc(analysis.coverageNote)}
          ${analysis.gaps && analysis.gaps.length ? `<div style="margin-top:6px;"><b>未着手と思われるテーマ：</b>${analysis.gaps.map(esc).join(' / ')}</div>` : ''}
        </div>
        ${analysis.fetchNotes && analysis.fetchNotes.length ? `<div style="font-size:11px;color:var(--sub);margin-top:8px;">※${analysis.fetchNotes.map(esc).join('<br>※')}</div>` : ''}
        ${analysis.headingSample ? `
        <div class="k" style="font-size:12.5px;font-weight:700;color:var(--sub);margin:14px 0 6px;">${analysis.real ? 'サイトから取得した見出し構成（サンプル）' : 'WordPressから取得した見出し構成（サンプル）'}</div>
        ${analysis.headingSample.map((a) => `
          <div class="outline-item">
            <div class="h2">${esc(a.title)}</div>
            ${a.headings.map((h) => `<div class="h3">${esc(h)}</div>`).join('')}
          </div>
        `).join('')}
        ` : ''}
        <div class="btn-row"><button class="btn navy" id="go-direction">メディアの方向性を見る →</button></div>
      </div>
    </div>
  `, { active: false, nav: false });
  document.getElementById('go-direction').addEventListener('click', renderDirectionGenerating);
  pushHistory();
}

// ---------------------------------------------------------------
// STEP 0-2b: メディア理解（新規メディアの場合／事業理解ヒアリング）【新設・v2】
// ---------------------------------------------------------------
function renderNewBusinessForm() {
  state.screen = 'understandNewForm';
  shell(`
    <div class="wrap">
      <div class="screen-head">
        <div class="eyebrow">STEP 0-2 ・ メディア理解（新規）</div>
        <h1>事業内容を教えてください</h1>
        <p>業種・商圏をもとに、AIが事業理解のヒアリングを行います（3.3）。</p>
      </div>
      <div class="card">
        <div class="field-grid">
          <div class="k">業種</div><div class="v"><input id="biz-industry" type="text" value="外壁塗装業" style="width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:8px;font-size:13px;font-family:inherit;"></div>
          <div class="k">商圏</div><div class="v"><input id="biz-area" type="text" value="関東一円" style="width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:8px;font-size:13px;font-family:inherit;"></div>
        </div>
        <div class="btn-row"><button class="btn navy" id="go-hearing-new">AIヒアリングを始める →</button></div>
      </div>
    </div>
  `, { active: false, nav: false });
  document.getElementById('go-hearing-new').addEventListener('click', submitBusinessInfo);
  pushHistory();
}

async function submitBusinessInfo() {
  const industry = (document.getElementById('biz-industry').value || '').trim() || '外壁塗装業';
  const area = (document.getElementById('biz-area').value || '').trim() || '未入力';
  try {
    await api('/api/media/business-info', { body: { mediaId: state.mediaId, industry, area } });
  } catch (err) {
    showFatalError(err);
    return;
  }
  state.businessInfo = { industry, area };
  state.newHearing = { history: [], question: null, questionNumber: 0, maxQuestions: 4, done: false, loading: false };
  renderNewHearing();
  askNextBusinessQuestion();
}

function renderNewHearing() {
  state.screen = 'understandNewHearing';
  const h = state.newHearing;
  const log = h.history.flatMap((x) => [
    `<div class="bub ai"><div class="who">AI</div>${esc(x.question)}</div>`,
    `<div class="bub user">${esc(x.answer)}</div>`,
  ]).join('');
  const currentQ = h.question ? `<div class="bub ai"><div class="who">AI</div>${esc(h.question)}</div>` : '';
  const thinking = h.loading ? `<div class="bub thinking">AIが質問を考えています…</div>` : '';

  shell(`
    <div class="wrap">
      <div class="screen-head">
        <div class="eyebrow">STEP 0-2 ・ 事業理解ヒアリング</div>
        <h1>AIが事業内容についてお聞きします</h1>
        <p>記事ごとのAIヒアリング（3.8）とは別の文脈です。仕様書上の暫定上限は8問ですが、本デモでは体験時間短縮のため${h.maxQuestions}問に設定しています。</p>
      </div>
      <div class="chat-panel">
        <div class="qcounter">${h.done ? 'ヒアリング完了' : `質問 ${h.questionNumber} / ${h.maxQuestions}`}</div>
        <div class="chat-log" id="chat-log">${log}${currentQ}${thinking}</div>
        ${h.done ? `
          <div class="btn-row"><button class="btn navy" id="go-direction2">メディアの方向性を見る →</button></div>
        ` : `
          <div class="chat-input-row">
            <textarea id="biz-answer-input" placeholder="回答を入力してください…" ${h.loading ? 'disabled' : ''}></textarea>
            <button class="btn navy" id="send-biz-answer" ${h.loading ? 'disabled' : ''}>送信</button>
          </div>
        `}
      </div>
    </div>
  `, { active: false, nav: false });
  const logEl = document.getElementById('chat-log');
  if (logEl) logEl.scrollTop = logEl.scrollHeight;

  const sendBtn = document.getElementById('send-biz-answer');
  if (sendBtn) sendBtn.addEventListener('click', submitBusinessAnswer);
  const goDir = document.getElementById('go-direction2');
  if (goDir) goDir.addEventListener('click', renderDirectionGenerating);
  if (!h.loading && (h.question || h.done || h.history.length)) pushHistory();
}

async function askNextBusinessQuestion() {
  const h = state.newHearing;
  h.loading = true;
  renderNewHearing();
  try {
    const r = await api('/api/media/hearing/next', { body: { mediaId: state.mediaId } });
    h.loading = false;
    if (r.done) {
      h.done = true;
    } else {
      h.question = r.question;
      h.questionNumber = r.questionNumber;
    }
  } catch (e) {
    h.loading = false;
    toast('AI呼び出しに失敗しました。シミュレーションで続行してください。');
  }
  renderNewHearing();
}

async function submitBusinessAnswer() {
  const ta = document.getElementById('biz-answer-input');
  const answer = (ta.value || '').trim();
  if (!answer) { toast('回答を入力してください'); return; }
  const h = state.newHearing;
  h.history.push({ question: h.question, answer });
  h.question = null;
  h.loading = true;
  renderNewHearing();
  try {
    const r = await api('/api/media/hearing/next', { body: { mediaId: state.mediaId, answer } });
    h.loading = false;
    if (r.done) {
      h.done = true;
    } else {
      h.question = r.question;
      h.questionNumber = r.questionNumber;
    }
  } catch (e) {
    h.loading = false;
    h.done = true;
    toast('AI呼び出しに失敗したため、ここでヒアリングを終了します');
  }
  renderNewHearing();
}

// ---------------------------------------------------------------
// STEP 0-3: メディアの方向性・テーマ領域設計【新設・v2】
// ---------------------------------------------------------------
async function renderDirectionGenerating() {
  state.screen = 'directionGenerating';
  shell(`<div class="wrap"><div class="loading-box"><div class="spinner"></div>AIがテーマ領域を設計しています…</div></div>`, { active: false, nav: false });
  let clusters = [], topCluster = null, mode;
  try {
    ({ clusters, topCluster, mode } = await api('/api/media/direction', { body: { mediaId: state.mediaId } }));
  } catch (e) {
    toast('方向性の生成に失敗しました');
  }
  state.direction = { clusters, topCluster };
  state.lastMode = mode;
  renderDirectionConfirm();
}

function clusterCardHtml(c) {
  return `
    <div class="card">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        <span class="pill ${c.priority === '高' ? 'danger' : c.priority === '中' ? 'gold' : 'grey'}">優先度：${esc(c.priority)}</span>
        <span class="pill ${c.coverage === '十分' ? 'ok' : c.coverage === '一部' ? 'gold' : 'grey'}">カバレッジ：${esc(c.coverage)}</span>
      </div>
      <h3>${esc(c.name)}</h3>
      <div style="font-size:12.5px;color:var(--sub);">${esc(c.reason)}</div>
    </div>`;
}

function renderDirectionConfirm() {
  state.screen = 'directionConfirm';
  const clusters = state.direction?.clusters || [];
  const rows = clusters.map(clusterCardHtml).join('');

  shell(`
    <div class="wrap">
      <div class="screen-head">
        <div class="eyebrow">STEP 0-3 ・ メディアの方向性</div>
        <h1>メディアの方向性・テーマ領域を確認する</h1>
        <p>扱うべきテーマ領域とその優先度です。内容を確認し、必要なら調整したうえで進めてください（3.4）。</p>
      </div>
      ${rows}
      <div style="font-size:11px;color:var(--sub);margin:10px 0;">未定：業種別テーマ体系をゼロ生成するか雛形を用意するか</div>
      <div class="btn-row"><button class="btn gold" id="confirm-direction">この方向性で進める →</button></div>
    </div>
  `, { active: false, nav: false });
  document.getElementById('confirm-direction').addEventListener('click', confirmDirection);
  pushHistory();
}

async function confirmDirection() {
  try {
    await api('/api/media/confirm-direction', { body: { mediaId: state.mediaId } });
  } catch (e) { /* デモでは失敗しても先に進める */ }
  renderDashboard();
}

function renderDirectionSummary() {
  state.screen = 'direction';
  const clusters = state.direction?.clusters || [];
  const rows = clusters.length
    ? clusters.map(clusterCardHtml).join('')
    : '<div class="card">まだメディアの方向性が設計されていません。</div>';

  shell(`
    <div class="wrap">
      <div class="screen-head">
        <div class="eyebrow">メディアの方向性</div>
        <h1>テーマ領域と優先度</h1>
        <p>「今、作るべき記事テーマ」は、このテーマ領域の設計結果を踏まえて提示されます（3.4）。</p>
      </div>
      ${rows}
    </div>
  `, { active: false });
  pushHistory();
}

// ---------------------------------------------------------------
// 設定画面【新設】：Google Search Console と WordPress の連携状況の確認・変更をここで一元管理する
// ---------------------------------------------------------------
async function renderSettings() {
  state.screen = 'settings';
  const connected = !!state.wordpressConnected;

  // Google Search Console の現在の連携状況（実連携はサーバーに保持されているので、その都度取得する）
  let gscStatus = { connected: false };
  if (state.mediaId) {
    try { gscStatus = await api('/api/gsc/status', { body: { mediaId: state.mediaId } }); } catch (e) { /* 取得できなければ未接続として表示 */ }
  }
  const gscDemo = !gscStatus.connected && !!state.gscDemo;

  // WordPressの現在の接続状況（実接続はサーバーに保持されているので、その都度取得する）
  let wpStatus = { connected: false };
  if (state.mediaId) {
    try { wpStatus = await api('/api/wordpress/status', { body: { mediaId: state.mediaId } }); } catch (e) { /* 取得できなければ未接続として表示 */ }
  }
  const wpDemo = !wpStatus.connected && connected && !state.wordpressReal;

  const gscBody = gscStatus.connected ? `
        <div class="info-box">
          <div class="h">接続中（実際のGoogleと連携）</div>
          アカウント：${esc(gscStatus.account || '不明')}<br>
          分析対象のサイト：${gscStatus.siteUrl ? esc(gscStatus.siteUrl) : '未選択（「サイトを切り替える」から選んでください）'}
        </div>
        <div class="btn-row">
          <button class="btn navy" id="gsc-change-site">サイトを切り替える</button>
          <button class="btn outline" id="gsc-real-connect">連携し直す</button>
          <button class="btn ghost" id="gsc-settings-disconnect">連携を解除する</button>
        </div>` : gscDemo ? `
        <div class="info-box">
          <div class="h">デモ連携（実際のGoogleには接続していません）</div>
          分析結果に出るGSCの検索クエリは、デモ用の固定値です。
        </div>
        <div class="btn-row">
          <button class="btn navy" id="gsc-real-connect">実際のGSCと連携する →</button>
          <button class="btn ghost" id="gsc-demo-off">デモ連携を解除する</button>
        </div>` : state.mediaId ? `
        <div class="missing-box">
          <div class="h">未接続</div>まだGoogle Search Consoleと連携していません。連携すると、検索クエリ・掲載順位などの実績を分析に使えます。
        </div>
        <div class="btn-row"><button class="btn navy" id="gsc-real-connect">GSCと連携する →</button></div>` : `
        <div class="missing-box">
          <div class="h">未接続</div>GSCとの連携は、「既存メディアを分析する」の流れから始められます。
        </div>`;

  shell(`
    <div class="wrap">
      <div class="screen-head">
        <div class="eyebrow">設定</div>
        <h1>連携の設定</h1>
        <p>Google Search Console と WordPress の接続状況を確認し、変更できます。</p>
      </div>
      <div class="card">
        <h3 style="margin:0 0 4px;">Google Search Console</h3>
        <p style="font-size:12.5px;color:var(--sub);margin:0 0 10px;">既存メディアの分析で、検索クエリ・掲載順位・ページ別の実績を取得するために使います（読み取り専用）。</p>
        ${gscBody}
      </div>
      <div class="card">
        <h3 style="margin:0 0 4px;">WordPress</h3>
        <p style="font-size:12.5px;color:var(--sub);margin:0 0 10px;">接続すると、生成した記事を、WordPressに「下書き」として投稿できるようになります（3.17）。公開はWordPress側で行います。</p>
        ${wpStatus.connected ? `
          <div class="info-box">
            <div class="h">接続中（実際のWordPressと連携）</div>
            サイト：${esc(wpStatus.siteName || '')} ${esc(wpStatus.siteUrl)}<br>
            ユーザー：${esc(wpStatus.userName || '')}<br>
            接続方式：${wpStatus.method === 'xmlrpc' ? 'ログイン用パスワード（XML-RPC）' : 'アプリケーションパスワード'}<br>
            投稿の種類：下書きのみ${wpStatus.canUpload ? '（画像のアップロード可）' : '（このユーザーは画像をアップロードできません）'}
          </div>
          ${wpStatus.isAdmin ? '<div class="missing-box" style="margin-top:8px;"><div class="h">管理者権限のユーザーで接続しています</div>安全のため、このアプリ専用の、権限が「投稿者」のユーザーでの接続をおすすめします。</div>' : ''}
          <div class="btn-row">
            <button class="btn outline" id="wp-connect-settings">接続し直す</button>
            <button class="btn ghost" id="wp-disconnect">接続を解除する</button>
          </div>
        ` : wpDemo ? `
          <div class="info-box">
            <div class="h">デモ接続（実際のWordPressには接続していません）</div>${esc(state.wordpressSiteUrl || '')}<br>記事の公開は、アプリ内の疑似ページになります。
          </div>
          <div class="btn-row">
            <button class="btn navy" id="wp-connect-settings">実際のWordPressと接続する →</button>
            <button class="btn ghost" id="wp-disconnect">デモ接続を解除する</button>
          </div>
        ` : state.mediaId ? `
          <div class="missing-box">
            <div class="h">未接続</div>まだWordPressと接続していません。記事を投稿する際に接続を求められますが、ここから先に接続しておくこともできます。
          </div>
          <div class="btn-row"><button class="btn navy" id="wp-connect-settings">WordPressと接続する →</button></div>
        ` : `
          <div class="missing-box">
            <div class="h">未接続</div>WordPressとの接続は、「既存メディアを分析する」または「新しくメディアを構築する」の流れの中から始められます。
          </div>
        `}
      </div>
    </div>
  `, { active: false });

  const gscConnectBtn = document.getElementById('gsc-real-connect');
  if (gscConnectBtn) gscConnectBtn.addEventListener('click', () => { state.gscContext = 'settings'; state.gscReconnect = !!gscStatus.connected; renderGscConnect(); });
  const gscChange = document.getElementById('gsc-change-site');
  if (gscChange) gscChange.addEventListener('click', () => { state.gscContext = 'settings'; renderGscSites(); });
  const gscOff = document.getElementById('gsc-settings-disconnect');
  if (gscOff) gscOff.addEventListener('click', async () => {
    await api('/api/gsc/disconnect', { body: { mediaId: state.mediaId } });
    state.gscConnected = false;
    state.gscDemo = false;
    renderSettings();
  });
  const gscDemoOff = document.getElementById('gsc-demo-off');
  if (gscDemoOff) gscDemoOff.addEventListener('click', () => { state.gscConnected = false; state.gscDemo = false; renderSettings(); });

  const connectBtn = document.getElementById('wp-connect-settings');
  if (connectBtn) connectBtn.addEventListener('click', () => { state.wpConnectContext = 'settings'; renderWordpressConnect(); });
  const disconnectBtn = document.getElementById('wp-disconnect');
  if (disconnectBtn) disconnectBtn.addEventListener('click', async () => {
    if (wpStatus.connected) await api('/api/wordpress/disconnect', { body: { mediaId: state.mediaId } });
    state.wordpressConnected = false;
    state.wordpressReal = false;
    renderSettings();
  });
  pushHistory();
}

// ---------------------------------------------------------------
// STEP 1: ダッシュボード
// ---------------------------------------------------------------
async function renderDashboard() {
  state.screen = 'dashboard';
  shell(`<div class="wrap"><div class="loading-box"><div class="spinner"></div>${state.mediaId && state.aiEnabled ? 'AIが、方向性と事業情報から「今、作るべき記事テーマ」を考えています…（10〜20秒ほどかかります）' : '読み込み中…'}</div></div>`, { active: false });
  let themes, aiEnabled, direction, themesMode;
  try {
    const q = state.mediaId ? `?mediaId=${encodeURIComponent(state.mediaId)}` : '';
    ({ themes, aiEnabled, direction, themesMode } = await api(`/api/themes${q}`));
  } catch (err) {
    showFatalError(err);
    return;
  }
  state.themes = themes;
  state.themesMode = themesMode;
  state.aiEnabled = aiEnabled;
  if (direction) state.direction = direction;

  const directionBanner = state.direction && state.direction.topCluster ? `
    <div class="direction-box">
      <div class="h">メディアの方向性を踏まえた提案（3.4）</div>
      最優先テーマ領域「${esc(state.direction.topCluster.name)}」（優先度：${esc(state.direction.topCluster.priority)}／カバレッジ：${esc(state.direction.topCluster.coverage)}）を中心に、次の記事テーマを提示しています。
      <a href="#" id="view-direction">方向性の一覧を見る →</a>
    </div>` : '';

  const cards = themes.map((t, i) => `
    <div class="card ${i === 0 ? 'primary' : ''} clickable" data-theme="${t.id}">
      <span class="pill ${t.priority === '高' ? 'gold' : 'grey'}">優先度：${esc(t.priority)}</span>
      ${i === 0 ? '<span class="pill ok" style="margin-left:6px;">主役</span>' : ''}
      <h3>${esc(t.title)}</h3>
      <div class="field-grid">
        <div class="k">想定キーワード</div><div class="v">${esc(t.keyword)}</div>
        ${t.volumeEstimate ? `<div class="k">検索ボリューム</div><div class="v">${esc(t.volumeEstimate)} <span class="pill grey">AI推測</span></div>` : ''}
      </div>
      <ul class="reason-list">${t.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
      <div class="btn-row"><button class="btn gold small" data-theme-go="${t.id}">このテーマを見る →</button></div>
    </div>`).join('');

  shell(`
    <div class="wrap">
      <div class="screen-head">
        <div class="eyebrow">STEP 1 ・ ダッシュボード</div>
        <h1>今、作るべき記事テーマ</h1>
        <p>検索需要・競合状況・自社の一次情報をもとに、次に作るべき記事テーマを優先順位付きで提示します。</p>
      </div>
      ${directionBanner}
      ${state.themes.some((t) => t.estimated) ? '<div class="info-box"><div class="h">この提案について</div>テーマはAI（ChatGPT）が、方向性・事業情報・事業ヒアリングの回答から生成しました。検索ボリューム・競合状況はAIの推測値です（外部の検索データ連携が済むまでの暫定表示で、実データではありません）。</div>' : ''}
      ${cards}
    </div>
  `, { active: false });

  const viewDir = document.getElementById('view-direction');
  if (viewDir) viewDir.addEventListener('click', (e) => { e.preventDefault(); renderDirectionSummary(); });

  app.querySelectorAll('[data-theme-go]').forEach((btn) => {
    btn.addEventListener('click', () => selectTheme(btn.dataset.themeGo));
  });
  app.querySelectorAll('[data-theme]').forEach((c) => {
    c.addEventListener('click', (e) => { if (!e.target.closest('button')) selectTheme(c.dataset.theme); });
  });
  pushHistory();
}

async function selectTheme(themeId) {
  let sessionId, theme, availablePrimaryInfo;
  try {
    ({ sessionId, theme, availablePrimaryInfo } = await api('/api/session', { body: { themeId, mediaId: state.mediaId } }));
  } catch (err) {
    showFatalError(err);
    return;
  }
  state.sessionId = sessionId;
  state.rewriteMeasureId = null; // 新しい記事の作成（リライト案の編集ではない）
  state.rewriteArticle = null;
  state.theme = theme;
  state.availablePrimaryInfo = availablePrimaryInfo;
  state.hearing = { history: [], question: null, questionNumber: 0, maxQuestions: 3, done: false, loading: false };
  state.outline = null;
  state.article = null;
  renderThemeDetail();
}

// ---------------------------------------------------------------
// STEP 2: 記事テーマの詳細
// ---------------------------------------------------------------
function renderThemeDetail() {
  state.screen = 'themeDetail';
  const t = state.theme;
  shell(`
    <div class="wrap">
      <div class="screen-head">
        <div class="eyebrow">STEP 2 ・ テーマ詳細</div>
        <h1>${esc(t.title)}</h1>
        <p>なぜ今このテーマを作るべきかを確認できます。</p>
      </div>
      <div class="card">
        <div class="field-grid">
          <div class="k">推奨優先度</div><div class="v">${esc(t.priority)}</div>
          <div class="k">想定キーワード</div><div class="v">${esc(t.keyword)}</div>
          <div class="k">想定検索ニーズ</div><div class="v">${esc(t.searchIntent)}</div>
          <div class="k">競合状況</div><div class="v">${esc(t.competition)}${t.estimated ? ' <span class="pill grey">AI推測</span>' : ''}</div>
          ${t.volumeEstimate ? `<div class="k">検索ボリューム</div><div class="v">${esc(t.volumeEstimate)} <span class="pill grey">AI推測</span></div>` : ''}
        </div>
        <div class="k" style="font-size:12.5px;font-weight:700;color:var(--sub);margin-top:10px;">作るべき理由</div>
        <ul class="reason-list">${t.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
        <div class="btn-row">
          <button class="btn navy" id="go-primary">記事を作成する →</button>
          <button class="btn ghost" id="back-dash">← ダッシュボードに戻る</button>
        </div>
      </div>
    </div>
  `);
  document.getElementById('go-primary').addEventListener('click', renderPrimaryInfo);
  document.getElementById('back-dash').addEventListener('click', renderDashboard);
  pushHistory();
}

// ---------------------------------------------------------------
// STEP 3: 一次情報確認
// ---------------------------------------------------------------
function renderPrimaryInfo() {
  state.screen = 'primaryInfo';
  const infoHtml = state.availablePrimaryInfo.map((p) => `
    <div class="info-box"><div class="h">${esc(p.label)}</div>${esc(p.text)}</div>
  `).join('') || '<div class="info-box">登録済みの一次情報はまだありません。</div>';

  shell(`
    <div class="wrap">
      <div class="screen-head">
        <div class="eyebrow">STEP 3 ・ 一次情報の確認</div>
        <h1>この記事に使える一次情報</h1>
        <p>自社独自の実績・お客様の声など、記事の独自性のもとになる情報です。</p>
      </div>
      <div class="card">
        <div class="k" style="font-size:12.5px;font-weight:700;color:var(--sub);margin-bottom:8px;">この記事に利用できる情報</div>
        ${infoHtml}
        <div class="missing-box" style="margin-top:14px;">
          <div class="h">この記事をより独自性のある内容にするため、以下の情報が不足しています</div>
          ${esc(state.theme.missingInfoHint)}
        </div>
        <div class="btn-row">
          <button class="btn navy" id="go-hearing">AIに質問してもらう →</button>
        </div>
      </div>
    </div>
  `);
  document.getElementById('go-hearing').addEventListener('click', () => { renderHearing(); askNextQuestion(); });
  pushHistory();
}

// ---------------------------------------------------------------
// STEP 4: AIヒアリング
// ---------------------------------------------------------------
function renderHearing() {
  state.screen = 'hearing';
  const log = state.hearing.history.flatMap((h) => [
    `<div class="bub ai"><div class="who">AI</div>${esc(h.question)}</div>`,
    `<div class="bub user">${esc(h.answer)}</div>`,
  ]).join('');
  const currentQ = state.hearing.question
    ? `<div class="bub ai"><div class="who">AI</div>${esc(state.hearing.question)}</div>`
    : '';
  const thinking = state.hearing.loading ? `<div class="bub thinking">AIが質問を考えています…</div>` : '';

  shell(`
    <div class="wrap">
      <div class="screen-head">
        <div class="eyebrow">STEP 4 ・ AIヒアリング</div>
        <h1>AIが不足している情報を質問します</h1>
        <p>現場目線での見解や実例を教えてください。最大${state.hearing.maxQuestions}問で終了します。</p>
      </div>
      <div class="chat-panel">
        <div class="qcounter">${state.hearing.done ? 'ヒアリング完了' : `質問 ${state.hearing.questionNumber} / ${state.hearing.maxQuestions}`}</div>
        <div class="chat-log" id="chat-log">${log}${currentQ}${thinking}</div>
        ${state.hearing.done ? `
          <div class="btn-row"><button class="btn navy" id="go-outline">記事構成を生成する →</button></div>
        ` : `
          <div class="chat-input-row">
            <textarea id="answer-input" placeholder="回答を入力してください…" ${state.hearing.loading ? 'disabled' : ''}></textarea>
            <button class="btn navy" id="send-answer" ${state.hearing.loading ? 'disabled' : ''}>送信</button>
          </div>
        `}
      </div>
    </div>
  `);
  const logEl = document.getElementById('chat-log');
  if (logEl) logEl.scrollTop = logEl.scrollHeight;

  const sendBtn = document.getElementById('send-answer');
  if (sendBtn) sendBtn.addEventListener('click', submitAnswer);
  const goOutline = document.getElementById('go-outline');
  if (goOutline) goOutline.addEventListener('click', renderOutlineGenerating);
  if (!state.hearing.loading && (state.hearing.question || state.hearing.done || state.hearing.history.length)) pushHistory();
}

async function askNextQuestion() {
  state.hearing.loading = true;
  renderHearing();
  try {
    const r = await api('/api/hearing/next', { body: { sessionId: state.sessionId } });
    state.hearing.loading = false;
    if (r.done) {
      state.hearing.done = true;
    } else {
      state.hearing.question = r.question;
      state.hearing.questionNumber = r.questionNumber;
      state.lastMode = r.mode;
    }
  } catch (e) {
    state.hearing.loading = false;
    toast('AI呼び出しに失敗しました。シミュレーションで続行してください。');
  }
  renderHearing();
}

async function submitAnswer() {
  const ta = document.getElementById('answer-input');
  const answer = (ta.value || '').trim();
  if (!answer) { toast('回答を入力してください'); return; }
  state.hearing.history.push({ question: state.hearing.question, answer });
  state.hearing.question = null;
  state.hearing.loading = true;
  renderHearing();
  try {
    const r = await api('/api/hearing/next', { body: { sessionId: state.sessionId, answer } });
    state.hearing.loading = false;
    if (r.done) {
      state.hearing.done = true;
    } else {
      state.hearing.question = r.question;
      state.hearing.questionNumber = r.questionNumber;
    }
  } catch (e) {
    state.hearing.loading = false;
    state.hearing.done = true;
    toast('AI呼び出しに失敗したため、ここでヒアリングを終了します');
  }
  renderHearing();
}

// ---------------------------------------------------------------
// STEP 5: 記事構成生成
// ---------------------------------------------------------------
async function renderOutlineGenerating() {
  state.screen = 'outline';
  shell(`<div class="wrap"><div class="loading-box"><div class="spinner"></div>AIが記事構成を考えています…</div></div>`);
  try {
    const { outline, mode } = await api('/api/outline', { body: { sessionId: state.sessionId } });
    state.outline = outline;
    state.lastMode = mode;
  } catch (e) {
    toast('記事構成の生成に失敗しました');
  }
  renderOutline();
}

function renderOutline() {
  const o = state.outline;
  const sections = (o.sections || []).map((s) => `
    <div class="outline-item">
      <div class="h2">H2：${esc(s.h2)}</div>
      ${(s.h3s || []).filter(Boolean).map((h3) => `<div class="h3">H3：${esc(h3)}</div>`).join('')}
      <div class="sum">${esc(s.summary || '')}</div>
    </div>
  `).join('');

  shell(`
    <div class="wrap">
      <div class="screen-head">
        <div class="eyebrow">STEP 5 ・ 記事構成</div>
        <h1>${esc(o.title)}</h1>
        <p>${esc(o.intro || '')}</p>
      </div>
      <div class="card">
        ${sections}
        <div class="btn-row">
          <button class="btn navy" id="go-generate">この構成で記事を生成する →</button>
        </div>
      </div>
    </div>
  `);
  document.getElementById('go-generate').addEventListener('click', renderArticleGenerating);
  pushHistory();
}

// ---------------------------------------------------------------
// STEP 6-7: 記事本文生成（+装飾）
// ---------------------------------------------------------------
async function renderArticleGenerating() {
  state.screen = 'generating';
  shell(`<div class="wrap"><div class="loading-box"><div class="spinner"></div>AIが本文・図解・装飾を生成しています…（一次情報とヒアリング回答を反映中）</div></div>`);
  try {
    const { article, mode } = await api('/api/article', { body: { sessionId: state.sessionId } });
    state.article = article;
    state.lastMode = mode;
    await loadMediaLinks(); // 登録済みのリンクを読み込む
    applyDefaultCtaLink(); // 前回使ったリンクを、ボタンの初期値にする
  } catch (e) {
    toast('記事生成に失敗しました');
  }
  state.screen = 'articleEdit';
  renderArticleEdit();
}

// ---------------------------------------------------------------
// 挿入画像の自動生成（AI連携時）。生成中のブロック番号は、画面の再描画をまたいで覚えておく
// ---------------------------------------------------------------
const imageBusy = new Set();

function imageSrc(block, isHero) {
  return block.src || placeholderImageDataUri(block.alt || '', isHero ? 900 : 420, isHero ? 320 : 240);
}

function imageTag(block, i) {
  if (imageBusy.has(i)) return '<span class="proto-tag">画像を生成しています…</span>';
  if (block.src) return '<span class="proto-tag">AI生成画像</span>';
  return state.aiEnabled ? '<span class="proto-tag">仮画像（未生成）</span>' : '<span class="proto-tag">仮画像（AI連携時に自動生成）</span>';
}

function imageButtonLabel(block, i) {
  if (!state.aiEnabled) return '🖼 画像変更';
  if (imageBusy.has(i)) return '⏳ 生成中…';
  return block.src ? '🖼 再生成' : '🖼 画像を生成';
}

// 1枚を生成して、そのブロックだけ表示を差し替える（他の編集中の内容は触らない）
async function generateImage(i) {
  if (imageBusy.has(i)) return true;
  imageBusy.add(i);
  refreshImageBlock(i);
  let ok = true;
  try {
    const res = await fetch('/api/image/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: state.sessionId, blockIndex: i }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '画像を生成できませんでした');
    state.article.blocks[i].src = data.src;
  } catch (e) {
    ok = false;
    toast(e.message || '画像を生成できませんでした');
  }
  imageBusy.delete(i);
  refreshImageBlock(i);
  return ok;
}

function refreshImageBlock(i) {
  const wrap = app.querySelector(`[data-block="${i}"]`);
  if (!wrap || !state.article) return;
  wrap.outerHTML = blockToEditableHtml(state.article.blocks[i], i);
  bindImageButton(i);
}

function bindImageButton(i) {
  const btn = app.querySelector(`[data-block="${i}"] [data-reimg]`);
  if (!btn) return;
  btn.addEventListener('click', () => {
    if (state.aiEnabled) {
      generateImage(i);
    } else {
      toast('画像を再生成しました（仮画像を差し替え）');
      state.article.blocks[i].alt = state.article.blocks[i].alt + '·';
      renderArticleEdit();
    }
  });
}

// 未生成の画像を、上から順に生成する（失敗したら止める）
async function generateAllImages() {
  const todo = state.article.blocks.map((b, i) => (b.type === 'image' && !b.src ? i : -1)).filter((i) => i >= 0);
  for (const i of todo) {
    if (state.screen !== 'articleEdit') return;
    if (!(await generateImage(i))) return;
  }
  if (todo.length && state.screen === 'articleEdit') toast('画像の生成が完了しました');
}

// ---------------------------------------------------------------
// 記事のボタン（無料相談など）のリンク先URL：入力して、次回から選べるように登録できる。
// 登録したリンクは、登録済みのメディアごとに保存される（メディアを登録していない場合は、入力のみ）。
// ---------------------------------------------------------------
function safeUrl(u) {
  try {
    const x = new URL(String(u || '').trim());
    return ['http:', 'https:'].includes(x.protocol) ? x.toString() : '';
  } catch (e) { return ''; }
}

let ctaDeletingLink = null; // 削除の確認待ちのリンクID

// 登録済みのリンクを読み込み、リンク未設定のボタンには、前回使ったリンクを、初期値として入れる（画面上で変更できる）
async function loadMediaLinks() {
  state.mediaLinks = [];
  state.mediaDefaultLinkId = null;
  if (!state.registeredMedia) return;
  try {
    const data = await api(`/api/registered-media/${state.registeredMedia.id}/links`);
    state.mediaLinks = data.links || [];
    state.mediaDefaultLinkId = data.defaultLinkId || null;
  } catch (e) { /* 取得できなくても、URLの入力はできる */ }
}

function applyDefaultCtaLink() {
  const def = (state.mediaLinks || []).find((l) => l.id === state.mediaDefaultLinkId);
  if (!def || !state.article) return;
  state.article.blocks.forEach((b) => {
    if (b.type === 'cta' && !b.url && !b.linkInit) { b.url = def.url; }
    if (b.type === 'cta') b.linkInit = true;
  });
}

function ctaLinkControlsHtml(block, i) {
  const links = state.mediaLinks || [];
  const known = links.find((l) => l.url === block.url);
  const options = [`<option value="" ${block.url ? '' : 'selected'}>リンクなし</option>`]
    .concat(links.map((l) => `<option value="id:${esc(l.id)}" ${known && known.id === l.id ? 'selected' : ''}>${esc(l.label)}（${esc(l.url)}）</option>`))
    .concat(block.url && !known ? [`<option value="custom" selected>入力したURL：${esc(block.url)}</option>`] : [])
    .concat(['<option value="new">URLを入力する…</option>']);
  const small = 'font-size:12px;color:var(--sub);';
  const field = 'padding:6px 8px;border:1px solid var(--line);border-radius:6px;font-size:12.5px;font-family:inherit;box-sizing:border-box;';
  return `<div class="cta-link" data-cta="${i}" style="border:1px dashed var(--line);border-radius:10px;padding:10px 12px;margin:-8px 0 14px;background:#fafbfd;">
    <div style="${small}font-weight:700;margin-bottom:6px;">ボタンの設定</div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px;">
      <label style="${small}">ボタンの文字</label>
      <input class="cta-label" type="text" maxlength="30" value="${esc(block.buttonLabel || '')}" style="${field}width:180px;">
    </div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
      <label style="${small}">リンク先</label>
      <select class="cta-sel" style="${field}max-width:100%;">${options}</select>
      ${known && state.registeredMedia ? (ctaDeletingLink === known.id
        ? `<span style="font-size:12px;color:var(--danger);">登録を削除します。</span><button class="btn danger-outline small cta-del-yes" type="button" data-link="${esc(known.id)}">削除する</button><button class="btn ghost small cta-del-no" type="button">やめる</button>`
        : `<button class="btn ghost small cta-del" type="button" data-link="${esc(known.id)}">この登録を削除</button>`) : ''}
    </div>
    <div class="cta-new" hidden style="margin-top:8px;display:none;gap:6px;flex-wrap:wrap;align-items:center;">
      <input class="cta-url" type="text" placeholder="https://example.co.jp/contact" style="${field}width:min(420px,100%);">
      <button class="btn navy small cta-url-ok" type="button">このURLを使う</button>
    </div>
    <div class="cta-reg" hidden style="margin-top:8px;display:none;gap:6px;flex-wrap:wrap;align-items:center;">
      <span style="${small}">このURLを、次回から選べるように<b>登録しますか？</b></span>
      <input class="cta-reg-name" type="text" maxlength="40" placeholder="名前（例：無料相談ページ）" style="${field}width:200px;">
      <button class="btn navy small cta-reg-yes" type="button">登録する</button>
      <button class="btn ghost small cta-reg-no" type="button">登録しない</button>
    </div>
    ${state.registeredMedia ? '' : `<div style="${small}margin-top:6px;">※メディアを登録して分析すると、入力したURLを保存して、次回から選べるようになります。</div>`}
  </div>`;
}

function showFlex(el, on) {
  el.hidden = !on;
  el.style.display = on ? 'flex' : 'none';
}

// 1つのボタン（相談ボックス）の、リンク設定の操作を結びつける
function bindCtaControls(i) {
  const box = app.querySelector(`.cta-link[data-cta="${i}"]`);
  if (!box) return;
  const block = state.article.blocks[i];
  const refresh = () => refreshCtaBlock(i);

  box.querySelector('.cta-label').addEventListener('input', (e) => {
    block.buttonLabel = e.target.value;
    const preview = app.querySelector(`[data-block="${i}"] .cta-preview`);
    if (preview) preview.textContent = block.buttonLabel || '相談する';
  });

  box.querySelector('.cta-sel').addEventListener('change', async (e) => {
    const v = e.target.value;
    showFlex(box.querySelector('.cta-new'), v === 'new');
    showFlex(box.querySelector('.cta-reg'), false);
    if (v === 'new') { box.querySelector('.cta-url').focus(); return; }
    if (v === '') { block.url = ''; refresh(); return; }
    if (v.startsWith('id:')) {
      const link = state.mediaLinks.find((l) => l.id === v.slice(3));
      if (link) {
        block.url = link.url;
        state.mediaDefaultLinkId = link.id;
        if (state.registeredMedia) fetch(`/api/registered-media/${state.registeredMedia.id}/links/${link.id}/use`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => {});
      }
      refresh();
    }
  });

  box.querySelector('.cta-url-ok').addEventListener('click', () => {
    const url = safeUrl(box.querySelector('.cta-url').value);
    if (!url) { toast('URLの形式が正しくありません（https://… の形で入力してください）'); return; }
    block.url = url;
    const already = (state.mediaLinks || []).find((l) => l.url.toLowerCase() === url.toLowerCase());
    if (state.registeredMedia && !already) {
      // 登録するかどうかを聞く
      showFlex(box.querySelector('.cta-new'), false);
      const nameInput = box.querySelector('.cta-reg-name');
      showFlex(box.querySelector('.cta-reg'), true);
      nameInput.value = box.querySelector('.cta-label').value || '';
      nameInput.focus();
    } else {
      refresh();
    }
  });

  box.querySelector('.cta-reg-no').addEventListener('click', refresh);
  box.querySelector('.cta-reg-yes').addEventListener('click', async () => {
    const label = box.querySelector('.cta-reg-name').value.trim();
    if (!label) { toast('名前を入力してください（例：無料相談ページ）'); return; }
    try {
      const res = await fetch(`/api/registered-media/${state.registeredMedia.id}/links`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label, url: block.url }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok && !(res.status === 409 && data.existing)) { toast(data.error || '登録できませんでした'); return; }
      const link = res.ok ? data.link : data.existing;
      if (res.ok) state.mediaLinks.push(link);
      state.mediaDefaultLinkId = link.id;
      toast(res.ok ? 'リンクを登録しました。次回から、選べます' : 'すでに登録されているリンクです');
      refresh();
    } catch (e) { if (!e.authExpired) toast('登録できませんでした'); }
  });

  const del = box.querySelector('.cta-del');
  if (del) del.addEventListener('click', () => { ctaDeletingLink = del.dataset.link; refresh(); });
  const delNo = box.querySelector('.cta-del-no');
  if (delNo) delNo.addEventListener('click', () => { ctaDeletingLink = null; refresh(); });
  const delYes = box.querySelector('.cta-del-yes');
  if (delYes) delYes.addEventListener('click', async () => {
    const id = delYes.dataset.link;
    try {
      const res = await fetch(`/api/registered-media/${state.registeredMedia.id}/links/${id}`, { method: 'DELETE' });
      if (!res.ok) { toast('削除できませんでした'); return; }
      state.mediaLinks = state.mediaLinks.filter((l) => l.id !== id);
      if (state.mediaDefaultLinkId === id) state.mediaDefaultLinkId = null;
      ctaDeletingLink = null;
      toast('登録を削除しました（記事に入っているURLは、そのまま残ります）');
      state.article.blocks.forEach((b, idx) => { if (b.type === 'cta') refreshCtaBlock(idx); });
    } catch (e) { if (!e.authExpired) toast('削除できませんでした'); }
  });
}

// 相談ボックスを、その場で描き直す（他のブロックの編集内容は、そのまま）
function refreshCtaBlock(i) {
  const wrap = app.querySelector(`[data-block="${i}"]`);
  if (!wrap) return;
  wrap.outerHTML = blockToEditableHtml(state.article.blocks[i], i);
  const fresh = app.querySelector(`[data-block="${i}"]`);
  bindEditables(fresh);
  bindCtaControls(i);
}

function bindEditables(root) {
  root.querySelectorAll('.editable').forEach((elm) => {
    elm.addEventListener('blur', () => {
      const idx = Number(elm.closest('[data-block]').dataset.block);
      const field = elm.dataset.field;
      if (field) state.article.blocks[idx][field] = elm.textContent;
    });
  });
}

function blockToEditableHtml(block, i) {
  const tools = `<div class="block-toolbar">
      ${['paragraph', 'list', 'quote'].includes(block.type) ? `<button data-regen="${i}">↻ 再生成</button>` : ''}
      ${block.type === 'image' ? `<button data-reimg="${i}" ${imageBusy.has(i) ? 'disabled' : ''}>${imageButtonLabel(block, i)}</button>` : ''}
    </div>`;
  let inner = '';
  switch (block.type) {
    case 'image': {
      const isHero = block.role === 'hero';
      inner = `<img class="art-img ${isHero ? '' : 'inline'}" src="${esc(imageSrc(block, isHero))}" alt="${esc(block.alt)}" ${imageBusy.has(i) ? 'style="opacity:.45"' : ''}>
        <div class="img-cap">${esc(block.alt)}${block.caption ? ' - ' + esc(block.caption) : ''}${imageTag(block, i)}</div>`;
      break;
    }
    case 'h2': inner = `<h2 class="art-h2 editable" contenteditable="true" data-field="text">${esc(block.text)}</h2>`; break;
    case 'h3': inner = `<h3 class="art-h3 editable" contenteditable="true" data-field="text">${esc(block.text)}</h3>`; break;
    case 'paragraph': inner = `<p class="art-p editable" contenteditable="true" data-field="text">${esc(block.text)}</p>`; break;
    case 'list': inner = `<ul class="art-list">${(block.items || []).map((it) => `<li class="editable" contenteditable="true">${esc(it)}</li>`).join('')}</ul>`; break;
    case 'quote': inner = `<div class="art-quote"><span class="editable" contenteditable="true" data-field="text">${esc(block.text)}</span><cite>${esc(block.cite || '')}</cite></div>`; break;
    case 'callout': inner = `<div class="art-callout editable" contenteditable="true" data-field="text">💡 ${esc(block.text)}</div>`; break;
    case 'table': inner = `<table class="art-table">${block.caption ? `<caption>${esc(block.caption)}</caption>` : ''}
        <thead><tr>${(block.headers || []).map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
        <tbody>${(block.rows || []).map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
      break;
    case 'cta': inner = `<div class="art-cta"><div class="t editable" contenteditable="true" data-field="text">${esc(block.text)}</div><button type="button" class="cta-preview">${esc(block.buttonLabel || '相談する')}</button>${safeUrl(block.url) ? `<div style="font-size:11px;opacity:.85;margin-top:6px;word-break:break-all;">リンク先：${esc(block.url)}</div>` : ''}</div>${ctaLinkControlsHtml(block, i)}`; break;
    default: inner = `<div>${esc(JSON.stringify(block))}</div>`;
  }
  return `<div class="block-wrap" data-block="${i}">${tools}${inner}</div>`;
}

function renderArticleEdit() {
  state.screen = 'articleEdit';
  const a = state.article;
  const blocksHtml = a.blocks.map((b, i) => blockToEditableHtml(b, i)).join('');

  const rw = state.rewriteMeasureId ? state.rewriteArticle : null; // リライト案の編集中は、元の記事の情報が入る
  shell(`
    <div class="wrap wide">
      <div class="screen-head">
        <div class="eyebrow">${rw ? 'リライト案の編集' : 'STEP 6-8 ・ 記事生成・装飾・確認'}</div>
        <h1>${esc(a.title)}</h1>
        <p>本文・画像・装飾を確認し、必要に応じて編集してください（見出し・本文はクリックして直接編集できます）。</p>
      </div>
      <div class="card">
        ${rw ? `<div class="info-box" style="margin-bottom:12px;"><div class="h">リライト案です（元の記事：<a href="${esc(rw.url)}" target="_blank" rel="noopener">${esc(rw.title)}</a>）</div>「WordPressに新しい下書きとして保存」を押すと、「【リライト案】」を付けた<b>新しい下書き</b>を作ります。公開中の元の記事には、手を加えません。「【要確認】」の箇所は、人が確認してから、使ってください。</div>` : ''}
        <div style="font-size:11.5px;color:var(--sub);margin-bottom:10px;">使用した一次情報・ヒアリング回答は本文中に反映されています。<span class="proto-tag">生成モード: ${state.lastMode || (state.aiEnabled ? 'ai' : 'simulated')}</span></div>
        ${state.aiEnabled ? `<div class="info-box" style="margin-bottom:12px;">
          <div class="h">挿入画像は、AI（OpenAI）が自動で生成します</div>
          記事を開くと、画像が上から順に生成されます（1枚につき数十秒）。気に入らない画像は、各画像の「再生成」で作り直せます。画像を1枚生成するごとに、OpenAIの利用料がかかります（費用が膨らまないよう、1記事あたりの生成回数には上限があります）。
          <div style="margin-top:6px;"><button class="btn outline small" id="gen-all-images" type="button">未生成の画像をまとめて生成</button></div>
        </div>` : ''}
        ${blocksHtml}
        <div class="btn-row">
          <button class="btn ghost" id="save-draft">編集内容を保存</button>
          <button class="btn outline" id="go-export">WordPress用のHTMLを書き出す</button>
          <button class="btn gold" id="go-publish">${state.wordpressConnected && state.wordpressReal ? (rw ? 'WordPressに新しい下書きとして保存 →' : 'WordPressに下書き保存 →') : '公開する →'}</button>
        </div>
      </div>
    </div>
  `, rw ? { active: false } : undefined);

  bindEditables(app);
  state.article.blocks.forEach((b, i) => { if (b.type === 'cta') bindCtaControls(i); });
  app.querySelectorAll('[data-regen]').forEach((btn) => btn.addEventListener('click', () => regenerateBlock(Number(btn.dataset.regen))));
  state.article.blocks.forEach((b, i) => { if (b.type === 'image') bindImageButton(i); });
  const genAll = document.getElementById('gen-all-images');
  if (genAll) genAll.addEventListener('click', generateAllImages);
  document.getElementById('go-export').addEventListener('click', renderExport);
  document.getElementById('save-draft').addEventListener('click', async () => {
    await api('/api/article/save', { body: { sessionId: state.sessionId, article: state.article } });
    toast('編集内容を保存しました');
  });
  document.getElementById('go-publish').addEventListener('click', async () => {
    // アカウントに保存済みの接続があれば、接続画面を飛ばして、そのまま下書きを保存する（一度接続すれば、次回から省略）
    if (!state.wordpressConnected) {
      try {
        const st = await api('/api/wordpress/status', { body: { mediaId: state.mediaId } });
        if (st.connected) {
          state.wordpressConnected = true;
          state.wordpressReal = true;
          state.wordpressSiteUrl = st.siteUrl;
          state.wordpressMethod = st.method;
        }
      } catch (e) { if (e.authExpired) return; }
    }
    if (state.wordpressConnected) {
      doPublish();
    } else {
      state.wpConnectContext = 'publish';
      renderWordpressConnect();
    }
  });
  pushHistory();

  // AI連携中は、画像の自動生成を、記事ごとに1回だけ始める（戻る・進むで再描画しても、やり直さない）
  if (state.aiEnabled && state.autoImagesFor !== state.sessionId && state.article.blocks.some((b) => b.type === 'image' && !b.src)) {
    state.autoImagesFor = state.sessionId;
    generateAllImages();
  }
}

// ---------------------------------------------------------------
// WordPress用HTMLの書き出し：WordPressに接続できない（または接続したくない）場合に、
// 記事を、コピー＆貼り付けで WordPress に入れられる形で出力する。
// ---------------------------------------------------------------
async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    toast('コピーしました');
  } catch (e) {
    toast('コピーできませんでした。枠内の文字を選択して、コピーしてください');
  }
}

async function renderExport() {
  state.screen = 'export';
  shell(`<div class="wrap"><div class="loading-box"><div class="spinner"></div>書き出しの準備をしています…</div></div>`);
  let data;
  try {
    await api('/api/article/save', { body: { sessionId: state.sessionId, article: state.article } });
    data = await api('/api/article/export-html', { body: { sessionId: state.sessionId } });
  } catch (e) {
    showFatalError(e);
    return;
  }
  const box = 'width:100%;box-sizing:border-box;font-family:monospace;font-size:12px;padding:10px;border:1px solid var(--line);border-radius:8px;background:#f8fafc;';
  const imgRows = data.images.map((im) => `
    <div style="display:flex;gap:12px;align-items:center;padding:8px 0;border-top:1px solid var(--line);flex-wrap:wrap;">
      ${im.src ? `<img src="${esc(im.src)}" alt="" style="width:120px;border-radius:6px;">` : '<div style="width:120px;height:72px;border-radius:6px;background:#eceff3;color:#8890a0;font-size:11px;display:flex;align-items:center;justify-content:center;">未生成</div>'}
      <div style="flex:1;min-width:200px;">
        <div style="font-weight:700;font-size:12.5px;">${esc(im.role)}</div>
        <div style="font-size:12px;color:var(--sub);">代替テキスト：${esc(im.alt)}</div>
      </div>
      ${im.src ? `<a class="btn outline small" href="${esc(im.src)}" download="${esc(im.filename)}">画像を保存（${esc(im.filename)}）</a>` : '<span style="font-size:11.5px;color:var(--sub);">編集画面で、画像を生成してください</span>'}
    </div>`).join('');

  shell(`
    <div class="wrap">
      <div class="screen-head">
        <div class="eyebrow">STEP 9 ・ WordPress用に書き出す</div>
        <h1>WordPressに貼り付けるための内容</h1>
        <p>WordPressに接続しなくても、次の手順で、記事を WordPress に入れられます。</p>
      </div>
      <div class="card">
        <div class="info-box"><div class="h">貼り付けの手順</div>
          <ol style="margin:4px 0 0 18px;padding:0;line-height:1.8;">
            <li>WordPressの管理画面で「投稿」→「新規追加」を開く。</li>
            <li>下の「タイトル」を、タイトル欄に貼り付ける。</li>
            <li>本文の編集を「テキスト」（HTML）モードにして、下の「本文のHTML」を貼り付ける（クラシックエディターの場合は、右上の「テキスト」タブ）。</li>
            <li>「画像を保存」で保存した画像を、「メディアを追加」からアップロードし、本文の【ここに画像を挿入】の位置に入れる。</li>
            <li>アイキャッチ画像を、右側の「アイキャッチ画像を設定」から設定する。</li>
            <li>内容を確認して、「下書きとして保存」または「公開」を押す（このアプリは公開しません）。</li>
          </ol>
        </div>
        <h3 style="margin:14px 0 6px;">タイトル</h3>
        <input id="exp-title" type="text" readonly value="${esc(data.title)}" style="${box}font-family:inherit;font-size:13.5px;">
        <div class="btn-row" style="margin-top:6px;"><button class="btn navy small" id="copy-title">タイトルをコピー</button></div>
        <h3 style="margin:14px 0 6px;">本文のHTML</h3>
        <textarea id="exp-html" readonly rows="14" style="${box}">${esc(data.html)}</textarea>
        <div class="btn-row" style="margin-top:6px;"><button class="btn navy small" id="copy-html">本文のHTMLをコピー</button></div>
        <h3 style="margin:14px 0 4px;">画像</h3>
        ${imgRows || '<div style="font-size:12.5px;color:var(--sub);">この記事に、画像はありません。</div>'}
        <div class="btn-row"><button class="btn ghost" id="exp-back">← 編集画面に戻る</button></div>
      </div>
    </div>
  `);
  document.getElementById('copy-title').addEventListener('click', () => copyText(data.title));
  document.getElementById('copy-html').addEventListener('click', () => copyText(data.html));
  document.getElementById('exp-html').addEventListener('focus', (e) => e.target.select());
  document.getElementById('exp-back').addEventListener('click', renderArticleEdit);
  pushHistory();
}

async function regenerateBlock(idx) {
  toast('再生成しています…');
  try {
    const { block } = await api('/api/article/regenerate-block', { body: { sessionId: state.sessionId, blockIndex: idx } });
    state.article.blocks[idx] = block;
    renderArticleEdit();
  } catch (e) {
    toast('再生成に失敗しました');
  }
}

// ---------------------------------------------------------------
// STEP 9: 公開 → 実際のメディア記事ページ
// ---------------------------------------------------------------
async function doPublish() {
  const real = !!(state.wordpressConnected && state.wordpressReal);
  shell(`<div class="wrap"><div class="loading-box"><div class="spinner"></div>${real ? 'WordPressに下書きを保存しています…（画像のアップロードを含むため、少しかかります）' : '公開しています…'}</div></div>`);
  let res;
  let data;
  try {
    await api('/api/article/save', { body: { sessionId: state.sessionId, article: state.article } });
    res = await fetch('/api/publish', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: state.sessionId, expectWordpress: real }) });
    data = await res.json().catch(() => ({}));
  } catch (err) {
    showFatalError(err);
    return;
  }
  if (res.status === 409) {
    // サーバーを再起動した等で、WordPressの接続情報が失われている
    state.wordpressConnected = false;
    state.wordpressReal = false;
    state.wpConnectContext = 'publish';
    renderWordpressConnect();
    toast('WordPressの接続が切れていました。もう一度接続してください');
    return;
  }
  if (!res.ok) {
    renderPublishError(data.error || '投稿できませんでした');
    return;
  }
  state.publishInfo = data;
  state.screen = 'published';
  renderPublishedStatus();
}

function renderPublishError(message) {
  state.screen = 'publishError';
  state.publishErrorMessage = message;
  shell(`
    <div class="wrap">
      <div class="screen-head">
        <div class="eyebrow">STEP 9 ・ WordPressへの投稿</div>
        <h1>WordPressに投稿できませんでした</h1>
      </div>
      <div class="card">
        <div class="missing-box"><div class="h">${esc(message)}</div>記事の内容は失われていません。原因を確認して、もう一度お試しください。</div>
        <div class="btn-row">
          <button class="btn navy" id="pub-retry">もう一度投稿する</button>
          <button class="btn outline" id="pub-reconnect">WordPressの接続を見直す</button>
          <button class="btn ghost" id="pub-back">← 編集画面に戻る</button>
        </div>
      </div>
    </div>
  `);
  document.getElementById('pub-retry').addEventListener('click', doPublish);
  document.getElementById('pub-reconnect').addEventListener('click', () => { state.wpConnectContext = 'publish'; renderWordpressConnect(); });
  document.getElementById('pub-back').addEventListener('click', renderArticleEdit);
  pushHistory();
}

function renderPublishedStatus() {
  const info = state.publishInfo;
  if (info && info.mode === 'wordpress-draft') {
    shell(`
      <div class="wrap">
        <div class="screen-head">
          <div class="eyebrow">STEP 10 ・ WordPressへの下書き投稿</div>
          <h1>${info.isRewrite ? 'リライト案を、WordPressに新しい下書きとして保存しました' : 'WordPressに下書きとして保存しました'}</h1>
          <p>${info.isRewrite ? '元の記事は、そのままです。下書きの内容を確認してください。' : 'この記事はまだ公開されていません。WordPressの管理画面で内容を確認し、問題がなければ公開してください。'}</p>
        </div>
        <div class="card">
          <div class="field-grid">
            <div class="k">投稿先</div><div class="v">${esc(info.siteName || '')} ${esc(info.siteUrl)}</div>
            <div class="k">状態</div><div class="v">下書き（非公開）</div>
            <div class="k">画像</div><div class="v">${info.imagesInDraft}枚をアップロード${info.hasFeatured ? '（アイキャッチ画像を設定済み）' : ''}${info.skippedImages ? `／未生成の仮画像${info.skippedImages}枚は、含めていません` : ''}</div>
            <div class="k">保存日時</div><div class="v">${new Date(info.savedAt).toLocaleString('ja-JP')}</div>
          </div>
          <div class="btn-row">
            <a class="btn navy" href="${esc(info.editUrl)}" target="_blank" rel="noopener">WordPressで下書きを開く →</a>
            <a class="btn outline" href="${esc(info.previewUrl)}" target="_blank" rel="noopener">プレビューを見る</a>
            ${info.isRewrite ? '<button class="btn navy" id="go-measures2">施策管理で確認する</button><button class="btn ghost" id="back-articles2">記事一覧へ</button>' : '<button class="btn ghost" id="back-dash2">ダッシュボードに戻る</button>'}
          </div>
          ${info.isRewrite ? '<div class="info-box" style="margin-top:12px;"><div class="h">元の記事と差し替えるときは</div>記事のURLを変えないために、<b>下書きの内容を、元の記事の編集画面にコピーして、更新する</b>方法がおすすめです（URLが変わると、検索順位が引き継がれないことがあります）。コピー用の内容は、編集画面の「WordPress用のHTMLを書き出す」から取れます。差し替えて公開したら、施策管理で、ステータスを「完了」にしてください（効果測定の基準日になります）。</div>' : ''}
          <div style="font-size:11px;color:var(--sub);margin-top:8px;">※このアプリからは、記事を公開しません。編集後にもう一度「WordPressに下書き保存」を押すと、同じ下書きを更新します（WordPress側ですでに公開した場合は、公開済みの記事には手を加えず、別の下書きとして保存します）。</div>
        </div>
      </div>
    `);
    const bd = document.getElementById('back-dash2');
    if (bd) bd.addEventListener('click', renderDashboard);
    const gm = document.getElementById('go-measures2');
    if (gm) gm.addEventListener('click', renderMeasures);
    const ba = document.getElementById('back-articles2');
    if (ba) ba.addEventListener('click', renderArticles);
    pushHistory();
    return;
  }
  shell(`
    <div class="wrap">
      <div class="screen-head">
        <div class="eyebrow">STEP 10 ・ 公開完了</div>
        <h1>この記事は公開されました</h1>
      </div>
      <div class="card">
        <div class="field-grid">
          <div class="k">記事URL</div><div class="v"><a href="#" id="open-media">${state.publishInfo.url}</a></div>
          <div class="k">公開日時</div><div class="v">${new Date(state.publishInfo.publishedAt).toLocaleString('ja-JP')}</div>
          <div class="k">監視状況</div><div class="v">検索順位・流入の監視対象になりました（3.11）</div>
        </div>
        <div class="btn-row">
          <button class="btn navy" id="open-media-btn">公開された記事を見る →</button>
          <button class="btn ghost" id="back-dash2">ダッシュボードに戻る</button>
        </div>
      </div>
    </div>
  `);
  document.getElementById('open-media-btn').addEventListener('click', () => renderMediaPage(state.publishInfo.articleId));
  document.getElementById('open-media').addEventListener('click', (e) => { e.preventDefault(); renderMediaPage(state.publishInfo.articleId); });
  document.getElementById('back-dash2').addEventListener('click', renderDashboard);
  pushHistory();
}

function blockToReaderHtml(block) {
  switch (block.type) {
    case 'image': {
      const isHero = block.role === 'hero';
      return `<img class="art-img ${isHero ? '' : 'inline'}" src="${esc(block.src || placeholderImageDataUri(block.alt || '', isHero ? 900 : 420, isHero ? 340 : 240))}" alt="${esc(block.alt)}"><div class="img-cap">${esc(block.caption || '')}</div>`;
    }
    case 'h2': return `<h2 class="art-h2">${esc(block.text)}</h2>`;
    case 'h3': return `<h3 class="art-h3">${esc(block.text)}</h3>`;
    case 'paragraph': return `<p class="art-p">${esc(block.text)}</p>`;
    case 'list': return `<ul class="art-list">${(block.items || []).map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`;
    case 'quote': return `<div class="art-quote">${esc(block.text)}<cite>${esc(block.cite || '')}</cite></div>`;
    case 'callout': return `<div class="art-callout">💡 ${esc(block.text)}</div>`;
    case 'table': return `<table class="art-table">${block.caption ? `<caption>${esc(block.caption)}</caption>` : ''}<thead><tr>${(block.headers || []).map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${(block.rows || []).map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    case 'cta': {
      const url = safeUrl(block.url);
      const label = esc(block.buttonLabel || '相談する');
      return `<div class="art-cta"><div class="t">${esc(block.text)}</div>${url ? `<a class="cta-btn" href="${esc(url)}" target="_blank" rel="noopener">${label}</a>` : `<button type="button">${label}</button>`}</div>`;
    }
    default: return '';
  }
}

async function renderMediaPage(articleId) {
  state.screen = 'mediaPage';
  app.innerHTML = `<div class="loading-box"><div class="spinner"></div>読み込み中…</div>`;
  let rec;
  try {
    rec = await api(`/api/media/${articleId}`);
  } catch (err) {
    showFatalError(err);
    return;
  }
  const body = rec.blocks.map(blockToReaderHtml).join('');
  app.innerHTML = `
    <div class="media-shell">
      <div class="dev-banner">🧪 これはプロトタイプの疑似メディアページです（実際の一般公開サイトではありません）</div>
      <div class="media-header">
        <span class="logo">${esc(rec.theme?.industry || '')} メディア（デモ）</span>
        <div class="menu"><span>コラム一覧</span><span>会社情報</span><span>お問い合わせ</span></div>
      </div>
      <div class="media-crumbs">ホーム ＞ コラム ＞ ${esc(rec.title)}</div>
      <div class="media-article">
        <div class="cat">外壁塗装コラム</div>
        <h1>${esc(rec.title)}</h1>
        <div class="media-meta"><span>公開日：${new Date(rec.publishedAt).toLocaleDateString('ja-JP')}</span><span>執筆：編集部</span></div>
        ${body}
      </div>
      <div class="media-related">
        <h4>関連記事</h4>
        <div class="items">
          <div class="item">外壁塗装の費用相場について</div>
          <div class="item">外壁塗装は何年ごとに必要か</div>
        </div>
      </div>
      <div class="media-footer">© デモ企業（メディアコンパス極プロトタイプ）</div>
    </div>
    <button class="btn navy" style="position:fixed;bottom:20px;right:20px;z-index:30;" id="back-to-app">← プロトタイプに戻る</button>
  `;
  document.getElementById('back-to-app').addEventListener('click', renderPublishedStatus);
  pushHistory();
}

// ---------------------------------------------------------------
// 記事一覧・監視（公開後）＋「今、直すべき記事」
// ---------------------------------------------------------------
async function renderMonitoring() {
  state.screen = 'monitoring';
  shell(`<div class="wrap"><div class="loading-box"><div class="spinner"></div>読み込み中…</div></div>`, { active: false });
  let mine, fixCandidate;
  try {
    ({ mine, fixCandidate } = await api('/api/monitoring'));
  } catch (err) {
    showFatalError(err);
    return;
  }

  const mineHtml = mine.length
    ? mine.map((a) => `<div class="card"><span class="pill ok">監視中</span><h3>${esc(a.title)}</h3><div class="field-grid"><div class="k">公開日時</div><div class="v">${new Date(a.publishedAt).toLocaleString('ja-JP')}</div><div class="k">状態</div><div class="v">${esc(a.status)}</div></div></div>`).join('')
    : '<div class="card">まだ公開した記事がありません。ダッシュボードから記事を作成してみてください。</div>';

  shell(`
    <div class="wrap">
      <div class="screen-head">
        <div class="eyebrow">記事一覧・監視</div>
        <h1>公開した記事の状態</h1>
        <p>検索順位・流入等を継続的に監視します（3.11）。</p>
      </div>
      ${mineHtml}
      <div class="screen-head" style="margin-top:26px;">
        <div class="eyebrow">今、直すべき記事（デモ用の既存記事）</div>
      </div>
      <div class="card danger-edge clickable" id="fix-card">
        <span class="pill danger">優先度：${esc(fixCandidate.priority)}</span>
        <h3>${esc(fixCandidate.title)}</h3>
        <div class="status-row">
          <span>順位　<b>${fixCandidate.stats.rankBefore}位 → ${fixCandidate.stats.rankNow}位</b></span>
          <span>クリック数　<b>前期間比 ${fixCandidate.stats.ctrChangePct}%</b></span>
        </div>
        <div class="field-grid"><div class="k">判定方針</div><div class="v">順位変動・表示回数など複数指標の変化度合いから「今、直す価値が高い記事」を判定（単純な順位しきい値ではない）</div></div>
        <div class="btn-row"><button class="btn outline small">修正箇所を見る →</button></div>
      </div>
    </div>
  `, { active: false });
  state.fixArticle = fixCandidate;
  document.getElementById('fix-card').addEventListener('click', renderFixDetail);
  pushHistory();
}

async function renderFixDetail() {
  state.screen = 'fixDetail';
  let rec;
  try {
    rec = await api(`/api/fix-candidates/${state.fixArticle.id}`);
  } catch (err) {
    showFatalError(err);
    return;
  }
  state.fixArticle = rec;
  const sectionsHtml = rec.sections.map((s) => `
    <div class="card">
      <h3>${esc(s.heading)}</h3>
      <div class="field-grid">
        <div class="k">なぜ修正か</div><div class="v">${esc(s.issue)}</div>
        <div class="k">推奨対応</div><div class="v">${esc(s.recommendation)}</div>
      </div>
      <div class="btn-row"><button class="btn navy small" data-rewrite="${s.id}">AIでリライトする →</button></div>
      <div id="rewrite-result-${s.id}"></div>
    </div>
  `).join('');

  shell(`
    <div class="wrap">
      <div class="screen-head">
        <div class="eyebrow">修正箇所</div>
        <h1>${esc(rec.title)}</h1>
        <p>順位低下・情報の陳腐化など複数シグナルから検知した、修正が必要な箇所です。</p>
      </div>
      ${sectionsHtml}
      <div class="btn-row"><button class="btn ghost" id="back-mon">← 一覧に戻る</button></div>
    </div>
  `, { active: false });

  document.getElementById('back-mon').addEventListener('click', renderMonitoring);
  app.querySelectorAll('[data-rewrite]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true; btn.textContent = 'AIが検討中…';
      try {
        const r = await api('/api/rewrite', { body: { sectionId: btn.dataset.rewrite } });
        document.getElementById(`rewrite-result-${btn.dataset.rewrite}`).innerHTML = `
          <div class="missing-box" style="margin-top:10px;">
            <div class="h">修正理由</div>${esc(r.reason)}
            <div class="h" style="margin-top:8px;">参照した情報</div>${esc(r.referencedInfo)}
            <div class="h" style="margin-top:8px;">リライト案</div>${esc(r.rewriteText)}
          </div>`;
        btn.textContent = '再度リライトする';
        btn.disabled = false;
      } catch (e) {
        toast('リライト生成に失敗しました');
        btn.disabled = false;
      }
    });
  });
  pushHistory();
}

// ---------------------------------------------------------------
// ブラウザの戻る/進むボタン対応【新設】：画面名 → 再描画関数のマッピング
// ---------------------------------------------------------------
// ---------------------------------------------------------------
// アカウント・施策のステータス管理（ローカル版）
// ログインしたアカウントごとに、施策（やること）と、その進み具合（ステータス）を管理する。
// ---------------------------------------------------------------
const STATUS_LIST = ['未着手', '対応中', '確認待ち', '完了'];
const STATUS_PILL = { 未着手: 'grey', 対応中: 'gold', 確認待ち: 'blue', 完了: 'ok' };

let measureCache = []; // 取得済みの施策（画面の描画用。保存の正はサーバー側）
let editingId = null; // 編集中の施策
let deletingId = null; // 削除の確認待ちの施策
let measureDraft = { title: '', memo: '', status: '未着手' }; // 登録フォームの入力途中の内容

// ---------------------------------------------------------------
// 記事一覧・リライト（ローカル版）
// 登録済みメディアのWordPressから、投稿済み記事を取り込み、GSCの実績と合わせて「リライト候補」を出す。
// 候補から「リライト施策」を作り、AIがリライト案を作る。保存先は、WordPressの「新しい下書き」。
// ---------------------------------------------------------------
let articlesData = null; // GET /api/articles の結果
let articlesFilter = 'candidates'; // 'candidates' | 'all'
let articlesPage = 1;
const ARTICLES_PER_PAGE = 30;

async function postJson(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

const fmtD = (iso) => (iso ? new Date(iso).toLocaleDateString('ja-JP') : '-');
const PRIORITY_PILL = { 高: 'danger', 中: 'gold', 低: 'grey' };

// 現在の登録済みメディアの、作業環境（WordPress・GSCの接続を持つ）を確保して、画面の状態に反映する
async function ensureWorkspace(reg) {
  const e = await api('/api/media/ensure', { body: { registeredId: reg.id } });
  state.mediaId = e.mediaId;
  state.mediaState = 'existing';
  state.registeredMedia = e.registered;
  return e;
}

// メディアを選ぶ（記事一覧に入るとき、メディアが決まっていない場合）
async function renderArticlesPickMedia() {
  state.screen = 'articlesPick';
  shell(`<div class="wrap"><div class="loading-box"><div class="spinner"></div>読み込み中…</div></div>`, { active: false });
  let media;
  try {
    ({ media } = await api('/api/registered-media'));
  } catch (e) { if (!e.authExpired) showFatalError(e); return; }
  const items = media.map((m) => `
    <div class="card clickable" data-reg="${esc(m.id)}">
      <h3>${esc(m.name)}</h3>
      <div style="font-size:12.5px;color:var(--sub);word-break:break-all;">${esc(m.siteUrl)}</div>
    </div>`).join('');
  shell(`
    <div class="wrap">
      <div class="screen-head">
        <div class="eyebrow">記事一覧・リライト</div>
        <h1>どのメディアの記事を見ますか？</h1>
        <p>登録済みのメディアから選んでください。</p>
      </div>
      ${items || '<div class="card" style="color:var(--sub);font-size:13px;">登録済みのメディアがありません。「既存メディアを分析する」から、メディアを登録してください。</div>'}
    </div>
  `, { active: false });
  app.querySelectorAll('[data-reg]').forEach((c) => c.addEventListener('click', async () => {
    const reg = media.find((m) => m.id === c.dataset.reg);
    state.registeredMedia = reg;
    renderArticles();
  }));
  pushHistory();
}

async function renderArticles() {
  state.screen = 'articles';
  if (!state.registeredMedia) { renderArticlesPickMedia(); return; }
  shell(`<div class="wrap"><div class="loading-box"><div class="spinner"></div>記事一覧を読み込んでいます…</div></div>`, { active: false });
  try {
    await ensureWorkspace(state.registeredMedia);
    articlesData = await api(`/api/articles?mediaId=${encodeURIComponent(state.mediaId)}`);
  } catch (e) {
    if (e.authExpired) return;
    state.registeredMedia = null; // 登録が削除された等
    renderArticlesPickMedia();
    return;
  }
  articlesPage = 1;
  drawArticles();
  pushHistory();
}

function metricLine(cur, prev) {
  if (!cur) return '<span style="color:var(--sub);">検索実績：なし（直近28日）</span>';
  const diff = (a, b, goodWhenUp = true, unit = '') => {
    if (!prev || prev[b] == null || cur[a] == null) return '';
    const d = Math.round((cur[a] - prev[b]) * 10) / 10;
    if (d === 0) return '';
    const good = goodWhenUp ? d > 0 : d < 0;
    return ` <span style="color:${good ? 'var(--ok)' : 'var(--danger)'};">(${d > 0 ? '+' : ''}${d}${unit})</span>`;
  };
  return `表示 ${cur.impressions.toLocaleString()}回${diff('impressions', 'impressions')}　クリック ${cur.clicks.toLocaleString()}回${diff('clicks', 'clicks')}　クリック率 ${cur.ctr}%${diff('ctr', 'ctr', true, '%')}　平均順位 ${cur.position}位${diff('position', 'position', false)}`;
}

function drawArticles() {
  const d = articlesData;
  const all = d.articles;
  const cands = all.filter((a) => a.candidate && a.candidate.priority);
  const list = articlesFilter === 'candidates' ? cands : all;
  const pages = Math.max(1, Math.ceil(list.length / ARTICLES_PER_PAGE));
  if (articlesPage > pages) articlesPage = pages;
  const slice = list.slice((articlesPage - 1) * ARTICLES_PER_PAGE, articlesPage * ARTICLES_PER_PAGE);
  const per = d.periods ? `${d.periods.cur.startDate}〜${d.periods.cur.endDate}（比較：その前の28日）` : null;

  const rows = slice.map((a) => {
    const rw = d.rewrites[a.id];
    const c = a.candidate || {};
    return `<div class="card" data-article="${a.id}">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        ${c.priority ? `<span class="pill ${PRIORITY_PILL[c.priority]}">リライト候補：${esc(c.priority)}</span>` : '<span class="pill grey">候補なし</span>'}
        ${rw ? `<span class="pill ${rw.status === '完了' ? 'ok' : 'blue'}">リライト施策：${esc(rw.status)}</span>` : ''}
        <span style="font-size:11px;color:var(--sub);">公開 ${esc(fmtD(a.date))}／更新 ${esc(fmtD(a.modified))}</span>
      </div>
      <h3 style="margin:6px 0;"><a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.title)}</a></h3>
      <div style="font-size:12.5px;color:var(--sub);">${metricLine(a.cur, a.prev)}</div>
      ${c.reasons && c.reasons.length ? `<ul class="reason-list" style="margin-top:6px;">${c.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
      <div class="btn-row">
        ${rw ? '<button class="btn outline small" data-act="view">施策を見る</button>' : ''}
        <button class="btn navy small" data-act="rewrite">${rw ? 'もう一度リライト案を作る' : 'この記事をリライトする →'}</button>
      </div>
    </div>`;
  }).join('');

  shell(`
    <div class="wrap">
      <div class="screen-head">
        <div class="eyebrow">記事一覧・リライト</div>
        <h1>${esc(d.media.name)} の記事</h1>
        <p>投稿済みの記事を、検索実績と照らし合わせて、リライトの候補を出します。</p>
      </div>
      <div class="card">
        <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
          <button class="btn navy small" id="art-sync">${d.syncedAt ? '最新の状態に更新する' : '記事を取り込む（WordPress＋GSC）'}</button>
          <button class="btn ghost small" id="art-switch">メディアを切り替える</button>
          <button class="btn ghost small" id="art-measures">施策管理へ</button>
          <span style="font-size:11.5px;color:var(--sub);">${d.syncedAt ? `最終取り込み：${esc(new Date(d.syncedAt).toLocaleString('ja-JP'))}　${all.length}本` : 'まだ記事を取り込んでいません。'}${per ? `<br>検索実績の期間：${esc(per)}` : ''}</span>
        </div>
        ${d.note ? `<div class="missing-box" style="margin-top:10px;">${esc(d.note)}</div>` : ''}
        <div id="art-error" style="color:var(--danger);font-size:12.5px;margin-top:8px;"></div>
      </div>
      ${all.length ? `
      <div class="chips">
        <button class="chip ${articlesFilter === 'candidates' ? 'on' : ''}" data-filter="candidates">リライト候補（${cands.length}）</button>
        <button class="chip ${articlesFilter === 'all' ? 'on' : ''}" data-filter="all">すべての記事（${all.length}）</button>
      </div>
      ${rows || '<div class="card" style="color:var(--sub);font-size:13px;">この条件に当てはまる記事はありません。</div>'}
      ${pages > 1 ? `<div class="btn-row"><button class="btn ghost small" id="art-prev" ${articlesPage <= 1 ? 'disabled' : ''}>← 前へ</button><span style="align-self:center;font-size:12px;color:var(--sub);">${articlesPage} / ${pages}ページ</span><button class="btn ghost small" id="art-next" ${articlesPage >= pages ? 'disabled' : ''}>次へ →</button></div>` : ''}` : ''}
    </div>
  `, { active: false });

  document.getElementById('art-sync').addEventListener('click', syncArticles);
  document.getElementById('art-switch').addEventListener('click', () => { state.registeredMedia = null; renderArticlesPickMedia(); });
  document.getElementById('art-measures').addEventListener('click', renderMeasures);
  app.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => { articlesFilter = b.dataset.filter; articlesPage = 1; drawArticles(); }));
  const prev = document.getElementById('art-prev');
  const next = document.getElementById('art-next');
  if (prev) prev.addEventListener('click', () => { articlesPage -= 1; drawArticles(); window.scrollTo(0, 0); });
  if (next) next.addEventListener('click', () => { articlesPage += 1; drawArticles(); window.scrollTo(0, 0); });
  app.querySelectorAll('[data-article]').forEach((card) => {
    const id = Number(card.dataset.article);
    const art = all.find((a) => a.id === id);
    card.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.act === 'rewrite') startRewrite(art);
      else if (b.dataset.act === 'view') showMeasureById(d.rewrites[id].measureId);
    }));
  });
}

async function syncArticles() {
  shell(`<div class="wrap"><div class="loading-box"><div class="spinner"></div>WordPressから記事を取り込み、GSCの実績と照らし合わせています…<br><span style="font-size:11.5px;color:var(--sub);">記事の数によって、数十秒かかることがあります</span></div></div>`, { active: false });
  let r;
  try { r = await postJson('/api/articles/sync', { mediaId: state.mediaId }); } catch (e) { if (!e.authExpired) showFatalError(e); return; }
  if (!r.ok) {
    await renderArticles();
    const errEl = document.getElementById('art-error');
    if (r.data.error === 'wordpress_not_connected') {
      errEl.innerHTML = 'このメディアは、まだWordPressに接続されていません。記事を取り込むには、接続が必要です。 <a href="#" id="art-connect-wp">WordPressと接続する →</a>';
      document.getElementById('art-connect-wp').addEventListener('click', (e) => { e.preventDefault(); state.wpConnectContext = 'articles'; renderWordpressConnect(); });
    } else {
      errEl.textContent = r.data.error || '取り込めませんでした';
    }
    return;
  }
  await renderArticles();
  toast(`${r.data.count}本の記事を取り込みました（リライト候補：${r.data.candidates}本）`);
}

// ---- リライト案の作成 ----
async function startRewrite(article, { force = false } = {}) {
  shell(`<div class="wrap"><div class="loading-box"><div class="spinner"></div>AIが、リライト案を作成しています…<br><span style="font-size:11.5px;color:var(--sub);">記事の内容と検索実績を読み取って、全文をリライトします（30秒〜1分ほどかかります）</span></div></div>`, { active: false });
  let r;
  try { r = await postJson('/api/rewrite/start', { mediaId: state.mediaId, articleId: article.id, force }); } catch (e) { if (!e.authExpired) showFatalError(e); return; }
  if (!r.ok) {
    await renderArticles();
    const errEl = document.getElementById('art-error');
    if (errEl) errEl.textContent = r.data.error === 'wordpress_not_connected' ? 'WordPressに接続されていません' : (r.data.error || 'リライト案を作成できませんでした');
    return;
  }
  renderRewriteResult(r.data.measure);
}

async function showMeasureById(measureId) {
  let measures;
  try { ({ measures } = await api('/api/measures')); } catch (e) { if (!e.authExpired) showFatalError(e); return; }
  const m = measures.find((x) => x.id === measureId);
  if (m) renderRewriteResult(m);
}

function renderRewriteResult(m) {
  state.screen = 'rewriteResult';
  state.rewriteMeasureId = m.id;
  const p = m.proposal;
  if (!p) { renderMeasures(); return; }
  const changes = (p.changes || []).map((c) => `
    <div class="info-box"><div class="h">${esc(c.area || '修正ポイント')}</div>
      <div><b>問題：</b>${esc(c.issue)}</div><div><b>対応：</b>${esc(c.action)}</div></div>`).join('');
  const queries = (p.queries || []).map((q) => `<tr style="border-top:1px solid var(--line);"><td style="padding:4px 6px;">${esc(q.query)}</td><td>${q.impressions}</td><td>${q.clicks}</td><td>${q.position}</td></tr>`).join('');
  shell(`
    <div class="wrap">
      <div class="screen-head">
        <div class="eyebrow">リライト施策</div>
        <h1>リライト案ができました</h1>
        <p>対象の記事：<a href="${esc(m.article.url)}" target="_blank" rel="noopener">${esc(m.article.title)}</a>　<span class="pill ${m.status === '完了' ? 'ok' : 'blue'}">施策のステータス：${esc(m.status)}</span></p>
      </div>
      <div class="card">
        <h3 style="margin:0 0 6px;">リライトが必要と判断した理由</h3>
        <ul class="reason-list">${(m.reasons || []).map((r) => `<li>${esc(r)}</li>`).join('') || '<li>定期的な見直し</li>'}</ul>
        <h3 style="margin:14px 0 6px;">AIの診断</h3>
        <div class="info-box">${esc(p.diagnosis)}</div>
        <h3 style="margin:14px 0 6px;">直すポイント</h3>
        ${changes || '<div style="font-size:12.5px;color:var(--sub);">（なし）</div>'}
        <h3 style="margin:14px 0 6px;">タイトル案・説明文案</h3>
        <div class="field-grid">
          <div class="k">タイトル案</div><div class="v">${esc(p.titleSuggestion)} <button class="btn ghost small" id="rw-copy-title" type="button">コピー</button></div>
          <div class="k">説明文案</div><div class="v">${esc(p.metaDescription)} <button class="btn ghost small" id="rw-copy-meta" type="button">コピー</button></div>
        </div>
        ${queries ? `<h3 style="margin:14px 0 6px;">この記事に流入している検索クエリ（直近28日）</h3><div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:12px;"><tr style="text-align:left;color:var(--sub);"><th style="padding:4px 6px;">クエリ</th><th>表示</th><th>クリック</th><th>順位</th></tr>${queries}</table></div>` : ''}
        <div style="font-size:11.5px;color:var(--sub);margin-top:10px;">※リライト案の全文は、次の画面で、確認・編集できます。数値・制度・日付などは、AIが断定せず、「【要確認】」として示しています。必ず、人が確認してください。</div>
        <div class="btn-row">
          <button class="btn gold" id="rw-open">リライト案を編集して、WordPressに下書き保存 →</button>
          <button class="btn outline" id="rw-redo">リライト案を作り直す</button>
          <button class="btn ghost" id="rw-measures">施策管理へ</button>
          <button class="btn ghost" id="rw-back">← 記事一覧へ</button>
        </div>
      </div>
    </div>
  `, { active: false });
  document.getElementById('rw-copy-title').addEventListener('click', () => copyText(p.titleSuggestion));
  document.getElementById('rw-copy-meta').addEventListener('click', () => copyText(p.metaDescription));
  document.getElementById('rw-open').addEventListener('click', () => openRewriteEditor(m));
  document.getElementById('rw-redo').addEventListener('click', () => startRewrite({ id: m.article.wpId }, { force: true }));
  document.getElementById('rw-measures').addEventListener('click', renderMeasures);
  document.getElementById('rw-back').addEventListener('click', renderArticles);
  pushHistory();
}

// リライト案を、記事の編集画面（画像の自動生成・ボタンのリンク設定・WordPress下書き保存）で開く
async function openRewriteEditor(m) {
  shell(`<div class="wrap"><div class="loading-box"><div class="spinner"></div>編集画面を開いています…</div></div>`, { active: false });
  try {
    if (!state.registeredMedia || state.registeredMedia.id !== m.regId) await ensureWorkspace({ id: m.regId });
  } catch (e) { if (!e.authExpired) showFatalError(e); return; }
  let r;
  try { r = await postJson('/api/rewrite/session', { mediaId: state.mediaId, measureId: m.id }); } catch (e) { if (!e.authExpired) showFatalError(e); return; }
  if (!r.ok) { toast(r.data.error || '開けませんでした'); renderMeasures(); return; }
  state.sessionId = r.data.sessionId;
  state.theme = r.data.theme;
  state.article = r.data.article;
  state.rewriteMeasureId = m.id;
  state.rewriteArticle = r.data.measure.article;
  state.wordpressConnected = true; // リライトは、WordPressに接続したメディアで行う（接続が切れていれば、保存時に、接続画面が出る）
  state.wordpressReal = true;
  state.publishInfo = null;
  state.autoImagesFor = null; // 画像が未生成なら、自動生成を始める
  await loadMediaLinks();
  applyDefaultCtaLink();
  state.screen = 'articleEdit';
  renderArticleEdit();
}

// ---------------------------------------------------------------
// 施策管理（リライト施策の表示・操作・効果測定）
// ---------------------------------------------------------------
function effectHtml(m) {
  const b = m.baseline;
  const last = (m.effects || [])[m.effects.length - 1];
  const num = (x, unit = '') => (x == null ? '-' : `${x.toLocaleString ? x.toLocaleString() : x}${unit}`);
  const sign = (d, goodWhenUp, unit = '') => {
    if (d == null) return '-';
    if (d === 0) return '±0';
    const good = goodWhenUp ? d > 0 : d < 0;
    return `<span style="color:${good ? 'var(--ok)' : 'var(--danger)'};font-weight:700;">${d > 0 ? '+' : ''}${d}${unit}</span>`;
  };
  let html = '';
  if (b) html += `<div style="font-size:11.5px;color:var(--sub);margin-top:6px;">リライト前の実績（施策を作った時点・直近28日${b.period ? `：${esc(b.period.startDate)}〜${esc(b.period.endDate)}` : ''}）：表示 ${num(b.impressions)}回／クリック ${num(b.clicks)}回／クリック率 ${num(b.ctr, '%')}／平均順位 ${num(b.position, '位')}</div>`;
  if (last) {
    const a = last.after;
    const d = last.delta || {};
    html += `<div style="overflow-x:auto;margin-top:8px;"><table style="width:100%;border-collapse:collapse;font-size:12px;">
      <tr style="text-align:left;color:var(--sub);"><th style="padding:4px 6px;">効果測定（${esc(fmtD(last.measuredAt))}）</th><th>リライト前</th><th>直近28日</th><th>変化</th></tr>
      <tr style="border-top:1px solid var(--line);"><td style="padding:4px 6px;">表示回数</td><td>${num(b && b.impressions)}</td><td>${num(a.impressions)}</td><td>${sign(d.impressions, true)}</td></tr>
      <tr style="border-top:1px solid var(--line);"><td style="padding:4px 6px;">クリック数</td><td>${num(b && b.clicks)}</td><td>${num(a.clicks)}</td><td>${sign(d.clicks, true)}</td></tr>
      <tr style="border-top:1px solid var(--line);"><td style="padding:4px 6px;">クリック率</td><td>${num(b && b.ctr, '%')}</td><td>${num(a.ctr, '%')}</td><td>${sign(d.ctr, true, '%')}</td></tr>
      <tr style="border-top:1px solid var(--line);"><td style="padding:4px 6px;">平均順位</td><td>${num(b && b.position, '位')}</td><td>${num(a.position, '位')}</td><td>${sign(d.position, false)}（マイナスが改善）</td></tr>
    </table></div>
    <div style="font-size:11px;color:var(--sub);margin-top:4px;">${last.daysSinceRewrite == null ? '※「完了」にした日が記録されていないため、リライトからの日数は不明です。' : last.daysSinceRewrite < 14 ? `※リライト（完了）から${last.daysSinceRewrite}日です。検索順位の変化には時間がかかるため、参考値です。` : `リライト（完了）から${last.daysSinceRewrite}日たっています。`}</div>`;
  }
  return html;
}

function rewriteExtrasHtml(m) {
  const a = m.article || {};
  return `<div class="rw-box" style="border:1px solid var(--line);border-radius:10px;padding:10px 12px;background:#fafbfd;">
    <div style="font-size:12.5px;"><span class="pill blue">リライト</span> 対象の記事：<a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.title)}</a>${m.mediaName ? `（${esc(m.mediaName)}）` : ''}</div>
    ${(m.reasons || []).length ? `<ul class="reason-list" style="margin-top:4px;">${m.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
    ${m.draft ? `<div style="font-size:12px;margin-top:4px;">WordPressの下書き：<a href="${esc(m.draft.editUrl)}" target="_blank" rel="noopener">管理画面で開く</a>（保存：${esc(fmtD(m.draft.savedAt))}）</div>` : ''}
    ${m.rewrittenAt ? `<div style="font-size:12px;margin-top:2px;">リライト（完了）した日：${esc(fmtD(m.rewrittenAt))}</div>` : ''}
    ${effectHtml(m)}
    <div class="btn-row" style="margin-top:8px;">
      ${m.hasRewrite ? '<button class="btn outline small" data-rw="view">リライト案を見る</button><button class="btn navy small" data-rw="edit">編集して下書き保存</button>' : '<button class="btn navy small" data-rw="create">リライト案を作る</button>'}
      <button class="btn ghost small" data-rw="effect">効果を測定する</button>
    </div>
    ${m.status !== '完了' ? '<div style="font-size:11px;color:var(--sub);margin-top:4px;">リライトを公開したら、ステータスを「完了」にしてください（効果測定の基準日になります）。</div>' : ''}
  </div>`;
}

function bindRewriteActions(card, id) {
  const m = measureCache.find((x) => x.id === id);
  if (!m || m.kind !== 'rewrite') return;
  card.querySelectorAll('[data-rw]').forEach((b) => b.addEventListener('click', async () => {
    const act = b.dataset.rw;
    try {
      if (!state.registeredMedia || state.registeredMedia.id !== m.regId) await ensureWorkspace({ id: m.regId });
    } catch (e) { if (!e.authExpired) toast('このメディアの登録が見つかりません（削除された可能性があります）'); return; }
    if (act === 'view') renderRewriteResult(m);
    else if (act === 'edit') openRewriteEditor(m);
    else if (act === 'create') startRewrite({ id: m.article.wpId });
    else if (act === 'effect') {
      b.disabled = true;
      b.textContent = '測定しています…';
      try {
        const r = await postJson(`/api/measures/${m.id}/effect`, { mediaId: state.mediaId });
        if (!r.ok) { toast(r.data.error || '測定できませんでした'); b.disabled = false; b.textContent = '効果を測定する'; return; }
        measureCache = measureCache.map((x) => (x.id === m.id ? { ...x, ...r.data.measure } : x));
        drawMeasures();
        toast('効果を測定しました');
      } catch (e) { if (!e.authExpired) toast('測定できませんでした'); }
    }
  }));
}

async function measureApi(method, path, body) {
  const res = await fetch(path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    // ログインの有効期限切れ（サーバー再起動など）
    state.user = null;
    renderAuth('ログインの有効期限が切れました。もう一度ログインしてください');
    const e = new Error('login_required');
    e.handled = true;
    throw e;
  }
  if (!res.ok) throw new Error(data.error || '処理に失敗しました');
  return data;
}

function renderAuth(message) {
  state.screen = 'auth';
  const isReg = state.authMode === 'register';
  shell(`
    <div class="wrap" style="max-width:520px;">
      <div class="screen-head">
        <div class="eyebrow">アカウント</div>
        <h1>${isReg ? 'アカウントを作成' : 'ログイン'}</h1>
        <p>ご利用にはアカウントが必要です。ログインすると、アカウントごとに、メディアの分析や施策のステータスを管理できます。</p>
      </div>
      <div class="card">
        <form class="auth-form" id="auth-form" autocomplete="on">
          <label style="display:block;font-size:12.5px;font-weight:700;color:var(--sub);margin-bottom:4px;">ユーザー名</label>
          <input id="auth-username" type="text" autocomplete="username" placeholder="半角の英数字（3〜50文字）" style="margin-bottom:12px;">
          <label style="display:block;font-size:12.5px;font-weight:700;color:var(--sub);margin-bottom:4px;">パスワード</label>
          <input id="auth-password" type="password" autocomplete="${isReg ? 'new-password' : 'current-password'}" placeholder="${isReg ? '8文字以上' : ''}">
          <div id="auth-error" style="color:var(--danger);font-size:12.5px;margin:10px 0 0;">${esc(message || '')}</div>
          <div class="btn-row">
            <button class="btn navy" type="submit" id="auth-submit">${isReg ? 'アカウントを作成する' : 'ログイン'}</button>
            <button class="btn ghost" type="button" id="auth-toggle">${isReg ? 'ログインへ' : '新しくアカウントを作る'}</button>
          </div>
        </form>
        <div style="font-size:11px;color:var(--sub);margin-top:12px;">※このパソコンの中（data フォルダ）にだけ保存されます。パスワードは、読み取れない形（ハッシュ）にして保存します。</div>
      </div>
    </div>
  `, { active: false });
  document.getElementById('auth-toggle').addEventListener('click', () => { state.authMode = isReg ? 'login' : 'register'; renderAuth(); });
  document.getElementById('auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('auth-error');
    const btn = document.getElementById('auth-submit');
    errEl.textContent = '';
    btn.disabled = true;
    try {
      const res = await fetch(isReg ? '/api/auth/register' : '/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: document.getElementById('auth-username').value, password: document.getElementById('auth-password').value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { errEl.textContent = data.error || 'ログインできませんでした'; return; }
      location.reload(); // 前のアカウントの作業内容が残らないよう、画面の状態を作り直して「メディアを選ぶ」画面へ
    } catch (err) {
      errEl.textContent = 'サーバーに接続できませんでした';
    } finally {
      btn.disabled = false;
    }
  });
  pushHistory();
}

async function renderMeasures() {
  state.screen = 'measures';
  if (!state.user) { renderAuth(); return; }
  shell(`<div class="wrap"><div class="loading-box"><div class="spinner"></div>読み込み中…</div></div>`, { active: false });
  try {
    ({ measures: measureCache } = await measureApi('GET', '/api/measures'));
  } catch (e) {
    if (!e.handled) showFatalError(e);
    return;
  }
  editingId = null;
  deletingId = null;
  drawMeasures();
  pushHistory();
}

// 描画前に、登録フォームの入力途中の内容を覚えておく（一覧の操作で再描画しても、消えないように）
function captureMeasureDraft() {
  const t = document.getElementById('m-title');
  if (t) measureDraft = { title: t.value, memo: document.getElementById('m-memo').value, status: '未着手' };
}

function drawMeasures({ keepDraft = true } = {}) {
  if (keepDraft) captureMeasureDraft(); // 登録直後は、入力欄を空に戻したいので、画面上の内容を取り込まない
  const filter = state.measuresFilter || 'all';
  const counts = Object.fromEntries(STATUS_LIST.map((s) => [s, measureCache.filter((m) => m.status === s).length]));
  const list = measureCache.filter((m) => filter === 'all' || m.status === filter);
  const fmt = (iso) => new Date(iso).toLocaleString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const options = (cur) => STATUS_LIST.map((s) => `<option value="${s}" ${s === cur ? 'selected' : ''}>${s}</option>`).join('');

  const items = list.map((m) => {
    if (m.id === editingId) {
      return `<div class="card measure" data-id="${m.id}">
        <input class="m-edit-title" type="text" maxlength="100" value="${esc(m.title)}" style="width:100%;font-family:inherit;font-size:14px;padding:7px 10px;border:1px solid var(--line);border-radius:8px;box-sizing:border-box;">
        <textarea class="m-edit-memo" rows="3" maxlength="2000" style="width:100%;font-family:inherit;font-size:13px;padding:7px 10px;border:1px solid var(--line);border-radius:8px;box-sizing:border-box;">${esc(m.memo)}</textarea>
        <div class="btn-row" style="margin-top:4px;"><button class="btn navy small" data-act="save">保存</button><button class="btn ghost small" data-act="cancel">キャンセル</button></div>
      </div>`;
    }
    return `<div class="card measure" data-id="${m.id}">
      <div class="top">
        <div class="title">${esc(m.title)}</div>
        <span class="pill ${STATUS_PILL[m.status]}">${esc(m.status)}</span>
        <select data-act="status" aria-label="ステータスを変更">${options(m.status)}</select>
      </div>
      ${m.kind === 'rewrite' ? rewriteExtrasHtml(m) : (m.memo ? `<div class="memo">${esc(m.memo)}</div>` : '')}
      <div class="meta">登録：${fmt(m.createdAt)} ／ 更新：${fmt(m.updatedAt)}</div>
      <div class="btn-row" style="margin-top:2px;">
        ${m.id === deletingId
          ? '<span style="font-size:12.5px;color:var(--danger);align-self:center;">この施策を削除します。元に戻せません。</span><button class="btn danger-outline small" data-act="delete-yes">削除する</button><button class="btn ghost small" data-act="delete-no">やめる</button>'
          : '<button class="btn ghost small" data-act="edit">編集</button><button class="btn ghost small" data-act="delete">削除</button>'}
      </div>
    </div>`;
  }).join('');

  shell(`
    <div class="wrap">
      <div class="screen-head">
        <div class="eyebrow">施策管理</div>
        <h1>施策のステータス管理</h1>
        <p>ログイン中のアカウント（<b>${esc(state.user.username)}</b>）の施策だけが表示されます。 <a href="#" id="m-logout">ログアウト</a></p>
      </div>
      <div class="card m-form">
        <h3 style="margin:0 0 8px;">施策を登録する</h3>
        <div class="row"><input id="m-title" type="text" maxlength="100" placeholder="施策名（例：費用相場の記事をリライトする）" value="${esc(measureDraft.title)}"></div>
        <div class="row"><textarea id="m-memo" rows="2" maxlength="2000" placeholder="メモ（任意）">${esc(measureDraft.memo)}</textarea></div>
        <div class="row" style="align-items:center;">
          <button class="btn navy small" id="m-add">登録する</button>
          <span style="font-size:11.5px;color:var(--sub);">登録した施策は「未着手」から始まります。ステータスは、一覧の各施策で変更できます。</span>
        </div>
      </div>
      <div class="chips">
        <button class="chip ${filter === 'all' ? 'on' : ''}" data-filter="all">すべて（${measureCache.length}）</button>
        ${STATUS_LIST.map((s) => `<button class="chip ${filter === s ? 'on' : ''}" data-filter="${s}">${s}（${counts[s]}）</button>`).join('')}
      </div>
      ${items || `<div class="card" style="color:var(--sub);font-size:13px;">${measureCache.length ? 'この条件に当てはまる施策はありません。' : 'まだ施策が登録されていません。上のフォームから登録してください。'}</div>`}
    </div>
  `, { active: false });

  document.getElementById('m-logout').addEventListener('click', async (e) => {
    e.preventDefault();
    await fetch('/api/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    location.reload(); // ログイン画面に戻る（作業内容も消す）
  });
  document.getElementById('m-add').addEventListener('click', addMeasure);
  document.getElementById('m-title').addEventListener('keydown', (e) => { if (e.key === 'Enter') addMeasure(); });
  app.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => { state.measuresFilter = b.dataset.filter; drawMeasures(); }));
  app.querySelectorAll('.measure').forEach((card) => {
    const id = card.dataset.id;
    bindRewriteActions(card, id);
    card.querySelectorAll('[data-act]').forEach((el) => {
      const act = el.dataset.act;
      if (act === 'status') el.addEventListener('change', () => updateMeasure(id, { status: el.value }, `ステータスを「${el.value}」に変更しました`));
      else el.addEventListener('click', () => {
        if (act === 'edit') { editingId = id; drawMeasures(); }
        else if (act === 'cancel') { editingId = null; drawMeasures(); }
        else if (act === 'save') updateMeasure(id, { title: card.querySelector('.m-edit-title').value, memo: card.querySelector('.m-edit-memo').value }, '変更を保存しました', true);
        else if (act === 'delete') { deletingId = id; drawMeasures(); }
        else if (act === 'delete-no') { deletingId = null; drawMeasures(); }
        else if (act === 'delete-yes') deleteMeasure(id);
      });
    });
  });
}

async function addMeasure() {
  captureMeasureDraft();
  if (!measureDraft.title.trim()) { toast('施策名を入力してください'); return; }
  try {
    const { measure } = await measureApi('POST', '/api/measures', measureDraft);
    measureCache.unshift(measure);
    measureDraft = { title: '', memo: '', status: '未着手' };
    drawMeasures({ keepDraft: false });
    toast('施策を登録しました');
  } catch (e) {
    if (!e.handled) toast(e.message);
  }
}

async function updateMeasure(id, patch, message, leaveEdit) {
  try {
    const { measure } = await measureApi('PUT', `/api/measures/${id}`, patch);
    measureCache = measureCache.map((m) => (m.id === id ? measure : m)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (leaveEdit) editingId = null;
    drawMeasures();
    toast(message);
  } catch (e) {
    if (!e.handled) { toast(e.message); drawMeasures(); }
  }
}

async function deleteMeasure(id) {
  try {
    await measureApi('DELETE', `/api/measures/${id}`);
    measureCache = measureCache.filter((m) => m.id !== id);
    deletingId = null;
    drawMeasures();
    toast('施策を削除しました');
  } catch (e) {
    if (!e.handled) toast(e.message);
  }
}

const SCREEN_RENDERERS = {
  mediaState: renderMediaState,
  understandExistingForm: renderExistingUnderstand,
  gscConnect: renderGscConnect,
  gscSites: renderGscSites,
  gscError: () => renderGscError(state.gscErrorMessage || ''),
  wordpressConnect: renderWordpressConnect,
  understandExistingResult: renderExistingAnalysisResult,
  crawlError: () => renderCrawlError(state.crawlErrorMessage || ''),
  understandNewForm: renderNewBusinessForm,
  understandNewHearing: renderNewHearing,
  directionConfirm: renderDirectionConfirm,
  direction: renderDirectionSummary,
  dashboard: renderDashboard,
  themeDetail: renderThemeDetail,
  primaryInfo: renderPrimaryInfo,
  hearing: renderHearing,
  outline: renderOutline,
  articleEdit: renderArticleEdit,
  published: renderPublishedStatus,
  publishError: () => renderPublishError(state.publishErrorMessage || ''),
  export: renderExport,
  articles: renderArticles,
  articlesPick: renderArticlesPickMedia,
  rewriteResult: () => { if (state.rewriteMeasureId) showMeasureById(state.rewriteMeasureId); else renderArticles(); },
  mediaChoice: renderMediaChoice,
  mediaRegister: renderMediaRegister,
  mediaList: renderMediaList,
  workLost: renderWorkLost,
  mediaPage: () => renderMediaPage(state.publishInfo && state.publishInfo.articleId),
  monitoring: renderMonitoring,
  fixDetail: renderFixDetail,
  settings: renderSettings,
  measures: renderMeasures,
  auth: () => renderAuth(),
};

window.addEventListener('popstate', (e) => {
  if (!e.state) return;
  isRestoringHistory = true;
  Object.assign(state, e.state.snapshot);
  const renderFn = SCREEN_RENDERERS[e.state.screen];
  if (renderFn) renderFn();
  isRestoringHistory = false;
});

// 起動時にAI連携の有効/無効を取得してから最初の画面を描画する（バッジの表示を正しくするため）
(async () => {
  try {
    const { aiEnabled, gscEnabled } = await api('/api/themes');
    state.aiEnabled = !!aiEnabled;
    state.gscEnabled = !!gscEnabled;
    const me = await api('/api/auth/me');
    state.accountsEnabled = !!me.enabled;
    state.user = me.user;
  } catch (e) { /* サーバー未接続でも最初の画面は表示する */ }
  if (state.accountsEnabled && !state.user) renderAuth(); // アカウント機能が有効なときは、ログイン（アカウント作成）が必須
  else if (!handleGscReturn()) renderMediaState();
})();
