"use strict";

// Background email processor — automatically extracts data from incoming
// emails using a single combined Ollama call, caching results for instant
// display when the user opens Auto Analyze.
//
// Depends on: config.js (DEFAULTS), utils.js, cache.js — all loaded before
// this script in the manifest.

const BG_PROCESSOR_DELAY_MS = 2000;       // pause between background calls
const BG_RETRY_DELAY_MS     = 30000;      // retry delay when Ollama is down
const BG_MIN_EMAIL_LENGTH   = 20;         // skip very short emails
const BG_MAX_BODY_LENGTH    = 12000;      // truncate body for combined prompt
const BG_BACKFILL_DAYS      = 1;          // how many days back to look on startup

const BG_LOG_PREFIX = "[ThunderClerk-AI BG]";

// --- Queue state ---

const bgQueue = [];                       // array of { messageId, force }
let bgProcessing = false;                 // currently running an extraction
let bgPaused = false;                     // paused (Ollama unreachable, etc.)
let bgEnabled = false;                    // user setting
let manualActionInFlight = false;         // a manual menu action is running
let bgProcessedCount = 0;                 // session counter
let bgErrorCount = 0;                     // session counter

// --- Public API for background.js ---

function bgProcessorSetManualFlag(active) {
  manualActionInFlight = active;
  if (active) {
    console.log(BG_LOG_PREFIX, "Manual action started — background processing paused");
  } else {
    console.log(BG_LOG_PREFIX, "Manual action finished — background processing resumed");
    scheduleNext();
  }
}

function bgProcessorGetStatus() {
  return {
    enabled: bgEnabled,
    queueLength: bgQueue.length,
    processing: bgProcessing,
    paused: bgPaused,
    processedCount: bgProcessedCount,
    errorCount: bgErrorCount,
  };
}

function bgProcessorStop() {
  bgEnabled = false;
  console.log(BG_LOG_PREFIX, `Stopped — ${bgQueue.length} items still in queue (will not be processed until started)`);
}

function bgProcessorStart() {
  bgEnabled = true;
  bgPaused = false;
  console.log(BG_LOG_PREFIX, `Started — ${bgQueue.length} items in queue`);
  if (bgQueue.length > 0) {
    scheduleNext();
  } else {
    // Backfill since we're starting fresh
    bgBackfill();
  }
}

function bgProcessorEnqueue(messageId, force = false) {
  // Avoid duplicates
  if (!force && bgQueue.some(item => item.messageId === messageId)) return;
  bgQueue.push({ messageId, force });
  console.log(BG_LOG_PREFIX, `Enqueued message ${messageId}${force ? " (force)" : ""} — queue length: ${bgQueue.length}`);
  scheduleNext();
}

// --- Internal processing loop ---

function scheduleNext() {
  if (bgProcessing || bgPaused || !bgEnabled || bgQueue.length === 0) return;
  setTimeout(() => processNextInQueue(), BG_PROCESSOR_DELAY_MS);
}

async function processNextInQueue() {
  if (bgProcessing || bgPaused || !bgEnabled || bgQueue.length === 0) return;
  if (manualActionInFlight) {
    console.log(BG_LOG_PREFIX, "Waiting for manual action to finish…");
    setTimeout(() => processNextInQueue(), 1000);
    return;
  }

  bgProcessing = true;
  const item = bgQueue.shift();
  const startTime = Date.now();

  try {
    // Check cache first (skip if already done, unless force)
    if (!item.force && await cacheHas(item.messageId)) {
      console.log(BG_LOG_PREFIX, `Skipping message ${item.messageId} — already cached (${bgQueue.length} remaining)`);
      bgProcessing = false;
      scheduleNext();
      return;
    }

    // Load settings
    const settings = await browser.storage.sync.get(DEFAULTS);
    const host  = settings.ollamaHost  || "http://127.0.0.1:11434";
    const model = settings.ollamaModel || DEFAULTS.ollamaModel;

    // Get message data
    let message;
    try {
      message = await browser.messages.get(item.messageId);
    } catch {
      console.warn(BG_LOG_PREFIX, `Message ${item.messageId} no longer exists — skipping (${bgQueue.length} remaining)`);
      bgProcessing = false;
      scheduleNext();
      return;
    }

    const subject = message.subject || "(no subject)";
    console.log(BG_LOG_PREFIX, `Processing message ${item.messageId}: "${subject.slice(0, 80)}" (${bgQueue.length} remaining)`);

    // Get email body
    let emailBody = "";
    try {
      const full = await browser.messages.getFull(item.messageId);
      emailBody = extractTextBody(full);
    } catch (e) {
      console.warn(BG_LOG_PREFIX, `Could not read body for message ${item.messageId}: ${e.message} — skipping`);
      bgProcessing = false;
      scheduleNext();
      return;
    }

    // Skip very short emails
    if (!emailBody || emailBody.length < BG_MIN_EMAIL_LENGTH) {
      console.log(BG_LOG_PREFIX, `Message ${item.messageId} body too short (${emailBody?.length || 0} chars) — caching as empty`);
      await cacheSet(item.messageId, { summary: "(email too short to analyze)", events: [], tasks: [], contacts: [], tags: [], reply: "", forwardSummary: "" });
      bgProcessing = false;
      scheduleNext();
      return;
    }

    // Truncate if needed
    let analysisBody = emailBody;
    const wasTruncated = analysisBody.length > BG_MAX_BODY_LENGTH;
    if (wasTruncated) {
      analysisBody = analysisBody.slice(0, BG_MAX_BODY_LENGTH) +
        "\n\n[… email truncated — there may be additional items beyond this point]";
    }
    console.log(BG_LOG_PREFIX, `  Body: ${emailBody.length} chars${wasTruncated ? ` (truncated to ${BG_MAX_BODY_LENGTH})` : ""}`);

    const author       = message.author || "";
    const mailDatetime = formatDatetime(message.date);
    const currentDt    = currentDatetime();

    // Always extract maximally — settings applied at display time
    const attendeeHints = buildAttendeesHint(message, "from_to", "");

    let categories = null;
    try {
      categories = await browser.CalendarTools.getCategories();
    } catch {}

    let existingTags = [];
    try {
      const tags = await browser.messages.tags.list();
      existingTags = tags.map(t => t.tag);
    } catch {}

    const prompt = buildCombinedExtractionPrompt(
      analysisBody, subject, author, mailDatetime, currentDt,
      attendeeHints, categories, existingTags
    );
    console.log(BG_LOG_PREFIX, `  Prompt: ${prompt.length} chars — calling ${model}…`);

    // Call Ollama
    const ollamaOpts = {
      num_ctx: Math.max(settings.numCtx || 0, 16384),
      num_predict: Math.max(settings.numPredict || 0, 16384),
    };

    const ollamaStartTime = Date.now();
    let rawResponse;
    try {
      rawResponse = await callOllama(host, model, prompt, ollamaOpts);
    } catch (e) {
      const elapsed = ((Date.now() - ollamaStartTime) / 1000).toFixed(1);
      console.warn(BG_LOG_PREFIX, `  Ollama error after ${elapsed}s: ${e.message}`);
      console.warn(BG_LOG_PREFIX, `  Pausing queue — will retry in ${BG_RETRY_DELAY_MS / 1000}s`);
      bgErrorCount++;
      bgPaused = true;
      bgProcessing = false;
      bgQueue.unshift(item);
      setTimeout(() => {
        console.log(BG_LOG_PREFIX, "Retry delay elapsed — resuming queue");
        bgPaused = false;
        scheduleNext();
      }, BG_RETRY_DELAY_MS);
      return;
    }

    const ollamaElapsed = ((Date.now() - ollamaStartTime) / 1000).toFixed(1);
    console.log(BG_LOG_PREFIX, `  Ollama responded in ${ollamaElapsed}s — ${rawResponse.length} chars`);

    // Parse response
    let result = null;
    try {
      const jsonStr = extractJSON(rawResponse);
      result = JSON.parse(jsonStr);
    } catch (parseErr) {
      console.warn(BG_LOG_PREFIX, `  JSON parse failed: ${parseErr.message} — attempting repair`);
      result = typeof repairAnalysisJSON === "function"
        ? repairAnalysisJSON(rawResponse)
        : null;
      if (result) {
        console.log(BG_LOG_PREFIX, "  Repair succeeded — got:", Object.keys(result).join(", "));
      }
    }

    if (result) {
      // Normalize item previews
      for (const key of ["events", "tasks", "contacts"]) {
        if (Array.isArray(result[key])) {
          result[key] = result[key].map(item => {
            if (typeof item === "string") return { preview: item };
            if (!item.preview) {
              item.preview = item.title || item.name || item.description
                || item.summary || item.label || "";
            }
            return item;
          });
        }
      }
      await cacheSet(item.messageId, result);
      bgProcessedCount++;

      const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const found = [];
      if (result.events?.length)   found.push(`${result.events.length} event(s)`);
      if (result.tasks?.length)    found.push(`${result.tasks.length} task(s)`);
      if (result.contacts?.length) found.push(`${result.contacts.length} contact(s)`);
      if (result.tags?.length)     found.push(`tags: ${result.tags.join(", ")}`);
      if (result.reply)            found.push("reply draft");
      if (result.forwardSummary)   found.push("forward summary");
      console.log(BG_LOG_PREFIX, `  Cached successfully in ${totalElapsed}s — found: ${found.join(", ") || "nothing notable"}`);
      console.log(BG_LOG_PREFIX, `  Session totals: ${bgProcessedCount} processed, ${bgErrorCount} errors, ${bgQueue.length} remaining`);
    } else {
      console.warn(BG_LOG_PREFIX, `  Invalid JSON for message ${item.messageId} — marking as error`);
      console.warn(BG_LOG_PREFIX, `  Response preview: ${rawResponse?.substring(0, 200)}…`);
      await cacheSetError(item.messageId);
      bgErrorCount++;
    }
  } catch (e) {
    console.error(BG_LOG_PREFIX, `Unexpected error processing message ${item.messageId}:`, e.message);
    bgErrorCount++;
    await cacheSetError(item.messageId).catch(() => {});
  }

  bgProcessing = false;
  scheduleNext();
}

// --- New mail listener ---

function initBgNewMailListener() {
  if (typeof browser.messages?.onNewMailReceived === "undefined") {
    console.log(BG_LOG_PREFIX, "onNewMailReceived not available — new mail listener disabled");
    return;
  }

  browser.messages.onNewMailReceived.addListener((folder, messageList) => {
    if (!bgEnabled) return;
    const count = messageList.messages?.length || 0;
    // Only process inbox messages
    const isInbox = Array.isArray(folder.specialUse)
      ? folder.specialUse.includes("inbox")
      : folder.type === "inbox";
    if (!isInbox) {
      console.log(BG_LOG_PREFIX, `New mail in ${folder.name} (${folder.specialUse || folder.type}) — skipping (not inbox)`);
      return;
    }
    console.log(BG_LOG_PREFIX, `New mail in inbox (${folder.name}): ${count} message(s)`);
    for (const msg of (messageList.messages || [])) {
      bgProcessorEnqueue(msg.id);
    }
  });
  console.log(BG_LOG_PREFIX, "New mail listener registered");
}

// --- Deleted mail listener — clean up cache ---

function initBgDeletedMailListener() {
  if (typeof browser.messages?.onDeleted === "undefined") {
    console.log(BG_LOG_PREFIX, "onDeleted not available — deleted mail listener disabled");
    return;
  }

  browser.messages.onDeleted.addListener((messageList) => {
    const count = messageList.messages?.length || 0;
    if (count > 0) {
      console.log(BG_LOG_PREFIX, `${count} message(s) deleted — cleaning cache`);
    }
    for (const msg of (messageList.messages || [])) {
      cacheDelete(msg.id).catch(() => {});
    }
  });
  console.log(BG_LOG_PREFIX, "Deleted mail listener registered");
}

// --- Startup backfill ---

async function bgBackfill() {
  if (!bgEnabled) return;

  const settings = await browser.storage.sync.get(DEFAULTS);
  const backfillDays = settings.bgCacheMaxDays || BG_BACKFILL_DAYS;

  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - backfillDays);

  // Find all inbox folders across all accounts
  let inboxFolders = [];
  try {
    inboxFolders = await browser.folders.query({ specialUse: ["inbox"] });
  } catch (e) {
    console.warn(BG_LOG_PREFIX, "Could not query inbox folders:", e.message);
    return;
  }

  if (inboxFolders.length === 0) {
    console.log(BG_LOG_PREFIX, "No inbox folders found — skipping backfill");
    return;
  }

  const folderNames = inboxFolders.map(f => `${f.accountId}/${f.name}`).join(", ");
  console.log(BG_LOG_PREFIX, `Starting backfill — last ${backfillDays} day(s) (since ${fromDate.toLocaleDateString()}) across ${inboxFolders.length} inbox(es): ${folderNames}`);

  let totalMessages = 0;
  let enqueued = 0;
  let alreadyCached = 0;

  for (const folder of inboxFolders) {
    try {
      let page = await browser.messages.query({ folderId: folder.id, fromDate });
      while (page) {
        const msgs = page.messages || [];
        totalMessages += msgs.length;
        for (const msg of msgs) {
          if (!await cacheHas(msg.id)) {
            bgProcessorEnqueue(msg.id);
            enqueued++;
          } else {
            alreadyCached++;
          }
        }
        if (page.id) {
          try {
            page = await browser.messages.continueList(page.id);
          } catch {
            break;
          }
        } else {
          break;
        }
      }
    } catch (e) {
      console.warn(BG_LOG_PREFIX, `Backfill query failed for ${folder.accountId}/${folder.name}:`, e.message);
    }
  }

  console.log(BG_LOG_PREFIX, `Backfill complete — ${totalMessages} inbox messages found, ${enqueued} enqueued, ${alreadyCached} already cached`);
}

// --- Periodic cache cleanup ---

let bgCleanupInterval = null;

function initBgCleanup() {
  async function runCleanup() {
    try {
      const settings = await browser.storage.sync.get({ bgCacheMaxDays: 1 });
      const maxAgeMs = (settings.bgCacheMaxDays || 1) * 24 * 60 * 60 * 1000;
      const removed = await cacheCleanup(maxAgeMs);
      if (removed > 0) {
        console.log(BG_LOG_PREFIX, `Cache cleanup: removed ${removed} expired entries`);
      }
      const orphans = await cacheCleanupOrphans();
      if (orphans > 0) {
        console.log(BG_LOG_PREFIX, `Cache cleanup: removed ${orphans} orphaned entries`);
      }
      if (removed === 0 && orphans === 0) {
        console.log(BG_LOG_PREFIX, "Cache cleanup: nothing to remove");
      }
    } catch (e) {
      console.warn(BG_LOG_PREFIX, "Cache cleanup error:", e.message);
    }
  }

  // Run on startup
  runCleanup();

  // Run hourly
  bgCleanupInterval = setInterval(runCleanup, 60 * 60 * 1000);
}

// --- Initialization (called from background.js) ---

async function initBgProcessor() {
  const settings = await browser.storage.sync.get({
    bgProcessingEnabled: DEFAULTS.bgProcessingEnabled || false,
    autoAnalyzeEnabled: DEFAULTS.autoAnalyzeEnabled || false,
  });

  bgEnabled = !!(settings.bgProcessingEnabled && settings.autoAnalyzeEnabled);

  console.log(BG_LOG_PREFIX, `Initializing — bgProcessingEnabled: ${settings.bgProcessingEnabled}, autoAnalyzeEnabled: ${settings.autoAnalyzeEnabled}, active: ${bgEnabled}`);

  initBgNewMailListener();
  initBgDeletedMailListener();
  initBgCleanup();

  if (bgEnabled) {
    bgBackfill();
  } else {
    console.log(BG_LOG_PREFIX, "Background processing is disabled — skipping backfill");
  }

  // Listen for settings changes
  let lastKnownBgSetting = settings.bgProcessingEnabled;
  let lastKnownAutoSetting = settings.autoAnalyzeEnabled;
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    if (changes.bgProcessingEnabled || changes.autoAnalyzeEnabled) {
      if (changes.bgProcessingEnabled) lastKnownBgSetting = changes.bgProcessingEnabled.newValue;
      if (changes.autoAnalyzeEnabled) lastKnownAutoSetting = changes.autoAnalyzeEnabled.newValue;
      const newBgEnabled = lastKnownBgSetting;
      const newAutoEnabled = lastKnownAutoSetting;
      const wasEnabled = bgEnabled;
      bgEnabled = !!(newBgEnabled && newAutoEnabled);
      console.log(BG_LOG_PREFIX, `Settings changed — active: ${bgEnabled} (was: ${wasEnabled})`);

      if (bgEnabled && !wasEnabled) {
        console.log(BG_LOG_PREFIX, "Background processing enabled — starting backfill");
        bgBackfill();
      } else if (!bgEnabled && wasEnabled) {
        console.log(BG_LOG_PREFIX, "Background processing disabled — queue will drain without processing");
      }
    }

    // Cache duration changed — clean up expired entries and re-backfill
    if (changes.bgCacheMaxDays && bgEnabled) {
      const oldDays = changes.bgCacheMaxDays.oldValue;
      const newDays = changes.bgCacheMaxDays.newValue;
      console.log(BG_LOG_PREFIX, `Cache duration changed: ${oldDays} → ${newDays} day(s)`);

      // Clear the queue — it was built for the old duration
      const oldQueueLen = bgQueue.length;
      bgQueue.length = 0;
      if (oldQueueLen > 0) {
        console.log(BG_LOG_PREFIX, `  Cleared ${oldQueueLen} queued items`);
      }

      // Clean up expired entries with the new duration, then re-backfill
      const maxAgeMs = (newDays || 1) * 24 * 60 * 60 * 1000;
      cacheCleanup(maxAgeMs).then(removed => {
        if (removed > 0) {
          console.log(BG_LOG_PREFIX, `  Cleaned up ${removed} expired cache entries`);
        }
        console.log(BG_LOG_PREFIX, "  Re-running backfill with new duration");
        bgBackfill();
      }).catch(e => {
        console.warn(BG_LOG_PREFIX, "  Cleanup after duration change failed:", e.message);
        bgBackfill();
      });
    }
  });
}
