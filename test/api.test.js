'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tossnote-test-'));
const { server } = require('../server.js');

let base;
test.before(() => new Promise((r) => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));
test.after(() => { server.close(); server.closeAllConnections?.(); fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });

const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const create = async (body) => { const r = await post('/api/pastes', body); assert.equal(r.status, 201); return r.json(); };
const open = (id, body = {}) => post(`/api/pastes/${id}/open`, body);

test('create, view meta, open and count views', async () => {
  const { id, editToken } = await create({ content: 'hello world', title: 'Greeting', syntax: 'plaintext' });
  assert.ok(editToken);
  const meta = await (await fetch(`${base}/api/pastes/${id}`)).json();
  assert.equal(meta.title, 'Greeting');
  assert.equal(meta.views, 0, 'metadata lookups must not count views');
  const o = await (await open(id)).json();
  assert.equal(o.content, 'hello world');
  assert.equal(o.views, 1);
  // Refreshing with the view token does not count another view.
  const o2 = await (await open(id, { viewToken: o.viewToken })).json();
  assert.equal(o2.views, 1);
});

test('burn after reading deletes on first open only', async () => {
  const { id } = await create({ content: 'secret', burn: true });
  const [a, b] = await Promise.all([open(id), open(id)]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 404], 'exactly one concurrent reader gets the note');
  assert.equal((await fetch(`${base}/api/pastes/${id}`)).status, 404);
});

test('password protection and max views', async () => {
  const { id } = await create({ content: 'pw note', password: 'hunter2', maxViews: 2, title: 'hidden title' });
  const meta = await (await fetch(`${base}/api/pastes/${id}`)).json();
  assert.equal(meta.needPassword, true);
  assert.equal(meta.title, '', 'title is hidden behind the password');
  assert.equal((await open(id)).status, 403);
  assert.equal((await open(id, { password: 'nope' })).status, 403);
  assert.equal((await open(id, { password: 'hunter2' })).status, 200);
  const last = await (await open(id, { password: 'hunter2' })).json();
  assert.equal(last.consumed, true);
  assert.equal((await open(id, { password: 'hunter2' })).status, 404);
});

test('edit with token, reject without; delete', async () => {
  const { id, editToken } = await create({ content: 'v1' });
  const bad = await fetch(`${base}/api/pastes/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Edit-Token': 'wrong' }, body: JSON.stringify({ content: 'x' }) });
  assert.equal(bad.status, 403);
  const ok = await fetch(`${base}/api/pastes/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Edit-Token': editToken }, body: JSON.stringify({ content: 'v2' }) });
  assert.equal((await ok.json()).version, 2);
  assert.equal((await (await open(id)).json()).content, 'v2');
  const del = await fetch(`${base}/api/pastes/${id}`, { method: 'DELETE', headers: { 'X-Edit-Token': editToken } });
  assert.equal(del.status, 200);
  assert.equal((await open(id)).status, 404);
});

test('live update event is pushed to subscribers', async () => {
  const { id, editToken } = await create({ content: 'live v1' });
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/pastes/${id}/events`, { signal: ctrl.signal });
  const reader = res.body.getReader();
  await reader.read(); // retry preamble
  await fetch(`${base}/api/pastes/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Edit-Token': editToken }, body: JSON.stringify({ content: 'live v2' }) });
  const { value } = await reader.read();
  assert.match(new TextDecoder().decode(value), /event: update\ndata: \{"version":2\}/);
  ctrl.abort();
});

test('custom slug, conflicts, and expiry', async () => {
  const slug = `my-note-${Date.now()}`;
  const { id } = await create({ content: 'x', slug });
  assert.equal(id, slug);
  assert.equal((await post('/api/pastes', { content: 'y', slug })).status, 409);
  assert.equal((await post('/api/pastes', { content: 'y', slug: 'Bad Slug!' })).status, 400);
  const short = await create({ content: 'gone soon', expiry: 1 });
  const file = path.join(process.env.DATA_DIR, 'pastes', `${short.id}.json`);
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  rec.expiresAt = Date.now() - 1;
  fs.writeFileSync(file, JSON.stringify(rec));
  assert.equal((await fetch(`${base}/api/pastes/${short.id}`)).status, 404);
  assert.equal(fs.existsSync(file), false, 'expired notes are removed from disk');
});

test('files are stored and returned', async () => {
  const data = Buffer.from('PNGDATA').toString('base64url');
  const { id } = await create({ content: '', files: [{ name: 'a.png', type: 'image/png', size: 7, data }] });
  const o = await (await open(id)).json();
  assert.equal(o.files.length, 1);
  assert.equal(o.files[0].name, 'a.png');
  assert.equal(Buffer.from(o.files[0].data, 'base64url').toString(), 'PNGDATA');
});

test('encrypted notes are stored opaque and refused by raw endpoint', async () => {
  const { id } = await create({ content: 'opaque-ciphertext', encrypted: true, title: 'leak?' });
  const meta = await (await fetch(`${base}/api/pastes/${id}`)).json();
  assert.equal(meta.encrypted, true);
  assert.equal(meta.title, '', 'server discards plaintext titles for encrypted notes');
  assert.equal((await fetch(`${base}/r/${id}`)).status, 400);
});

test('curl API: create and read raw', async () => {
  const r = await fetch(`${base}/api/raw?expiry=1h&syntax=python`, { method: 'POST', body: 'print("hi")\n' });
  assert.equal(r.status, 201);
  const url = (await r.text()).trim();
  assert.ok(r.headers.get('x-edit-token'));
  const id = url.split('/').pop();
  assert.equal(await (await fetch(`${base}/r/${id}`)).text(), 'print("hi")\n');
  const pw = await fetch(`${base}/api/raw?burn=1`, { method: 'POST', body: 'top', headers: { 'X-Password': 'p' } });
  const pid = (await pw.text()).trim().split('/').pop();
  assert.equal((await fetch(`${base}/r/${pid}`)).status, 403);
  assert.equal(await (await fetch(`${base}/r/${pid}`, { headers: { 'X-Password': 'p' } })).text(), 'top');
  assert.equal((await fetch(`${base}/r/${pid}`, { headers: { 'X-Password': 'p' } })).status, 404);
});

test('rejects empty notes and path traversal', async () => {
  assert.equal((await post('/api/pastes', { content: '   ' })).status, 400);
  assert.equal((await fetch(`${base}/assets/..%2f..%2fserver.js`)).status, 404);
  assert.equal((await fetch(`${base}/api/pastes/..%2fx`)).status, 404);
});
