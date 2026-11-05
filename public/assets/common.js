'use strict';
// Shared helpers: base64url, AES-GCM end-to-end encryption, API calls, local note list.

const TN = (() => {
  function b64uEncode(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let s = '';
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64uDecode(str) {
    let s = str.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // The 256-bit key lives only in the URL fragment (#k=...), which browsers never send to the server.
  const importKey = (raw) => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  async function newKey() {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    return { raw: b64uEncode(raw), key: await importKey(raw) };
  }
  const keyFromString = (s) => importKey(b64uDecode(s));
  async function encrypt(key, bytes) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
    const out = new Uint8Array(12 + ct.length);
    out.set(iv); out.set(ct, 12);
    return out;
  }
  async function decrypt(key, bytes) {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12) }, key, bytes.subarray(12)));
  }
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const encryptJson = async (key, obj) => b64uEncode(await encrypt(key, enc.encode(JSON.stringify(obj))));
  const decryptJson = async (key, str) => JSON.parse(dec.decode(await decrypt(key, b64uDecode(str))));

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch { /* empty */ }
    if (!res.ok) { const e = new Error(data.error || `Request failed (${res.status})`); e.status = res.status; throw e; }
    return data;
  }

  // Notes you created in this browser (with their edit tokens) are remembered locally.
  const STORE = 'tossnote:notes';
  function myNotes() {
    try { return JSON.parse(localStorage.getItem(STORE) || '[]').filter((n) => !n.expiresAt || n.expiresAt > Date.now()); }
    catch { return []; }
  }
  function saveNotes(list) { try { localStorage.setItem(STORE, JSON.stringify(list.slice(0, 200))); } catch { /* storage unavailable */ } }
  function rememberNote(n) { saveNotes([n, ...myNotes().filter((x) => x.id !== n.id)]); }
  function forgetNote(id) { saveNotes(myNotes().filter((x) => x.id !== id)); }
  const findNote = (id) => myNotes().find((x) => x.id === id);

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return node;
  }

  function relTime(ts) {
    const diff = ts - Date.now();
    const abs = Math.abs(diff);
    const units = [['year', 31536e6], ['month', 2592e6], ['day', 864e5], ['hour', 36e5], ['minute', 6e4]];
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
    for (const [u, ms] of units) if (abs >= ms) return rtf.format(Math.round(diff / ms), u);
    return rtf.format(Math.round(diff / 1000), 'second');
  }
  function fmtBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1048576).toFixed(1)} MB`;
  }
  function qrDataUrl(text) {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    return qr.createDataURL(6, 2);
  }
  async function copy(text, btn) {
    try { await navigator.clipboard.writeText(text); }
    catch {
      const t = el('textarea', {}, text); document.body.append(t); t.select(); document.execCommand('copy'); t.remove();
    }
    if (btn) { const old = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = old; }, 1400); }
  }

  const LANGS = [
    ['auto', 'Auto-detect'], ['plaintext', 'Plain text'], ['bash', 'Bash / Shell'], ['c', 'C'], ['cpp', 'C++'], ['csharp', 'C#'],
    ['css', 'CSS'], ['diff', 'Diff'], ['go', 'Go'], ['graphql', 'GraphQL'], ['xml', 'HTML / XML'], ['ini', 'INI / TOML / .env'],
    ['java', 'Java'], ['javascript', 'JavaScript'], ['json', 'JSON'], ['kotlin', 'Kotlin'], ['lua', 'Lua'], ['makefile', 'Makefile'],
    ['markdown', 'Markdown'], ['objectivec', 'Objective-C'], ['perl', 'Perl'], ['php', 'PHP'], ['python', 'Python'], ['r', 'R'],
    ['ruby', 'Ruby'], ['rust', 'Rust'], ['scss', 'SCSS'], ['sql', 'SQL'], ['swift', 'Swift'], ['typescript', 'TypeScript'], ['yaml', 'YAML'],
  ];

  return { b64uEncode, b64uDecode, newKey, keyFromString, encrypt, decrypt, encryptJson, decryptJson, api, myNotes, rememberNote, forgetNote, findNote, el, relTime, fmtBytes, qrDataUrl, copy, LANGS };
})();
