// QQ 通知补丁 - 渲染层 preload v6.4
// 变更:去掉双重确认延迟(登记 base 必须在增长当轮,否则 base 已是新文本);
//       DOM 变化直接驱动检查(防最小化时定时器被节流);
//       全量遥测:每次快照变化记录补丁看到的会话列表,便于精确诊断。
try {
  const { ipcRenderer } = require('electron');
  const send = (payload) => { try { ipcRenderer.send('QQX_NOTIFIER_EVENT', payload); } catch (e) {} };
  const log = (text) => send({ type: 'log', text: String(text).slice(0, 600) });

  if (!window.__qqxNotifierInstalled) {
    window.__qqxNotifierInstalled = true;

    const perChat = new Map();      // name -> count
    const lastPreview = new Map();  // name -> 最近预览
    const pendingFires = new Map(); // name -> {ts, base}
    const bootAt = Date.now();
    let lastSig = null;
    let lastCheckAt = 0;

    function rowOf(el) {
      let p = el.parentElement, depth = 0;
      while (p && depth < 10) {
        try {
          const r = p.getBoundingClientRect();
          if (r.width > 150 && r.height >= 36 && r.height <= 130) return p;
        } catch (e) {}
        p = p.parentElement; depth++;
      }
      return null;
    }

    function parseRow(row, countText, badgeEl) {
      const lines = (row.innerText || '').split('\n').map(s => s.trim()).filter(Boolean);
      let name = '', preview = '';
      const count = parseInt(countText, 10) || 0;
      for (const ln of lines) {
        if (/^\d{1,3}$/.test(ln)) continue;
        if (/^\d{1,2}:\d{2}$/.test(ln)) continue;
        if (/^(昨天|星期[一二三四五六日]|\d{1,2}\/\d{1,2})/.test(ln)) continue;
        if (!name) { name = ln; continue; }
      }
      for (let i = lines.length - 1; i >= 0; i--) {
        const ln = lines[i];
        if (/^\d{1,3}$/.test(ln)) continue;
        if (/^\d{1,2}:\d{2}$/.test(ln)) continue;
        if (ln === name) continue;
        preview = ln; break;
      }
      const badgeCls = (badgeEl && badgeEl.className || '').toString();
      const muted = /q-badge__grey|mute|disturb|grey|gray|silent|quiet/i.test(badgeCls);
      return { name, preview, count, muted };
    }

    function collect() {
      const rowMap = new Map();
      const addRow = (el, badgeText) => {
        try {
          const row = rowOf(el) || el.closest('[class*="item"]');
          if (!row) return;
          if (!rowMap.has(row)) rowMap.set(row, { row, badgeEl: null, badgeText: null });
          if (badgeText != null) { const c = rowMap.get(row); c.badgeEl = el; c.badgeText = badgeText; }
        } catch (e) {}
      };
      const sel = '[class*="badge"], [class*="unread"], [class*="redPoint"], [class*="remind"], [class*="icon-dot"]';
      for (const el of document.querySelectorAll(sel)) {
        const t = (el.textContent || '').trim();
        if (/^\d{1,3}$/.test(t)) addRow(el, t); else addRow(el, null);
      }
      for (const el of document.querySelectorAll('[class*="item__info"]')) addRow(el, null);
      const out = [];
      const seen = new Set();
      let idx = 0;
      for (const { row, badgeEl, badgeText } of rowMap.values()) {
        const info = parseRow(row, badgeText || '0', badgeEl || row);
        if (!info.name || info.name === '消息' || /^\d+$/.test(info.name)) continue;
        if (seen.has(info.name)) {
          const prev = out.find(o => o.name === info.name);
          if (prev && info.count > prev.count) { prev.count = info.count; prev.muted = prev.muted && info.muted; if (info.preview) prev.preview = info.preview; }
          continue;
        }
        seen.add(info.name);
        info.idx = idx++;
        out.push(info);
      }
      return out;
    }

    function check() {
      try {
        const now = Date.now();
        const rows = collect();
        // 遥测:快照变化时记录(补丁眼中的会话列表 + 窗口状态)
        const sig = rows.map(r => `${r.name}:${r.count}:${r.muted ? 1 : 0}:${r.preview || ''}`).join(';');
        if (sig !== lastSig) {
          lastSig = sig;
          const st = (document.hidden ? 'H' : 'h') + (document.hasFocus() ? 'F' : 'f');
          log('sig[' + st + '] ' + rows.slice(0, 10).map(r =>
            `${r.name.slice(0, 10)}=${r.count}${r.muted ? '(静)' : ''}${r.preview ? ':' + r.preview.slice(0, 12) : ''}`).join(' , '));
        }
        if (!rows.length) { if (perChat.size) perChat.clear(); return; }

        const covered = document.hidden || !document.hasFocus();
        const warm = now - bootAt > 30000;
        for (const r of rows) {
          if (r.preview) lastPreview.set(r.name, r.preview);
          const prev = perChat.get(r.name);
          perChat.set(r.name, r.count);
          if (r.muted || !covered) continue;
          const grew = prev !== undefined
            ? r.count > prev
            : (r.count > 0 && r.idx < 12 && warm);   // 新行出现在可视区:列表外会话的首条
          if (!grew) continue;
          // 立刻登记(base=此刻预览,通常还是旧文本)
          const p = pendingFires.get(r.name);
          pendingFires.set(r.name, { ts: p ? p.ts : now, base: r.preview || '' });
          log('pending ' + r.name.slice(0, 12) + ' cnt=' + r.count + ' base=' + JSON.stringify((r.preview || '').slice(0, 16)));
        }

        // 解决待发:预览与 base 不同(=新内容已渲染)立刻发;
        // 行可见但 6 秒无变化 → 兜底;行被虚拟列表挤出视野 → 持续等它回来,最长 30 秒
        for (const [name, p] of pendingFires) {
          const cur = rows.find(x => x.name === name);
          const curText = (cur && cur.preview) || '';
          const updated = curText && curText !== p.base;
          const age = now - p.ts;
          if (updated) {
            pendingFires.delete(name);
            log('FIRE ' + name.slice(0, 12) + ' (fresh) body=' + JSON.stringify(curText.slice(0, 24)));
            send({ type: 'unread', title: `QQ ${name}`, body: curText, key: name });
          } else if ((cur && age > 6000) || age > 30000) {
            pendingFires.delete(name);
            log('FIRE ' + name.slice(0, 12) + ' (fallback) row=' + (cur ? 'vis' : 'gone'));
            send({ type: 'unread', title: `QQ ${name}`, body: '(新消息)', key: name });
          }
        }
      } catch (e) { /* 静默 */ }
    }

    const maybeCheck = () => { const n = Date.now(); if (n - lastCheckAt > 250) { lastCheckAt = n; check(); } };
    const observer = new MutationObserver(maybeCheck);
    const start = () => {
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      setInterval(check, 800);
      document.addEventListener('visibilitychange', maybeCheck);
      window.addEventListener('focus', maybeCheck);
      window.addEventListener('blur', maybeCheck);
      log('v6.4 watcher active');
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  }
} catch (e) { /* preload 失败不影响 QQ */ }
