/**
 * JSON-file persistence layer
 *
 * Files written under _node/data/:
 *   tokens.json   — OAuth tokens keyed by provider ('mal')
 *   cache.json    — Title → { malId } lookup cache
 *
 * All reads/writes are atomic: we read the full file, mutate in memory, write back.
 */

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

const TOKENS_FILE = path.join(DATA_DIR, 'tokens.json');
const CACHE_FILE = path.join(DATA_DIR, 'cache.json');

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readJson(file, fallback = {}) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJson(file, data) {
  await ensureDataDir();
  await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
}

// ─── Tokens ──────────────────────────────────────────────────────────────────

/**
 * @param {'mal'} provider
 * @returns {{ access_token: string, refresh_token?: string } | null}
 */
export async function getTokens(provider) {
  const all = await readJson(TOKENS_FILE);
  return all[provider] ?? null;
}

/**
 * @param {'mal'} provider
 * @param {{ access_token: string, refresh_token?: string }} tokens
 */
export async function setTokens(provider, tokens) {
  const all = await readJson(TOKENS_FILE);
  all[provider] = tokens;
  await writeJson(TOKENS_FILE, all);
}

// ─── Title cache ─────────────────────────────────────────────────────────────
// Cached entries: { malId, cachedAt }
// No TTL — entries persist until manually deleted.

/**
 * @param {string} titleKey  normalised title string used as cache key
 */
export async function getCachedIds(titleKey) {
  const cache = await readJson(CACHE_FILE);
  const entry = cache[titleKey];
  if (!entry) return null;
  return entry;
}

/**
 * @param {string} titleKey
 * @param {{ malId: number|null }} ids
 */
export async function setCachedIds(titleKey, ids) {
  const cache = await readJson(CACHE_FILE);
  cache[titleKey] = { ...ids, cachedAt: Date.now() };
  await writeJson(CACHE_FILE, cache);
}

/**
 * Dump the whole cache — useful for the /cache debug endpoint.
 */
export async function getAllCache() {
  return readJson(CACHE_FILE);
}

/**
 * Delete a single cache entry by title key so a fresh lookup is forced.
 * @param {string} titleKey
 */
export async function deleteCachedIds(titleKey) {
  const cache = await readJson(CACHE_FILE);
  delete cache[titleKey];
  await writeJson(CACHE_FILE, cache);
}

// ─── Pending resolutions ──────────────────────────────────────────────────────
// When no confident match is found, we store a pending entry that the user
// can resolve via the /resolve/:id web page.

const PENDING_FILE = path.join(DATA_DIR, 'pending.json');

export async function createPending({ title, year, cacheKey, episode }) {
  const pending = await readJson(PENDING_FILE, {});
  const id = crypto.randomBytes(6).toString('hex');
  pending[id] = { id, title, year, cacheKey, episode, createdAt: Date.now() };
  await writeJson(PENDING_FILE, pending);
  return id;
}

export async function getPending(id) {
  const pending = await readJson(PENDING_FILE, {});
  return pending[id] ?? null;
}

export async function getAllPending() {
  return readJson(PENDING_FILE, {});
}

export async function deletePending(id) {
  const pending = await readJson(PENDING_FILE, {});
  delete pending[id];
  await writeJson(PENDING_FILE, pending);
}
