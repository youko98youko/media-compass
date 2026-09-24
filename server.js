// メディアコンパス極 ― UX検証用プロトタイプ サーバー
// 本番仕様ではありません。仕様書「AIエージェント向けコーディング仕様書_v1」を根拠に、
// UXの流れ（テーマ提示→一次情報→AIヒアリング→記事生成→装飾→公開→監視）を
// 実際に操作できる形で検証するためのものです。
//
// 起動方法:
//   1) npm install
//   2) .env.example を .env にコピーし、必要なら ANTHROPIC_API_KEY を設定
//   3) npm start
//   4) http://localhost:3000 を開く
//
// ANTHROPIC_API_KEY が未設定でも「シミュレーションモード」で全ステップを最後まで
// 操作できます（AI呼び出しの代わりにテンプレート応答を返します。回答内容は反映されます）。

require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'media-compass-saas-prototype.html'));
});

const PORT = process.env.PORT || 3000;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
const AI_ENABLED = !!process.env.ANTHROPIC_API_KEY;

// ---------------------------------------------------------------
// デモ用の仮想企業ペルソナ・一次情報・テーマ候補（UX検証用の仮データ）
// ---------------------------------------------------------------
const PRIMARY_INFO_LIBRARY = {
  pi1: { id: 'pi1', label: '施工実績', text: '築20年の戸建て住宅の外壁塗装（2025年施工）で、耐用年数15年のフッ素塗料を採用。仕上がりと価格のバランスを重視するお客様から好評だった。' },
  pi2: { id: 'pi2', label: 'お客様の声', text: '「他社より対応が早く、追加費用もなく安心できた」というお客様の声を複数いただいている。' },
  pi3: { id: 'pi3', label: '対応実績', text: '関東一円で年間200件以上の外壁塗装を施工している。' },
};

const THEMES = [
  {
    id: 'theme1',
    title: '外壁塗装の色選びで失敗しないコツ',
    keyword: '外壁塗装 色 選び方',
    priority: '高',
    reasons: ['一定の検索需要がある', '自社サイトに該当記事が存在しない', '上位競合の多くが扱っている', '自社の施工実績・お客様の声が活用できる'],
    searchIntent: '色選びで失敗したくない／自宅に合う色を知りたい',
    competition: '上位10サイトのうち7サイトがこのテーマを扱っている',
    usablePrimaryInfoIds: ['pi1'],
    missingInfoHint: '実際の色選びの相談内容や失敗事例',
  },
  {
    id: 'theme2',
    title: '外壁塗装の費用相場と内訳',
    keyword: '外壁塗装 費用 相場',
    priority: '中',
    reasons: ['検索ボリュームが大きい', '既存記事はあるが情報が古い', '競合が価格訴求を強めている'],
    searchIntent: '適正価格を知りたい／見積もりの妥当性を判断したい',
    competition: '上位サイトの多くが料金表を掲載している',
    usablePrimaryInfoIds: ['pi3'],
    missingInfoHint: '実際の見積もり内訳や価格帯の事例',
  },
  {
    id: 'theme3',
    title: '外壁塗装は何年ごとに必要か',
    keyword: '外壁塗装 時期 目安',
    priority: '中',
    reasons: ['季節性のある検索需要がある', '自社サイトに関連記事が少ない'],
    searchIntent: '自宅の塗装時期を判断したい',
    competition: '一般的な内容の記事が多く、独自性で差別化しやすい',
    usablePrimaryInfoIds: ['pi2'],
    missingInfoHint: '実際に多い相談タイミングや劣化サインの実例',
  },
];

// 「今、直すべき記事」デモ用の既存記事（仕様書4.1の表示例と同じ数値を使用）
const SEED_FIX_ARTICLE = {
  id: 'existing-1',
  title: '外壁塗装の費用相場について',
  priority: '高',
  stats: { rankBefore: 4, rankNow: 9, ctrChangePct: -32, note: '上位競合3記事が更新されている／統計データが旧年度のまま' },
  sections: [
    { id: 'sec1', heading: 'H2：市場規模・相場感', issue: '掲載データが旧年度のまま。上位競合は最新データへ更新済み', recommendation: '最新の相場データへ更新し、価格変動の背景を解説する' },
    { id: 'sec2', heading: 'H2：料金の内訳', issue: '自社の実際の見積もり事例が反映されていない', recommendation: '自社の施工実績・見積もり事例を一次情報として追加する' },
  ],
};

// メディア理解・方向性設計のデモ用シード（既存メディア側の疑似分析結果）
// GSC連携・WordPress接続の有無で内容が変わる（仕様書12章：既存記事一覧の取得手段はGSC連携／簡易クロール／手動アップロード／
// CMS連携のいずれかが未定のため、本デモでは組み合わせを体験できるようにしている）
function buildExistingAnalysis(withGsc, withWordpress) {
  return {
    withGsc,
    withWordpress,
    articlesCount: 18,
    topQueries: withGsc ? ['外壁塗装 業者 比較', '外壁塗装 費用', '屋根塗装 時期'] : [],
    cannibalization: [
      { topic: '費用相場', articles: ['外壁塗装の費用相場について', '塗装費用はいくら？相場ガイド'] },
    ],
    coverageNote: withGsc
      ? '「基礎知識」「実績紹介」は手厚いが、「失敗事例」「アフター保証」は未着手のテーマが多い'
      : '「基礎知識」「実績紹介」は手厚いが、「失敗事例」「アフター保証」は未着手のテーマが多い（GSC未連携のため、記事タイトル・見出しの簡易クロールによる推定です）',
    headingSample: withWordpress ? [
      { title: '外壁塗装の費用相場について', headings: ['H2：外壁塗装の相場とは', 'H2：費用の内訳', 'H3：塗料別の価格差', 'H2：安く抑えるコツ'] },
      { title: '外壁塗装の色選びで失敗しないコツ', headings: ['H2：人気の色ランキング', 'H2：色選びで失敗する理由', 'H3：近隣とのバランス'] },
    ] : null,
  };
}

const DIRECTION_SIMULATION = {
  existing: [
    { name: '基礎知識', priority: '低', coverage: '十分', reason: '既に複数記事があり検索流入も安定している' },
    { name: '費用・料金', priority: '中', coverage: '一部', reason: '記事はあるが情報が古く、カニバリも発生している' },
    { name: '失敗事例', priority: '高', coverage: '未着手', reason: '検索需要があるが自社に該当記事がなく、競合の多くが扱っている' },
    { name: 'アフター保証', priority: '高', coverage: '未着手', reason: '差別化しやすいが未着手のテーマ' },
  ],
  new: [
    { name: '基礎知識', priority: '中', coverage: '未着手', reason: '新規メディアのため、まず信頼を得る入口記事が必要' },
    { name: '費用・料金', priority: '高', coverage: '未着手', reason: '検索需要が大きく、自社の価格帯情報を強みにできる' },
    { name: '選び方・比較', priority: '高', coverage: '未着手', reason: '競合が多く扱うテーマだが、自社の実績・強みで差別化できる' },
    { name: '施工事例', priority: '中', coverage: '未着手', reason: 'ヒアリングで得た実績を活かせるテーマ' },
  ],
};

const BUSINESS_HEARING_TEMPLATES = [
  () => '他社と比べた強みや、専門的に対応できる領域はありますか？',
  () => '代表的な実績・施工事例（件数や規模感）を教えてください。',
  () => '価格帯の目安や、対応エリアの詳細を教えてください。',
  () => '顧客からよく受ける質問や、相談内容の傾向はありますか？',
];

function priorityRank(p) {
  return { 高: 0, 中: 1, 低: 2 }[p] ?? 3;
}
function topClusterOf(clusters) {
  if (!clusters || !clusters.length) return null;
  return [...clusters].sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority))[0];
}

// ---------------------------------------------------------------
// インメモリ・ストア（プロトタイプ用の簡易割り切り。本番DBではありません）
// ---------------------------------------------------------------
const sessions = new Map();
const publishedArticles = new Map();
const mediaProfiles = new Map();

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

// ---------------------------------------------------------------
// AI 呼び出し（Anthropic Messages API）。未設定時はシミュレーションへフォールバック。
// ---------------------------------------------------------------
async function callClaude(systemPrompt, userPrompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Anthropic API error ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  return (data.content || []).map((c) => c.text || '').join('\n');
}

function extractJSON(text) {
  const start = text.search(/[[{]/);
  if (start === -1) throw new Error('no JSON found');
  const openChar = text[start];
  const closeChar = openChar === '{' ? '}' : ']';
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === openChar) depth++;
    else if (text[i] === closeChar) {
      depth--;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error('unbalanced JSON');
}

// system, jsonInstruction 付きの userPrompt を渡し、実AI or シミュレーションでJSONを得る
async function getStructured({ system, user, simulate, label }) {
  if (AI_ENABLED) {
    try {
      const raw = await callClaude(system, user);
      return { data: extractJSON(raw), mode: 'ai' };
    } catch (err) {
      console.warn(`[AI呼び出し失敗・シミュレーションにフォールバック: ${label}]`, err.message);
      return { data: simulate(), mode: 'simulated-fallback' };
    }
  }
  return { data: simulate(), mode: 'simulated' };
}

// ---------------------------------------------------------------
// ルート: 起点（メディア状態判定 → メディア理解 → 方向性設計）【新設・v2】
// ---------------------------------------------------------------
function getMediaProfile(req, res) {
  const { mediaId } = req.body || {};
  const m = mediaProfiles.get(mediaId);
  if (!m) {
    res.status(404).json({ error: 'media profile not found' });
    return null;
  }
  return m;
}

// STEP 0-1: メディア状態判定（3.1）
app.post('/api/media/state', (req, res) => {
  const { mediaState } = req.body || {};
  if (!['existing', 'new'].includes(mediaState)) return res.status(400).json({ error: 'invalid mediaState' });

  const mediaId = newId('media');
  mediaProfiles.set(mediaId, {
    id: mediaId,
    mediaState,
    siteUrl: null,
    businessInfo: null,
    wordpress: null,
    hearing: { history: [], lastQuestion: null, done: false, maxQuestions: 4 },
    existingAnalysis: null,
    topicClusters: null,
    directionConfirmed: false,
  });
  res.json({ mediaId });
});

// STEP 0-2a: 既存メディア理解（3.2）
app.post('/api/media/understand-existing', (req, res) => {
  const m = getMediaProfile(req, res);
  if (!m) return;
  const { siteUrl, withGsc, withWordpress } = req.body || {};
  m.siteUrl = siteUrl || '(未入力)';
  const analysis = buildExistingAnalysis(!!withGsc, !!withWordpress);
  m.existingAnalysis = analysis;
  res.json({ analysis });
});

// WordPress接続（既存・新規どちらのメディア理解からも呼ばれる。将来の公開時CMS連携／3.17にもつながる想定）
app.post('/api/media/wordpress-connect', (req, res) => {
  const m = getMediaProfile(req, res);
  if (!m) return;
  const { siteUrl } = req.body || {};
  m.wordpress = { connected: true, siteUrl: siteUrl || '(未入力)' };
  res.json({ ok: true, siteUrl: m.wordpress.siteUrl });
});

// STEP 0-2b: 新規メディア理解（事業情報の登録＋事業理解ヒアリング／3.3）
app.post('/api/media/business-info', (req, res) => {
  const m = getMediaProfile(req, res);
  if (!m) return;
  const { industry, area } = req.body || {};
  m.businessInfo = { industry: industry || '外壁塗装業', area: area || '未入力' };
  res.json({ ok: true });
});

app.post('/api/media/hearing/next', async (req, res) => {
  const m = getMediaProfile(req, res);
  if (!m) return;
  const { answer } = req.body || {};

  if (answer && m.hearing.lastQuestion) {
    m.hearing.history.push({ question: m.hearing.lastQuestion, answer });
    m.hearing.lastQuestion = null;
  }

  if (m.hearing.history.length >= m.hearing.maxQuestions) {
    m.hearing.done = true;
    return res.json({ done: true, history: m.hearing.history });
  }

  const system = 'あなたは日本語のマーケターです。新しくメディアを立ち上げる企業から、事業内容・強み・実績を引き出すための、短く具体的な質問を1つだけJSONで返してください。フォーマット: {"question": "質問文"}';
  const user = `業種: ${m.businessInfo?.industry}\n商圏: ${m.businessInfo?.area}\nこれまでのヒアリング履歴: ${JSON.stringify(m.hearing.history)}\n\n上記を踏まえ、まだ聞いていない、事業の強み・独自性を引き出す質問を1つ生成してください。`;

  const { data, mode } = await getStructured({
    system,
    user,
    label: 'business-hearing',
    simulate: () => ({ question: BUSINESS_HEARING_TEMPLATES[m.hearing.history.length]() }),
  });

  m.hearing.lastQuestion = data.question;
  res.json({ done: false, question: data.question, questionNumber: m.hearing.history.length + 1, maxQuestions: m.hearing.maxQuestions, mode });
});

// STEP 0-3: メディアの方向性・テーマ領域設計（3.4）
app.post('/api/media/direction', async (req, res) => {
  const m = getMediaProfile(req, res);
  if (!m) return;

  const system = 'あなたはSEO戦略コンサルタントです。与えられた情報から、このメディアが扱うべきテーマ領域（TopicCluster）を3〜5個、優先度・カバレッジ状況とともにJSONで提案してください。フォーマット: {"clusters":[{"name":"","priority":"高|中|低","coverage":"未着手|一部|十分","reason":""}]}';
  const user = m.mediaState === 'existing'
    ? `既存メディアの分析結果: ${JSON.stringify(m.existingAnalysis)}`
    : `業種: ${m.businessInfo?.industry}\n商圏: ${m.businessInfo?.area}\n事業理解ヒアリング: ${m.hearing.history.map((h) => `Q:${h.question} A:${h.answer}`).join(' / ')}`;

  const { data, mode } = await getStructured({
    system,
    user,
    label: 'direction',
    simulate: () => ({ clusters: DIRECTION_SIMULATION[m.mediaState] }),
  });

  m.topicClusters = data.clusters;
  res.json({ clusters: data.clusters, topCluster: topClusterOf(data.clusters), mode });
});

app.post('/api/media/confirm-direction', (req, res) => {
  const m = getMediaProfile(req, res);
  if (!m) return;
  m.directionConfirmed = true;
  res.json({ ok: true });
});

// ---------------------------------------------------------------
// ルート: テーマ一覧・セッション
// ---------------------------------------------------------------
app.get('/api/themes', (req, res) => {
  const themes = THEMES.map((t) => ({
    ...t,
    availablePrimaryInfo: t.usablePrimaryInfoIds.map((id) => PRIMARY_INFO_LIBRARY[id]),
  }));

  let direction = null;
  const mediaId = req.query.mediaId;
  if (mediaId && mediaProfiles.has(mediaId)) {
    const m = mediaProfiles.get(mediaId);
    if (m.topicClusters) {
      direction = { mediaState: m.mediaState, clusters: m.topicClusters, topCluster: topClusterOf(m.topicClusters) };
    }
  }

  res.json({ themes, aiEnabled: AI_ENABLED, direction });
});

app.post('/api/session', (req, res) => {
  const { themeId } = req.body || {};
  const theme = THEMES.find((t) => t.id === themeId);
  if (!theme) return res.status(400).json({ error: 'invalid themeId' });

  const sessionId = newId('sess');
  sessions.set(sessionId, {
    id: sessionId,
    theme,
    availablePrimaryInfo: theme.usablePrimaryInfoIds.map((id) => PRIMARY_INFO_LIBRARY[id]),
    hearing: { history: [], lastQuestion: null, done: false, maxQuestions: 3 },
    outline: null,
    article: null,
    publishedArticleId: null,
  });
  res.json({ sessionId, theme, availablePrimaryInfo: theme.usablePrimaryInfoIds.map((id) => PRIMARY_INFO_LIBRARY[id]) });
});

function getSession(req, res) {
  const { sessionId } = req.body || {};
  const s = sessions.get(sessionId);
  if (!s) {
    res.status(404).json({ error: 'session not found' });
    return null;
  }
  return s;
}

// ---------------------------------------------------------------
// AIヒアリング（3.8）: 最大3問。ユーザーの負担にならないよう上限を設ける。
// ---------------------------------------------------------------
const HEARING_TEMPLATES = [
  (theme) => `「${theme.title}」について、御社では実際にどのようなご相談を受けることが多いですか？`,
  (theme) => `${theme.title}に関連して、実際の事例や具体的な数字（件数・期間・金額など）はありますか？`,
  (theme) => `現場の実感として、一般的に言われていることと違うと感じるポイントはありますか？`,
];

app.post('/api/hearing/next', async (req, res) => {
  const s = getSession(req, res);
  if (!s) return;
  const { answer } = req.body || {};

  if (answer && s.hearing.lastQuestion) {
    s.hearing.history.push({ question: s.hearing.lastQuestion, answer });
    s.hearing.lastQuestion = null;
  }

  if (s.hearing.history.length >= s.hearing.maxQuestions) {
    s.hearing.done = true;
    return res.json({ done: true, history: s.hearing.history });
  }

  const system = 'あなたは日本語のSEO・コンテンツ編集者です。企業独自の一次情報（実績・事例・現場の声）を引き出すための、短く具体的な質問を1つだけJSONで返してください。フォーマット: {"question": "質問文"}';
  const user = `記事テーマ: ${s.theme.title}\n検索キーワード: ${s.theme.keyword}\n既に登録済みの一次情報: ${s.availablePrimaryInfo.map((p) => `${p.label}: ${p.text}`).join(' / ')}\n不足していると推測される情報: ${s.theme.missingInfoHint}\nこれまでのヒアリング履歴: ${JSON.stringify(s.hearing.history)}\n\n上記を踏まえ、まだ聞いていない、記事の独自性を高めるための質問を1つ生成してください。`;

  const { data, mode } = await getStructured({
    system,
    user,
    label: 'hearing',
    simulate: () => ({ question: HEARING_TEMPLATES[s.hearing.history.length](s.theme) }),
  });

  s.hearing.lastQuestion = data.question;
  res.json({ done: false, question: data.question, questionNumber: s.hearing.history.length + 1, maxQuestions: s.hearing.maxQuestions, mode });
});

// ---------------------------------------------------------------
// 記事構成生成（3.10）
// ---------------------------------------------------------------
app.post('/api/outline', async (req, res) => {
  const s = getSession(req, res);
  if (!s) return;

  const system = 'あなたは日本語のSEO編集者です。与えられた情報から、検索ユーザーの疑問に答えつつ、企業独自の一次情報を活かした記事構成をJSONで返してください。フォーマット: {"title":"","intro":"導入文","sections":[{"h2":"","h3s":["",""],"summary":"このセクションで書く内容の要約"}]}。sectionsは3〜4個。';
  const user = `記事テーマ: ${s.theme.title}\nキーワード: ${s.theme.keyword}\n検索意図: ${s.theme.searchIntent}\n一次情報: ${s.availablePrimaryInfo.map((p) => `${p.label}: ${p.text}`).join(' / ')}\nヒアリングで得た情報: ${s.hearing.history.map((h) => `Q:${h.question} A:${h.answer}`).join(' / ') || 'なし'}`;

  const { data, mode } = await getStructured({
    system,
    user,
    label: 'outline',
    simulate: () => ({
      title: `${s.theme.title}｜プロが解説`,
      intro: `「${s.theme.title}」で悩んでいませんか？現場での実績をもとに、失敗しないポイントを解説します。`,
      sections: [
        { h2: `${s.theme.title}とは`, h3s: ['基本的な考え方'], summary: '検索ユーザーの前提知識を整理する' },
        { h2: '現場でよくあるご相談', h3s: s.hearing.history.map((h) => h.answer.slice(0, 18)), summary: 'ヒアリングで得た自社ならではの情報を紹介する' },
        { h2: '選び方・進め方のポイント', h3s: ['チェックすべき点', '失敗しやすい点'], summary: '実務目線での注意点を解説する' },
        { h2: 'まとめ', h3s: [], summary: '要点を整理し、相談を促す' },
      ],
    }),
  });

  s.outline = data;
  res.json({ outline: data, mode });
});

// ---------------------------------------------------------------
// 記事本文生成（構造化ブロックとして生成し、画像・表・引用等の装飾も含める）
// ---------------------------------------------------------------
app.post('/api/article', async (req, res) => {
  const s = getSession(req, res);
  if (!s) return;
  if (!s.outline) return res.status(400).json({ error: 'outline not generated yet' });

  const system = `あなたは日本語のSEO編集者兼デザイナーです。以下のブロック形式のJSONで、独自性の高い記事本文を生成してください。
一般論だけで終わらせず、与えられた「一次情報」「ヒアリング回答」を必ず具体的に本文・引用に反映してください。
フォーマット: {"title":"","blocks":[ブロックの配列]}
ブロックのtype一覧:
 - {"type":"image","role":"hero","alt":"アイキャッチ画像の説明"}
 - {"type":"paragraph","text":""}
 - {"type":"h2","text":""}
 - {"type":"h3","text":""}
 - {"type":"list","items":["",""]}
 - {"type":"quote","text":"現場の声や事例の引用","cite":"（社内実績より）"}
 - {"type":"table","caption":"","headers":["",""],"rows":[["",""]]}
 - {"type":"callout","text":"注意点や補足の強調表示"}
 - {"type":"image","role":"inline","alt":"補足図解の説明"}
 - {"type":"cta","text":"相談を促す一言","buttonLabel":"無料相談する"}
必ずhero画像を1つ、H2ごとに本文paragraphを1つ以上、quoteを最低1つ、listまたはtableを最低1つ、calloutを1つ、末尾にctaを1つ含めてください。`;
  const user = `記事構成: ${JSON.stringify(s.outline)}\n一次情報: ${s.availablePrimaryInfo.map((p) => `${p.label}: ${p.text}`).join(' / ')}\nヒアリング回答: ${s.hearing.history.map((h) => `Q:${h.question} A:${h.answer}`).join(' / ') || 'なし'}`;

  const { data, mode } = await getStructured({
    system,
    user,
    label: 'article',
    simulate: () => simulateArticle(s),
  });

  s.article = data;
  res.json({ article: data, mode });
});

function simulateArticle(s) {
  const blocks = [];
  blocks.push({ type: 'image', role: 'hero', alt: `${s.theme.title}のイメージ` });
  blocks.push({ type: 'paragraph', text: s.outline?.intro || `「${s.theme.title}」について、現場の実績をもとに解説します。` });
  (s.outline?.sections || []).forEach((sec, i) => {
    blocks.push({ type: 'h2', text: sec.h2 });
    blocks.push({ type: 'paragraph', text: `${sec.h2}について、${sec.summary || '重要なポイント'}を押さえておくことが大切です。` });
    if (i === 1 && s.hearing.history.length) {
      blocks.push({
        type: 'quote',
        text: s.hearing.history[0].answer,
        cite: '（お客様対応の実例より）',
      });
    }
    (sec.h3s || []).forEach((h3) => {
      if (!h3) return;
      blocks.push({ type: 'h3', text: h3 });
      blocks.push({ type: 'paragraph', text: `${h3}については、${s.availablePrimaryInfo[0]?.text || '自社の実績'}からもわかる通り、慎重に検討する必要があります。` });
    });
  });
  blocks.push({
    type: 'list',
    items: [
      '検索ユーザーが本当に知りたい情報を優先する',
      '自社にしか書けない実績・事例を盛り込む',
      '専門用語には補足を添える',
    ],
  });
  blocks.push({ type: 'callout', text: `※本記事の内容は${new Date().getFullYear()}年時点の情報です。最新の状況は改めてご確認ください。` });
  blocks.push({ type: 'image', role: 'inline', alt: `${s.theme.title}の比較イメージ` });
  blocks.push({ type: 'cta', text: 'もっと詳しく知りたい方へ', buttonLabel: '無料相談する' });
  return { title: s.outline?.title || s.theme.title, blocks };
}

// ---------------------------------------------------------------
// 記事編集（STEP8: 保存・単一ブロック再生成）
// ---------------------------------------------------------------
app.post('/api/article/save', (req, res) => {
  const s = getSession(req, res);
  if (!s) return;
  const { article } = req.body || {};
  if (!article) return res.status(400).json({ error: 'article required' });
  s.article = article;
  res.json({ ok: true });
});

app.post('/api/article/regenerate-block', async (req, res) => {
  const s = getSession(req, res);
  if (!s) return;
  const { blockIndex } = req.body || {};
  const block = s.article?.blocks?.[blockIndex];
  if (!block) return res.status(400).json({ error: 'invalid blockIndex' });

  const system = '与えられた1つの記事ブロックを、同じtype・同じ意味内容のまま、少し違う表現で書き直してJSONで1ブロックだけ返してください。';
  const user = `記事テーマ: ${s.theme.title}\n書き直し対象ブロック: ${JSON.stringify(block)}`;

  const { data, mode } = await getStructured({
    system,
    user,
    label: 'regenerate-block',
    simulate: () => {
      if (block.type === 'paragraph') return { ...block, text: `【再生成】${block.text}` };
      if (block.type === 'list') return { ...block, items: block.items.map((i) => `${i}（見直し済み）`) };
      if (block.type === 'quote') return { ...block };
      return { ...block };
    },
  });

  s.article.blocks[blockIndex] = data;
  res.json({ block: data, mode });
});

// ---------------------------------------------------------------
// 公開（3.17を仮の1クリック公開として簡略化）
// ---------------------------------------------------------------
app.post('/api/publish', (req, res) => {
  const s = getSession(req, res);
  if (!s) return;
  if (!s.article) return res.status(400).json({ error: 'article not generated yet' });

  const articleId = newId('art');
  const record = {
    id: articleId,
    title: s.article.title,
    blocks: s.article.blocks,
    theme: s.theme,
    publishedAt: new Date().toISOString(),
  };
  publishedArticles.set(articleId, record);
  s.publishedArticleId = articleId;
  res.json({ articleId, url: `/media/${articleId}`, publishedAt: record.publishedAt });
});

app.get('/api/media/:articleId', (req, res) => {
  const rec = publishedArticles.get(req.params.articleId);
  if (!rec) return res.status(404).json({ error: 'not found' });
  res.json(rec);
});

app.get('/api/monitoring', (req, res) => {
  const mine = Array.from(publishedArticles.values()).map((a) => ({
    id: a.id,
    title: a.title,
    publishedAt: a.publishedAt,
    status: '公開直後・監視中（順調）',
  }));
  res.json({ mine, fixCandidate: SEED_FIX_ARTICLE });
});

app.get('/api/fix-candidates/:id', (req, res) => {
  if (req.params.id !== SEED_FIX_ARTICLE.id) return res.status(404).json({ error: 'not found' });
  res.json(SEED_FIX_ARTICLE);
});

// ---------------------------------------------------------------
// リライト（3.14〜3.15の簡易版。新規記事フローを優先するため簡略化）
// ---------------------------------------------------------------
app.post('/api/rewrite', async (req, res) => {
  const { sectionId } = req.body || {};
  const section = SEED_FIX_ARTICLE.sections.find((sec) => sec.id === sectionId);
  if (!section) return res.status(400).json({ error: 'invalid sectionId' });

  const system = '記事の一部を修正するリライト担当者として、なぜ直すか・何を参照したか・修正後の文章案をJSONで返してください。フォーマット: {"reason":"","referencedInfo":"","rewriteText":""}';
  const user = `記事タイトル: ${SEED_FIX_ARTICLE.title}\n対象箇所: ${section.heading}\n問題点: ${section.issue}\n推奨対応: ${section.recommendation}`;

  const { data, mode } = await getStructured({
    system,
    user,
    label: 'rewrite',
    simulate: () => ({
      reason: `${section.issue}ため、情報の陳腐化・競合との差分の観点から更新が必要です。`,
      referencedInfo: '一次情報／最新の外部データ／競合との差分（3.15）',
      rewriteText: `【更新後案】${section.heading}については、最新の状況を踏まえて次のように見直します。${section.recommendation}。`,
    }),
  });

  res.json({ ...data, mode });
});

app.listen(PORT, () => {
  console.log(`メディアコンパス極プロトタイプ起動: http://localhost:${PORT}`);
  console.log(AI_ENABLED ? `AI連携: 有効 (model=${MODEL})` : 'AI連携: 未設定のためシミュレーションモードで動作します');
});
