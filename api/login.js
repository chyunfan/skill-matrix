'use strict';
/* ============================================================================
 * POST /api/login
 *   body: { teller, password }
 *   返回: { ok:true, token, expires_in, me }
 *
 * 流程：查授权清单（不在清单里直接拒）→ 比对 scrypt 密码哈希 → 签发自签令牌
 *       → 回读档案一起返回，前端据此决定去改密页还是主页。
 * 数据库里没有 auth.users 这一层，账号就是 skillm_app_users 里的一行。
 * ========================================================================== */

const supa = require('./_lib/supa');
const auth = require('./_lib/auth');
const kit  = require('./_lib/kit');

module.exports = async function handler(req, res) {
  if (kit.preflight(req, res, ['POST'])) return;
  if (kit.requireEnv(res)) return;

  const b = await kit.body(req);
  const teller = String(b.teller || '').trim();
  const pwd    = String(b.password || '');

  if (!teller) return kit.fail(res, 400, '请输入柜员号');
  if (!pwd)    return kit.fail(res, 400, '请输入密码');

  // ① 授权清单（白名单）：只有管理员建过号的柜员号才能登录
  const me = await supa.userByTeller(teller);
  if (!me) {
    return kit.fail(res, 403, '该柜员号未在授权清单中，请联系管理员', 'not_allowed');
  }
  if (me.status === 'disabled') {
    return kit.fail(res, 403, '账号已停用，请联系管理员', 'disabled');
  }
  if (!auth.hasPwd(me.password_hash)) {
    return kit.fail(res, 403, '该账号尚未设置密码，请联系管理员重置', 'no_password');
  }

  // ② 比对密码（scrypt + 定长比较）
  if (!auth.verifyPwd(pwd, me.password_hash)) {
    return kit.fail(res, 401, '柜员号或密码错误', 'bad_credentials');
  }

  // ③ 签发令牌（令牌里只有柜员号和过期时间，权限一律每次查库）
  const tk = auth.issue(me.teller_no);

  return kit.ok(res, {
    token: tk.token,
    expires_in: tk.expires_in,
    me: kit.profile(me)
  });
};
