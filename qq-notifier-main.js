// QQ Linux 通知补丁 - 主进程侧 v6.6
// 职责:接收渲染层信号 → 集中节流 → 发系统通知 → 点击通知聚焦 QQ 并打开对应会话
// 兼容两种部署:开发目录(qq-re)与 /opt/QQ 安装(preload 按 __dirname 解析)
const fs = require('fs');
const path = require('path');
const os = require('os');

// Diagnostics are opt-in and never include chat names or message contents.
const DEBUG = process.env.QQX_DEBUG === '1';
const LOGDIR = path.join(os.homedir(), '.local', 'state', 'qq-notify-patch');
const LOG = process.env.QQX_LOG || path.join(LOGDIR, 'status.log');
const PRELOAD_PATH = process.env.QQX_PRELOAD_PATH || path.join(__dirname, 'qq-notifier-preload.js');
const nlog = (event) => {
  if (!DEBUG) return;
  let fd;
  try {
    fs.mkdirSync(LOGDIR, { recursive: true, mode: 0o700 });
    fd = fs.openSync(LOG, fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    if (fs.fstatSync(fd).size > 65536) fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, new Date().toISOString() + ' ' + event + '\n');
  } catch (_) {} finally { if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {} }
};

const electron = require('electron');

// 集中节流(多窗口重复信号在此合并裁决)
const lastByChat = new Map();   // key -> ts(同会话 20s)
const lastByBody = new Map();   // title|body -> ts(相同内容 45s)
let globalFires = [];           // 60s 内最多 4 条

function allowed(key, title, body) {
  const now = Date.now();
  globalFires = globalFires.filter(t => now - t < 60000);
  for (const [k, ts] of lastByChat) if (now - ts >= 60000) lastByChat.delete(k);
  for (const [k, ts] of lastByBody) if (now - ts >= 60000) lastByBody.delete(k);
  if (globalFires.length >= 4) return 'rate-global';
  const lb = lastByBody.get(title + '|' + body);
  if (lb && now - lb < 45000) return 'dup-body';
  const lc = lastByChat.get(key);
  if (lc && now - lc < 20000) return 'rate-chat';
  return null;
}

// Retain native notifications and route clicks back to the original renderer.
const activeNotifications = new Set();
const pendingOpens = new Map();

function openChatTarget(srcWcId, token) {
  try {
    const wc = electron.webContents.fromId(srcWcId);
    if (!wc || wc.isDestroyed() || !token) { nlog('[CLICK] source unavailable'); return; }
    try {
      const wins = electron.BrowserWindow.getAllWindows();
      const owner = electron.BrowserWindow.fromWebContents(wc);
      const main = owner || wins.find(w => /#\/(main|chat)/.test(w.webContents.getURL() || '')) || wins[0];
      if (main) { if (main.isMinimized()) main.restore(); main.show(); main.focus(); }
      wc.focus();
    } catch (_) { nlog('[CLICK] window focus unavailable'); }
    for (const [k, p] of pendingOpens) if (p.until < Date.now()) pendingOpens.delete(k);
    pendingOpens.set(token, { wcId: srcWcId, until: Date.now() + 6000 });
    setTimeout(() => {
      try { if (!wc.isDestroyed()) wc.send('QQX_NOTIFIER_OPEN', { token }); }
      catch (_) { pendingOpens.delete(token); nlog('[CLICK] source unavailable'); }
    }, 200);
    nlog('[CLICK] locator requested');
  } catch (_) { nlog('[CLICK] request failed'); }
}

function handleOpenTarget(ev, payload) {
  if (typeof payload.token !== 'string' || payload.token.length > 100) return;
  const pending = pendingOpens.get(payload.token);
  if (!pending || pending.wcId !== ev.sender.id || pending.until < Date.now()) return;
  pendingOpens.delete(payload.token);
  if (payload.status !== 'ready') {
    const allowed = new Set(['not-found', 'ambiguous-or-not-found', 'outside-viewport', 'layout-failed', 'lookup-failed']);
    nlog('[CLICK] ' + (allowed.has(payload.status) ? payload.status : 'target unavailable')); return;
  }
  const { x, y } = payload;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 16384 || y > 16384) return;
  try {
    ev.sender.focus();
    ev.sender.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) });
    ev.sender.sendInputEvent({ type: 'mouseDown', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
    ev.sender.sendInputEvent({ type: 'mouseUp', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
    nlog('[CLICK] native conversation-row click sent');
  } catch (_) { nlog('[CLICK] native click failed'); }
}

function fire(title, body, key, srcWcId, target) {
  const verdict = allowed(key, title, body);
  if (verdict) { nlog('[NOTIFIER] suppressed (' + verdict + ')'); return false; }
  const now = Date.now();
  try {
    const n = new electron.Notification({
      title: String(title || 'QQ').slice(0, 60),
      body: String(body || '').slice(0, 120),
      silent: false,
    });
    activeNotifications.add(n);
    while (activeNotifications.size > 256) activeNotifications.delete(activeNotifications.values().next().value);
    n.on('close', () => activeNotifications.delete(n));
    n.on('failed', () => activeNotifications.delete(n));
    n.on('click', () => {
      activeNotifications.delete(n);
      openChatTarget(srcWcId, target);
    });
    n.show();
    lastByChat.set(key, now);
    lastByBody.set(title + '|' + body, now);
    globalFires.push(now);
    nlog('[NOTIFIER] notification shown');
    return true;
  } catch (e) {
    nlog('[NOTIFIER] notification failed');
    return false;
  }
}

electron.ipcMain.on('QQX_NOTIFIER_EVENT', (ev, payload) => {
  try {
    if (!payload || typeof payload !== 'object' || !ev.sender || ev.sender.isDestroyed()) return;
    // Ignore iframe senders; only a top-level QQ renderer can report a conversation.
    if (ev.senderFrame && ev.sender.mainFrame && ev.senderFrame !== ev.sender.mainFrame) return;
    if (payload.type === 'unread' &&
        (typeof payload.title !== 'string' || typeof payload.body !== 'string' ||
         typeof payload.key !== 'string' || typeof payload.target !== 'string' || payload.target.length > 100 || payload.title.length > 512 ||
         payload.body.length > 8192 || !payload.key || payload.key.length > 512)) return;
    if (payload.type === 'open-target') {
      handleOpenTarget(ev, payload);
    } else if (payload.type === 'unread') {
      fire(payload.title || 'QQ 新消息', payload.body || '', payload.key || payload.title, ev.sender.id, payload.target);
    } else if (payload.type === 'log') {
      // Renderer diagnostics are intentionally not persisted.
    }
  } catch (e) { nlog('[NOTIFIER] handler failed'); }
});

// preload 注入:session-created 钩 + setPreloads 包装防覆盖
function hookSession(s) {
  if (s.__qqxHooked) return;
  s.__qqxHooked = true;
  const orig = s.setPreloads.bind(s);
  s.setPreloads = function (arr) {
    const list = (arr || []).slice();
    if (!list.includes(PRELOAD_PATH)) list.push(PRELOAD_PATH);
    return orig(list);
  };
  const cur = (typeof s.getPreloads === 'function') ? s.getPreloads() : [];
  s.setPreloads(cur);
}

try {
  electron.app.on('session-created', hookSession);
  if (electron.app.isReady()) hookSession(electron.session.defaultSession);
  else electron.app.whenReady().then(() => hookSession(electron.session.defaultSession)).catch(() => {});
  nlog('[NOTIFIER] initialized');
  try { process.stderr.write('[qq-notify-patch] initialized\n'); } catch (_) {}
} catch (e) {
  nlog('[NOTIFIER] initialization failed');
}
