'use strict';
/* ============================================================================
 * POST /api/logout
 *   令牌是自签无状态的，服务端没有会话可吊销，前端清掉本地 token 即退出。
 *   这个接口保留下来是为了：① 前端逻辑统一；② 以后真要加"吊销名单"时有落点。
 * ========================================================================== */

const kit = require('./_lib/kit');

module.exports = async function handler(req, res) {
  if (kit.preflight(req, res, ['POST'])) return;
  return kit.ok(res, {});
};
