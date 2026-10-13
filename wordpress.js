// WordPress連携（REST API＋アプリケーションパスワード）
// 記事は必ず「下書き」として投稿する。公開（status: publish）は、このアプリからは行わない。
// ※プロトタイプのため、認証情報はサーバーのメモリ上にのみ保持する（画面・ログには出さない）。
const { assertPublicUrl } = require('./crawler');

// リンク先として使えるURL（http／https）だけを返す。それ以外（javascript: など）は、使わない。
function safeHttpUrl(u) {
  try {
    const x = new URL(String(u || '').trim());
    return ['http:', 'https:'].includes(x.protocol) ? x.toString() : '';
  } catch { return ''; }
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function normalizeSite(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('サイトURLを入力してください');
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  const u = new URL(s);
  // 認証情報を平文で送らないよう、httpのURLはhttpsに切り替える（自動テスト用のローカルの擬似サーバーを除く）
  if (u.protocol === 'http:' && process.env.ALLOW_LOCAL_TARGETS !== '1') u.protocol = 'https:';
  // ログイン画面・管理画面・APIのURLを貼り付けても、サイトのトップ（WordPressのインストール場所）に直す
  const base = u.pathname.replace(/\/(wp-login\.php|wp-admin(\/.*)?|xmlrpc\.php|wp-json(\/.*)?|wp-content(\/.*)?|index\.php)$/i, '');
  return `${u.origin}${base.replace(/\/+$/, '')}`; // 末尾の/を除く（サブディレクトリ運用のWordPressにも対応）
}

function authHeader(cfg) {
  return `Basic ${Buffer.from(`${cfg.username}:${cfg.appPassword}`).toString('base64')}`;
}

// 「パーマリンク設定」によってREST APIのURLが変わるため、使える方を判定して保持する
function apiUrl(cfg, route) {
  const r = route.startsWith('/') ? route : `/${route}`;
  if (cfg.plain) {
    const [path, query] = r.split('?');
    return `${cfg.siteUrl}/?rest_route=${path}${query ? `&${query}` : ''}`;
  }
  return `${cfg.siteUrl}/wp-json${r}`;
}

async function request(cfg, route, { method = 'GET', headers = {}, body, timeoutMs = 30000, noAuth = false } = {}) {
  const url = apiUrl(cfg, route);
  await assertPublicUrl(new URL(url)); // 内部ネットワーク等への接続を防ぐ
  const res = await fetch(url, {
    method,
    redirect: 'manual', // 認証情報を別ホストに送らないため、リダイレクトは追わない
    headers: { ...(noAuth ? {} : { authorization: authHeader(cfg) }), accept: 'application/json', ...headers },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status >= 300 && res.status < 400) {
    const to = res.headers.get('location') || '';
    throw new Error(`サイトのURLがリダイレクトされました。サイトURLを「${to.replace(/\/wp-json.*$/, '').replace(/\?rest_route.*$/, '')}」に変えて、もう一度試してください`);
  }
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* JSONでない応答（HTMLのエラーページ等） */ }
  if (!res.ok) {
    const code = data?.code || '';
    let msg = data?.message || `HTTP ${res.status}`;
    if (res.status === 401 || code === 'incorrect_password' || code === 'invalid_username') msg = 'ユーザー名またはアプリケーションパスワードが正しくありません';
    else if (res.status === 403 || code === 'rest_cannot_create' || code === 'rest_cannot_upload') msg = 'このユーザーには、記事の投稿または画像のアップロードの権限がありません（権限を確認してください）';
    else if (res.status === 404 && !data) msg = 'WordPressのREST APIが見つかりませんでした（サイトURLの確認、またはセキュリティプラグインによる制限の可能性があります）';
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  if (data === null) throw new Error('WordPressから想定外の応答がありました（サイトURLを確認してください）');
  return data;
}

// 認証に失敗したとき、サイトがアプリケーションパスワード自体に対応しているかを調べ、原因に合った案内を返す
async function explainAuthFailure(cfg) {
  try {
    const root = await request(cfg, '/', { noAuth: true });
    const auth = root.authentication;
    const supported = auth && !Array.isArray(auth) && auth['application-passwords'];
    if (!supported) {
      return 'このWordPressサイトは、アプリケーションパスワードに対応していない状態です（入力内容の間違いではありません）。管理画面の「ユーザー」→「プロフィール」に「アプリケーションパスワード」の欄が無ければ、使えません。主な原因は、WordPressのバージョンが古い（5.6より前）、サイトのHTTPS設定が正しくない、セキュリティ系のプラグインなどで無効にされている、のいずれかです。サイトの管理者に確認してください。';
    }
  } catch { /* 原因を特定できなければ、通常の案内にする */ }
  return null;
}

// 接続の確認：REST APIが使え、ユーザーに投稿権限があるかを調べる
async function connect(siteInput, username, appPassword) {
  const user = String(username || '').trim();
  const pass = String(appPassword || '').trim();
  if (!user) throw new Error('ユーザー名を入力してください');
  if (pass.length < 8) throw new Error('アプリケーションパスワードを入力してください（WordPressのログインパスワードではありません）');
  const cfg = { siteUrl: normalizeSite(siteInput), username: user, appPassword: pass, plain: false };

  let me;
  try {
    me = await request(cfg, '/wp/v2/users/me?context=edit');
  } catch (e) {
    if (e.status === 401) {
      const why = await explainAuthFailure(cfg);
      if (why) throw new Error(why);
      throw new Error('ユーザー名またはアプリケーションパスワードが正しくありません。ログイン用のパスワードではなく、WordPressの「ユーザー」→「プロフィール」で発行した「アプリケーションパスワード」（英数字24文字。4文字ずつ空白で区切って表示されます）を入力してください');
    }
    // パーマリンクが「基本」の場合は ?rest_route= 形式でしか届かないため、もう一度試す
    if (e.status === 404 || /REST API/.test(e.message)) {
      cfg.plain = true;
      me = await request(cfg, '/wp/v2/users/me?context=edit');
    } else {
      throw e;
    }
  }
  const caps = me.capabilities || {};
  if (caps.edit_posts === false) throw new Error('このユーザーには記事を投稿する権限がありません（「投稿者」以上の権限が必要です）');

  let siteName = '';
  try { siteName = (await request(cfg, '/')).name || ''; } catch { /* サイト名が取れなくても接続は成立 */ }
  return { cfg, userName: me.name || user, siteName, canUpload: caps.upload_files !== false };
}

async function uploadMediaRest(cfg, { buffer, mime, filename, alt }) {
  const media = await request(cfg, '/wp/v2/media', {
    method: 'POST',
    headers: { 'content-type': mime, 'content-disposition': `attachment; filename="${filename}"` },
    body: buffer,
    timeoutMs: 60000,
  });
  if (alt) {
    try {
      await request(cfg, `/wp/v2/media/${media.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ alt_text: alt }) });
    } catch { /* 代替テキストの設定に失敗しても画像自体は使える */ }
  }
  return { id: media.id, url: media.source_url };
}

// 記事ブロックをWordPress用のHTMLにする。imageUrls: ブロック番号 -> アップロード済み画像のURL
function blocksToHtml(blocks, imageUrls, { placeholders = false } = {}) {
  const out = [];
  blocks.forEach((b, i) => {
    switch (b.type) {
      case 'image':
        if (b.role === 'hero') break;
        if (imageUrls[i]) out.push(`<figure class="wp-block-image"><img src="${esc(imageUrls[i])}" alt="${esc(b.alt)}"/></figure>`);
        else if (placeholders) out.push(`<p style="background:#fff8e1;border:1px dashed #e0a458;padding:8px;">【ここに画像を挿入】${esc(b.alt)}</p>`); // 書き出し用：画像は、WordPressの「メディアを追加」で挿入する目印
        break; // アイキャッチ画像は本文ではなく「アイキャッチ」に設定する
      case 'h2': out.push(`<h2>${esc(b.text)}</h2>`); break;
      case 'h3': out.push(`<h3>${esc(b.text)}</h3>`); break;
      case 'paragraph': out.push(`<p>${esc(b.text)}</p>`); break;
      case 'list': out.push(`<ul>${(b.items || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`); break;
      case 'quote': out.push(`<blockquote><p>${esc(b.text)}</p>${b.cite ? `<cite>${esc(b.cite)}</cite>` : ''}</blockquote>`); break;
      case 'callout': out.push(`<div style="border-left:4px solid #e0a458;background:#fff8ec;padding:12px 16px;margin:16px 0;"><p>💡 ${esc(b.text)}</p></div>`); break;
      case 'table':
        out.push(`<figure class="wp-block-table"><table>${b.caption ? `<caption>${esc(b.caption)}</caption>` : ''}<thead><tr>${(b.headers || []).map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${(b.rows || []).map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></figure>`);
        break;
      case 'cta': {
        // リンク先URLが指定されていれば、ボタンのリンクにする（http／httpsのURLだけを許可する）
        const url = safeHttpUrl(b.url);
        const label = esc(b.buttonLabel || '詳しくはこちら');
        const button = url
          ? `<a href="${esc(url)}" rel="noopener" style="display:inline-block;background:#1f3a5f;color:#ffffff;padding:10px 28px;border-radius:6px;text-decoration:none;font-weight:bold;">${label}</a>`
          : label;
        out.push(`<div style="background:#f3f6fb;padding:16px;margin:24px 0;text-align:center;"><p><strong>${esc(b.text)}</strong></p><p>${button}</p></div>`);
        break;
      }
      default: break;
    }
  });
  return out.join('\n');
}

// 下書きとして投稿する。existingId があれば、その下書きを更新する（2回押しても重複しない）。
async function saveDraftRest(cfg, { title, html, featuredMedia, existingId }) {
  const payload = { title, content: html, status: 'draft' };
  if (featuredMedia) payload.featured_media = featuredMedia;
  // 既存の下書きを更新するのは、まだ下書きのままの場合だけ（WordPress側で公開済みの記事を、下書きに戻してしまわないため）
  if (existingId) {
    try {
      const current = await request(cfg, `/wp/v2/posts/${existingId}?context=edit`);
      if (current.status !== 'draft') existingId = null;
    } catch { existingId = null; }
  }
  const route = existingId ? `/wp/v2/posts/${existingId}` : '/wp/v2/posts';
  const post = await request(cfg, route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  return { id: post.id, previewUrl: post.link, editUrl: `${cfg.siteUrl}/wp-admin/post.php?post=${post.id}&action=edit`, status: post.status };
}

// ---------------------------------------------------------------
// XML-RPC方式（WordPress 5.6より前の、アプリケーションパスワードが使えないサイト向け）
// 投稿専用の低権限ユーザー（投稿者など）のログイン用パスワードで接続する。記事は常に「下書き」として投稿する。
// ---------------------------------------------------------------
const cheerio = require('cheerio');

const stripControl = (s) => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
const xmlEsc = (s) => stripControl(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function xmlValue(v) {
  if (v === null || v === undefined) return '<value><string></string></value>';
  if (Buffer.isBuffer(v)) return `<value><base64>${v.toString('base64')}</base64></value>`;
  if (typeof v === 'boolean') return `<value><boolean>${v ? 1 : 0}</boolean></value>`;
  if (typeof v === 'number') return Number.isInteger(v) ? `<value><int>${v}</int></value>` : `<value><double>${v}</double></value>`;
  if (Array.isArray(v)) return `<value><array><data>${v.map(xmlValue).join('')}</data></array></value>`;
  if (typeof v === 'object') return `<value><struct>${Object.entries(v).map(([k, x]) => `<member><name>${xmlEsc(k)}</name>${xmlValue(x)}</member>`).join('')}</struct></value>`;
  return `<value><string>${xmlEsc(v)}</string></value>`;
}

function parseValue($, valueEl) {
  const child = $(valueEl).children().first();
  if (!child.length) return $(valueEl).text();
  const t = child.get(0).tagName.toLowerCase();
  switch (t) {
    case 'int': case 'i4': case 'i8': case 'double': return Number(child.text());
    case 'boolean': return child.text().trim() === '1';
    case 'nil': return null;
    case 'array': return child.children('data').children('value').map((_, v) => parseValue($, v)).get();
    case 'struct': {
      const o = {};
      child.children('member').each((_, m) => { o[$(m).children('name').text()] = parseValue($, $(m).children('value').get(0)); });
      return o;
    }
    default: return child.text();
  }
}

async function xmlrpc(cfg, method, params, { timeoutMs = 60000 } = {}) {
  const url = `${cfg.siteUrl}/xmlrpc.php`;
  await assertPublicUrl(new URL(url)); // 内部ネットワーク等への接続を防ぐ
  const body = `<?xml version="1.0"?><methodCall><methodName>${method}</methodName><params>${params.map((p) => `<param>${xmlValue(p)}</param>`).join('')}</params></methodCall>`;
  const res = await fetch(url, {
    method: 'POST',
    redirect: 'manual', // 認証情報を別ホストに送らないため、リダイレクトは追わない
    headers: { 'content-type': 'text/xml; charset=UTF-8' },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status >= 300 && res.status < 400) {
    throw new Error(`サイトのURLがリダイレクトされました。サイトURLを「${(res.headers.get('location') || '').replace(/xmlrpc\.php.*$/, '')}」に変えて、もう一度試してください`);
  }
  const text = await res.text();
  const at = text.indexOf('<methodResponse');
  if (at < 0) {
    if (res.status === 403 || res.status === 404 || res.status === 405) {
      throw new Error('このサイトでは、XML-RPCが無効、または制限されています（サイトの管理者に確認してください）');
    }
    // 原因を調べやすいよう、応答の先頭部分を添える（タグは除き、パスワードが含まれていた場合は伏せる）
    let head = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240);
    if (cfg.password) head = head.split(cfg.password).join('***');
    throw new Error(`WordPressから想定外の応答がありました（HTTP ${res.status}、形式：${res.headers.get('content-type') || '不明'}、${text.length}文字）。応答の先頭：${head || '（空）'}`);
  }
  const $ = cheerio.load(text.slice(at), { xmlMode: true });
  const fault = $('methodResponse > fault > value');
  if (fault.length) {
    const f = parseValue($, fault.get(0));
    const code = Number(f.faultCode);
    let msg = String(f.faultString || '');
    if (code === 403) msg = `ユーザー名またはパスワードが正しくありません（アプリが送信した内容：ユーザー名「${cfg.username}」、パスワード${String(cfg.password || '').length}文字、前後の空白${/^\s|\s$/.test(String(cfg.password || '')) ? 'あり' : 'なし'}）。まず、WordPressのログイン画面（サイトURL/wp-login.php）で、同じユーザー名・パスワードでログインできるか確認してください。ユーザー名は、メールアドレスや表示名ではなく、ログイン用の「ユーザー名」です。コピーしたときに、前後に空白が入っていないか、l（エル）とI（アイ）、0（ゼロ）とO（オー）の取り違えがないかも、確認してください`;
    else if (code === 401) msg = 'このユーザーには、この操作を行う権限がありません（投稿者以上の権限が必要です。画像のアップロードには、「寄稿者」ではなく「投稿者」以上が必要です）';
    const err = new Error(msg || 'WordPressでエラーが発生しました');
    err.status = code;
    throw err;
  }
  return parseValue($, $('methodResponse > params > param > value').first().get(0));
}

// 接続の確認：ログインできるか、投稿できる権限があるかを調べる
async function connectXmlRpc(siteInput, username, password) {
  const user = String(username || '').trim();
  const pass = String(password || '');
  if (!user) throw new Error('ユーザー名を入力してください');
  if (!pass) throw new Error('パスワードを入力してください');
  const cfg = { method: 'xmlrpc', siteUrl: normalizeSite(siteInput), username: user, password: pass, blogId: '1' };

  let blogs;
  try {
    blogs = await xmlrpc(cfg, 'wp.getUsersBlogs', [user, pass]);
  } catch (e) {
    // コピー時に前後の空白が混ざっていることがあるため、取り除いて、もう一度試す
    if (e.status === 403 && pass !== pass.trim()) {
      cfg.password = pass.trim();
      blogs = await xmlrpc(cfg, 'wp.getUsersBlogs', [user, cfg.password]);
    } else {
      throw e;
    }
  }
  if (!Array.isArray(blogs) || !blogs.length) throw new Error('ログインできましたが、投稿先のサイトが見つかりませんでした');
  cfg.blogId = String(blogs[0].blogid || '1');

  let profile = {};
  try { profile = await xmlrpc(cfg, 'wp.getProfile', [cfg.blogId, user, cfg.password]); } catch { /* 取れなくても接続は成立 */ }
  const roles = Array.isArray(profile.roles) ? profile.roles : [];
  if (roles.includes('subscriber')) throw new Error('このユーザーは「購読者」のため、記事を投稿できません（「投稿者」以上の権限が必要です）');
  return {
    cfg,
    userName: profile.display_name || user,
    siteName: blogs[0].blogName || '',
    canUpload: !roles.includes('contributor'),
    isAdmin: !!blogs[0].isAdmin,
    roles,
  };
}

async function uploadMediaXmlRpc(cfg, { buffer, mime, filename }) {
  const r = await xmlrpc(cfg, 'wp.uploadFile', [cfg.blogId, cfg.username, cfg.password, { name: filename, type: mime, bits: buffer, overwrite: false }]);
  return { id: Number(r.id), url: r.url };
}

async function saveDraftXmlRpc(cfg, { title, html, featuredMedia, existingId }) {
  // 既存の下書きを更新するのは、まだ下書きのままの場合だけ（公開済みの記事を、下書きに戻してしまわないため）
  if (existingId) {
    try {
      const cur = await xmlrpc(cfg, 'wp.getPost', [cfg.blogId, cfg.username, cfg.password, existingId, ['post_status']]);
      if (cur.post_status !== 'draft') existingId = null;
    } catch { existingId = null; }
  }
  const content = { post_type: 'post', post_status: 'draft', post_title: title, post_content: html };
  if (featuredMedia) content.post_thumbnail = featuredMedia;
  let id = existingId;
  if (existingId) await xmlrpc(cfg, 'wp.editPost', [cfg.blogId, cfg.username, cfg.password, existingId, content]);
  else id = Number(await xmlrpc(cfg, 'wp.newPost', [cfg.blogId, cfg.username, cfg.password, content]));
  let link = '';
  try { link = (await xmlrpc(cfg, 'wp.getPost', [cfg.blogId, cfg.username, cfg.password, id, ['link']])).link || ''; } catch { /* プレビューURLが取れなくても保存は成功 */ }
  return { id, previewUrl: link || `${cfg.siteUrl}/?p=${id}&preview=true`, editUrl: `${cfg.siteUrl}/wp-admin/post.php?post=${id}&action=edit`, status: 'draft' };
}

// ---------------------------------------------------------------
// 投稿済みの記事の取得（リライトの対象を探すため）。読み取りのみで、WordPress側は何も変更しない。
// ---------------------------------------------------------------
const MAX_POSTS = 500;

// XML-RPCの日付（例：20161001T10:00:00。GMT）を、ISO形式にする
function xmlDate(v) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(String(v || ''));
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : (v ? String(v) : null);
}

// 公開済みの記事の一覧（更新が新しい順）：{ id, title, url, date, modified }
async function listPublishedPosts(cfg, { max = MAX_POSTS } = {}) {
  const out = [];
  if (cfg.method === 'xmlrpc') {
    const per = 100;
    for (let offset = 0; offset < max; offset += per) {
      const rows = await xmlrpc(cfg, 'wp.getPosts', [cfg.blogId, cfg.username, cfg.password,
        { post_type: 'post', post_status: 'publish', number: per, offset, orderby: 'post_modified', order: 'DESC' },
        ['post_id', 'post_title', 'post_date_gmt', 'post_modified_gmt', 'link']]);
      if (!Array.isArray(rows) || !rows.length) break;
      for (const r of rows) out.push({ id: Number(r.post_id), title: String(r.post_title || ''), url: r.link, date: xmlDate(r.post_date_gmt), modified: xmlDate(r.post_modified_gmt) });
      if (rows.length < per) break;
    }
  } else {
    const per = 100;
    for (let page = 1; out.length < max; page++) {
      let rows;
      try {
        rows = await request(cfg, `/wp/v2/posts?status=publish&per_page=${per}&page=${page}&orderby=modified&order=desc&_fields=id,title,link,date_gmt,modified_gmt`);
      } catch (e) {
        if (e.status === 400 && page > 1) break; // ページ範囲外
        throw e;
      }
      if (!Array.isArray(rows) || !rows.length) break;
      for (const r of rows) out.push({ id: r.id, title: String(r.title?.rendered || '').replace(/<[^>]*>/g, ''), url: r.link, date: r.date_gmt ? `${r.date_gmt}Z` : null, modified: r.modified_gmt ? `${r.modified_gmt}Z` : null });
      if (rows.length < per) break;
    }
  }
  return out.slice(0, max);
}

// 記事1本の、現在のタイトルと本文（HTML）
async function getPostContent(cfg, id) {
  if (cfg.method === 'xmlrpc') {
    const p = await xmlrpc(cfg, 'wp.getPost', [cfg.blogId, cfg.username, cfg.password, Number(id), ['post_title', 'post_content', 'link', 'post_modified_gmt', 'post_status']]);
    return { id: Number(id), title: String(p.post_title || ''), html: String(p.post_content || ''), url: p.link, modified: xmlDate(p.post_modified_gmt), status: p.post_status };
  }
  const p = await request(cfg, `/wp/v2/posts/${Number(id)}?context=edit&_fields=id,title,content,link,modified_gmt,status`);
  return { id: p.id, title: String(p.title?.raw ?? p.title?.rendered ?? ''), html: String(p.content?.raw ?? p.content?.rendered ?? ''), url: p.link, modified: p.modified_gmt ? `${p.modified_gmt}Z` : null, status: p.status };
}

// AIに渡すための、記事の構成と内容（見出し・段落・リスト・表）を、テキストにする
function htmlToOutline(html, { maxChars = 14000 } = {}) {
  const $ = cheerio.load(`<div id="root">${String(html || '')}</div>`);
  $('script,style,noscript').remove();
  const lines = [];
  $('#root').find('h1,h2,h3,h4,p,li,blockquote,th,td,figcaption,img').each((_, el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'img') { const alt = $(el).attr('alt'); if (alt) lines.push(`[画像: ${alt}]`); return; }
    if (tag === 'blockquote') return; // 引用の中の段落は、個別に拾う
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (!text) return;
    if (/^h[1-4]$/.test(tag)) lines.push(`${'#'.repeat(Number(tag[1]))} ${text}`);
    else if (tag === 'li') lines.push(`- ${text}`);
    else if (tag === 'th' || tag === 'td') lines.push(`| ${text}`);
    else lines.push(text);
  });
  const joined = lines.join('\n');
  return joined.length > maxChars ? `${joined.slice(0, maxChars)}\n（以下、長いため省略）` : joined;
}

// 接続方式（REST API／XML-RPC）に合わせて、画像のアップロードと下書きの保存を切り替える
const uploadMedia = (cfg, args) => (cfg.method === 'xmlrpc' ? uploadMediaXmlRpc(cfg, args) : uploadMediaRest(cfg, args));
const saveDraft = (cfg, args) => (cfg.method === 'xmlrpc' ? saveDraftXmlRpc(cfg, args) : saveDraftRest(cfg, args));

module.exports = { connect, connectXmlRpc, uploadMedia, blocksToHtml, saveDraft, listPublishedPosts, getPostContent, htmlToOutline };
