'use strict';
/* ============================================================================
 * 数据库访问封装（只做"怎么调 Supabase 的 PostgREST"，不做任何权限判断）
 *
 * 环境变量（Vercel → 项目 → Settings → Environment Variables）：
 *   SUPABASE_URL           项目地址，形如 https://xxxxxxxx.supabase.co
 *   SUPABASE_SERVICE_KEY   service_role key（只在服务端使用，绝不下发浏览器）
 *
 * 与上一版的区别：删掉了整套 GoTrue（认证）调用。
 *   Supabase 现在只承担"一个 Postgres 数据库"的角色——存名单、评分、账号，
 *   认证由 api/_lib/auth.js 自己做（scrypt 密码 + 自签令牌），不再需要给每个
 *   用户建 auth.users 账号，也就不需要邮箱映射、Admin API、触发器这些东西。
 *
 * 注意：service_role 绕过 RLS，所以数据范围过滤必须由调用方（kit.js）自己做。
 * 零依赖：只用 Node 内置 fetch（Node 18+）。
 * ========================================================================== */

const BASE = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const KEY  = (process.env.SUPABASE_SERVICE_KEY || '').trim();

/** 返回缺失的环境变量名；空数组表示配置齐全 */
function missingEnv() {
  const miss = [];
  if (!BASE) miss.push('SUPABASE_URL');
  if (!KEY) miss.push('SUPABASE_SERVICE_KEY');
  return miss;
}

function headers(extra) {
  return Object.assign({
    apikey: KEY,
    'Content-Type': 'application/json'
  }, extra || {});
}

/** 统一出口：任何异常都变成 { ok:false }，不让函数 500 崩掉 */
async function call(path, opt) {
  opt = opt || {};
  let res;
  try {
    res = await fetch(BASE + path, {
      method: opt.method || 'GET',
      headers: opt.headers || headers(),
      body: opt.body === undefined ? undefined : JSON.stringify(opt.body),
      cache: 'no-store'
    });
  } catch (e) {
    return { ok: false, status: 0, data: { message: '无法连接数据库：' + (e.message || e) } };
  }

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = { message: text }; }
  return { ok: res.ok, status: res.status, data: data };
}

/* ---------------------------------------------------------------- REST ---- */

/**
 * 查/改业务表（走 PostgREST）
 *   rest('skillm_members', '?branch=eq.富春支行&select=*')
 *   rest('skillm_app_users', '?teller_no=eq.88001', { method:'PATCH', body:{...} })
 */
function rest(table, qs, opt) {
  opt = opt || {};
  const h = headers(opt.headers);
  if (opt.method && opt.method !== 'GET') {
    h['Prefer'] = opt.prefer || 'return=representation';
  }
  return call('/rest/v1/' + table + (qs || ''), { method: opt.method || 'GET', headers: h, body: opt.body });
}

/** 单条件等值查询，返回第一行或 null */
async function one(table, column, value, select) {
  const qs = '?' + column + '=eq.' + encodeURIComponent(value) + '&select=' + (select || '*') + '&limit=1';
  const r = await rest(table, qs);
  if (!r.ok || !Array.isArray(r.data) || !r.data.length) return null;
  return r.data[0];
}

/** 按柜员号取账号那一行（登录、鉴权、改密都用它） */
function userByTeller(teller) {
  return one('skillm_app_users', 'teller_no', teller);
}

/* ------------------------------------------------------- 业务数据（P2）--- */

/**
 * 读一行 skillm_state。
 * scope_key = 'ALL' 是全行配置，其余是支行名（存该支行的人员名单与评分）。
 * 行不存在时返回 null —— 调用方按"这份数据还没人录过"处理。
 */
async function stateGet(scopeKey) {
  const r = await one('skillm_state', 'scope_key', scopeKey, 'scope_key,data,updated_at,updated_by');
  return r;
}

/** 读全部行（全行管理员需要拿到所有支行的数据）。失败时返回 [] */
async function stateAll() {
  const r = await rest('skillm_state', '?select=scope_key,data,updated_at,updated_by&order=scope_key.asc');
  return (r.ok && Array.isArray(r.data)) ? r.data : [];
}

/**
 * 写一行（有则覆盖，无则新建）。
 * ON CONFLICT 由 PostgREST 的 resolution=merge-duplicates 实现，主键是 scope_key。
 */
function statePut(scopeKey, data, by) {
  return rest('skillm_state', '?on_conflict=scope_key', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=minimal',
    body: [{
      scope_key: scopeKey,
      data: data || {},
      updated_at: new Date().toISOString(),
      updated_by: String(by || '').slice(0, 60)
    }]
  });
}

module.exports = {
  missingEnv: missingEnv,
  rest: rest,
  one: one,
  userByTeller: userByTeller,
  stateGet: stateGet,
  stateAll: stateAll,
  statePut: statePut
};
