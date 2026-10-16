/* 软件下载中心 - 主逻辑（Supabase：会员 / 激活码 / 发布 / 下载） */
'use strict';

const cfg = window.PORTAL_CONFIG || {};
const CONFIGURED = !!(
  cfg.url && cfg.anonKey &&
  !/YOUR_|此处|替换/i.test(cfg.url + cfg.anonKey)
);

let sb = null;
let user = null;
let my = { level: 'member', expires_at: null };  // 我的会员行
let isAdmin = false;
let releases = [];
let newCodes = [];   // 本轮新生成的码
let editingRelease = null;

const $ = (s) => document.querySelector(s);
const show = (s) => { $(s).hidden = false; };
const hide = (s) => { $(s).hidden = true; };

const valid = () => my.expires_at && new Date(my.expires_at) > new Date();
const daysLeft = () => Math.max(0, Math.ceil((new Date(my.expires_at) - new Date()) / 86400000));
const fmt = (t) => (t && !t.startsWith('1970')) ? t.slice(0, 10) : '—';
const fmtMB = (b) => b > 0 ? (b / 1048576).toFixed(1) + ' MB' : '';

/* ---------- 启动 ---------- */
document.addEventListener('DOMContentLoaded', init);

async function init() {
  bindStaticEvents();
  if (!CONFIGURED) {
    document.body.innerHTML =
      '<div class="setup-notice"><div class="auth-card"><h2>⚠️ 还没连接 Supabase</h2>' +
      '<p style="color:#6d7f76;font-size:14px;margin-top:8px">config.js 需要填入 url 和 anonKey。</p></div></div>';
    return;
  }
  sb = supabase.createClient(cfg.url, cfg.anonKey);
  const { data: { session } } = await sb.auth.getSession();
  if (session && session.user) enterApp(session.user);
  else showAuth();
  sb.auth.onAuthStateChange((ev, s2) => {
    if (ev === 'SIGNED_IN' && s2 && s2.user && !user) enterApp(s2.user);
    if (ev === 'SIGNED_OUT') { user = null; isAdmin = false; showAuth(); }
  });
}

function showAuth() { hide('#app-view'); show('#auth-view'); }

async function enterApp(u) {
  user = u;
  hide('#auth-view');
  show('#app-view');
  $('#user-email').textContent = u.email || '';
  await loadProfile();
  await checkAdmin();
  await loadReleases();
  switchTab(isAdmin ? 'store' : 'store');
  if (isAdmin) await loadAdminData();
}

/* ---------- 登录 / 注册 ---------- */
let signupMode = false;
function bindStaticEvents() {
  $('#auth-form').addEventListener('submit', handleAuth);
  $('#auth-switch').addEventListener('click', (e) => {
    if (e.target.id !== 'auth-toggle') return;
    e.preventDefault();
    signupMode = !signupMode;
    $('#auth-submit').textContent = signupMode ? '注册' : '登录';
    $('#auth-switch').innerHTML = signupMode
      ? '已有账号？<a href="#" id="auth-toggle">去登录</a>'
      : '还没有账号？<a href="#" id="auth-toggle">注册一个</a>';
    $('#auth-password').setAttribute('autocomplete', signupMode ? 'new-password' : 'current-password');
  });
  $('#logout-btn').addEventListener('click', async () => { await sb.auth.signOut(); showAuth(); });

  $('#tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (btn) switchTab(btn.dataset.tab);
  });

  $('#redeem-form').addEventListener('submit', redeem);
  $('#publish-form').addEventListener('submit', publishRelease);
  $('#gen-codes-btn').addEventListener('click', genCodes);
  $('#copy-codes-btn').addEventListener('click', () => copyText(newCodes.join('\r\n')));
  $('#release-list').addEventListener('click', onListClick);
  $('#admin-releases').addEventListener('click', onAdminClick);
  $('#existing-codes').addEventListener('click', onCodesClick);
}

function setAuthLoading(on) {
  const btn = $('#auth-submit');
  btn.disabled = on;
  btn.textContent = on ? '请稍候…' : (signupMode ? '注册' : '登录');
}

async function handleAuth(e) {
  e.preventDefault();
  const email = $('#auth-email').value.trim();
  const password = $('#auth-password').value;
  if (!email || !password) return;
  setAuthLoading(true);
  try {
    if (signupMode) {
      const { data, error } = await sb.auth.signUp({ email, password });
      if (error) toast(authErrMsg(error), true, 6000);
      else if (!data.session) {
        toast('注册成功。若无法登录，请让管理员到 Supabase 关闭「Confirm email」', true, 8000);
        signupMode = false;
        $('#auth-submit').textContent = '登录';
      }
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) toast(authErrMsg(error), true, 6000);
    }
  } catch (err) {
    toast('网络错误：' + err.message, true, 6000);
  } finally {
    setAuthLoading(false);
  }
}

function authErrMsg(error) {
  const m = (error.message || '').toLowerCase();
  if (m.includes('invalid login credentials')) return '邮箱或密码错误';
  if (m.includes('already registered')) return '该邮箱已注册过，请直接登录';
  if (m.includes('not confirmed')) return '邮箱未验证，请联系管理员';
  if (m.includes('at least 6')) return '密码至少 6 位';
  if (m.includes('rate limit')) return '操作太频繁，请一分钟后再试';
  if (m.includes('failed to fetch') || m.includes('network')) return '连不上服务器，请检查网络';
  return error.message || '未知错误';
}

/* ---------- 我的资料 ---------- */
async function loadProfile() {
  let { data } = await sb.from('memberships').select('*').eq('user_id', user.id).maybeSingle();
  if (!data) {
    // 触发器建行前注册的老用户：自建一行
    const { error } = await sb.from('memberships')
      .insert({ user_id: user.id, email: user.email || '' });
    if (!error) {
      ({ data } = await sb.from('memberships').select('*').eq('user_id', user.id).maybeSingle());
    }
  }
  my = data || { level: 'member', expires_at: null };

  const badge = $('#member-badge');
  if (isAdmin0()) { badge.textContent = '管理员'; badge.classList.add('on'); }
  else if (valid()) { badge.textContent = `会员 · 剩 ${daysLeft()} 天`; badge.classList.add('on'); }
  else { badge.textContent = '未开通会员'; badge.classList.remove('on'); }

  $('#me-email').textContent = user.email || '-';
  $('#me-status').textContent = isAdmin0() ? '管理员' : (valid() ? '有效' : '未开通');
  $('#me-expiry').textContent = fmt(my.expires_at);
  $('#me-days').textContent = valid() ? daysLeft() + ' 天' : '—';
}

function isAdmin0() { return my.level === 'admin'; }

async function checkAdmin() {
  if (!user.email) { isAdmin = false; return; }
  const { data } = await sb.from('admins').select('email').eq('email', user.email).maybeSingle();
  isAdmin = !!data;
  const tab = document.querySelector('.tab.admin-only');
  if (tab) tab.hidden = !isAdmin;
}

/* ---------- Tab 切换 ---------- */
function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === name));
  document.querySelectorAll('.tabpanel').forEach((p) => { p.hidden = p.id !== 'tab-' + name; });
  if (name === 'me') loadProfile();
  if (name === 'admin' && isAdmin) loadAdminData();
}

/* ---------- 下载中心 ---------- */
async function loadReleases() {
  const { data, error } = await sb.from('releases').select('*').order('published_at', { ascending: false });
  releases = error ? [] : (data || []);
  renderStore();
  if (isAdmin) renderAdminReleases();
}

function renderStore() {
  const tip = $('#store-tip');
  tip.textContent = valid()
    ? `会员有效期至 ${fmt(my.expires_at)}（剩 ${daysLeft()} 天），以下版本全部可下载。`
    : '你还未开通会员——在「我的会员」页输入激活码即可开通，开通后全部版本可下载。';

  const el = $('#release-list');
  if (!releases.filter((r) => r.is_active).length) {
    el.innerHTML = '<div class="empty"><div class="big">📭</div>暂时还没有发布的版本<br>请稍后再来看看</div>';
    return;
  }
  el.innerHTML = releases.filter((r) => r.is_active).map(releaseCard).join('');
}

function releaseCard(r) {
  const initial = (r.software || '?').charAt(0).toUpperCase();
  const dl = valid()
    ? `<button class="btn primary small" data-act="download" data-id="${r.id}">⬇ 下载安装包${fmtMB(r.file_size) ? ' · ' + fmtMB(r.file_size) : ''}</button>`
    : `<button class="btn ghost small" data-act="needvip" disabled>🔒 会员可下载</button>`;
  return (
    `<div class="card" data-id="${r.id}">
      <div class="card-top">
        <div class="avatar">${esc(initial)}</div>
        <div class="card-name">${esc(r.software)}</div>
        <span class="card-ver">v${esc(r.version)}</span>
        <span class="badge">${fmtMB(r.file_size)}</span>
      </div>
      ${r.notes ? `<div class="card-notes">${esc(r.notes)}</div>` : ''}
      <div class="card-foot">
        <span class="time">发布于 ${(r.published_at || '').slice(0, 10)}</span>
        ${dl}
      </div>
    </div>`
  );
}

async function onListClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const r = releases.find((x) => x.id === btn.dataset.id);
  if (!r) return;
  if (btn.dataset.act === 'needvip') { switchTab('me'); return; }
  if (btn.dataset.act === 'download') downloadRelease(r);
}

async function downloadRelease(r) {
  if (!valid()) { toast('会员已过期，请先激活', true); switchTab('me'); return; }
  toast('正在生成下载链接…');
  sb.from('download_logs').insert({ user_id: user.id, release_id: r.id }).then(() => {}, () => {});
  const { data, error } = await sb.storage.from('releases').createSignedUrl(r.file_path, 3600);
  if (error || !data || !data.signedUrl) {
    const m = (error && error.message) || '';
    toast(m.toLowerCase().includes('row-level') ? '会员状态校验失败，请刷新后重试' : ('下载失败：' + m), true, 5000);
    return;
  }
  window.open(data.signedUrl, '_blank');
  toast('已开始下载 ✓');
}

/* ---------- 激活码兑换 ---------- */
async function redeem(e) {
  e.preventDefault();
  const code = $('#redeem-code').value.trim();
  if (!code) return;
  const btn = $('#redeem-btn');
  btn.disabled = true;
  try {
    const { data, error } = await sb.rpc('redeem_code', { p_code: code });
    if (error) {
      toast(error.message || '激活失败', true, 5000);
    } else {
      $('#redeem-code').value = '';
      await loadProfile();
      renderStore();
      toast(`激活成功！会员有效期至 ${fmt(data)} ✓`, false, 5000);
    }
  } finally {
    btn.disabled = false;
  }
}

/* ---------- 管理后台 ---------- */
async function loadAdminData() {
  await Promise.all([loadAdminReleases(), loadCodes(), loadMembers()]);
}

async function publishRelease(e) {
  e.preventDefault();
  const software = $('#p-software').value.trim();
  const version = $('#p-version').value.trim();
  const notes = $('#p-notes').value.trim();
  const fileInput = $('#p-file');
  const file = fileInput.files && fileInput.files[0];
  if (!software || !version || !file) return toast('请填全软件名、版本号并选择文件', true);

  if (file.size > 500 * 1024 * 1024) return toast('文件超过 500MB 上限', true, 5000);

  const btn = $('#publish-btn');
  const bar = document.querySelector('#p-progress .bar');
  const pText = $('#p-progress-text');
  btn.disabled = true; btn.textContent = '发布中…';
  bar.style.width = '0%';
  show('#p-progress'); show('#p-progress-text');
  try {
    const safe = file.name.replace(/[\\/:*?"<>|]+/g, '_');
    const path = `${software}/${version}_${Date.now()}_${safe}`;

    // 带进度的直传（supabase-js 的 upload 没有进度回调，改用 XHR 走同一存储接口）
    const { data: sData } = await sb.auth.getSession();
    const token = sData && sData.session ? sData.session.access_token : '';
    const encPath = path.split('/').map(encodeURIComponent).join('/');
    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${cfg.url}/storage/v1/object/releases/${encPath}`, true);
      xhr.setRequestHeader('apikey', cfg.anonKey);
      xhr.setRequestHeader('authorization', 'Bearer ' + token);
      xhr.setRequestHeader('x-upsert', 'false');
      xhr.setRequestHeader('cache-control', '3600');
      xhr.upload.onprogress = (ev) => {
        if (!ev.lengthComputable) return;
        const pct = Math.round((ev.loaded / ev.total) * 100);
        bar.style.width = pct + '%';
        pText.textContent = `上传中 ${pct}%（${(ev.loaded / 1048576).toFixed(1)} / ${(ev.total / 1048576).toFixed(1)} MB）… 上传期间请不要关闭页面`;
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) return resolve();
        let msg = 'HTTP ' + xhr.status;
        try { msg = JSON.parse(xhr.responseText).message || msg; } catch (_) {}
        reject(new Error(msg));
      };
      xhr.onerror = () => reject(new Error('网络中断，请重试'));
      xhr.send(file);
    });

    const { error } = await sb.from('releases')
      .insert({ software, version, notes, file_path: path, file_size: file.size });
    if (error) return toast('发布失败：' + error.message, true, 8000);

    $('#p-software').value = ''; $('#p-version').value = ''; $('#p-notes').value = ''; fileInput.value = '';
    hide('#p-progress'); hide('#p-progress-text');
    await loadReleases();
    toast('发布成功 ✓ 客户端已可见', false, 4000);
  } catch (err) {
    const m = (err.message || '').toLowerCase();
    if (m.includes('exceeded') || m.includes('size') || err.message.includes('413')) {
      toast('被 Supabase 单文件上限拦住了：Storage → Settings → 把 File upload size limit 调大（建议 5000MB）后重试', true, 10000);
    } else {
      toast('上传失败：' + err.message, true, 8000);
    }
  } finally {
    btn.disabled = false; btn.textContent = '发布';
  }
}

async function loadAdminReleases() {
  const { data, error } = await sb.from('releases').select('*').order('published_at', { ascending: false });
  const el = $('#admin-releases');
  if (error) { el.innerHTML = `<div class="empty">${esc(error.message)}</div>`; return; }
  const list = data || [];
  el.innerHTML = list.length ? list.map((r) => `
    <div class="card" data-id="${r.id}">
      <div class="card-top">
        <div class="card-name">${esc(r.software)} <span class="card-ver">v${esc(r.version)}</span></div>
        <span class="badge${r.is_active ? '' : ' off'}">${r.is_active ? '上架中' : '已下架'}</span>
      </div>
      <div class="card-foot">
        <span class="time">${fmtMB(r.file_size)} · ${(r.published_at || '').slice(0, 10)}</span>
        <button class="btn small ghost" data-a="toggle">${r.is_active ? '下架' : '恢复上架'}</button>
      </div>
    </div>`).join('') : '<div class="empty">还没有发布过版本</div>';
}

async function onAdminClick(e) {
  const btn = e.target.closest('[data-a]');
  if (!btn) return;
  const card = btn.closest('.card');
  const r = releases.find((x) => x.id === card.dataset.id);
  if (!r) return;
  const { error } = await sb.from('releases').update({ is_active: !r.is_active }).eq('id', r.id);
  if (error) return toast('操作失败：' + error.message, true);
  await loadReleases();
  toast(r.is_active ? '已下架' : '已恢复上架');
}

/* ---------- 激活码生成 ---------- */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
function randCode() {
  const seg = () => Array.from({ length: 4 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
  return `${seg()}-${seg()}-${seg()}`;
}

async function genCodes() {
  const n = Math.min(100, Math.max(1, parseInt($('#c-count').value, 10) || 0));
  const days = Math.min(3650, Math.max(1, parseInt($('#c-days').value, 10) || 0));
  const note = $('#c-note').value.trim();
  if (!n || !days) return toast('请填写数量和天数', true);
  const btn = $('#gen-codes-btn');
  btn.disabled = true;
  try {
    const rows = Array.from({ length: n }, () => ({ code: randCode(), days, note }));
    const { error } = await sb.from('license_codes').insert(rows);
    if (error) return toast('生成失败：' + error.message, true, 6000);
    newCodes = rows.map((r) => r.code);
    const el = $('#new-codes');
    el.innerHTML = newCodes.map((c) => `<span>${esc(c)}</span>`).join('');
    el.hidden = false;
    $('#copy-codes-btn').hidden = false;
    await loadCodes();
    toast(`已生成 ${n} 张 ${days} 天激活码 ✓`);
  } finally {
    btn.disabled = false;
  }
}

async function loadCodes() {
  const { data, error } = await sb.from('license_codes').select('*').order('created_at', { ascending: false }).limit(200);
  const el = $('#existing-codes');
  if (error) { el.innerHTML = `<div class="empty">${esc(error.message)}</div>`; return; }
  const list = data || [];
  el.innerHTML = list.length ? list.map((c) => `
    <div class="card" data-code="${esc(c.code)}">
      <div class="card-top">
        <b class="license-val" style="font-size:13.5px">${esc(c.code)}</b>
        <span class="badge${c.used_by ? ' off' : ''}">${c.used_by ? '已使用' : `${c.days} 天 · 未用`}</span>
        <button class="mini-btn" data-a="copy">复制</button>
        ${!c.used_by ? '<button class="mini-btn" data-a="del">删除</button>' : ''}
      </div>
      ${c.note ? `<div class="card-notes">${esc(c.note)}${c.used_at ? ' · ' + esc(c.used_at.slice(0, 10)) + ' 被使用' : ''}</div>` : ''}
    </div>`).join('') : '<div class="empty">还没有生成过激活码</div>';
}

async function onCodesClick(e) {
  const btn = e.target.closest('[data-a]');
  if (!btn) return;
  const card = btn.closest('.card');
  const code = card.dataset.code;
  if (btn.dataset.a === 'copy') return copyText(code);
  if (btn.dataset.a === 'del') {
    if (!confirm(`删除激活码 ${code}？`)) return;
    const { error } = await sb.from('license_codes').delete().eq('code', code);
    if (error) return toast('删除失败：' + error.message, true);
    await loadCodes();
    toast('已删除');
  }
}

/* ---------- 会员列表 ---------- */
async function loadMembers() {
  const { data, error } = await sb.from('memberships').select('*').order('expires_at', { ascending: false });
  const el = $('#member-list');
  if (error) { el.innerHTML = `<div class="empty">${esc(error.message)}</div>`; return; }
  const list = data || [];
  el.innerHTML = list.length ? list.map((m) => {
    const ok = m.expires_at && new Date(m.expires_at) > new Date();
    return `<div class="card"><div class="card-top">
      <div class="card-name">${esc(m.email || '(无邮箱)')}</div>
      <span class="badge${ok ? '' : ' off'}">${m.level === 'admin' ? '管理员' : (ok ? `有效 · 剩 ${Math.ceil((new Date(m.expires_at) - new Date()) / 86400000)} 天` : '未开通')}</span>
    </div>
    <div class="card-notes">到期：${fmt(m.expires_at)}</div></div>`;
  }).join('') : '<div class="empty">还没有会员</div>';
}

/* ---------- 工具 ---------- */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function copyText(t) {
  if (!t) return;
  try { await navigator.clipboard.writeText(t); toast('已复制到剪贴板'); }
  catch {
    const ta = document.createElement('textarea');
    ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('已复制到剪贴板'); }
    catch { toast('复制失败，请手动选择', true); }
    ta.remove();
  }
}

let toastTimer = null;
function toast(msg, isErr = false, ms = 2500) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', !!isErr);
  show('#toast');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => hide('#toast'), ms);
}
