/**
 * MAL API module
 *
 * Endpoints used:
 *   GET  https://api.myanimelist.net/v2/anime?q=...
 *   GET  https://api.myanimelist.net/v2/anime/{id}?fields=my_list_status,...
 *   PUT  https://api.myanimelist.net/v2/anime/{id}/my_list_status
 *   POST https://myanimelist.net/v1/oauth2/token  (refresh)
 */

import fetch from 'node-fetch';
import { getTokens, setTokens } from './storage.js';

const API_BASE = 'https://api.myanimelist.net/v2/';

// ─── HTTP helpers ────────────────────────────────────────────────────────────

async function apiCall({ method = 'GET', path, fields = [], body = null }) {
  const tokens = await getTokens('mal');
  if (!tokens?.access_token) throw new Error('MAL: not authenticated — run the OAuth flow first');

  let url = API_BASE + path;
  if (fields.length) {
    url += (url.includes('?') ? '&' : '?') + `fields=${fields.join(',')}`;
  }

  const headers = {
    Authorization: `Bearer ${tokens.access_token}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };

  const res = await fetch(url, {
    method,
    headers,
    body: body ? new URLSearchParams(body).toString() : undefined,
  });

  if (res.status === 401) {
    // Try a token refresh then retry once
    const refreshed = await refreshToken();
    if (!refreshed) throw new Error('MAL: token refresh failed, re-authenticate');
    return apiCall({ method, path, fields, body });
  }

  if (res.status >= 500 || res.status === 0) {
    throw new Error(`MAL: server error ${res.status}`);
  }

  if (res.status === 404) {
    throw new Error(`MAL: entry not found (${path})`);
  }

  if (res.status === 204) return null; // DELETE returns no content

  const json = await res.json();

  if (json?.error) {
    throw new Error(`MAL API error: ${json.error} — ${json.message ?? ''}`);
  }

  return json;
}

// ─── Token refresh ───────────────────────────────────────────────────────────

async function refreshToken() {
  const tokens = await getTokens('mal');
  if (!tokens?.refresh_token) return false;

  const clientId = process.env.MAL_CLIENT_ID;
  if (!clientId) throw new Error('MAL_CLIENT_ID not set in environment');

  const res = await fetch('https://myanimelist.net/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
    }).toString(),
  });

  const json = await res.json();

  if (json?.access_token && json?.refresh_token) {
    await setTokens('mal', {
      access_token: json.access_token,
      refresh_token: json.refresh_token,
    });
    console.log('[MAL] Token refreshed successfully');
    return true;
  }

  console.error('[MAL] Token refresh failed:', json?.error, json?.message);
  return false;
}

// ─── Search ──────────────────────────────────────────────────────────────────

export async function searchAnime(keyword) {
  keyword = keyword.trim().substring(0, 64);
  if (keyword.length < 3) throw new Error('Search term must be at least 3 characters');

  const encoded = encodeURIComponent(keyword);
  const json = await apiCall({
    path: `anime?q=${encoded}&limit=15&nsfw=true`,
    fields: ['start_date', 'mean', 'alternative_titles', 'media_type', 'num_episodes', 'main_picture'],
  });

  return (json?.data ?? []).map(({ node }) => {
    const alt = [node.title];
    if (node.alternative_titles?.en) alt.push(node.alternative_titles.en);
    if (node.alternative_titles?.ja) alt.push(node.alternative_titles.ja);
    if (node.alternative_titles?.synonyms) alt.push(...node.alternative_titles.synonyms);

    return {
      id: node.id,
      name: node.title,
      altNames: alt,
      url: `https://myanimelist.net/anime/${node.id}`,
      score: node.mean,
      totalEp: node.num_episodes ?? 0,
      year: node.start_date ? parseInt(node.start_date.slice(0, 4), 10) : null,
      imageUrl: node.main_picture?.large ?? node.main_picture?.medium ?? null,
    };
  });
}

// ─── Get current progress ────────────────────────────────────────────────────

export async function getAnimeEntry(malId) {
  return apiCall({
    path: `anime/${malId}`,
    fields: [
      'my_list_status{num_watched_episodes,status,score,is_rewatching,num_times_rewatched,start_date,finish_date}',
      'num_episodes',
    ],
  });
}

// ─── Update progress ─────────────────────────────────────────────────────────

export async function updateAnimeProgress(malId, { episode, status = null, score = null }) {
  const body = {
    num_watched_episodes: String(episode),
  };

  if (status) body.status = status;           // watching / completed / on_hold / dropped / plan_to_watch
  if (score !== null) body.score = String(score);

  return apiCall({
    method: 'PUT',
    path: `anime/${malId}/my_list_status`,
    body,
  });
}
