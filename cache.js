"use strict";

// Persistent cache layer backed by browser.storage.local.
// Stores combined extraction results keyed by message ID.
//
// Storage layout:
//   Key "_bgCacheIndex" → { entries: { [messageId]: { ts, status } } }
//   Key "cache_<msgId>" → { version: 1, ts, raw: <combined extraction JSON> }

const CACHE_VERSION = 1;
const CACHE_INDEX_KEY = "_bgCacheIndex";

async function _getCacheIndex() {
  const result = await browser.storage.local.get({ [CACHE_INDEX_KEY]: { entries: {} } });
  return result[CACHE_INDEX_KEY];
}

async function _setCacheIndex(index) {
  await browser.storage.local.set({ [CACHE_INDEX_KEY]: index });
}

async function cacheGet(messageId) {
  const key = "cache_" + messageId;
  const result = await browser.storage.local.get({ [key]: null });
  const entry = result[key];
  if (!entry || entry.version !== CACHE_VERSION) return null;
  return entry;
}

async function cacheSet(messageId, data) {
  const key = "cache_" + messageId;
  const entry = {
    version: CACHE_VERSION,
    ts: Date.now(),
    raw: data,
  };
  await browser.storage.local.set({ [key]: entry });

  // Update index
  const index = await _getCacheIndex();
  index.entries[messageId] = { ts: entry.ts, status: "ok" };
  await _setCacheIndex(index);
}

async function cacheHas(messageId) {
  const key = "cache_" + messageId;
  const result = await browser.storage.local.get({ [key]: null });
  return !!(result[key] && result[key].version === CACHE_VERSION);
}

async function cacheDelete(messageId) {
  const key = "cache_" + messageId;
  await browser.storage.local.remove(key);

  const index = await _getCacheIndex();
  delete index.entries[messageId];
  await _setCacheIndex(index);
}

async function cacheSetError(messageId) {
  const index = await _getCacheIndex();
  index.entries[messageId] = { ts: Date.now(), status: "error" };
  await _setCacheIndex(index);
}

async function cacheCleanup(maxAgeMs) {
  const index = await _getCacheIndex();
  const now = Date.now();
  const keysToRemove = [];
  const idsToRemove = [];

  for (const [msgId, meta] of Object.entries(index.entries)) {
    if (now - meta.ts > maxAgeMs) {
      keysToRemove.push("cache_" + msgId);
      idsToRemove.push(msgId);
    }
  }

  if (keysToRemove.length > 0) {
    await browser.storage.local.remove(keysToRemove);
    for (const id of idsToRemove) {
      delete index.entries[id];
    }
    await _setCacheIndex(index);
  }

  return idsToRemove.length;
}

// Remove cache entries whose source message no longer exists.
async function cacheCleanupOrphans() {
  const index = await _getCacheIndex();
  const keysToRemove = [];
  const idsToRemove = [];

  for (const msgId of Object.keys(index.entries)) {
    try {
      await browser.messages.get(Number(msgId));
    } catch {
      // Message no longer exists
      keysToRemove.push("cache_" + msgId);
      idsToRemove.push(msgId);
    }
  }

  if (keysToRemove.length > 0) {
    await browser.storage.local.remove(keysToRemove);
    for (const id of idsToRemove) {
      delete index.entries[id];
    }
    await _setCacheIndex(index);
  }

  return idsToRemove.length;
}

async function cacheClearAll() {
  const index = await _getCacheIndex();
  const keys = Object.keys(index.entries).map(id => "cache_" + id);
  const count = keys.length;
  if (keys.length > 0) {
    await browser.storage.local.remove(keys);
  }
  await _setCacheIndex({ entries: {} });
  return count;
}

async function cacheGetStats() {
  const index = await _getCacheIndex();
  const entries = Object.values(index.entries);
  const count = entries.filter(e => e.status === "ok").length;
  const errorCount = entries.filter(e => e.status === "error").length;
  // Rough estimate: ~3KB per cached email
  const sizeEstimate = count * 3 * 1024;
  return { count, errorCount, sizeEstimate };
}
