// QQ 通知补丁 - 渲染层 preload v6.6
// 变更:去掉双重确认延迟(登记 base 必须在增长当轮,否则 base 已是新文本);
//       DOM 变化直接驱动检查(防最小化时定时器被节流);
// 不记录聊天遥测；前台、免打扰或已读时取消待发通知。
try {
  const { ipcRenderer } = require('electron');
  const send = (payload) => { try { ipcRenderer.send('QQX_NOTIFIER_EVENT', payload); } catch (e) {} };
  // Chat names and previews must never be written to diagnostic logs.

  if (!window.__qqxNotifierInstalled) {
    window.__qqxNotifierInstalled = true;

    const perChat = new Map();      // name -> count
    const lastPreview = new Map();  // name -> 最近预览
    const pendingFires = new Map(); // name -> {ts, base}
    const bootAt = Date.now();
    let lastCheckAt = 0;
    const clickTargets = new Map();
    let targetSerial = 0;

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

    function collect(deduplicate = true) {
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
        if (deduplicate && seen.has(info.name)) {
          const prev = out.find(o => o.name === info.name);
          if (prev && info.count > prev.count) { prev.count = info.count; prev.muted = prev.muted && info.muted; if (info.preview) prev.preview = info.preview; }
          continue;
        }
        seen.add(info.name);
        info.idx = idx++;
        info.row = row;
        out.push(info);
      }
      return out;
    }

    const idAttributes = ['data-peer-id', 'data-peer-uid', 'data-chat-id', 'data-conversation-id', 'data-contact-id', 'data-uid', 'data-uin'];
    function identity(row) {
      const found = {};
      if (row && row.getAttribute) for (const key of idAttributes) {
        const value = row.getAttribute(key);
        if (value) found[key] = value;
      }
      return found;
    }
    function sameId(row, ids) {
      return Object.entries(ids).every(([key, value]) => row.getAttribute && row.getAttribute(key) === value);
    }
    function resolveTarget(target) {
      const rows = collect(false);
      const ref = rows.find(r => r.row === target.row && r.name === target.name && sameId(r.row, target.ids));
      if (ref && ref.row.isConnected !== false) return ref.row;
      if (Object.keys(target.ids).length) {
        const stable = rows.filter(r => sameId(r.row, target.ids));
        return stable.length === 1 ? stable[0].row : null;
      }
      // A duplicate name is ambiguous: never choose a different person arbitrarily.
      const named = rows.filter(r => r.name === target.name);
      return named.length === 1 ? named[0].row : null;
    }
    function sendUnread(name, body, current, queued) {
      const token = 'n' + bootAt.toString(36) + '.' + (++targetSerial).toString(36);
      const row = current ? current.row : queued.row;
      clickTargets.set(token, { name, row, ids: current ? identity(row) : queued.ids });
      while (clickTargets.size > 256) clickTargets.delete(clickTargets.keys().next().value);
      send({ type: 'unread', title: `QQ ${name}`, body, key: name, target: token });
    }
    ipcRenderer.on('QQX_NOTIFIER_OPEN', (_event, payload) => {
      if (!payload || typeof payload.token !== 'string') return;
      const target = clickTargets.get(payload.token);
      if (!target) { send({ type: 'open-target', token: payload.token, status: 'not-found' }); return; }
      try {
        const row = resolveTarget(target);
        if (!row) { send({ type: 'open-target', token: payload.token, status: 'ambiguous-or-not-found' }); return; }
        row.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        // Let layout settle after restoring the window and scrolling a virtual row.
        setTimeout(() => {
          try {
            const live = resolveTarget(target);
            if (!live) { send({ type: 'open-target', token: payload.token, status: 'not-found' }); return; }
            const r = live.getBoundingClientRect();
            const x = Math.round(r.left + Math.min(r.width * 0.4, 100));
            const y = Math.round(r.top + r.height / 2);
            if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) {
              send({ type: 'open-target', token: payload.token, status: 'outside-viewport' }); return;
            }
            send({ type: 'open-target', token: payload.token, status: 'ready', x, y });
          } catch (_) { send({ type: 'open-target', token: payload.token, status: 'layout-failed' }); }
        }, 80);
      } catch (_) { send({ type: 'open-target', token: payload.token, status: 'lookup-failed' }); }
    });

    function check() {
      try {
        const now = Date.now();
        const rows = collect();
        if (!rows.length) {
          // A temporary empty/virtualized view is not a new unread baseline.
          for (const [name, p] of pendingFires) if (now - p.ts > 30000) pendingFires.delete(name);
          return;
        }

        const covered = document.hidden || !document.hasFocus();
        const warm = now - bootAt > 30000;
        for (const r of rows) {
          const previousPreview = lastPreview.get(r.name);
          if (r.preview) lastPreview.set(r.name, r.preview);
          const prev = perChat.get(r.name);
          perChat.set(r.name, r.count);
          if (r.muted || !covered) continue;
          const grew = prev !== undefined
            ? r.count > prev
            : (r.count > 0 && r.idx < 12 && warm);   // 新行出现在可视区:列表外会话的首条
          if (!grew) continue;
          // 保留上一轮预览作为基准，兼容未读数与预览在同一轮更新。
          const p = pendingFires.get(r.name);
          pendingFires.set(r.name, { ts: p ? p.ts : now, base: p ? p.base : (previousPreview || r.preview || ''), row: r.row, ids: identity(r.row) });
        }

        // 解决待发:预览与 base 不同(=新内容已渲染)立刻发;
        // 行可见但 6 秒无变化 → 兜底;行被虚拟列表挤出视野 → 持续等它回来,最长 30 秒
        // A message queued in the background must be cancelled if the user returns,
        // reads the conversation, or enables mute before the notification is shown.
        if (!covered) { pendingFires.clear(); return; }
        for (const [name, p] of pendingFires) {
          const cur = rows.find(x => x.name === name);
          if (cur && (cur.muted || cur.count === 0)) { pendingFires.delete(name); continue; }
          const curText = (cur && cur.preview) || '';
          const updated = curText && curText !== p.base;
          const age = now - p.ts;
          if (updated) {
            pendingFires.delete(name);
            sendUnread(name, curText, cur, p);
          } else if ((cur && age > 6000) || age > 30000) {
            pendingFires.delete(name);
            sendUnread(name, '(新消息)', cur, p);
          }
        }
      } catch (e) { /* 静默 */ }
    }

    // Bound renderer caches without forgetting all baselines during a virtual-list redraw.
    const trim = () => {
      for (const map of [perChat, lastPreview]) {
        while (map.size > 1024) map.delete(map.keys().next().value);
      }
    };
    const maybeCheck = () => { const n = Date.now(); if (n - lastCheckAt > 250) { lastCheckAt = n; check(); trim(); } };
    const observer = new MutationObserver(maybeCheck);
    const start = () => {
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      setInterval(() => { check(); trim(); }, 800);
      document.addEventListener('visibilitychange', maybeCheck);
      window.addEventListener('focus', maybeCheck);
      window.addEventListener('blur', maybeCheck);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  }
} catch (e) { /* preload 失败不影响 QQ */ }
