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
};

const STEPS = ['テーマ選定', '一次情報', 'AIヒアリング', '記事構成・生成', '装飾・確認', '公開'];
function stepIndexFor(screen) {
  return { dashboard: -1, themeDetail: 0, primaryInfo: 1, hearing: 2, outline: 3, generating: 3, articleEdit: 4, published: 5 }[screen] ?? -1;
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
    throw new Error('NO_SERVER');
  }
  if (!res.ok) throw new Error(`API error ${res.status} on ${path}`);
  return res.json();
}

function showFatalError(err) {
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
        <span data-nav="monitoring">記事一覧・監視</span>
      </div>` : '';
  app.innerHTML = `
    <div class="appbar">
      <span class="brand">メディアコンパス極</span>
      ${navHtml}
      <span class="mode-badge ${state.aiEnabled ? 'ai' : 'sim'}"><span class="dot"></span>${state.aiEnabled ? 'AI連携中（Claude）' : 'シミュレーションモード'}</span>
    </div>
    ${stepperHtml}
    ${innerHtml}
  `;
  app.querySelectorAll('[data-nav]').forEach((elm) => {
    elm.addEventListener('click', () => {
      if (elm.dataset.nav === 'dashboard') renderDashboard();
      if (elm.dataset.nav === 'monitoring') renderMonitoring();
      if (elm.dataset.nav === 'direction') renderDirectionSummary();
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
      <div class="card clickable" id="pick-new">
        <h3>新しくメディアを構築する</h3>
        <div style="font-size:12.5px;color:var(--sub);">事業内容についてAIがヒアリングし、ゼロから方向性を設計します。</div>
      </div>
      <div style="font-size:11px;color:var(--sub);margin-top:6px;">※新規／既存の判定はユーザーが手動で選択します（自動判定はしません）。</div>
    </div>
  `, { active: false, nav: false });
  document.getElementById('pick-existing').addEventListener('click', () => pickMediaState('existing'));
  document.getElementById('pick-new').addEventListener('click', () => pickMediaState('new'));
  pushHistory();
}

async function pickMediaState(mediaState) {
  let mediaId;
  try {
    ({ mediaId } = await api('/api/media/state', { body: { mediaState } }));
  } catch (err) {
    showFatalError(err);
    return;
  }
  state.mediaId = mediaId;
  state.mediaState = mediaState;
  if (mediaState === 'existing') renderExistingUnderstand();
  else renderNewBusinessForm();
}

// ---------------------------------------------------------------
// STEP 0-2a: メディア理解（既存メディアの場合）【新設・v2】
// ---------------------------------------------------------------
function renderExistingUnderstand() {
  state.screen = 'understandExistingForm';
  shell(`
    <div class="wrap">
      <div class="screen-head">
        <div class="eyebrow">STEP 0-2 ・ メディア理解（既存）</div>
        <h1>既存メディアを分析する</h1>
        <p>サイトURLをもとに、現状の記事・検索順位・カバレッジ状況を分析します（3.2）。</p>
      </div>
      <div class="card">
        <div class="field-grid">
          <div class="k">サイトURL</div><div class="v"><input id="site-url" type="text" placeholder="https://example.co.jp" style="width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:8px;font-size:13px;font-family:inherit;"></div>
        </div>
        <div style="font-size:11px;color:var(--sub);margin:6px 0 12px;">未定：既存記事一覧の取得手段（GSC連携／簡易クロール／手動アップロードのいずれを主手段とするか）。本デモでは、GSC連携の有無で分析結果が変わる2パターンを体験できます。</div>
        <div class="btn-row">
          <button class="btn navy" id="go-analyze-gsc">GSCと連携して分析する →</button>
          <button class="btn outline" id="go-analyze-nogsc">GSCと連携しないで分析する →</button>
        </div>
      </div>
    </div>
  `, { active: false, nav: false });
  document.getElementById('go-analyze-gsc').addEventListener('click', () => {
    state.siteUrlInput = (document.getElementById('site-url').value || '').trim() || 'https://example.co.jp';
    renderGscConnect();
  });
  document.getElementById('go-analyze-nogsc').addEventListener('click', () => {
    state.siteUrlInput = (document.getElementById('site-url').value || '').trim() || 'https://example.co.jp';
    analyzeExisting(false);
  });
  pushHistory();
}

// GSC連携の疑似的な確認画面（プロトタイプ用の仮実装。実際のGoogleアカウント連携は行わない）
function renderGscConnect() {
  state.screen = 'gscConnect';
  shell(`
    <div class="wrap">
      <div class="screen-head">
        <div class="eyebrow">STEP 0-2 ・ メディア理解（既存）</div>
        <h1>Google Search Console と連携します</h1>
        <p>連携すると、検索クエリ・掲載順位・インデックス済みURLなどのデータを取得できます。</p>
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
          <li>検索クエリ・クリック数・表示回数・掲載順位</li>
          <li>インデックス済みURLの一覧</li>
        </ul>
        <div class="info-box" style="margin:10px 0;">
          <div class="h">連携するアカウント（デモ）</div>demo-owner@example.co.jp
        </div>
        <div style="font-size:10.5px;color:var(--sub);margin-bottom:10px;">※プロトタイプのため、実際のGoogleアカウントとの連携は行われません。ボタンを押すと連携済みとして次に進みます。</div>
        <div class="btn-row">
          <button class="btn navy" id="gsc-authorize">連携して続ける →</button>
          <button class="btn ghost" id="gsc-cancel">← キャンセル</button>
        </div>
      </div>
    </div>
  `, { active: false, nav: false });
  document.getElementById('gsc-authorize').addEventListener('click', () => analyzeExisting(true));
  document.getElementById('gsc-cancel').addEventListener('click', renderExistingUnderstand);
  pushHistory();
}

async function analyzeExisting(withGsc) {
  const siteUrl = state.siteUrlInput || 'https://example.co.jp';
  shell(`<div class="wrap"><div class="loading-box"><div class="spinner"></div>${withGsc ? 'サイト構成・検索順位・GSCデータを分析しています…' : 'サイト構成を簡易クロールで分析しています…（GSC未連携）'}</div></div>`, { active: false, nav: false });
  let analysis;
  try {
    ({ analysis } = await api('/api/media/understand-existing', { body: { mediaId: state.mediaId, siteUrl, withGsc } }));
  } catch (err) {
    showFatalError(err);
    return;
  }
  state.existingAnalysis = analysis;
  renderExistingAnalysisResult();
}

function renderExistingAnalysisResult() {
  state.screen = 'understandExistingResult';
  const analysis = state.existingAnalysis;
  shell(`
    <div class="wrap">
      <div class="screen-head">
        <div class="eyebrow">STEP 0-2 ・ メディア理解（既存）</div>
        <h1>分析結果</h1>
        <p>${analysis.withGsc ? 'Google Search Consoleと連携した分析結果です。' : 'GSCとは連携せず、サイトの簡易クロールのみで分析した結果です。'}</p>
      </div>
      <div class="card">
        <div class="field-grid">
          <div class="k">既存記事数</div><div class="v">${analysis.articlesCount}本</div>
          <div class="k">主な検索クエリ</div><div class="v">${analysis.topQueries.length ? analysis.topQueries.map(esc).join(' / ') : 'GSC未連携のため取得できません'}</div>
        </div>
        <div class="missing-box" style="margin-top:10px;">
          <div class="h">カニバリゼーションの兆候</div>
          ${analysis.cannibalization.map((c) => `「${esc(c.topic)}」で複数記事が競合：${c.articles.map(esc).join(' と ')}`).join('<br>')}
        </div>
        <div class="info-box" style="margin-top:10px;">
          <div class="h">カバレッジの傾向</div>${esc(analysis.coverageNote)}
        </div>
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
  if (!h.loading) pushHistory();
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
// STEP 1: ダッシュボード
// ---------------------------------------------------------------
async function renderDashboard() {
  state.screen = 'dashboard';
  shell(`<div class="wrap"><div class="loading-box"><div class="spinner"></div>読み込み中…</div></div>`, { active: false });
  let themes, aiEnabled, direction;
  try {
    const q = state.mediaId ? `?mediaId=${encodeURIComponent(state.mediaId)}` : '';
    ({ themes, aiEnabled, direction } = await api(`/api/themes${q}`));
  } catch (err) {
    showFatalError(err);
    return;
  }
  state.themes = themes;
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
    ({ sessionId, theme, availablePrimaryInfo } = await api('/api/session', { body: { themeId } }));
  } catch (err) {
    showFatalError(err);
    return;
  }
  state.sessionId = sessionId;
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
          <div class="k">競合状況</div><div class="v">${esc(t.competition)}</div>
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
  if (!state.hearing.loading) pushHistory();
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
  } catch (e) {
    toast('記事生成に失敗しました');
  }
  state.screen = 'articleEdit';
  renderArticleEdit();
}

function blockToEditableHtml(block, i) {
  const tools = `<div class="block-toolbar">
      ${['paragraph', 'list', 'quote'].includes(block.type) ? `<button data-regen="${i}">↻ 再生成</button>` : ''}
      ${block.type.startsWith('image') || block.role ? `<button data-reimg="${i}">🖼 画像変更</button>` : ''}
    </div>`;
  let inner = '';
  switch (block.type) {
    case 'image': {
      const isHero = block.role === 'hero';
      inner = `<img class="art-img ${isHero ? '' : 'inline'}" src="${placeholderImageDataUri(block.alt || '', isHero ? 900 : 420, isHero ? 320 : 240)}" alt="${esc(block.alt)}">
        <div class="img-cap">${esc(block.alt)}${block.caption ? ' - ' + esc(block.caption) : ''}<span class="proto-tag">仮画像（本番は画像生成AI想定）</span></div>`;
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
    case 'cta': inner = `<div class="art-cta"><div class="t editable" contenteditable="true" data-field="text">${esc(block.text)}</div><button type="button">${esc(block.buttonLabel || '相談する')}</button></div>`; break;
    default: inner = `<div>${esc(JSON.stringify(block))}</div>`;
  }
  return `<div class="block-wrap" data-block="${i}">${tools}${inner}</div>`;
}

function renderArticleEdit() {
  state.screen = 'articleEdit';
  const a = state.article;
  const blocksHtml = a.blocks.map((b, i) => blockToEditableHtml(b, i)).join('');

  shell(`
    <div class="wrap wide">
      <div class="screen-head">
        <div class="eyebrow">STEP 6-8 ・ 記事生成・装飾・確認</div>
        <h1>${esc(a.title)}</h1>
        <p>本文・画像・装飾を確認し、必要に応じて編集してください（見出し・本文はクリックして直接編集できます）。</p>
      </div>
      <div class="card">
        <div style="font-size:11.5px;color:var(--sub);margin-bottom:10px;">使用した一次情報・ヒアリング回答は本文中に反映されています。<span class="proto-tag">生成モード: ${state.lastMode || (state.aiEnabled ? 'ai' : 'simulated')}</span></div>
        ${blocksHtml}
        <div class="btn-row">
          <button class="btn ghost" id="save-draft">下書きとして保存</button>
          <button class="btn gold" id="go-publish">公開する →</button>
        </div>
      </div>
    </div>
  `);

  app.querySelectorAll('.editable').forEach((elm) => {
    elm.addEventListener('blur', () => {
      const idx = Number(elm.closest('[data-block]').dataset.block);
      const field = elm.dataset.field;
      if (field) state.article.blocks[idx][field] = elm.textContent;
    });
  });
  app.querySelectorAll('[data-regen]').forEach((btn) => btn.addEventListener('click', () => regenerateBlock(Number(btn.dataset.regen))));
  app.querySelectorAll('[data-reimg]').forEach((btn) => btn.addEventListener('click', () => {
    toast('画像を再生成しました（仮画像を差し替え）');
    const idx = Number(btn.dataset.reimg);
    state.article.blocks[idx].alt = state.article.blocks[idx].alt + '·';
    renderArticleEdit();
  }));
  document.getElementById('save-draft').addEventListener('click', async () => {
    await api('/api/article/save', { body: { sessionId: state.sessionId, article: state.article } });
    toast('下書きを保存しました');
  });
  document.getElementById('go-publish').addEventListener('click', doPublish);
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
  await api('/api/article/save', { body: { sessionId: state.sessionId, article: state.article } });
  const info = await api('/api/publish', { body: { sessionId: state.sessionId } });
  state.publishInfo = info;
  state.screen = 'published';
  renderPublishedStatus();
}

function renderPublishedStatus() {
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
      return `<img class="art-img ${isHero ? '' : 'inline'}" src="${placeholderImageDataUri(block.alt || '', isHero ? 900 : 420, isHero ? 340 : 240)}" alt="${esc(block.alt)}"><div class="img-cap">${esc(block.caption || '')}</div>`;
    }
    case 'h2': return `<h2 class="art-h2">${esc(block.text)}</h2>`;
    case 'h3': return `<h3 class="art-h3">${esc(block.text)}</h3>`;
    case 'paragraph': return `<p class="art-p">${esc(block.text)}</p>`;
    case 'list': return `<ul class="art-list">${(block.items || []).map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`;
    case 'quote': return `<div class="art-quote">${esc(block.text)}<cite>${esc(block.cite || '')}</cite></div>`;
    case 'callout': return `<div class="art-callout">💡 ${esc(block.text)}</div>`;
    case 'table': return `<table class="art-table">${block.caption ? `<caption>${esc(block.caption)}</caption>` : ''}<thead><tr>${(block.headers || []).map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${(block.rows || []).map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    case 'cta': return `<div class="art-cta"><div class="t">${esc(block.text)}</div><button type="button">${esc(block.buttonLabel || '相談する')}</button></div>`;
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
const SCREEN_RENDERERS = {
  mediaState: renderMediaState,
  understandExistingForm: renderExistingUnderstand,
  gscConnect: renderGscConnect,
  understandExistingResult: renderExistingAnalysisResult,
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
  mediaPage: () => renderMediaPage(state.publishInfo && state.publishInfo.articleId),
  monitoring: renderMonitoring,
  fixDetail: renderFixDetail,
};

window.addEventListener('popstate', (e) => {
  if (!e.state) return;
  isRestoringHistory = true;
  Object.assign(state, e.state.snapshot);
  const renderFn = SCREEN_RENDERERS[e.state.screen];
  if (renderFn) renderFn();
  isRestoringHistory = false;
});

renderMediaState();
