'use strict';
/* ============================================================================
 * 账号与令牌：不再使用 Supabase Auth
 *
 * 为什么改：给每个柜员建一个 auth.users 账号，等于把一套通用的身份系统搬进来
 * —— 要维护邮箱映射、GoTrue 版本差异、改密接口、触发器建档……而这个工具只需要
 * "谁能登录、能看哪些数据"。所以账号直接存在自己的表 skillm_app_users 里：
 *
 *   password_hash  Node 内置 crypto.scrypt 加盐哈希（格式 scrypt$<盐>$<摘要>）
 *   token          HMAC-SHA256 自签的无状态令牌 "<base64url(payload)>.<签名>"
 *
 * 令牌里只放柜员号与过期时间，权限一律每次查库取——这样管理员改了权限、停用了
 * 账号，下一次请求立刻生效，不用等令牌过期，也不用维护吊销名单。
 *
 * 环境变量（Vercel → Settings → Environment Variables）：
 *   AUTH_SECRET   签名密钥，随便一串足够长的随机字符（建议 32 位以上）
 *                 改了它＝所有已登录用户被强制下线，这是唯一的"吊销"手段。
 *
 * 零依赖：只用 Node 内置的 crypto 与 Buffer，不需要 npm install。
 * ========================================================================== */

const crypto = require('crypto');

const SECRET = (process.env.AUTH_SECRET || '').trim();
const TTL_MS = 7 * 24 * 60 * 60 * 1000;          // 令牌有效期 7 天
const SALT_LEN = 16;
const KEY_LEN = 32;

/** 返回缺失的环境变量名；空数组表示配置齐全 */
function missingEnv() {
  return SECRET ? [] : ['AUTH_SECRET'];
}

/* ------------------------------------------------------------ 密码哈希 ---- */

/** 生成 "scrypt$<盐 hex>$<摘要 hex>"，每次调用结果都不同（盐随机） */
function hashPwd(plain) {
  const salt = crypto.randomBytes(SALT_LEN);
  const key = crypto.scryptSync(String(plain), salt, KEY_LEN);
  return 'scrypt$' + salt.toString('hex') + '$' + key.toString('hex');
}

/** 校验明文密码与库里的哈希；任何格式异常一律判为不匹配 */
function verifyPwd(plain, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const p = stored.split('$');
  if (p.length !== 3 || p[0] !== 'scrypt') return false;

  let key;
  try {
    key = crypto.scryptSync(String(plain), Buffer.from(p[1], 'hex'), KEY_LEN);
  } catch (e) {
    return false;
  }
  const want = Buffer.from(p[2], 'hex');
  if (want.length !== key.length) return false;
  return crypto.timingSafeEqual(key, want);      // 定长比较，避免计时侧信道
}

/** 库里是不是还没有设过密码（例如名单刚导入、账号还没建） */
function hasPwd(stored) {
  return typeof stored === 'string' && stored.indexOf('scrypt$') === 0;
}

/* ---------------------------------------------------------------- 令牌 ---- */

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}

/** 验签 + 查过期，通过返回 payload，否则 null */
function open(token) {
  if (!token || typeof token !== 'string') return null;

  const i = token.lastIndexOf('.');
  if (i <= 0) return null;

  const body = token.slice(0, i);
  const sig = token.slice(i + 1);

  const want = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let p;
  try {
    p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch (e) {
    return null;
  }
  if (!p || !p.t || !p.exp) return null;
  if (Date.now() > Number(p.exp)) return null;

  return p;
}

/** 给某个柜员号签发令牌 */
function issue(teller) {
  const exp = Date.now() + TTL_MS;
  return {
    token: sign({ t: String(teller), exp: exp }),
    expires_in: Math.floor(TTL_MS / 1000)
  };
}

/** 从 Authorization: Bearer <token> 里取出并验证，返回 { t, exp } 或 null */
function fromReq(req) {
  const h = (req && req.headers) || {};
  const m = /^Bearer\s+(.+)$/i.exec(String(h['authorization'] || h['Authorization'] || ''));
  if (!m) return null;
  return open(m[1].trim());
}

module.exports = {
  missingEnv: missingEnv,
  hashPwd: hashPwd,
  verifyPwd: verifyPwd,
  hasPwd: hasPwd,
  sign: sign,
  open: open,
  issue: issue,
  fromReq: fromReq,
  TTL_MS: TTL_MS
};
