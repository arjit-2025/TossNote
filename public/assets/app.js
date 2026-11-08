'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const { el } = TN;
  let attached = []; // File objects

  document.querySelectorAll('.origin').forEach((n) => { n.textContent = location.origin; });
  for (const [v, label] of TN.LANGS) $('syntax').append(el('option', { value: v }, label));

  // ---- editor niceties ----
  const content = $('content');
  content.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      const { selectionStart: s, selectionEnd: t } = content;
      content.setRangeText('  ', s, t, 'end');
      updateStats();
    }
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); share(); }
  });
  const updateStats = () => {
    const n = content.value.length;
    const lines = content.value ? content.value.split('\n').length : 0;
    $('stats').textContent = `${n.toLocaleString()} characters · ${lines} lines${attached.length ? ` · ${attached.length} file(s)` : ''}`;
  };
  content.addEventListener('input', updateStats);
  updateStats();

  // ---- files ----
  function renderFiles() {
    const box = $('files');
    box.replaceChildren(...attached.map((f, i) => el('span', { class: 'chip' }, `${f.name} · ${TN.fmtBytes(f.size)}`,
      el('button', { type: 'button', 'aria-label': `Remove ${f.name}`, onclick: () => { attached.splice(i, 1); renderFiles(); } }, '×'))));
    updateStats();
  }
  const addFiles = (list) => { attached.push(...list); renderFiles(); };
  $('file-input').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
  const drop = $('drop');
  ['dragenter', 'dragover'].forEach((t) => document.addEventListener(t, (e) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); drop.classList.add('over'); } }));
  ['dragleave', 'drop'].forEach((t) => document.addEventListener(t, (e) => { if (t === 'drop' || e.target === document.documentElement) drop.classList.remove('over'); }));
  document.addEventListener('drop', (e) => { if (e.dataTransfer?.files.length) { e.preventDefault(); addFiles(e.dataTransfer.files); } });
  content.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); addFiles(files); }
  });

  // ---- share ----
  function showError(msg) { $('error').textContent = msg; $('error').hidden = !msg; }

  async function share() {
    const btn = $('share');
    if (btn.disabled) return;
    showError('');
    const text = content.value;
    const livePad = $('livepad').checked;
    if (!livePad && !text.trim() && !attached.length) { showError('Add some text or a file first.'); return; }
    btn.disabled = true;
    btn.firstChild.textContent = 'Sharing… ';
    try {
      const encrypted = $('encrypt').checked;
      const title = $('title').value.trim();
      const body = {
        syntax: $('syntax').value,
        expiry: $('expiry').value,
        burn: !livePad && $('burn').checked,
        livePad,
        password: $('password').value || undefined,
        maxViews: $('maxviews').value || undefined,
        slug: $('slug').value.trim() || undefined,
        encrypted,
      };
      let keyStr = null;
      const fileBytes = await Promise.all(attached.map(async (f) => new Uint8Array(await f.arrayBuffer())));
      if (encrypted) {
        const { raw, key } = await TN.newKey();
        keyStr = raw;
        body.content = await TN.encryptJson(key, { title, text, files: attached.map((f) => ({ name: f.name, type: f.type, size: f.size })) });
        body.files = await Promise.all(fileBytes.map(async (b) => ({ data: TN.b64uEncode(await TN.encrypt(key, b)) })));
      } else {
        body.title = title;
        body.content = text;
        body.files = attached.map((f, i) => ({ name: f.name, type: f.type, size: f.size, data: TN.b64uEncode(fileBytes[i]) }));
      }
      const res = await TN.api('/api/pastes', { method: 'POST', body });
      const url = `${location.origin}/${res.id}${keyStr ? `#k=${keyStr}` : ''}`;
      TN.rememberNote({ id: res.id, title: title || text.slice(0, 60) || attached[0]?.name || 'Untitled', createdAt: Date.now(), expiresAt: res.expiresAt, editToken: res.editToken, key: keyStr, burn: body.burn });
      showResult(url, res, body);
    } catch (e) {
      showError(e.message);
    } finally {
      btn.disabled = false;
      syncLiveToggle();
    }
  }
  $('share').addEventListener('click', share);

  // Live pads can't burn after reading (the first device would destroy it for the others).
  function syncLiveToggle() {
    const live = $('livepad').checked;
    $('burn').disabled = live;
    if (live) $('burn').checked = false;
    $('share').firstChild.textContent = live ? 'Start live pad ' : 'Share ';
  }
  $('livepad').addEventListener('change', syncLiveToggle);
  syncLiveToggle();

  function showResult(url, res, body) {
    $('compose').hidden = true;
    $('result').hidden = false;
    $('link').value = url;
    $('open').href = url;
    $('qr').src = TN.qrDataUrl(url);
    const bits = [res.expiresAt ? `Expires ${TN.relTime(res.expiresAt)}` : 'Never expires'];
    if (body.livePad) bits.unshift('Live pad: open it on your other devices (scan the QR code) and type on any of them');
    if (body.burn) bits.push('burns after one view');
    if (body.maxViews) bits.push(`max ${body.maxViews} views`);
    if (body.password) bits.push('password protected');
    if (body.encrypted) bits.push('end-to-end encrypted');
    $('result-meta').textContent = `${bits.join(' · ')}.`;
    $('link').select();
    renderMine();
  }
  $('copy').addEventListener('click', (e) => TN.copy($('link').value, e.currentTarget));
  $('again').addEventListener('click', () => {
    content.value = ''; $('title').value = ''; $('password').value = ''; $('maxviews').value = ''; $('slug').value = '';
    attached = []; renderFiles();
    $('result').hidden = true; $('compose').hidden = false; content.focus();
  });

  // ---- my notes ----
  function renderMine() {
    const list = TN.myNotes();
    $('mine-count').textContent = list.length || '';
    $('mine-list').replaceChildren(...(list.length ? list.map((n) => {
      const href = `/${n.id}${n.key ? `#k=${n.key}` : ''}`;
      return el('li', {},
        el('a', { href }, n.title || n.id),
        el('span', { class: 'muted' }, n.expiresAt ? `expires ${TN.relTime(n.expiresAt)}` : 'never expires'),
        el('button', { class: 'ghost small', type: 'button', onclick: async () => {
          if (!confirm('Delete this note for everyone?')) return;
          try { await TN.api(`/api/pastes/${n.id}`, { method: 'DELETE', headers: { 'X-Edit-Token': n.editToken } }); }
          catch (e) { if (e.status !== 404) { alert(e.message); return; } }
          TN.forgetNote(n.id); renderMine();
        } }, 'Delete'));
    }) : [el('li', { class: 'muted' }, 'Nothing yet.')]));
  }
  $('mine-toggle').addEventListener('click', () => { $('mine').hidden = !$('mine').hidden; renderMine(); });
  renderMine();
  content.focus();
})();
