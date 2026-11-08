'use strict';
(async () => {
  const $ = (id) => document.getElementById(id);
  const { el } = TN;
  const id = location.pathname.slice(1).toLowerCase();
  const keyStr = new URLSearchParams(location.hash.slice(1)).get('k');
  const mine = TN.findNote(id);

  let meta = null;      // public metadata
  let note = null;      // opened note (decrypted)
  let password = null;
  let viewToken = null;
  let cryptoKey = null;
  let editing = false;
  let objectUrls = [];
  // Live pad state (declared up here because open() runs before the pad functions below).
  const clientId = TN.b64uEncode(crypto.getRandomValues(new Uint8Array(9)));
  let padReady = false;
  let dirty = false;
  let saving = false;
  let queued = false;
  let saveTimer = null;
  let lastVersion = 0;
  let statusTimer = null;

  const show = (section) => ['loading', 'gate', 'missing', 'note'].forEach((s) => { $(s).hidden = s !== section; });
  const missing = (msg) => { if (msg) $('missing-text').textContent = msg; show('missing'); };

  try {
    meta = await TN.api(`/api/pastes/${encodeURIComponent(id)}`);
  } catch (e) {
    if (e.status === 404) { TN.forgetNote(id); return missing(); }
    return missing(e.message);
  }
  if (meta.encrypted) {
    if (!keyStr) return missing('This note is end-to-end encrypted, and the link you opened has no key. Ask the sender for the full link, including everything after the #.');
    try { cryptoKey = await TN.keyFromString(keyStr); } catch { return missing('The key in this link is not valid.'); }
  }

  // Burn-after-reading and passwords need an explicit click, so link previews don't consume the note.
  if (meta.needPassword || meta.burn) {
    show('gate');
    $('gate-title').textContent = meta.needPassword ? 'This note is password protected' : 'This note burns after reading';
    $('gate-text').textContent = meta.burn
      ? 'It will be permanently deleted as soon as you open it, so copy anything you need first.'
      : 'Enter the password to view it.';
    $('gate-password').hidden = !meta.needPassword;
    $('gate-btn').textContent = meta.burn ? 'Reveal and destroy' : 'Open';
    if (meta.needPassword) $('gate-password').focus();
    $('gate-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      password = $('gate-password').value || null;
      $('gate-error').hidden = true;
      try { await open(); } catch (err) {
        if (err.status === 404) return missing();
        $('gate-error').textContent = err.message; $('gate-error').hidden = false;
      }
    });
  } else {
    try { await open(); } catch (err) { if (err.status === 404) return missing(); missing(err.message); }
  }

  async function open() {
    note = await fetchNote();
    if (note.consumed) TN.forgetNote(id);
    render();
    if (!note.consumed && !window._live) live();
  }

  // Opens the note (or refreshes it with the view token) and returns it decrypted, without rendering.
  async function fetchNote() {
    const res = await TN.api(`/api/pastes/${encodeURIComponent(id)}/open`, { method: 'POST', body: viewToken ? { viewToken } : { password } });
    viewToken = res.viewToken || null;
    let files = res.files || [];
    if (res.encrypted) {
      let payload;
      try { payload = await TN.decryptJson(cryptoKey, res.content); }
      catch { throw Object.assign(new Error('Could not decrypt. The key in the link is wrong or incomplete.'), { status: 400 }); }
      files = await Promise.all(files.map(async (f, i) => ({ ...(payload.files[i] || { name: `file-${i + 1}` }), bytes: await TN.decrypt(cryptoKey, TN.b64uDecode(f.data)) })));
      return { ...res, title: payload.title, text: payload.text, files, payloadFiles: payload.files };
    }
    return { ...res, text: res.content, files: files.map((f) => ({ ...f, bytes: TN.b64uDecode(f.data) })) };
  }

  function render() {
    show('note');
    document.title = `${note.title || 'Untitled note'} · Tossnote`;
    $('note-title').textContent = note.title || 'Untitled note';
    const bits = [];
    if (note.livePad) bits.push('anyone with the link can edit');
    if (note.encrypted) bits.push('🔒 end-to-end encrypted');
    bits.push(`created ${TN.relTime(note.createdAt)}`);
    if (note.version > 1) bits.push(`edited ${TN.relTime(note.updatedAt)}`);
    if (!note.consumed) bits.push(note.expiresAt ? `expires ${TN.relTime(note.expiresAt)}` : 'never expires');
    bits.push(`${note.views} view${note.views === 1 ? '' : 's'}${note.maxViews ? ` of ${note.maxViews}` : ''}`);
    $('note-meta').textContent = bits.join(' · ');

    const banner = $('banner');
    banner.hidden = !note.consumed;
    if (note.consumed) banner.textContent = 'This note has now been deleted from the server. Once you leave this page, it is gone for good.';

    const hasText = note.livePad || (note.text && note.text.length > 0);
    if (note.livePad) {
      $('viewer').hidden = true;
      $('pad').hidden = false;
      setupPad();
    } else {
      $('viewer').hidden = !hasText || editing;
      if (hasText) highlight(note.text, note.syntax);
    }
    $('btn-copy').hidden = !hasText;
    $('btn-download').hidden = !hasText;
    const raw = $('btn-raw');
    raw.hidden = note.encrypted || note.needPassword || note.consumed || note.maxViews != null;
    raw.href = `/r/${id}`;
    const canEdit = Boolean(mine && mine.editToken);
    $('btn-edit').hidden = !canEdit || note.consumed || note.burn || note.livePad || editing;
    $('btn-delete').hidden = !canEdit || note.consumed;
    renderFiles();
  }

  function highlight(text, syntax) {
    const code = $('code');
    code.className = 'hljs';
    if (typeof hljs === 'undefined' || syntax === 'plaintext' || text.length > 500000) { code.textContent = text; return; }
    try {
      const out = syntax !== 'auto' && hljs.getLanguage(syntax) ? hljs.highlight(text, { language: syntax, ignoreIllegals: true }) : hljs.highlightAuto(text);
      code.innerHTML = out.value; // highlight.js escapes the input
    } catch { code.textContent = text; }
  }

  function renderFiles() {
    objectUrls.forEach((u) => URL.revokeObjectURL(u));
    objectUrls = [];
    $('file-list').replaceChildren(...note.files.map((f) => {
      const url = URL.createObjectURL(new Blob([f.bytes], { type: f.type || 'application/octet-stream' }));
      objectUrls.push(url);
      let preview = null;
      if (/^image\//.test(f.type) && f.type !== 'image/svg+xml') preview = el('img', { src: url, alt: f.name, loading: 'lazy' });
      else if (/^video\//.test(f.type)) preview = el('video', { src: url, controls: true, preload: 'metadata' });
      else if (/^audio\//.test(f.type)) preview = el('audio', { src: url, controls: true });
      return el('div', { class: 'card file' }, preview,
        el('div', { class: 'file-row' }, el('span', {}, `${f.name} · ${TN.fmtBytes(f.bytes.length)}`), el('a', { class: 'btn', href: url, download: f.name }, 'Download')));
    }));
  }

  // ---- live pad: every device types into the same text ----
  // Sync model: last writer wins. A device never overwrites text it is still sending,
  // and its own echoes are recognised by clientId.
  function setStatus(text, isError = false) {
    const s = $('pad-status');
    s.textContent = text;
    s.classList.toggle('error', isError);
  }

  function setupPad() {
    if (padReady) return;
    padReady = true;
    const area = $('pad-area');
    area.value = note.text || '';
    lastVersion = note.version;
    area.addEventListener('input', () => {
      dirty = true;
      note.text = area.value;
      setStatus('Saving…');
      // Throttle (not debounce) so other devices see text while you are still typing.
      if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; savePad(); }, 300);
    });
    area.addEventListener('keydown', (e) => {
      if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        area.setRangeText('  ', area.selectionStart, area.selectionEnd, 'end');
        area.dispatchEvent(new Event('input'));
      }
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) resync(); });
    if (!note.text) area.focus();
  }

  async function putPad(text) {
    const content = note.encrypted ? await TN.encryptJson(cryptoKey, { title: note.title, text, files: note.payloadFiles || [] }) : text;
    const r = await TN.api(`/api/pastes/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'X-View-Token': viewToken || '' }, body: { content, clientId } });
    lastVersion = Math.max(lastVersion, r.version);
  }

  // View tokens live in server memory; after a server restart, open the pad again to get a new one.
  async function renewAccess() {
    try {
      const res = await TN.api(`/api/pastes/${encodeURIComponent(id)}/open`, { method: 'POST', body: { password } });
      viewToken = res.viewToken || null;
      return Boolean(viewToken);
    } catch { return false; }
  }

  async function savePad() {
    if (saving) { queued = true; return; }
    saving = true;
    queued = false;
    dirty = false;
    const text = $('pad-area').value;
    let err = null;
    try { await putPad(text); } catch (e) { err = e; }
    if (err && err.status === 403 && await renewAccess()) {
      try { await putPad(text); err = null; } catch (e) { err = e; }
    }
    saving = false;
    if (err) {
      dirty = true;
      setStatus(err.status === 404 ? 'This pad has expired or was deleted' : `Not saved: ${err.message}`, true);
      if (err.status !== 404 && !saveTimer) saveTimer = setTimeout(() => { saveTimer = null; savePad(); }, 3000);
      return;
    }
    if (queued || dirty) savePad();
    else setStatus('All changes saved');
  }

  function applyRemote(text, version) {
    const area = $('pad-area');
    const old = area.value;
    lastVersion = version;
    if (old === text) return;
    // Keep the caret in place: positions after the first changed character shift by the length difference.
    const focused = document.activeElement === area;
    const { selectionStart: s, selectionEnd: e } = area;
    let pre = 0;
    while (pre < old.length && pre < text.length && old[pre] === text[pre]) pre++;
    const delta = text.length - old.length;
    area.value = text;
    note.text = text;
    if (focused) {
      const fix = (p) => (p <= pre ? p : Math.max(pre, p + delta));
      area.setSelectionRange(fix(s), fix(e));
    }
    setStatus('Updated from another device');
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { if (!dirty && !saving) setStatus('All changes saved'); }, 2000);
  }

  async function onRemoteUpdate(data) {
    if (data.version <= lastVersion) return;
    if (data.clientId === clientId) { lastVersion = data.version; return; }
    if (dirty || saving) return; // our pending save is newer and will win
    let text;
    if (data.content != null) {
      text = note.encrypted ? (await TN.decryptJson(cryptoKey, data.content)).text : data.content;
    } else {
      text = (await fetchNote()).text; // password-protected pads don't broadcast content
    }
    if (dirty || saving) return;
    applyRemote(text, data.version);
  }

  // Catch up after the connection dropped or the phone was asleep.
  async function resync() {
    if (!padReady || dirty || saving) return;
    try {
      const fresh = await fetchNote();
      if (!dirty && !saving && fresh.version > lastVersion) applyRemote(fresh.text, fresh.version);
    } catch { /* the next update or reconnect will retry */ }
  }

  function showPresence(count) {
    $('pad-devices').textContent = count <= 1 ? 'Only this device is connected' : `${count} devices connected`;
  }

  // ---- live updates ----
  function live() {
    let connectedBefore = false;
    window._live = new EventSource(`/api/pastes/${encodeURIComponent(id)}/events`);
    window._live.addEventListener('open', () => {
      if (connectedBefore && note.livePad) resync();
      connectedBefore = true;
    });
    window._live.addEventListener('presence', (ev) => { if (note.livePad) showPresence(JSON.parse(ev.data).count); });
    window._live.addEventListener('update', async (ev) => {
      if (note.livePad) { try { await onRemoteUpdate(JSON.parse(ev.data)); } catch { /* ignore */ } return; }
      if (editing) return;
      try { await open(); } catch { /* ignore */ }
    });
    window._live.addEventListener('gone', () => {
      window._live.close();
      if (!note.consumed) { $('banner').hidden = false; $('banner').textContent = 'This note has been deleted or has expired. What you see is the last copy.'; }
    });
  }

  // ---- toolbar ----
  $('btn-copy').addEventListener('click', (e) => TN.copy(note.text, e.currentTarget));
  $('btn-link').addEventListener('click', (e) => TN.copy(location.href, e.currentTarget));
  $('btn-download').addEventListener('click', () => {
    const ext = { python: 'py', javascript: 'js', typescript: 'ts', markdown: 'md', bash: 'sh', json: 'json', yaml: 'yml', xml: 'html', go: 'go', rust: 'rs', sql: 'sql', css: 'css' }[note.syntax] || 'txt';
    const a = el('a', { href: URL.createObjectURL(new Blob([note.text], { type: 'text/plain' })), download: `${(note.title || id).replace(/[^\w.-]+/g, '_')}.${ext}` });
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('btn-qr').addEventListener('click', () => {
    const box = $('qr-box');
    if (box.hidden) $('qr').src = TN.qrDataUrl(location.href);
    box.hidden = !box.hidden;
  });
  $('btn-delete').addEventListener('click', async () => {
    if (!confirm('Delete this note for everyone?')) return;
    try { await TN.api(`/api/pastes/${id}`, { method: 'DELETE', headers: { 'X-Edit-Token': mine.editToken } }); }
    catch (e) { if (e.status !== 404) { alert(e.message); return; } }
    TN.forgetNote(id); location.href = '/';
  });
  $('btn-edit').addEventListener('click', () => {
    editing = true;
    $('edit-area').value = note.text || '';
    $('editor').hidden = false;
    render();
    $('edit-area').focus();
  });
  $('edit-cancel').addEventListener('click', () => { editing = false; $('editor').hidden = true; render(); });
  $('edit-save').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const text = $('edit-area').value;
      const content = note.encrypted ? await TN.encryptJson(cryptoKey, { title: note.title, text, files: note.payloadFiles || [] }) : text;
      await TN.api(`/api/pastes/${id}`, { method: 'PUT', headers: { 'X-Edit-Token': mine.editToken }, body: { content } });
      editing = false; $('editor').hidden = true;
      await open();
    } catch (err) { alert(err.message); }
    finally { btn.disabled = false; }
  });
})();
