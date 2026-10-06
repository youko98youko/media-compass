// WordPress連携（REST API＋アプリケーションパスワード）
// 記事は必ず「下書き」として投稿する。公開（status: publish）は、このアプリからは行わない。
// ※プロトタイプのため、認証情報はサーバーのメモリ上にのみ保持する（画面・ログには出さない）。
const { assertPublicUrl } = require('./crawler');

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function normalizeSite(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('サイトURLを入力してください');
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  const u = new URL(s);
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`; // 末尾の/を除く（サブディレクトリ運用のWordPressにも対応）
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

async function request(cfg, route, { method = 'GET', headers = {}, body, timeoutMs = 30000 } = {}) {
  const url = apiUrl(cfg, route);
  await assertPublicUrl(new URL(url)); // 内部ネットワーク等への接続を防ぐ
  const res = await fetch(url, {
    method,
    redirect: 'manual', // 認証情報を別ホストに送らないため、リダイレクトは追わない
    headers: { authorization: authHeader(cfg), accept: 'application/json', ...headers },
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

async function uploadMedia(cfg, { buffer, mime, filename, alt }) {
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
function blocksToHtml(blocks, imageUrls) {
  const out = [];
  blocks.forEach((b, i) => {
    switch (b.type) {
      case 'image':
        if (b.role !== 'hero' && imageUrls[i]) out.push(`<figure class="wp-block-image"><img src="${esc(imageUrls[i])}" alt="${esc(b.alt)}"/></figure>`);
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
      case 'cta': out.push(`<div style="background:#f3f6fb;padding:16px;margin:24px 0;text-align:center;"><p><strong>${esc(b.text)}</strong></p><p>${esc(b.buttonLabel || '')}</p></div>`); break;
      default: break;
    }
  });
  return out.join('\n');
}

// 下書きとして投稿する。existingId があれば、その下書きを更新する（2回押しても重複しない）。
async function saveDraft(cfg, { title, html, featuredMedia, existingId }) {
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

module.exports = { connect, uploadMedia, blocksToHtml, saveDraft };
