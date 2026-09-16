'use strict';
/* ============================================================================
 * POST /api/change-password
 *   头: Authorization: Bearer <token>
 *   body: { newPassword }
 *   返回: { ok:true, me }
 *
 * 密码由服务端自己算哈希落库（不再调 Supabase Auth 的 Admin API），所以
 * 那 5 条密码规则是**服务端强制**的：绕过前端直接打接口也设不了弱密码。
 * 改完顺手把 must_change_pwd 置 false —— 这是"首登必须改密"的销记动作。
 * ========================================================================== */

const supa = require('./_lib/supa');
const auth = require('./_lib/auth');
const kit  = require('./_lib/kit');

module.exports = async function handler(req, res) {
  if (kit.preflight(req, res, ['POST'])) return;
  if (kit.requireEnv(res)) return;

  const me = await kit.currentUser(req);
  if (!me) return kit.fail(res, 401, '登录状态已失效，请重新登录', 'unauthorized');
  if (me.status === 'disabled') return kit.fail(res, 403, '账号已停用，请联系管理员', 'disabled');

  const b = await kit.body(req);
  const pwd = String(b.newPassword || b.password || '');

  const err = kit.checkPwd(pwd, me.teller_no);
  if (err) return kit.fail(res, 400, err, 'weak_password');

  // 改成和现在一样的密码没有意义，也容易让人以为"改了"
  if (auth.verifyPwd(pwd, me.password_hash)) {
    return kit.fail(res, 400, '新密码不能与当前密码相同', 'same_password');
  }

  const r = await supa.rest('skillm_app_users', '?teller_no=eq.' + encodeURIComponent(me.teller_no), {
    method: 'PATCH',
    body: {
      password_hash: auth.hashPwd(pwd),
      must_change_pwd: false,
      updated_at: new Date().toISOString()
    }
  });
  if (!r.ok) return kit.fail(res, 502, '密码修改失败：' + kit.errText(r), 'update_failed');

  me.must_change_pwd = false;
  return kit.ok(res, { me: kit.profile(me) });
};
