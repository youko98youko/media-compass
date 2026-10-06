// 記事の挿入画像の自動生成（OpenAI Images API）
// 生成した画像はサーバーのメモリ上に保持し、/api/image/:id で配信する（プロトタイプ用。本番では画像ストレージへ保存する想定）。
const crypto = require('crypto');

const IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
const IMAGE_QUALITY = process.env.OPENAI_IMAGE_QUALITY || 'medium'; // low | medium | high（高いほど高品質・高コスト）
const IMAGE_SIZE = process.env.OPENAI_IMAGE_SIZE || '1536x1024'; // 横長
const MAX_PER_SESSION = Number(process.env.IMAGE_MAX_PER_SESSION || 15); // 1記事あたりの生成回数の上限（費用の暴走防止）
const MAX_STORED = 80; // メモリ上に保持する枚数の上限（古いものから捨てる）

const store = new Map(); // id -> { buffer, mime, createdAt }

function put(buffer, mime) {
  while (store.size >= MAX_STORED) store.delete(store.keys().next().value);
  const id = crypto.randomBytes(12).toString('hex');
  store.set(id, { buffer, mime, createdAt: Date.now() });
  return id;
}

function get(id) {
  return store.get(id) || null;
}

// "/api/image/<id>" 形式のURLから画像を取り出す（WordPressへのアップロード用）
function getBySrc(src) {
  const m = /^\/api\/image\/([0-9a-f]{24})$/.exec(String(src || ''));
  return m ? get(m[1]) : null;
}

function buildPrompt(themeTitle, block) {
  const role = block.role === 'hero' ? 'アイキャッチ画像' : '本文中の挿絵';
  return [
    `「${themeTitle}」というWebメディアの記事に使う${role}を作成してください。`,
    `内容：${block.alt || themeTitle}`,
    'スタイル：やわらかい色合いの、清潔感のあるフラットなイラスト。横長の構図。',
    '制約：画像の中に文字・数字・ロゴ・看板の文字を入れないこと。実在の人物や企業を連想させないこと。',
  ].join('\n');
}

async function generate(prompt) {
  const body = { model: IMAGE_MODEL, prompt, size: IMAGE_SIZE, n: 1 };
  if (IMAGE_MODEL.startsWith('gpt-image')) {
    body.quality = IMAGE_QUALITY;
    body.output_format = 'jpeg';
    body.output_compression = 85;
  } else {
    body.response_format = 'b64_json'; // dall-e系
  }
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error?.message || `HTTP ${res.status}`;
    // 組織の確認が必要なモデルなどの、利用者に分かりやすい案内
    if (/verif/i.test(msg)) throw new Error(`画像生成モデル(${IMAGE_MODEL})を使うには、OpenAI側で組織の確認（Verify Organization）が必要です。（${msg}）`);
    throw new Error(`画像生成に失敗しました（${msg}）`);
  }
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new Error('画像生成の結果が空でした');
  return { buffer: Buffer.from(b64, 'base64'), mime: body.output_format === 'jpeg' ? 'image/jpeg' : 'image/png' };
}

module.exports = { MAX_PER_SESSION, IMAGE_MODEL, IMAGE_QUALITY, buildPrompt, generate, put, get, getBySrc };
