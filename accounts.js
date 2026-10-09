// アカウント（ログイン）と、アカウントごとの「施策ステータス管理」。ローカル版用。
// データは data/accounts.json に保存する（サーバーを再起動しても残る。.gitignoreで除外済み）。
// 公開環境（Render）では無効（誰でも登録できる公開サイトにアカウント機能を置かないため）。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'accounts.json');
const ENABLED = !process.env.RENDER && process.env.ACCOUNTS_ENABLED !== '0';

const STATUSES = ['未着手', '対応中', '確認待ち', '完了'];
const SESSION_DAYS = 7;
const COOKIE = 'mc_session';

// ---- 保存（JSONファイル。書き込み途中で壊れないよう、一時ファイルに書いてから置き換える） ----
let db = { users: [], measures: [] };

function load() {
  try {
    db = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
    db.users = db.users || [];
    db.measures = db.measures || [];
  } catch (e) {
    if (e.code !== 'ENOENT') {
      // 壊れたファイルは退避して、空の状態から始める（元のデータは消さない）
      try { fs.renameSync(FILE, `${FILE}.broken-${Date.now()}`); } catch { /* 退避できなくても続行 */ }
      console.warn('[アカウント] データファイルを読めなかったため退避しました:', e.message);
    }
    db = { users: [], measures: [] };
  }
}

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf-8');
  fs.renameSync(tmp, FILE);
}

// ---- 連携情報（Google等のトークン）の暗号化保存 ----
// AES-256-GCMで暗号化して、アカウントのデータに入れる。鍵は、環境変数 DATA_ENCRYPTION_KEY（64桁の16進数）か、
// なければ data/secret.key（初回に自動生成。.gitignoreで除外済み）を使う。
// ※鍵ファイルが同じパソコン内にあるため、「ファイルを見られても、そのままでは読めない」程度の保護。パソコン自体の管理は別途必要。
function encryptionKey() {
  if (/^[0-9a-fA-F]{64}$/.test(process.env.DATA_ENCRYPTION_KEY || '')) return Buffer.from(process.env.DATA_ENCRYPTION_KEY, 'hex');
  const keyFile = path.join(DATA_DIR, 'secret.key');
  try {
    return Buffer.from(fs.readFileSync(keyFile, 'utf-8').trim(), 'hex');
  } catch {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const key = crypto.randomBytes(32);
    fs.writeFileSync(keyFile, key.toString('hex'), { encoding: 'utf-8', mode: 0o600 });
    return key;
  }
}

function encryptJson(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf-8'), c.final()]);
  return `v1:${iv.toString('hex')}:${c.getAuthTag().toString('hex')}:${data.toString('hex')}`;
}

function decryptJson(text) {
  const [v, iv, tag, data] = String(text).split(':');
  if (v !== 'v1') throw new Error('unknown format');
  const d = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'hex'));
  d.setAuthTag(Buffer.from(tag, 'hex'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(data, 'hex')), d.final()]).toString('utf-8'));
}

// アカウントごとの連携情報（name: 'gsc' など）。obj に null を渡すと削除する。
function setIntegration(userId, name, obj) {
  if (!ENABLED) return;
  const user = db.users.find((u) => u.id === userId);
  if (!user) return;
  user.integrations = user.integrations || {};
  if (obj) user.integrations[name] = encryptJson(obj);
  else delete user.integrations[name];
  save();
}

function getIntegration(userId, name) {
  if (!ENABLED) return null;
  const user = db.users.find((u) => u.id === userId);
  const enc = user?.integrations?.[name];
  if (!enc) return null;
  try { return decryptJson(enc); } catch (e) { console.warn('[アカウント] 連携情報を復号できませんでした:', name); return null; }
}

// ---- パスワード（scrypt。平文は保存しない） ----
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  return `${salt.toString('hex')}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [saltHex, hashHex] = String(stored).split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

// ---- ログイン状態（data/accounts.json に保存。サーバーを再起動しても、ログインしたままになる） ----
// Cookieに入れる値（トークン）そのものは保存せず、そのハッシュだけを保存する。
const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');
function sessionTable() {
  db.sessions = db.sessions || {};
  return db.sessions;
}
const failures = new Map(); // ユーザー名 -> { count, until }（総当たり対策）

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function currentUser(req) {
  const token = parseCookies(req)[COOKIE];
  const key = token ? hashToken(token) : null;
  const s = key ? sessionTable()[key] : null;
  if (!s || s.exp < Date.now()) {
    if (s) { delete sessionTable()[key]; save(); }
    return null;
  }
  return db.users.find((u) => u.id === s.userId) || null;
}

function startSession(res, user) {
  const token = crypto.randomBytes(32).toString('hex');
  const table = sessionTable();
  for (const [k, v] of Object.entries(table)) if (v.exp < Date.now()) delete table[k]; // 期限切れを片付ける
  table[hashToken(token)] = { userId: user.id, exp: Date.now() + SESSION_DAYS * 86400000 };
  save();
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}`);
}

const publicUser = (u) => ({ id: u.id, username: u.username });

// ---- 入力の検証 ----
const USERNAME_RE = /^[A-Za-z0-9_.@+-]{3,50}$/;

function cleanMeasureInput(body, { partial }) {
  const out = {};
  if (!partial || body.title !== undefined) {
    const title = String(body.title ?? '').trim();
    if (!title) throw new Error('施策名を入力してください');
    if (title.length > 100) throw new Error('施策名は100文字以内で入力してください');
    out.title = title;
  }
  if (body.memo !== undefined) {
    const memo = String(body.memo).trim();
    if (memo.length > 2000) throw new Error('メモは2000文字以内で入力してください');
    out.memo = memo;
  }
  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) throw new Error('ステータスが正しくありません');
    out.status = body.status;
  }
  return out;
}

function install(app) {
  if (ENABLED) load();

  const requireEnabled = (req, res, next) => (ENABLED ? next() : res.status(404).json({ error: 'accounts_disabled' }));
  const requireLogin = (req, res, next) => {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ error: 'login_required' });
    req.user = user;
    next();
  };

  app.get('/api/auth/me', (req, res) => {
    const user = ENABLED ? currentUser(req) : null;
    res.json({ enabled: ENABLED, user: user ? publicUser(user) : null, statuses: STATUSES });
  });

  app.post('/api/auth/register', requireEnabled, (req, res) => {
    const username = String(req.body?.username ?? '').trim();
    const password = String(req.body?.password ?? '');
    if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'ユーザー名は、半角の英数字と _ . @ + - で、3〜50文字にしてください' });
    if (password.length < 8 || password.length > 200) return res.status(400).json({ error: 'パスワードは8文字以上にしてください' });
    if (db.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) return res.status(409).json({ error: 'このユーザー名はすでに使われています' });
    const user = { id: crypto.randomBytes(8).toString('hex'), username, passwordHash: hashPassword(password), createdAt: new Date().toISOString() };
    db.users.push(user);
    save();
    startSession(res, user);
    res.json({ user: publicUser(user) });
  });

  app.post('/api/auth/login', requireEnabled, (req, res) => {
    const username = String(req.body?.username ?? '').trim();
    const password = String(req.body?.password ?? '');
    const key = username.toLowerCase();
    const f = failures.get(key);
    if (f && f.until > Date.now()) return res.status(429).json({ error: 'ログインに続けて失敗したため、しばらく時間をおいてからお試しください' });
    const user = db.users.find((u) => u.username.toLowerCase() === key);
    // ユーザーがいない場合も、同じだけ時間をかけて、存在の有無を推測されにくくする
    const ok = user ? verifyPassword(password, user.passwordHash) : (verifyPassword(password, `${'0'.repeat(32)}:${'0'.repeat(128)}`), false);
    if (!ok) {
      const count = (f?.count || 0) + 1;
      failures.set(key, { count, until: count >= 5 ? Date.now() + 60000 : 0 });
      return res.status(401).json({ error: 'ユーザー名またはパスワードが正しくありません' });
    }
    failures.delete(key);
    startSession(res, user);
    res.json({ user: publicUser(user) });
  });

  app.post('/api/auth/logout', (req, res) => {
    const token = parseCookies(req)[COOKIE];
    if (token && sessionTable()[hashToken(token)]) { delete sessionTable()[hashToken(token)]; save(); }
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    res.json({ ok: true });
  });

  // ---- ログイン必須：ログイン・アカウント作成・起動時の設定確認・Googleからの戻り先以外のAPIは、ログインしていないと使えない ----
  // （この下で定義される、メディア分析・記事作成・設定などのAPIすべてが対象）
  app.use('/api', (req, res, next) => {
    if (!ENABLED) return next();
    const user = currentUser(req);
    req.user = user;
    const open = req.path.startsWith('/auth/') || req.path === '/gsc/callback' || (req.path === '/themes' && !req.query.mediaId);
    if (open || user) return next();
    res.status(401).json({ error: 'login_required' });
  });

  // ---- 施策のステータス管理（ログイン中のアカウント自身のデータだけを扱う） ----
  const mine = (user) => db.measures.filter((m) => m.userId === user.id);
  const view = ({ userId, ...m }) => m;

  app.get('/api/measures', requireEnabled, requireLogin, (req, res) => {
    const list = mine(req.user).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const counts = Object.fromEntries(STATUSES.map((s) => [s, list.filter((m) => m.status === s).length]));
    res.json({ measures: list.map(view), counts, total: list.length, statuses: STATUSES });
  });

  app.post('/api/measures', requireEnabled, requireLogin, (req, res) => {
    try {
      const input = cleanMeasureInput(req.body || {}, { partial: false });
      const now = new Date().toISOString();
      const m = { id: crypto.randomBytes(6).toString('hex'), userId: req.user.id, title: input.title, memo: input.memo || '', status: input.status || STATUSES[0], createdAt: now, updatedAt: now };
      db.measures.push(m);
      save();
      res.status(201).json({ measure: view(m) });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.put('/api/measures/:id', requireEnabled, requireLogin, (req, res) => {
    const m = mine(req.user).find((x) => x.id === req.params.id); // 他のアカウントの施策は、存在しないものとして扱う
    if (!m) return res.status(404).json({ error: '施策が見つかりません' });
    try {
      Object.assign(m, cleanMeasureInput(req.body || {}, { partial: true }), { updatedAt: new Date().toISOString() });
      save();
      res.json({ measure: view(m) });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.delete('/api/measures/:id', requireEnabled, requireLogin, (req, res) => {
    const m = mine(req.user).find((x) => x.id === req.params.id);
    if (!m) return res.status(404).json({ error: '施策が見つかりません' });
    db.measures = db.measures.filter((x) => x !== m);
    save();
    res.json({ ok: true });
  });
}

module.exports = { install, STATUSES, ENABLED, setIntegration, getIntegration };
