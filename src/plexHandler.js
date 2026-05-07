/**
 * Plex webhook handler
 *
 * Plex sends a multipart/form-data POST with a single field named "payload"
 * that contains a JSON string.  The relevant fields:
 *
 *   event                     — "media.scrobble" fires at ~90 % watched
 *                               "media.stop", "media.pause", "media.play" also available
 *   Metadata.type             — "episode" | "movie" | ...
 *   Metadata.grandparentTitle — show title (each season is its own show in Plex)
 *   Metadata.index            — episode number within the show
 *
 * Since each season is a separate show in Plex, Metadata.index already matches
 * the episode number on MAL for that entry.
 */

import { searchAnime as malSearch, getAnimeEntry as malGetEntry, updateAnimeProgress as malUpdate } from './mal.js';
import { getCachedIds, setCachedIds, createPending } from './storage.js';
import { compareTwoStrings } from 'string-similarity';
import fetch from 'node-fetch';

// ─── Parse title and extract optional year from Plex metadata ────────────────
// Plex often appends the year and wraps titles in smart quotes, e.g.:
//   "Oshi no Ko" (2026)  →  { title: 'Oshi no Ko', year: 2026 }

function parseTitle(str) {
  // Normalise smart/curly quotes to straight ones first
  str = str
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"');

  // Extract trailing (year) if present
  const yearMatch = str.match(/\s*\((\d{4})\)\s*$/);
  const year = yearMatch ? parseInt(yearMatch[1], 10) : null;

  // Strip year and surrounding straight quotes
  const title = str
    .replace(/\s*\(\d{4}\)\s*$/, '')
    .replace(/^["']+|["']+$/g, '')
    .trim();

  return { title, year };
}

// ─── Normalise a title for use as a cache key ─────────────────────────────────

function normalise(str) {
  return str.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
}

// ─── Resolve series title → { malId } ──────────────────────────────────────
// Results are cached in data/cache.json to avoid hammering the APIs on every
// scrobble of the same show.

async function resolveIds(seriesTitle, year = null, rawPlexTitle = null) {
  const key = normalise(seriesTitle) + (year ? `_${year}` : '');
  const cached = await getCachedIds(key);
  if (cached) {
    console.log(`[resolve] cache hit for "${seriesTitle}"${year ? ` (${year})` : ''}`);
    return cached;
  }

  console.log(`[resolve] searching for "${seriesTitle}"${year ? ` (${year})` : ''} …`);

  const plexTitle = rawPlexTitle ?? seriesTitle;

  // Score each result by title similarity (checking all alt titles) + year bonus.
  // Rejects anything below 0.4 similarity to avoid accepting garbage matches.
  function bestMatch(results) {
    if (results.length === 0) return null;
    const normSearch = seriesTitle.toLowerCase();
    let best = null;
    let bestScore = -1;
    for (const r of results) {
      const titles = [r.name, ...(r.altNames ?? [])].filter(Boolean);
      const sim = Math.max(...titles.map(t => compareTwoStrings(normSearch, t.toLowerCase())));
      const yearBonus = (year && r.year === year) ? 0.2 : 0;
      const score = sim + yearBonus;
      if (score > bestScore) { bestScore = score; best = r; }
    }
    // If a year was provided, only accept results that match it exactly
    if (year && best?.year !== year) {
      console.warn(`[resolve] year mismatch for "${seriesTitle}" — wanted ${year}, best match "${best?.name}" is ${best?.year}`);
      return null;
    }
    // Require at least 0.4 base similarity
    const baseSim = bestScore - ((year && best?.year === year) ? 0.2 : 0);
    if (baseSim < 0.4) {
      console.warn(`[resolve] no confident match for "${seriesTitle}" (best sim=${baseSim.toFixed(2)}: "${best?.name}")`);
      return null;
    }
    return best;
  }

  let malId = null;
  let malName = null;
  let imageUrl = null;

  try {
    const results = await malSearch(seriesTitle);
    const match = bestMatch(results);
    if (match) {
      malId = match.id;
      malName = match.name;
      imageUrl = match.imageUrl ?? null;
      console.log(`[resolve] MAL match: "${match.name}" (id=${malId}, year=${match.year})`);
    }
  } catch (err) {
    console.error('[resolve] MAL search failed:', err.message);
  }

  const ids = { malId, malName, plexTitle, year, imageUrl };
  await setCachedIds(key, ids);
  if (malId) {
    await notifyResolved({ seriesTitle, plexTitle, year, malId, malName, imageUrl });
  }
  return ids;
}

// ─── Discord notification for resolved (auto-matched) titles ─────────────────

async function notifyResolved({ seriesTitle, plexTitle, year, malId, malName, imageUrl }) { // eslint-disable-line no-unused-vars
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return;

  const label = plexTitle ?? (year ? `${seriesTitle} (${year})` : seriesTitle);
  const malUrl = malId ? `https://myanimelist.net/anime/${malId}` : null;
  const title = malName ?? (malId ? `MAL #${malId}` : 'Unknown');

  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          title: `✅ New match cached`,
          description: `**${label}** → [${title}](${malUrl ?? '#'})`,
          color: 0x2e51a2,
          thumbnail: imageUrl ? { url: imageUrl } : undefined,
          fields: malUrl ? [{ name: 'MAL URL', value: malUrl, inline: false }] : [],
        }],
      }),
    });
  } catch (err) {
    console.error('[discord] notifyResolved failed:', err.message);
  }
}

// ─── Discord notification for unresolved titles ───────────────────────────────

async function notifyUnresolved({ seriesTitle, rawTitle, year, episodeNumber }) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return;

  const cacheKey = seriesTitle.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim()
    + (year ? `_${year}` : '');

  const pendingId = await createPending({
    title: rawTitle ?? seriesTitle,
    year,
    cacheKey,
    episode: episodeNumber,
  });

  const baseUrl = process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
  const resolveUrl = `${baseUrl}/resolve/${pendingId}`;

  const label = year ? `${seriesTitle} (${year})` : seriesTitle;

  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          title: `❓ Unresolved: ${label}`,
          description: `Could not find a confident MAL match for **${label}** — ep **${episodeNumber}**.\n\n[Click here to manually set the MAL URL](${resolveUrl})`,
          color: 0xf5a623,
          footer: { text: `Pending ID: ${pendingId}` },
        }],
      }),
    });
    console.log(`[discord] notified — resolve at ${resolveUrl}`);
  } catch (err) {
    console.error('[discord] notification failed:', err.message);
  }
}

// ─── Main webhook handler ─────────────────────────────────────────────────────

export async function handlePlexWebhook(req, res) {
  // multer places the text field on req.body.payload
  let payload;
  try {
    payload = JSON.parse(req.body.payload);
  } catch {
    return res.status(400).json({ error: 'Invalid payload JSON' });
  }

  const event = payload.event;
  const meta = payload.Metadata ?? {};

  console.log(`[plex] event="${event}" type="${meta.type}" title="${meta.grandparentTitle ?? meta.title}"`);

  // Only act on scrobbles of TV episodes
  const allowedEvents = (process.env.PLEX_EVENTS ?? 'media.scrobble').split(',').map(s => s.trim());
  if (!allowedEvents.includes(event)) {
    return res.json({ ignored: true, reason: `event "${event}" not in PLEX_EVENTS` });
  }

  if (meta.type !== 'episode') {
    return res.json({ ignored: true, reason: `media type "${meta.type}" is not episode` });
  }

  // Extract title and episode number.
  // Each season is its own show in Plex, so grandparentTitle is the show title
  // and index is already the correct episode number for the MAL entry.
  const rawTitle = meta.grandparentTitle ?? meta.parentTitle ?? meta.title;
  const { title: seriesTitle, year } = parseTitle(rawTitle ?? '');
  const episodeNumber = parseInt(meta.index ?? '0', 10);

  if (!seriesTitle || !episodeNumber) {
    return res.status(422).json({ error: 'Could not extract series title or episode number' });
  }

  if (rawTitle !== seriesTitle) {
    console.log(`[plex] title cleaned: "${rawTitle}" → "${seriesTitle}"${year ? ` (year=${year})` : ''}`);
  }
  console.log(`[plex] "${seriesTitle}" ep ${episodeNumber}`);

  const { malId } = await resolveIds(seriesTitle, year, rawTitle);

  if (!malId) {
    const msg = `Could not find "${seriesTitle}" on MAL`;
    console.warn('[plex]', msg);
    await notifyUnresolved({ seriesTitle, rawTitle, year, episodeNumber });
    return res.status(404).json({ error: msg });
  }

  const results = {};

  // ── Update MAL ──────────────────────────────────────────────────────────────
  try {
    const entry = await malGetEntry(malId);
    const currentEp = entry?.my_list_status?.num_watched_episodes ?? 0;
    if (episodeNumber <= currentEp) {
      console.log(`[MAL] skipping anime/${malId}: already at ep ${currentEp}, got ep ${episodeNumber}`);
      results.mal = { id: malId, skipped: true, currentEpisode: currentEp, incomingEpisode: episodeNumber };
    } else {
      const updated = await malUpdate(malId, { episode: episodeNumber });
      results.mal = { id: malId, episode: episodeNumber, response: updated };
      console.log(`[MAL] updated anime/${malId}: ep ${currentEp} → ep ${episodeNumber}`);
    }
  } catch (err) {
    console.error('[MAL] update failed:', err.message);
    results.mal = { error: err.message };
  }

  return res.json({ title: seriesTitle, episode: episodeNumber, results });
}
