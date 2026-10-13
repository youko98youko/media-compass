// 投稿済み記事のリライト支援（ローカル版）
//  1) WordPressから投稿済み記事を取り込み、GSCの実績と合わせて「リライト候補」を判定する
//  2) 候補の記事から「リライト施策」を作り、AIがリライト案（診断・修正ポイント・全文）を作る
//  3) リライト案は、WordPressへ「新しい下書き」として保存する（公開中の記事は書き換えない）
//  4) リライト後の効果（順位・クリックなどの変化）を測定する
const accounts = require('./accounts');
const gsc = require('./gsc');
const wordpress = require('./wordpress');

const TITLE_PREFIX = '【リライト案】';

// ---- リライト候補の判定（ルールベース。しきい値は、運用しながら調整する想定） ----
function evaluate(article, cur, prev, now = Date.now()) {
  const reasons = [];
  let score = 0;
  const modified = article.modified ? Date.parse(article.modified) : null;
  const ageDays = modified ? Math.floor((now - modified) / 86400000) : null;

  if (cur && prev) {
    const dPos = cur.position - prev.position; // 正の値は、順位が下がったことを表す
    if (prev.impressions >= 50 && cur.impressions >= 20 && dPos >= 2) {
      reasons.push(`平均順位が ${prev.position}位 → ${cur.position}位 に低下`);
      score += Math.min(40, 15 + dPos * 5);
    }
    if (prev.clicks >= 10 && cur.clicks <= prev.clicks * 0.7) {
      const pct = Math.round((1 - cur.clicks / prev.clicks) * 100);
      reasons.push(`クリックが ${prev.clicks}回 → ${cur.clicks}回（${pct}%減）`);
      score += Math.min(35, 10 + pct / 2);
    }
    if (prev.impressions >= 100 && cur.impressions <= prev.impressions * 0.6) {
      const pct = Math.round((1 - cur.impressions / prev.impressions) * 100);
      reasons.push(`検索での表示が ${prev.impressions}回 → ${cur.impressions}回（${pct}%減）`);
      score += Math.min(25, 8 + pct / 3);
    }
    if (prev.impressions >= 100 && cur.impressions >= 100 && prev.ctr > 0 && cur.ctr <= prev.ctr * 0.75) {
      reasons.push(`クリック率が ${prev.ctr}% → ${cur.ctr}% に低下`);
      score += 15;
    }
  }
  if (cur) {
    if (cur.position >= 11 && cur.position <= 20 && cur.impressions >= 100) {
      reasons.push(`${cur.position}位で、1ページ目に届く可能性がある（表示 ${cur.impressions}回）`);
      score += 25;
    }
    if (cur.impressions >= 300 && cur.ctr < 1 && cur.position <= 15) {
      reasons.push(`表示は多い（${cur.impressions}回）が、クリック率が低い（${cur.ctr}%）`);
      score += 20;
    }
  }
  if (ageDays !== null && ageDays >= 365) {
    reasons.push(`最終更新から ${Math.floor(ageDays / 30)}か月以上たっている`);
    score += ageDays >= 730 ? 20 : 10;
  }
  if (ageDays !== null && ageDays >= 180 && (!cur || cur.impressions < 10)) {
    reasons.push('直近28日で、検索での表示がほとんどない');
    score += 8;
  }
  const priority = score >= 45 ? '高' : score >= 20 ? '中' : score > 0 ? '低' : null;
  return { score: Math.round(score), priority, reasons };
}

// ---- AIへの指示 ----
const BLOCK_SPEC = `ブロックのtype一覧（blocksの要素）:
 - {"type":"image","role":"hero","alt":"アイキャッチ画像の説明"}
 - {"type":"paragraph","text":""}
 - {"type":"h2","text":""}
 - {"type":"h3","text":""}
 - {"type":"list","items":["",""]}
 - {"type":"quote","text":"現場の声や事例の引用","cite":"（出典）"}
 - {"type":"table","caption":"","headers":["",""],"rows":[["",""]]}
 - {"type":"callout","text":"注意点や補足の強調表示"}
 - {"type":"image","role":"inline","alt":"補足図解の説明"}
 - {"type":"cta","text":"相談を促す一言","buttonLabel":"無料相談する"}`;

const REWRITE_SYSTEM = `あなたは日本語のSEO編集者です。公開済みの記事を、検索からの流入を回復・向上させるために、リライトしてください。
入力として、記事の現状（タイトルと、見出し・本文の内容）、検索の実績（表示回数・クリック・順位の変化）、この記事に流入している検索クエリ、リライトが必要と判定された理由が、与えられます。

方針:
- 元の記事にある、正しい情報・独自の知見・事例・良い構成は、できるだけ残す。
- 検索意図に合っていない部分、内容が薄い部分、古い可能性がある部分を、改善・追加する。
- 検索クエリを見て、読者が知りたいことに答える構成に直し、タイトルと見出しも見直す。
- 数値・制度・日付・固有名詞など、事実の確認が必要なものを、断定して書き換えない。新しい事実を、創作しない。確認が必要な点は、"【要確認】"で始まるcalloutブロックで、人が確認する点として示す。
- 全文を、リライトした記事として出力する（元の記事の、残す部分も含める）。

JSONのみで返してください。フォーマット:
{"diagnosis":"この記事の何が問題か（2〜4文）","changes":[{"area":"対象の箇所（見出しなど）","issue":"問題点","action":"どう直したか"}],"titleSuggestion":"改善したタイトル案","metaDescription":"検索結果に出す説明文案（120字程度）","article":{"title":"リライト後のタイトル","blocks":[ブロックの配列]}}
changesは3〜6件。
${BLOCK_SPEC}
必ずhero画像を1つ、H2ごとに本文paragraphを1つ以上、listまたはtableを最低1つ、末尾にctaを1つ含めてください。`;

function sanitizeBlocks(blocks) {
  const ok = new Set(['image', 'paragraph', 'h2', 'h3', 'list', 'quote', 'table', 'callout', 'cta']);
  return (Array.isArray(blocks) ? blocks : []).filter((b) => b && ok.has(b.type));
}

const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

function install(app, ctx) {
  const { ownedMedia, loadWp, loadGsc, applyRegisteredSite, getStructured, AI_ENABLED, sessions, newId } = ctx;

  const guard = (req, res) => {
    if (!accounts.ENABLED) { res.status(404).json({ error: 'accounts_disabled' }); return null; }
    if (!req.user) { res.status(401).json({ error: 'login_required' }); return null; }
    const m = ownedMedia(req, req.body?.mediaId ?? req.query?.mediaId);
    if (!m) { res.status(404).json({ error: 'media profile not found' }); return null; }
    const reg = m.regId ? accounts.getRegisteredMedia(req.user.id, m.regId) : null;
    if (!reg) { res.status(400).json({ error: '登録済みのメディアを選んでください（記事の取り込みは、登録したメディアで行います）' }); return null; }
    return { m, reg };
  };

  const gscFor = (req, m) => {
    const g = loadGsc(req, m);
    applyRegisteredSite(req, m);
    return g && g.siteUrl ? g : null;
  };

  // ---- 記事の一覧（取り込み済み） ----
  app.get('/api/articles', (req, res) => {
    const ctx2 = guard(req, res);
    if (!ctx2) return;
    const { reg } = ctx2;
    const measures = accounts.listMeasures(req.user.id).filter((x) => x.kind === 'rewrite' && x.regId === reg.id);
    const rewrites = {};
    for (const x of measures) {
      const k = x.article?.wpId;
      if (k == null) continue;
      if (!rewrites[k] || (rewrites[k].status === '完了' && x.status !== '完了')) rewrites[k] = { measureId: x.id, status: x.status };
    }
    res.json({ media: { id: reg.id, name: reg.name, siteUrl: reg.siteUrl }, articles: reg.articles || [], syncedAt: reg.articlesSyncedAt || null, periods: reg.articlesPeriods || null, note: reg.articlesNote || '', rewrites });
  });

  // ---- 記事の取り込み（WordPress）と、実績の取り込み（GSC）、リライト候補の判定 ----
  app.post('/api/articles/sync', async (req, res) => {
    const ctx2 = guard(req, res);
    if (!ctx2) return;
    const { m, reg } = ctx2;
    const wp = loadWp(req, m);
    if (!wp?.real) return res.status(400).json({ error: 'wordpress_not_connected' });
    try {
      const posts = await wordpress.listPublishedPosts(wp.cfg);
      let perf = null;
      let note = '';
      const g = gscFor(req, m);
      if (g) {
        try { perf = await gsc.fetchPagePerformance(g); } catch (e) { note = `GSCの実績を取得できませんでした（${e.message}）。記事の更新日だけで判定しています。`; }
      } else {
        note = 'GSCが未連携（またはサイトが未選択）のため、記事の更新日だけで判定しています。GSCと連携すると、順位やクリックの変化も使えます。';
      }
      const articles = posts.map((p) => {
        const key = gsc.normUrl(p.url);
        const cur = perf ? perf.cur.get(key) || null : null;
        const prev = perf ? perf.prev.get(key) || null : null;
        const cand = evaluate(p, cur, prev);
        return { id: p.id, title: p.title, url: p.url, date: p.date, modified: p.modified, cur, prev, candidate: cand };
      }).sort((a, b) => b.candidate.score - a.candidate.score || String(a.modified).localeCompare(String(b.modified)));
      accounts.updateRegisteredMedia(req.user.id, reg.id, { articles, articlesSyncedAt: new Date().toISOString(), articlesPeriods: perf ? perf.periods : null, articlesNote: note });
      res.json({ count: articles.length, withMetrics: articles.filter((a) => a.cur).length, candidates: articles.filter((a) => a.candidate.priority).length, note });
    } catch (e) {
      console.warn('[記事の取り込み失敗]', e.message);
      res.status(502).json({ error: e.message });
    }
  });

  // ---- リライト施策の作成と、AIによるリライト案の作成 ----
  app.post('/api/rewrite/start', async (req, res) => {
    const ctx2 = guard(req, res);
    if (!ctx2) return;
    const { m, reg } = ctx2;
    if (!AI_ENABLED) return res.status(400).json({ error: 'リライト案の作成には、AI連携（OpenAIのAPIキー）が必要です' });
    const wp = loadWp(req, m);
    if (!wp?.real) return res.status(400).json({ error: 'wordpress_not_connected' });
    const article = (reg.articles || []).find((a) => String(a.id) === String(req.body?.articleId));
    if (!article) return res.status(404).json({ error: '記事が見つかりません。記事を取り込み直してください' });

    try {
      // 同じ記事で、完了していないリライト施策があれば、それを使う（重複して作らない）
      let measure = accounts.listMeasures(req.user.id).find((x) => x.kind === 'rewrite' && x.regId === reg.id && x.article?.wpId === article.id && x.status !== '完了');
      const g = gscFor(req, m);
      if (!measure) {
        // 施策を作る時点の実績を、効果測定の基準（ベースライン）として記録する
        let baseline = article.cur ? { ...article.cur, period: reg.articlesPeriods?.cur || null } : null;
        if (g) { try { baseline = await gsc.fetchPageTotal(g, article.cur?.page || article.url); } catch { /* 取れなければ、取り込み時の値を使う */ } }
        measure = accounts.createMeasure(req.user.id, {
          kind: 'rewrite',
          regId: reg.id,
          mediaName: reg.name,
          title: `【リライト】${article.title}`,
          memo: (article.candidate?.reasons || []).join(' ／ '),
          status: '未着手',
          article: { wpId: article.id, title: article.title, url: article.url, modified: article.modified },
          reasons: article.candidate?.reasons || [],
          baseline,
          effects: [],
        });
      }
      if (measure.rewrite && !req.body?.force) return res.json({ measure: publicMeasure(measure), reused: true });

      const content = await wordpress.getPostContent(wp.cfg, article.id);
      let queries = [];
      if (g) { try { queries = await gsc.fetchPageQueries(g, article.cur?.page || article.url); } catch { /* クエリが取れなくても、リライトはできる */ } }
      const metricsText = (x) => (x ? `表示${x.impressions}回／クリック${x.clicks}回／クリック率${x.ctr}%／平均順位${x.position}位` : '（データなし）');
      const user = [
        `メディア：${reg.name}（${reg.siteUrl}）`,
        `記事のタイトル：${content.title}`,
        `記事のURL：${article.url}`,
        `最終更新：${article.modified || '不明'}`,
        `検索実績（直近28日）：${metricsText(article.cur)}`,
        `検索実績（その前の28日）：${metricsText(article.prev)}`,
        `リライトが必要と判定された理由：${(article.candidate?.reasons || []).join(' ／ ') || '（なし。定期的な見直し）'}`,
        `この記事に流入している検索クエリ（直近28日）：${queries.length ? queries.map((q) => `「${q.query}」（表示${q.impressions}・クリック${q.clicks}・順位${q.position}）`).join('、') : '（取得できていません）'}`,
        '',
        '【現在の記事の内容】',
        wordpress.htmlToOutline(content.html),
      ].join('\n');

      const { data, mode } = await getStructured({
        system: REWRITE_SYSTEM,
        user,
        label: 'rewrite-article',
        simulate: () => { throw new Error('AIの呼び出しに失敗しました。しばらくしてから、もう一度お試しください'); },
      });
      const blocks = sanitizeBlocks(data?.article?.blocks);
      if (!blocks.length) throw new Error('リライト案を作成できませんでした。もう一度お試しください');

      measure = accounts.updateMeasure(req.user.id, measure.id, {
        status: '対応中',
        proposal: {
          diagnosis: String(data.diagnosis || ''),
          changes: (Array.isArray(data.changes) ? data.changes : []).slice(0, 10).map((c) => ({ area: String(c.area || ''), issue: String(c.issue || ''), action: String(c.action || '') })),
          titleSuggestion: String(data.titleSuggestion || ''),
          metaDescription: String(data.metaDescription || ''),
          queries: queries.slice(0, 10),
          generatedAt: new Date().toISOString(),
          mode,
        },
        rewrite: { title: String(data.article?.title || content.title), blocks },
      });
      res.json({ measure: publicMeasure(measure) });
    } catch (e) {
      console.warn('[リライト案の作成失敗]', e.message);
      res.status(502).json({ error: e.message });
    }
  });

  const publicMeasure = ({ userId, rewrite, ...x }) => ({ ...x, hasRewrite: !!rewrite });

  // ---- リライト案を、編集画面（記事の編集・WordPress下書き保存）で開く ----
  app.post('/api/rewrite/session', (req, res) => {
    const ctx2 = guard(req, res);
    if (!ctx2) return;
    const measure = accounts.findMeasure(req.user.id, String(req.body?.measureId || ''));
    if (!measure || measure.kind !== 'rewrite' || !measure.rewrite) return res.status(404).json({ error: 'リライト案が見つかりません' });
    const sessionId = newId('sess');
    const theme = { id: 'rewrite', title: measure.article.title, keyword: '', priority: '', reasons: measure.reasons || [], searchIntent: '', competition: '', usablePrimaryInfoIds: [], missingInfoHint: '' };
    sessions.set(sessionId, {
      id: sessionId,
      userId: req.user.id,
      mediaId: ctx2.m.id,
      theme,
      availablePrimaryInfo: [],
      mediaContext: '',
      hearing: { history: [], lastQuestion: null, done: true, maxQuestions: 0 },
      outline: null,
      article: JSON.parse(JSON.stringify(measure.rewrite)),
      publishedArticleId: null,
      measureId: measure.id,
      titlePrefix: TITLE_PREFIX,
      wpDraftId: measure.draft?.id || null, // 再度保存するときは、同じ下書きを更新する
    });
    res.json({ sessionId, theme, article: sessions.get(sessionId).article, measure: publicMeasure(measure) });
  });

  // ---- 効果測定：リライト前（ベースライン）と、直近28日を比べる ----
  app.post('/api/measures/:id/effect', async (req, res) => {
    const ctx2 = guard(req, res);
    if (!ctx2) return;
    const { m } = ctx2;
    const measure = accounts.findMeasure(req.user.id, req.params.id);
    if (!measure || measure.kind !== 'rewrite') return res.status(404).json({ error: '施策が見つかりません' });
    const g = gscFor(req, m);
    if (!g) return res.status(400).json({ error: '効果の測定には、GSCの連携と、サイトの選択が必要です' });
    try {
      const after = await gsc.fetchPageTotal(g, measure.article.url);
      const before = measure.baseline;
      const days = measure.rewrittenAt ? Math.floor((Date.now() - Date.parse(measure.rewrittenAt)) / 86400000) : null;
      const delta = before ? {
        clicks: after.clicks - before.clicks,
        impressions: after.impressions - before.impressions,
        ctr: round1(after.ctr - before.ctr),
        position: before.position != null && after.position != null ? round1(after.position - before.position) : null, // 負の値は、順位が上がったこと
      } : null;
      const effect = { measuredAt: new Date().toISOString(), after, delta, daysSinceRewrite: days };
      const updated = accounts.updateMeasure(req.user.id, measure.id, { effects: [...(measure.effects || []), effect].slice(-20) });
      res.json({ measure: publicMeasure(updated), effect });
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });
}

// ---- 編集画面からの保存・WordPress下書き保存を、施策に反映する ----
function onArticleSaved(session) {
  if (!session.measureId || !session.userId) return;
  accounts.updateMeasure(session.userId, session.measureId, { rewrite: { title: session.article.title, blocks: session.article.blocks } });
}

function onDraftSaved(session, info) {
  if (!session.measureId || !session.userId) return;
  const cur = accounts.findMeasure(session.userId, session.measureId);
  accounts.updateMeasure(session.userId, session.measureId, {
    status: cur && cur.status === '完了' ? '完了' : '確認待ち', // すでに完了の施策は、完了のまま（再保存で戻さない）
    rewrite: { title: session.article.title, blocks: session.article.blocks },
    draft: { id: info.draftId, editUrl: info.editUrl, previewUrl: info.previewUrl, siteName: info.siteName, savedAt: info.savedAt },
  });
}

module.exports = { install, evaluate, onArticleSaved, onDraftSaved, TITLE_PREFIX };
