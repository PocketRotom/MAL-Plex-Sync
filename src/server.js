/**
 * Express server — MALSync Plex Bridge
 *
 * Routes:
 *   POST /webhook/plex          ← Plex webhook receiver (multipart/form-data)
 *
 *   GET  /auth/mal              ← Start MAL OAuth flow (opens browser URL)
 *   GET  /auth/mal/callback     ← OAuth redirect URI registered with MAL
 *
 *   GET  /cache                 ← List cached title→id mappings
 *   DELETE /cache/:titleKey     ← Bust a single cache entry
 *   GET  /status                ← Health check + auth status
 */

import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import crypto from 'crypto';
import fetch from 'node-fetch';
import { handlePlexWebhook } from './plexHandler.js';
import { getAnimeEntry as malGetEntry } from './mal.js';
import { getTokens, setTokens, getAllCache, deleteCachedIds, getPending, deletePending, setCachedIds, getAllPending } from './storage.js';

const app = express();
const PORT = process.env.PORT ?? 8222;

// multer: Plex sends multipart/form-data with a `payload` text field and
// optionally a thumbnail file attachment. Use upload.any() to accept both,
// then only read req.body.payload (files are ignored).
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ─── Plex webhook ─────────────────────────────────────────────────────────────

app.post('/webhook/plex', upload.any(), handlePlexWebhook);

// ─── MAL OAuth ────────────────────────────────────────────────────────────────
// MAL uses PKCE (no client_secret needed for public clients).
// Flow:
//   1. GET /auth/mal        → redirects browser to MAL authorization page
//   2. User approves
//   3. MAL redirects back to GET /auth/mal/callback?code=...
//   4. Server exchanges code for tokens and stores them

// In-memory PKCE state (single-user; fine for a personal server)
let pkceState = null;

app.get('/auth/mal', (req, res) => {
  const clientId = process.env.MAL_CLIENT_ID;
  if (!clientId) return res.status(500).send('MAL_CLIENT_ID not set in .env');

  // Generate PKCE code verifier + challenge
  const verifier = crypto.randomBytes(48).toString('base64url');
  const state = crypto.randomBytes(16).toString('hex');
  // MAL uses plain code challenge method (not S256) for simplicity
  pkceState = { verifier, state };

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    code_challenge: verifier,        // plain method
    code_challenge_method: 'plain',
    state,
  });

  const authUrl = `https://myanimelist.net/v1/oauth2/authorize?${params}`;
  console.log('[MAL OAuth] Redirecting to:', authUrl);
  res.redirect(authUrl);
});

app.get('/auth/mal/callback', async (req, res) => {
  const { code, state } = req.query;
  const clientId = process.env.MAL_CLIENT_ID;

  if (!pkceState || state !== pkceState.state) {
    return res.status(400).send('Invalid OAuth state — try /auth/mal again');
  }

  try {
    const tokenRes = await fetch('https://myanimelist.net/v1/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        grant_type: 'authorization_code',
        code,
        code_verifier: pkceState.verifier,
      }).toString(),
    });

    const json = await tokenRes.json();

    if (!json.access_token) {
      console.error('[MAL OAuth] Token exchange failed:', json);
      return res.status(500).send(`Token exchange failed: ${JSON.stringify(json)}`);
    }

    await setTokens('mal', {
      access_token: json.access_token,
      refresh_token: json.refresh_token,
    });

    pkceState = null;
    console.log('[MAL OAuth] Tokens stored successfully');
    res.send('<h2>MAL authenticated ✓</h2><p>You can close this tab. The server is ready.</p>');
  } catch (err) {
    console.error('[MAL OAuth] Error:', err);
    res.status(500).send(`OAuth error: ${err.message}`);
  }
});

// ─── Cache management ─────────────────────────────────────────────────────────

app.get('/cache', async (req, res) => {
  const cache = await getAllCache();
  res.json(cache);
});

app.delete('/cache/:titleKey', async (req, res) => {
  await deleteCachedIds(decodeURIComponent(req.params.titleKey));
  res.json({ ok: true });
});

app.delete('/pending/:id', async (req, res) => {
  await deletePending(req.params.id);
  res.json({ ok: true });
});

app.put('/cache/:titleKey', async (req, res) => {
  const titleKey = decodeURIComponent(req.params.titleKey);
  const cache = await getAllCache();
  const existing = cache[titleKey];
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const raw = (req.body.malUrl ?? '').trim();
  const malIdMatch = raw.match(/(\d+)/);
  if (!malIdMatch) return res.status(400).json({ error: 'Invalid MAL URL or ID' });
  const malId = parseInt(malIdMatch[1], 10);

  let malName = `MAL #${malId}`;
  try {
    const entry = await malGetEntry(malId);
    if (entry?.title) malName = entry.title;
  } catch { /* non-fatal */ }

  await setCachedIds(titleKey, { ...existing, malId, malName });
  res.json({ ok: true, malId, malName });
});

// ─── Manual resolution page ───────────────────────────────────────────────────
// When a Plex scrobble can't be matched automatically, a pending entry is
// created and a Discord notification is sent with a link to this page.

app.get('/resolve/:id', async (req, res) => {
  const pending = await getPending(req.params.id);
  if (!pending) return res.status(404).send('<h2>Not found or already resolved.</h2>');

  const label = pending.year ? `${pending.title} (${pending.year})` : pending.title;
  const malSearch = `https://myanimelist.net/anime.php?q=${encodeURIComponent(pending.title)}&cat=anime`;

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Resolve: ${label}</title>
  <style>
    body { font-family: sans-serif; max-width: 600px; margin: 40px auto; padding: 0 16px; }
    input { width: 100%; padding: 8px; font-size: 1rem; box-sizing: border-box; }
    button { margin-top: 12px; padding: 10px 24px; font-size: 1rem; cursor: pointer; background: #2e51a2; color: white; border: none; border-radius: 4px; }
    .hint { color: #666; font-size: 0.9rem; margin-top: 6px; }
    .ep { font-weight: bold; }
  </style>
</head>
<body>
  <h2>Unresolved: ${label}</h2>
  <p>Episode <span class="ep">${pending.episode}</span> was scrobbled but no MAL match was found.</p>
  <p><a href="${malSearch}" target="_blank">Search MAL for "${pending.title}"</a></p>
  <form method="POST" action="/resolve/${pending.id}">
    <label for="malUrl"><strong>MAL URL or ID</strong></label><br>
    <input type="text" id="malUrl" name="malUrl"
      placeholder="https://myanimelist.net/anime/12345  or just  12345" required>
    <p class="hint">Find the anime on MAL and paste the URL or just the numeric ID.</p>
    <button type="submit">Save &amp; update progress</button>
  </form>
</body>
</html>`);
});

app.post('/resolve/:id', async (req, res) => {
  const isJson = req.headers['content-type']?.includes('application/json');
  const pending = await getPending(req.params.id);
  if (!pending) {
    return isJson
      ? res.status(404).json({ error: 'Not found or already resolved.' })
      : res.status(404).send('<h2>Not found or already resolved.</h2>');
  }

  const raw = (req.body.malUrl ?? '').trim();
  // Accept full URL or bare numeric ID
  const malIdMatch = raw.match(/(\d+)/);
  if (!malIdMatch) {
    return isJson
      ? res.status(400).json({ error: 'Invalid MAL URL or ID.' })
      : res.status(400).send('<h2>Invalid MAL URL or ID.</h2>');
  }
  const malId = parseInt(malIdMatch[1], 10);

  // Fetch the real MAL title so the matches page shows something meaningful
  let malName = `MAL #${malId}`;
  try {
    const entry = await malGetEntry(malId);
    if (entry?.title) malName = entry.title;
  } catch { /* non-fatal, fallback to MAL #id */ }

  await setCachedIds(pending.cacheKey, { malId, malName, plexTitle: pending.title, year: pending.year, cachedAt: Date.now() });
  await deletePending(pending.id);

  const label = pending.year ? `${pending.title} (${pending.year})` : pending.title;
  console.log(`[resolve] manually resolved "${label}" → MAL id ${malId}`);

  if (isJson) return res.json({ ok: true, malId, malName });

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Resolved</title>
  <style>body { font-family: sans-serif; max-width: 600px; margin: 40px auto; padding: 0 16px; }</style>
</head>
<body>
  <h2>✅ Resolved</h2>
  <p><strong>${label}</strong> mapped to <a href="https://myanimelist.net/anime/${malId}" target="_blank">MAL #${malId}</a>.</p>
  <p>Future scrobbles will use this mapping. The episode counter will be updated automatically on next scrobble.</p>
</body>
</html>`);
});

// ─── Matches page ─────────────────────────────────────────────────────────────

app.get('/', async (req, res) => {
  const [cache, pending] = await Promise.all([getAllCache(), getAllPending()]);

  const entries = Object.entries(cache)
    .filter(([, e]) => e.malId)
    .sort(([, a], [, b]) => (a.plexTitle ?? '').localeCompare(b.plexTitle ?? ''));

  const pendingEntries = Object.values(pending)
    .sort((a, b) => b.createdAt - a.createdAt);

  const rows = entries.map(([key, e]) => {
    const plexLabel = (e.plexTitle ?? '—').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const malName = (e.malName ?? `MAL #${e.malId}`).replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const malUrl = `https://myanimelist.net/anime/${e.malId}`;
    const age = e.cachedAt ? Math.floor((Date.now() - e.cachedAt) / 86400000) : '?';
    const safeKey = encodeURIComponent(key);
    return `<tr id="row-${safeKey}">
      <td>${plexLabel}</td>
      <td class="mal-name"><a href="${malUrl}" target="_blank">${malName}</a></td>
      <td><a href="${malUrl}" target="_blank" style="font-size:0.8rem;color:#888;word-break:break-all">${malUrl}</a></td>
      <td style="white-space:nowrap;color:#999;font-size:0.8rem">${age === 0 ? 'Today' : age + ' days ago'}</td>
      <td class="actions">
        <button class="btn-edit" onclick="startEdit('${safeKey}','${e.malId}')">Edit</button>
        <button class="btn-delete" onclick="deleteEntry('${safeKey}', this)">Delete</button>
      </td>
    </tr>
    <tr id="edit-${safeKey}" style="display:none">
      <td colspan="5">
        <form onsubmit="submitEdit(event,'${safeKey}')">
          <input type="text" id="input-${safeKey}" placeholder="MAL URL or numeric ID" style="width:360px;padding:6px;font-size:0.9rem">
          <button type="submit" class="btn-save">Save</button>
          <button type="button" onclick="cancelEdit('${safeKey}')" class="btn-cancel">Cancel</button>
        </form>
      </td>
    </tr>`;
  }).join('\n');

  const pendingRows = pendingEntries.map(p => {
    const label = p.title;
    const malSearch = `https://myanimelist.net/anime.php?q=${encodeURIComponent(p.title)}&cat=anime`;
    const age = p.createdAt ? Math.floor((Date.now() - p.createdAt) / 86400000) : '?';
    return `<tr id="prow-${p.id}">
      <td>${label}</td>
      <td style="white-space:nowrap;color:#999;font-size:0.8rem">Episode ${p.episode}</td>
      <td style="white-space:nowrap;color:#999;font-size:0.8rem">${age === 0 ? 'Today' : age + ' days ago'}</td>
      <td class="actions">
        <button class="btn-edit" onclick="startResolve('${p.id}')">Resolve</button>
        <button class="btn-delete" onclick="dismissPending('${p.id}', this)">Dismiss</button>
      </td>
    </tr>
    <tr id="pedit-${p.id}" style="display:none">
      <td colspan="4" style="background:#fff8f0;padding:10px">
        <a href="${malSearch}" target="_blank" style="font-size:0.85rem">Search MAL for "${p.title.replace(/</g, '&lt;').replace(/>/g, '&gt;')}"</a><br><br>
        <form onsubmit="submitResolve(event,'${p.id}')">
          <input type="text" id="pinput-${p.id}" placeholder="MAL URL or numeric ID" style="width:360px;padding:6px;font-size:0.9rem">
          <button type="submit" class="btn-save">Save</button>
          <button type="button" onclick="cancelResolve('${p.id}')" class="btn-cancel">Cancel</button>
        </form>
      </td>
    </tr>`;
  }).join('\n');

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MALSync Plex Bridge — Matches</title>
  <style>
    body { font-family: sans-serif; max-width: 1100px; margin: 40px auto; padding: 0 16px; }
    h2 { margin-bottom: 4px; }
    h3 { margin: 32px 0 4px; }
    p.sub { color: #666; margin-top: 0; font-size: 0.9rem; }
    table { width: 100%; border-collapse: collapse; margin-top: 16px; }
    th { text-align: left; border-bottom: 2px solid #ccc; padding: 8px 10px; background: #f4f4f4; }
    td { padding: 8px 10px; border-bottom: 1px solid #eee; vertical-align: middle; }
    tr:hover td { background: #f9f9f9; }
    a { color: #2e51a2; }
    .actions { white-space: nowrap; }
    button { padding: 4px 10px; font-size: 0.82rem; cursor: pointer; border: none; border-radius: 4px; }
    .btn-edit   { background: #e8eef7; color: #2e51a2; }
    .btn-delete { background: #fdecea; color: #c0392b; margin-left: 4px; }
    .btn-save   { background: #2e51a2; color: white; margin-left: 6px; }
    .btn-cancel { background: #eee; color: #333; margin-left: 4px; }
    tr[id^="edit-"] td, tr[id^="pedit-"] td { background: #f0f4ff; padding: 10px; }
    .badge-unresolved { display:inline-block; background:#f5a623; color:white; border-radius:10px; padding:1px 8px; font-size:0.78rem; margin-left:6px; vertical-align:middle; }
  </style>
</head>
<body>
  <h2>Cached Matches</h2>
  <p class="sub">${entries.length} title${entries.length !== 1 ? 's' : ''} resolved.</p>
  ${entries.length === 0
    ? '<p>No matches cached yet.</p>'
    : `<table>
    <thead><tr><th>Plex title</th><th>MAL title</th><th>MAL URL</th><th>Cached</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`}

  <h3>Unresolved <span class="badge-unresolved">${pendingEntries.length}</span></h3>
  <p class="sub">Titles that could not be auto-matched. Resolve them by providing the correct MAL URL or ID.</p>
  ${pendingEntries.length === 0
    ? '<p style="color:#888">No unresolved titles.</p>'
    : `<table>
    <thead><tr><th>Plex title</th><th>Episode</th><th>Received</th><th></th></tr></thead>
    <tbody>${pendingRows}</tbody>
  </table>`}

<script>
// ── Resolved matches ──────────────────────────────────────────────────────────
function startEdit(key, currentId) {
  document.getElementById('edit-' + key).style.display = '';
  const input = document.getElementById('input-' + key);
  input.value = currentId;
  input.focus();
  input.select();
}
function cancelEdit(key) {
  document.getElementById('edit-' + key).style.display = 'none';
}
async function submitEdit(e, key) {
  e.preventDefault();
  const val = document.getElementById('input-' + key).value.trim();
  const btn = e.target.querySelector('.btn-save');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const res = await fetch('/cache/' + key, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ malUrl: val })
    });
    const json = await res.json();
    if (!res.ok) { alert(json.error ?? 'Error'); btn.disabled = false; btn.textContent = 'Save'; return; }
    const row = document.getElementById('row-' + key);
    const malUrl = 'https://myanimelist.net/anime/' + json.malId;
    row.querySelector('.mal-name').innerHTML = '<a href="' + malUrl + '" target="_blank">' + json.malName + '</a>';
    row.cells[2].innerHTML = '<a href="' + malUrl + '" target="_blank" style="font-size:0.8rem;color:#888;word-break:break-all">' + malUrl + '</a>';
    document.getElementById('edit-' + key).style.display = 'none';
  } catch(err) { alert('Request failed: ' + err.message); btn.disabled = false; btn.textContent = 'Save'; }
}
async function deleteEntry(key, btn) {
  if (!confirm('Delete this cached mapping?')) return;
  btn.disabled = true;
  try {
    await fetch('/cache/' + key, { method: 'DELETE' });
    document.getElementById('row-' + key).remove();
    document.getElementById('edit-' + key).remove();
  } catch(err) { alert('Delete failed: ' + err.message); btn.disabled = false; }
}

// ── Unresolved / pending ──────────────────────────────────────────────────────
function startResolve(id) {
  document.getElementById('pedit-' + id).style.display = '';
  const input = document.getElementById('pinput-' + id);
  input.focus();
}
function cancelResolve(id) {
  document.getElementById('pedit-' + id).style.display = 'none';
}
async function submitResolve(e, id) {
  e.preventDefault();
  const val = document.getElementById('pinput-' + id).value.trim();
  const btn = e.target.querySelector('.btn-save');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const res = await fetch('/resolve/' + id, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ malUrl: val })
    });
    const json = await res.json();
    if (!res.ok) { alert(json.error ?? 'Error'); btn.disabled = false; btn.textContent = 'Save'; return; }
    document.getElementById('prow-' + id).remove();
    document.getElementById('pedit-' + id).remove();
    // Reload to show new entry in resolved table
    window.location.reload();
  } catch(err) { alert('Request failed: ' + err.message); btn.disabled = false; btn.textContent = 'Save'; }
}
async function dismissPending(id, btn) {
  if (!confirm('Dismiss this unresolved entry?')) return;
  btn.disabled = true;
  try {
    await fetch('/pending/' + id, { method: 'DELETE' });
    document.getElementById('prow-' + id).remove();
    document.getElementById('pedit-' + id).remove();
  } catch(err) { alert('Failed: ' + err.message); btn.disabled = false; }
}
</script>
</body>
</html>`);
});

// ─── Status / health check ────────────────────────────────────────────────────

app.get('/status', async (req, res) => {
  const malTokens = await getTokens('mal');

  res.json({
    status: 'ok',
    auth: {
      mal: malTokens ? 'authenticated' : 'not authenticated — visit /auth/mal',
    },
    plexEvents: (process.env.PLEX_EVENTS ?? 'media.scrobble').split(',').map(s => s.trim()),
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n  MALSync Plex Bridge running on http://localhost:${PORT}`);
  console.log(`  POST http://localhost:${PORT}/webhook/plex  ← configure this in Plex`);
  console.log(`  GET  http://localhost:${PORT}/status`);
  console.log(`  GET  http://localhost:${PORT}/                 ← view cached matches and unresolved entries`);
  console.log(`  GET  http://localhost:${PORT}/auth/mal      ← run once to authenticate\n`);
});
