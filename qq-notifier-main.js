// QQ Linux 通知补丁 - 主进程侧 v6.6
// 职责:接收渲染层信号 → 集中节流 → 发系统通知 → 点击通知聚焦 QQ 并打开对应会话
// 兼容两种部署:开发目录(qq-re)与 /opt/QQ 安装(preload 按 __dirname 解析)
const fs = require('fs');
const path = require('path');
const os = require('os');

const LOG = process.env.QQX_LOG || path.join(os.homedir(), '.qq-notify-patch.log');
const PRELOAD_PATH = process.env.QQX_PRELOAD_PATH || path.join(__dirname, 'qq-notifier-preload.js');
const nlog = (...a) => { try { fs.appendFileSync(LOG, a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n'); } catch (e) {} };

const electron = require('electron');

// 集中节流(多窗口重复信号在此合并裁决)
const lastByChat = new Map();   // key -> ts(同会话 20s)
const lastByBody = new Map();   // title|body -> ts(相同内容 45s)
let globalFires = [];           // 60s 内最多 4 条

function allowed(key, title, body) {
  const now = Date.now();
  globalFires = globalFires.filter(t => now - t < 60000);
  if (globalFires.length >= 4) return 'rate-global';
  const lb = lastByBody.get(title + '|' + body);
  if (lb && now - lb < 45000) return 'dup-body';
  const lc = lastByChat.get(key);
  if (lc && now - lc < 20000) return 'rate-chat';
  return null;
}

// 在报告消息的渲染进程里找到该会话行并点击(打开对话)
function openChatByRow(srcWcId, chatName) {
  try {
    if (!srcWcId || !chatName) return;
    const wc = electron.webContents.fromId(srcWcId);
    if (!wc) return;
    setTimeout(() => {
      try {
        wc.executeJavaScript(`(function(){
          var name = ${JSON.stringify(String(chatName))};
          var items = document.querySelectorAll('[class*="item"]');
          for (var i = 0; i < items.length; i++) {
            var it = items[i];
            var r = it.getBoundingClientRect ? it.getBoundingClientRect() : null;
            if (!r || r.width < 150 || r.height < 30 || r.height > 140) continue;
            var lines = (it.innerText || '').split('\\n').map(function(s){return s.trim();}).filter(Boolean);
            if (lines[0] === name) {
              it.scrollIntoView({block: 'center'});
              it.click();
              return 'ok';
            }
          }
          return 'not-found';
        })()`, false).catch(() => {});
      } catch (e) { /* ignore */ }
    }, 300);
  } catch (e) { /* ignore */ }
}

function fire(title, body, key, srcWcId) {
  const verdict = allowed(key, title, body);
  if (verdict) { nlog('[NOTIFIER] suppressed (' + verdict + '):', key); return false; }
  const now = Date.now();
  lastByChat.set(key, now);
  lastByBody.set(title + '|' + body, now);
  globalFires.push(now);
  try {
    const n = new electron.Notification({
      title: String(title || 'QQ').slice(0, 60),
      body: String(body || '').slice(0, 120),
      silent: false,
    });
    n.on('click', () => {
      try {
        const wins = electron.BrowserWindow.getAllWindows();
        const main = wins.find(w => /#\/(main|chat)/.test(w.webContents.getURL() || '')) || wins[0];
        if (main) { if (main.isMinimized()) main.restore(); main.show(); main.focus(); }
        openChatByRow(srcWcId, key);
      } catch (e) { /* ignore */ }
    });
    n.show();
    nlog('[NOTIFIER] fired:', title, '|', body);
    return true;
  } catch (e) {
    nlog('[NOTIFIER] fire fail:', e.message);
    return false;
  }
}

electron.ipcMain.on('QQX_NOTIFIER_EVENT', (ev, payload) => {
  try {
    if (!payload || typeof payload !== 'object') return;
    if (payload.type === 'unread') {
      fire(payload.title || 'QQ 新消息', payload.body || '', payload.key || payload.title, ev.sender.id);
    } else if (payload.type === 'log') {
      nlog('[preload:wc' + ev.sender.id + ']', payload.text);
    }
  } catch (e) { nlog('[NOTIFIER] handler fail:', e.message); }
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
  nlog('[NOTIFIER] v6.6 main-side installed, preload =', PRELOAD_PATH);
} catch (e) {
  nlog('[NOTIFIER] install fail:', e.message);
}
