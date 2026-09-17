'use strict';
/* ============================================================================
 * /api/data —— 业务数据的读写（P2：把主程序从"本机浏览器存储"改成"云端共享"）
 *
 * 存哪：skillm_state 表，一行一支行（scope_key），整份 JSON 存 data 列。
 *   scope_key = 'ALL'        全行统一配置（技能项 / 录入方式 / 岗位标准 / 标题）
 *   scope_key = '富春支行'    该支行的人员名单与技能评分
 *   scope_key = '__none__'   支行字段留空的人员
 *
 * ---------------------------------------------------------------------- GET --
 *   全行管理员（role=admin 或 data_scope=all）
 *     → 返回 ALL 配置 + 所有支行的人员（管理员要的是"全行录入情况"）
 *   支行账号（data_scope=branch）
 *     → 返回 ALL 配置（只读）+ 只有自己支行的人员
 *   账号未设支行 → 拿不到任何人员（canSee 返回 false），但配置照给
 *
 * --------------------------------------------------------------------- POST --
 *   请求体：{ config?: {...}, people?: [...], removed?: ["id", ...] }
 *     config   全行配置，只有全行管理员（admin / data_scope=all 且 can_edit）能改
 *     people   变化的人员（整条记录），服务端按 _id 合并：
 *                 · 同一个 _id 已存在 → 覆盖那一条
 *                 · 不存在 → 追加
 *                 · 管理员把某人的支行改了 → 自动从旧支行行里摘掉再写到新行
 *              合并粒度是"人员"：A 改张三、B 改李四互不覆盖
 *     removed  删除的人员 _id
 *
 *   权限：每一条人员都过 kit.canWrite(me, 该人员的支行) ——
 *     admin / data_scope=all 且 can_edit → 任何支行都放行
 *     data_scope=branch 且 can_edit     → 只有自己支行放行，写别家一律拒绝
 *     can_edit=false                    → 全部拒绝（这就是"只读账号"的实现）
 *   被拒的条目不会中断整个请求，会汇总在返回的 denied 数组里，前端据此提示。
 *
 *   为什么"整份 JSON 一行"：工具的数据本来就是一份快照（名单+评分+技能项配置+
 *   标准+标题），整份存取每次只要 1 个请求，前端 save()/load() 换实现即可，
 *   不必为"录入方式""文字录入内容（员工优缺点）"这些新字段再动关系表结构。
 *   数据边界靠"一行一支行"天然成立，不依赖"按 branch 字段过滤"这种容易漏的地方。
 * ========================================================================== */

const kit = require('./_lib/kit');
const supa = require('./_lib/supa');

const CONFIG_KEY = 'ALL';        // 全行统一配置
const NO_BRANCH = '__none__';    // 支行字段留空

const keyOf = function (b) {
  const s = String(b == null ? '' : b).trim();
  return s || NO_BRANCH;
};
const branchOf = function (k) { return k === NO_BRANCH ? '' : k; };

/** 账号档案 → 能不能编辑业务数据（管理员恒为真，其余看 can_edit） */
function canEditOf(me) {
  if (kit.isAdmin(me)) return true;
  return !!(me.can_edit && me.status === 'active' && !me.must_change_pwd);
}

/** 账号档案 → 能不能改"全行统一配置"（技能项 / 岗位标准） */
function canConfigOf(me) {
  if (kit.isAdmin(me)) return true;
  return !!(me.data_scope === 'all' && me.can_edit && me.status === 'active' && !me.must_change_pwd);
}

/** 全行管理员 = 能看到所有支行的数据 */
function scopeAllOf(me) { return kit.isAdmin(me) || me.data_scope === 'all'; }

/** ALL 行的 data → 前端要的 config 对象（缺项给 null，由前端决定是否用默认值） */
function cfgOf(row) {
  const d = (row && row.data) || {};
  return {
    skillList: Array.isArray(d.skillList) ? d.skillList : null,
    skillTypes: (d.skillTypes && typeof d.skillTypes === 'object') ? d.skillTypes : {},
    standards: (d.standards && typeof d.standards === 'object') ? d.standards : {},
    mxTitle: typeof d.mxTitle === 'string' ? d.mxTitle : null,
    mxSubtitle: typeof d.mxSubtitle === 'string' ? d.mxSubtitle : '',
    updated_at: (row && row.updated_at) || '',
    updated_by: (row && row.updated_by) || ''
  };
}

/** 人员记录入库前的清洗：白名单字段 + 长度上限，避免脏数据无限膨胀 */
function cleanPerson(raw, branch) {
  const o = {
    _id: String(raw && raw._id || '').slice(0, 60),
    branch: String(branch || '').slice(0, 60)
  };
  ['orgNo', 'orgName', 'tellerNo', 'name', 'post'].forEach(function (k) {
    o[k] = String((raw && raw[k]) || '').slice(0, 120);
  });

  const sk = {};
  const rawSk = (raw && raw.skills && typeof raw.skills === 'object') ? raw.skills : {};
  Object.keys(rawSk).slice(0, 200).forEach(function (k) {
    const v = parseInt(rawSk[k], 10);
    if (v >= 0 && v <= 3) sk[String(k).slice(0, 60)] = v;
  });
  o.skills = sk;

  const nt = {};
  const rawNt = (raw && raw.notes && typeof raw.notes === 'object') ? raw.notes : {};
  Object.keys(rawNt).slice(0, 200).forEach(function (k) {
    const v = String(rawNt[k] == null ? '' : rawNt[k]);
    if (v) nt[String(k).slice(0, 60)] = v.slice(0, 2000);
  });
  o.notes = nt;

  return o;
}

/* ---------------------------------------------------------------------- GET -- */

async function handleGet(req, res) {
  const me = await kit.currentUser(req);
  if (!me) return kit.fail(res, 401, '登录已过期，请重新登录', 'unauthorized');
  if (me.status !== 'active') return kit.fail(res, 403, '账号已停用，请联系管理员', 'disabled');
  if (me.must_change_pwd) return kit.fail(res, 403, '请先修改初始密码', 'must_change_pwd');

  const scopeAll = scopeAllOf(me);
  const rows = await supa.stateAll();
  let cfgRow = null;
  const people = [];
  const branches = [];

  rows.forEach(function (r) {
    if (r.scope_key === CONFIG_KEY) { cfgRow = r; return; }
    const br = branchOf(r.scope_key);
    if (!scopeAll && !kit.canSee(me, br)) return;       // 支行账号：别人家的一行都不给
    branches.push(br);
    const list = (r.data && Array.isArray(r.data.people)) ? r.data.people : [];
    list.forEach(function (p) {
      const o = Object.assign({}, p);
      o.branch = br;                                     // 以行的归属为准，盖掉脏字段
      o._branch = br;
      people.push(o);
    });
  });

  return kit.ok(res, {
    me: kit.profile(me),
    me_name: me.name || '',
    scope: scopeAll ? 'all' : 'branch',
    branches: branches.sort(),
    can_edit: canEditOf(me),
    can_config: canConfigOf(me),
    config: cfgOf(cfgRow),
    people: people
  });
}

/* --------------------------------------------------------------------- POST -- */

async function handlePost(req, res) {
  const me = await kit.currentUser(req);
  if (!me) return kit.fail(res, 401, '登录已过期，请重新登录', 'unauthorized');
  if (me.status !== 'active') return kit.fail(res, 403, '账号已停用，请联系管理员', 'disabled');
  if (me.must_change_pwd) return kit.fail(res, 403, '请先修改初始密码', 'must_change_pwd');

  const b = await kit.body(req);
  const scopeAll = scopeAllOf(me);
  const myBranch = String(me.branch || '').trim();
  const by = (me.name || '') + (me.teller_no ? '(' + me.teller_no + ')' : '');

  const rows = await supa.stateAll();
  const rowMap = new Map();                 // scope_key -> data
  rows.forEach(function (r) {
    rowMap.set(r.scope_key, (r.data && typeof r.data === 'object' && !Array.isArray(r.data)) ? r.data : {});
  });

  const dirty = new Set();
  const deniedSet = new Set();
  const deny = function (m) { deniedSet.add(m); };

  /* --- 1) 全行统一配置（技能项 / 岗位标准 / 标题） --- */
  const cfgIn = (b && b.config && typeof b.config === 'object') ? b.config : null;
  if (cfgIn) {
    if (!canConfigOf(me)) {
      deny('技能项与岗位技能标准是全行统一的，只有全行管理员能改');
    } else {
      const d = rowMap.get(CONFIG_KEY) || {};
      if (Array.isArray(cfgIn.skillList)) {
        d.skillList = cfgIn.skillList
          .filter(function (s) { return typeof s === 'string' && s.trim(); })
          .map(function (s) { return s.trim().slice(0, 60); })
          .slice(0, 200);
      }
      if (cfgIn.skillTypes && typeof cfgIn.skillTypes === 'object') d.skillTypes = cfgIn.skillTypes;
      if (cfgIn.standards && typeof cfgIn.standards === 'object') d.standards = cfgIn.standards;
      if (typeof cfgIn.mxTitle === 'string') d.mxTitle = cfgIn.mxTitle.slice(0, 120);
      if (typeof cfgIn.mxSubtitle === 'string') d.mxSubtitle = cfgIn.mxSubtitle.slice(0, 300);
      rowMap.set(CONFIG_KEY, d);
      dirty.add(CONFIG_KEY);
    }
  }

  /* --- 2) 逐条校验人员写权限，算出"要写哪些 _id、写到哪个支行" --- */
  const want = new Map();                   // _id -> { key, person }
  const incoming = Array.isArray(b && b.people) ? b.people : [];
  incoming.forEach(function (raw) {
    const id = String((raw && raw._id) || '').trim();
    if (!id) { deny('有人员记录缺少标识，已跳过'); return; }
    // 支行账号只能写自己支行：不管前端传什么 branch，一律按账号的支行落库
    const br = scopeAll ? String((raw && raw.branch) || '').trim() : myBranch;
    if (!kit.canWrite(me, br)) {
      deny((scopeAll ? '「' + (br || '未设支行') + '」' : '本支行') + '的数据你没有编辑权限');
      return;
    }
    want.set(id, { key: keyOf(br), person: cleanPerson(raw, br) });
  });

  /* --- 3) 先把这些 _id 从各行摘掉（覆盖旧值 + 处理"改支行"的搬迁） --- */
  rowMap.forEach(function (d, key) {
    if (key === CONFIG_KEY) return;
    if (!Array.isArray(d.people)) return;
    const keep = d.people.filter(function (p) { return !p || !want.has(String(p._id || '')); });
    if (keep.length === d.people.length) return;
    if (!kit.canWrite(me, branchOf(key))) { deny('「' + (branchOf(key) || '未设支行') + '」的数据你没有编辑权限'); return; }
    d.people = keep;
    dirty.add(key);
  });

  /* --- 4) 再写进各自的目标行 --- */
  want.forEach(function (v, id) {
    const d = rowMap.get(v.key) || {};
    if (!Array.isArray(d.people)) d.people = [];
    const i = d.people.findIndex(function (p) { return p && String(p._id || '') === id; });
    if (i >= 0) d.people[i] = v.person; else d.people.push(v.person);
    rowMap.set(v.key, d);
    dirty.add(v.key);
  });

  /* --- 5) 删除 --- */
  const delIds = Array.isArray(b && b.removed) ? b.removed.map(String) : [];
  let removedCount = 0;
  if (delIds.length) {
    rowMap.forEach(function (d, key) {
      if (key === CONFIG_KEY) return;
      if (!Array.isArray(d.people)) return;
      const keep = d.people.filter(function (p) { return delIds.indexOf(String(p && p._id || '')) < 0; });
      const gone = d.people.length - keep.length;
      if (!gone) return;
      if (!kit.canWrite(me, branchOf(key))) { deny('「' + (branchOf(key) || '未设支行') + '」的数据你没有编辑权限'); return; }
      d.people = keep;
      removedCount += gone;
      dirty.add(key);
    });
  }

  /* --- 6) 落库 --- */
  let savedRows = 0;
  for (const key of Array.from(dirty)) {
    const r = await supa.statePut(key, rowMap.get(key) || {}, by);
    if (!r.ok) {
      return kit.fail(res, 502,
        '保存失败（' + (key === CONFIG_KEY ? '全行配置' : key) + '）：' + kit.errText(r), 'db_error');
    }
    savedRows++;
  }

  return kit.ok(res, {
    saved_people: want.size,
    saved_rows: savedRows,
    removed: removedCount,
    denied: Array.from(deniedSet),
    saved_at: new Date().toISOString()
  });
}

/* ------------------------------------------------------------------- 入口 --- */

module.exports = async function handler(req, res) {
  try {
    if (kit.preflight(req, res, ['GET', 'POST'])) return;
    if (kit.requireEnv(res)) return;
    if (req.method === 'GET') return await handleGet(req, res);
    return await handlePost(req, res);
  } catch (e) {
    return kit.fail(res, 500, '服务器内部错误：' + (e && e.message ? e.message : e), 'internal');
  }
};
