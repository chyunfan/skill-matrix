'use strict';
/* ============================================================================
 * 通用工具：HTTP 响应、请求体解析、身份识别、权限判断、密码规则
 *
 * 权限模型：
 *   role        admin / user
 *   data_scope  branch / all      能看到哪些人的数据（同时也是编辑范围）
 *   can_edit    true / false      能不能改技能等级
 *   visible_pages                  纯前端用，服务端不参与判断
 *
 * 这是唯一的权限边界：服务端用 service_role 调库会绕过 RLS，数据范围必须在这
 * 一层兜住。数据库里的 RLS 只是"万一有人拿到 anon key 直连"时的兜底（表全开
 * RLS 且不给任何策略＝全拒），正常流程根本走不到那里。
 * ========================================================================== */

const supa = require('./supa');
const auth = require('./auth');

/* ----------------------------------------------------------------- HTTP --- */

function ok(res, data) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json(Object.assign({ ok: true }, data || {}));
}

function fail(res, status, msg, code) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json({ ok: false, msg: msg, code: code || '' });
}

/** 方法白名单 + 统一 no-store。命中则已响应，调用方直接 return */
function preflight(req, res, methods) {
  res.setHeader('Cache-Control', 'no-store');
  if (methods && methods.indexOf(req.method) < 0) {
    res.setHeader('Allow', methods.join(', '));
    fail(res, 405, '不支持的请求方法（只接受 ' + methods.join(' / ') + '）', 'method_not_allowed');
    return true;
  }
  return false;
}

/** 环境变量自检（数据库两项 + 令牌密钥）；缺了就直接响应并返回 true */
function requireEnv(res) {
  const miss = supa.missingEnv().concat(auth.missingEnv());
  if (miss.length) {
    fail(res, 500,
      '服务端未配置环境变量：' + miss.join('、') +
      '。请在 Vercel 项目的 Settings → Environment Variables 里添加后重新部署。',
      'env_missing');
    return true;
  }
  return false;
}

/** 读请求体：兼容运行时已解析（req.body）与需要自己读流两种情况 */
async function body(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body) {
    try { return JSON.parse(req.body); } catch (e) { return {}; }
  }
  return await new Promise(function (resolve) {
    let s = '';
    req.on('data', function (c) {
      s += c;
      if (s.length > 2 * 1024 * 1024) { req.destroy(); resolve({}); }
    });
    req.on('end', function () {
      try { resolve(s ? JSON.parse(s) : {}); } catch (e) { resolve({}); }
    });
    req.on('error', function () { resolve({}); });
  });
}

/** 从 Supabase 的错误体里抠出一句人能看懂的话 */
function errText(r) {
  if (!r) return '未知错误';
  const d = r.data;
  if (!d) return 'HTTP ' + r.status;
  if (typeof d === 'string') return d;
  return d.msg || d.message || d.error_description || d.error || ('HTTP ' + r.status);
}

/* ----------------------------------------------------------------- 鉴权 --- */

/**
 * 解出自签令牌里的柜员号，再回库取那一行档案；无效/过期/已删除返回 null。
 * 权限每次都从库里读，所以管理员刚改过的权限下一次请求就生效。
 */
async function currentUser(req) {
  const p = auth.fromReq(req);
  if (!p) return null;
  return await supa.userByTeller(p.t);
}

function isAdmin(me) { return !!me && me.role === 'admin' && me.status === 'active'; }

/** 账号可用：启用中且已完成首次改密 */
function isReady(me) { return !!me && me.status === 'active' && !me.must_change_pwd; }

/** 数据范围：能不能看某支行的数据 */
function canSee(me, branch) {
  if (!me) return false;
  if (me.role === 'admin') return true;
  if (me.status !== 'active' || me.must_change_pwd) return false;
  if (me.data_scope === 'all') return true;
  if (!branch) return false;
  return branch === me.branch;
}

/** 写入范围：管理员全放开；普通用户要 can_edit，且不超出自己的数据范围 */
function canWrite(me, branch) {
  if (!me) return false;
  if (me.role === 'admin') return true;
  if (me.status !== 'active' || me.must_change_pwd) return false;
  if (!me.can_edit) return false;
  if (me.data_scope === 'all') return true;
  if (!branch) return false;
  return branch === me.branch;
}

/** 对外输出的档案（白名单字段，password_hash 之类的列永远不会外泄） */
function profile(me) {
  return {
    teller_no: me.teller_no,
    name: me.name || '',
    branch: me.branch || '',
    role: me.role,
    data_scope: me.data_scope,
    can_edit: !!me.can_edit,
    visible_pages: me.visible_pages || [],
    status: me.status,
    must_change_pwd: !!me.must_change_pwd
  };
}

/* ------------------------------------------------------------- 密码规则 --- */

const WEAK = ['admin123', 'password1', 'abc12345', 'qwer1234', '88888888',
              '12345678', '11111111', 'a1234567', 'abcd1234', 'admin888'];

/** 是否含 n 位以上连续字符（12345 / abcde / 54321） */
function hasSeq(s, n) {
  n = n || 3;
  if (!s || s.length < n) return false;
  let up = 1, dn = 1;
  for (let i = 1; i < s.length; i++) {
    const d = s.charCodeAt(i) - s.charCodeAt(i - 1);
    up = (d === 1) ? up + 1 : 1;
    dn = (d === -1) ? dn + 1 : 1;
    if (up >= n || dn >= n) return true;
  }
  return false;
}

/** 校验新密码，通过返回空串，否则返回原因。服务端以这个为准 */
function checkPwd(pwd, teller) {
  if (!pwd) return '请输入新密码';
  if (typeof pwd !== 'string') return '密码格式不正确';
  if (pwd.length < 8) return '密码至少 8 位';
  if (!/[A-Za-z]/.test(pwd) || !/[0-9]/.test(pwd)) return '密码必须同时包含字母和数字';
  if (teller && pwd === teller) return '密码不能与柜员号相同';
  if (WEAK.indexOf(pwd.toLowerCase()) >= 0) return '密码过于简单，请更换';
  if (hasSeq(pwd, 3)) return '密码不能包含连续字符（如 123、abc）';
  if (/(.)\1{2,}/.test(pwd)) return '密码不能包含 3 个以上重复字符（如 111、aaa）';
  return '';
}

/* ------------------------------------------------ 版块与权限的默认约定 --- */

const ALL_PAGES = ['people', 'score', 'matrix', 'insight'];
const ADMIN_PAGES = ALL_PAGES.concat(['admin']);

/** 三档预设，给批量授权用 */
const PRESETS = {
  admin:    { role: 'admin', data_scope: 'all',    can_edit: true,  visible_pages: ADMIN_PAGES },
  recorder: { role: 'user',  data_scope: 'branch', can_edit: true,  visible_pages: ALL_PAGES },
  viewer:   { role: 'user',  data_scope: 'branch', can_edit: false, visible_pages: ALL_PAGES }
};

module.exports = {
  ok: ok,
  fail: fail,
  preflight: preflight,
  requireEnv: requireEnv,
  body: body,
  errText: errText,
  currentUser: currentUser,
  isAdmin: isAdmin,
  isReady: isReady,
  canSee: canSee,
  canWrite: canWrite,
  profile: profile,
  checkPwd: checkPwd,
  hasSeq: hasSeq,
  WEAK: WEAK,
  ALL_PAGES: ALL_PAGES,
  ADMIN_PAGES: ADMIN_PAGES,
  PRESETS: PRESETS
};
