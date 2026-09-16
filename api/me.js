'use strict';
/* ============================================================================
 * GET /api/me
 *   头: Authorization: Bearer <token>
 *   返回: { ok:true, me }
 *
 * 作用：① 刷新页面后判断"是否还处于登录态"；② 取最新权限（管理员改过权限后
 *       下一次进来就生效）。token 无效统一返回 401，前端据此回登录页。
 * ========================================================================== */

const kit = require('./_lib/kit');

module.exports = async function handler(req, res) {
  if (kit.preflight(req, res, ['GET'])) return;
  if (kit.requireEnv(res)) return;

  const me = await kit.currentUser(req);
  if (!me) return kit.fail(res, 401, '登录状态已失效，请重新登录', 'unauthorized');

  if (me.status === 'disabled') {
    return kit.fail(res, 403, '账号已停用，请联系管理员', 'disabled');
  }

  return kit.ok(res, { me: kit.profile(me) });
};
