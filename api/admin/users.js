'use strict';
/* ============================================================================
 * /api/admin/users   —— 仅管理员（服务端二次校验角色，前端藏菜单不算数）
 *
 * GET   列表
 *       ?q=8801            按柜员号/姓名模糊搜
 *       → { ok:true, users:[{ teller_no, name, branch, role, data_scope,
 *                             can_edit, visible_pages, status, must_change_pwd }] }
 *
 * POST  建号（单个或批量）
 *       { teller, name?, branch? }                   单个
 *       { users: [{teller,name?,branch?}, ...] }     批量导入
 *       初始密码 = 柜员号；姓名/支行留空时自动从名单 skillm_members 带出
 *       → { ok:true, created:[], existed:[], failed:[{teller,msg}] }
 *
 * PATCH 批量授权
 *       { tellers:[...], patch:{ data_scope, can_edit, visible_pages, status, role } }
 *       { tellers:[...], preset:'admin'|'recorder'|'viewer' }   三档预设
 *       { tellers:[...], reset_pwd:true }                       批量重置为初始密码
 *       → { ok:true, affected:n, users:[...], reset:[...] }
 *
 * 建号 = 往 skillm_app_users 插一行（该表已有 id 默认值），不再去动 auth.users。
 * ========================================================================== */

const supa = require('../_lib/supa');
const auth = require('../_lib/auth');
const kit  = require('../_lib/kit');

/* --------------------------------------------------------------- 工具 ---- */

function pickPatch(src) {
  const p = {};
  if (!src || typeof src !== 'object') return p;

  if (src.data_scope === 'branch' || src.data_scope === 'all') p.data_scope = src.data_scope;
  if (typeof src.can_edit === 'boolean') p.can_edit = src.can_edit;
  if (src.status === 'active' || src.status === 'disabled') p.status = src.status;
  if (src.role === 'admin' || src.role === 'user') p.role = src.role;

  if (Array.isArray(src.visible_pages)) {
    p.visible_pages = src.visible_pages.filter(function (k) {
      return kit.ALL_PAGES.indexOf(k) >= 0 || k === 'admin';
    });
  }
  return p;
}

/** PostgREST 的 in 列表，text 值要用双引号包住 */
function inList(arr) {
  return 'in.(' + arr.map(function (t) {
    return '"' + String(t).replace(/["\\]/g, '') + '"';
  }).join(',') + ')';
}

/** 从名单里带出姓名/支行（名单是导入的，账号表只需要这两项） */
async function fromRoster(teller) {
  const m = await supa.one('skillm_members', 'teller_no', teller, 'name,branch');
  return m || {};
}

/* ------------------------------------------------------------- Handler --- */

module.exports = async function handler(req, res) {
  if (kit.preflight(req, res, ['GET', 'POST', 'PATCH'])) return;
  if (kit.requireEnv(res)) return;

  const me = await kit.currentUser(req);
  if (!me) return kit.fail(res, 401, '登录状态已失效，请重新登录', 'unauthorized');
  if (!kit.isAdmin(me)) return kit.fail(res, 403, '仅管理员可管理用户', 'forbidden');

  /* ---------------------------------------------------------- GET 列表 --- */
  if (req.method === 'GET') {
    const q = String((req.query && req.query.q) || '').trim();
    let qs = '?select=*&order=teller_no.asc';
    if (q) {
      const v = encodeURIComponent(q);
      qs += '&or=(teller_no.ilike.*' + v + '*,name.ilike.*' + v + '*)';
    }
    const r = await supa.rest('skillm_app_users', qs);
    if (!r.ok) return kit.fail(res, 502, '读取用户列表失败：' + kit.errText(r), 'db_error');

    const users = (r.data || []).map(function (u) {
      const p = kit.profile(u);                       // 白名单字段，password_hash 不外泄
      p.created_at = u.created_at || null;
      p.updated_at = u.updated_at || null;
      return p;
    });
    return kit.ok(res, {
      users: users,
      total: users.length,
      presets: kit.PRESETS
    });
  }

  const b = await kit.body(req);

  /* ---------------------------------------------------------- POST 建号 -- */
  if (req.method === 'POST') {
    const list = Array.isArray(b.users)
      ? b.users
      : [{ teller: b.teller, name: b.name, branch: b.branch }];

    const out = { created: [], existed: [], failed: [] };

    for (let i = 0; i < list.length; i++) {
      const it = list[i] || {};
      const teller = String(it.teller || '').trim();
      const name = it.name ? String(it.name).trim() : '';
      const branch = it.branch ? String(it.branch).trim() : '';

      if (!teller) { out.failed.push({ teller: '', msg: '柜员号为空' }); continue; }
      if (!/^[A-Za-z0-9_-]{2,32}$/.test(teller)) {
        out.failed.push({ teller: teller, msg: '柜员号格式不合法（只允许字母数字，2-32 位）' });
        continue;
      }

      const roster = await fromRoster(teller);
      const vName   = name   || roster.name   || teller;
      const vBranch = branch || roster.branch || null;

      const already = await supa.userByTeller(teller);
      if (already) {
        // 已建过号：只在传了新值时补全姓名/支行，权限与密码一律不动
        const patch = {};
        if (vName && vName !== already.name) patch.name = vName;
        if (vBranch && vBranch !== already.branch) patch.branch = vBranch;
        if (Object.keys(patch).length) {
          patch.updated_at = new Date().toISOString();
          await supa.rest('skillm_app_users', '?teller_no=eq.' + encodeURIComponent(teller), {
            method: 'PATCH', body: patch
          });
        }
        out.existed.push(teller);
        continue;
      }

      const ins = await supa.rest('skillm_app_users', '', {
        method: 'POST',
        body: {
          teller_no: teller,
          name: vName,
          branch: vBranch,
          password_hash: auth.hashPwd(teller),      // 初始密码＝柜员号
          must_change_pwd: true
        }
      });
      if (!ins.ok) {
        out.failed.push({ teller: teller, msg: kit.errText(ins) });
        continue;
      }
      out.created.push(teller);
    }

    return kit.ok(res, {
      created: out.created,
      existed: out.existed,
      failed: out.failed,
      summary: {
        total: list.length,
        created: out.created.length,
        existed: out.existed.length,
        failed: out.failed.length
      }
    });
  }

  /* --------------------------------------------------------- PATCH 授权 -- */
  const tellers = (Array.isArray(b.tellers) ? b.tellers : []).map(function (t) {
    return String(t).trim();
  }).filter(Boolean);

  if (!tellers.length) return kit.fail(res, 400, '未选择用户');

  /* 批量重置密码：每个柜员号的哈希都不一样（盐随机），只能逐个写 */
  if (b.reset_pwd === true) {
    const reset = [], bad = [];
    for (let i = 0; i < tellers.length; i++) {
      const t = tellers[i];
      const r = await supa.rest('skillm_app_users', '?teller_no=eq.' + encodeURIComponent(t), {
        method: 'PATCH',
        body: {
          password_hash: auth.hashPwd(t),           // 重置回"密码＝柜员号"
          must_change_pwd: true,
          updated_at: new Date().toISOString()
        }
      });
      if (r.ok && Array.isArray(r.data) && r.data.length) reset.push(t);
      else bad.push({ teller: t, msg: kit.errText(r) });
    }
    if (!b.preset && !b.patch) {
      return kit.ok(res, { reset: reset, failed: bad, affected: reset.length });
    }
  }

  let patch = {};
  if (b.preset) {
    const pre = kit.PRESETS[b.preset];
    if (!pre) return kit.fail(res, 400, '未知的预设档位：' + b.preset);
    patch = Object.assign({}, pre);
  }
  patch = Object.assign(patch, pickPatch(b.patch));

  if (!Object.keys(patch).length) return kit.fail(res, 400, '没有要修改的权限项');

  // 别把自己锁在门外
  if (tellers.indexOf(me.teller_no) >= 0) {
    if (patch.role && patch.role !== 'admin') {
      return kit.fail(res, 400, '不能修改自己的角色，请由另一位管理员操作');
    }
    if (patch.status === 'disabled') {
      return kit.fail(res, 400, '不能停用自己的账号');
    }
  }

  patch.updated_at = new Date().toISOString();

  const r = await supa.rest('skillm_app_users', '?teller_no=' + inList(tellers), {
    method: 'PATCH', body: patch
  });
  if (!r.ok) return kit.fail(res, 502, '保存权限失败：' + kit.errText(r), 'db_error');

  const users = (r.data || []).map(function (u) { return kit.profile(u); });
  return kit.ok(res, {
    affected: users.length,
    users: users,
    not_found: tellers.filter(function (t) {
      return !users.some(function (u) { return u.teller_no === t; });
    })
  });
};
