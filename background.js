"use strict";

const DEBUG = false;

const DEFAULT_HOST = "http://127.0.0.1:11434";

// Singleton window IDs — prevent multiple triage/analysis windows
let triageWindowId = null;
let analyzeWindowId = null;
// Guards against race conditions during async window creation
let triageOpening = false;
let analyzeOpening = false;

// DEFAULTS is defined in config.js, loaded before this script.

// --- LLM parameter helpers ---

// Build Ollama options from user settings. Omits keys whose value is 0 (model default).
function buildOllamaOptions(settings) {
  const opts = {};
  if (settings.numCtx)     opts.num_ctx     = settings.numCtx;
  if (settings.numPredict) opts.num_predict = settings.numPredict;
  return opts;
}

// Build Ollama options for Auto Analyze calls. User settings can raise
// above the hardcoded minimums but never lower below them — Auto Analyze
// needs generous token budgets to function reliably.
function autoAnalyzeOpts(settings, minCtx, minPredict) {
  return {
    num_ctx:     Math.max(settings.numCtx || 0, minCtx),
    num_predict: Math.max(settings.numPredict || 0, minPredict),
  };
}

// --- First-run onboarding ---

browser.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    // Flag so the options page can show the first-run notice
    await browser.storage.local.set({ firstRun: true });
    // Open settings so the user can configure Ollama host and model
    browser.runtime.openOptionsPage();
  }
});

// --- Context menu setup ---

const MENU_IDS = new Set([
  "thunderclerk-ai-add-calendar",
  "thunderclerk-ai-add-task",
  "thunderclerk-ai-draft-reply",
  "thunderclerk-ai-summarize-forward",
  "thunderclerk-ai-extract-contact",
  "thunderclerk-ai-catalog-email",
  "thunderclerk-ai-auto-analyze",
  "thunderclerk-ai-queue-analysis",
  "thunderclerk-ai-bulk-triage",
]);

browser.menus.create({
  id: "thunderclerk-ai-parent",
  title: "ThunderClerk-AI",
  contexts: ["message_list"],
});

browser.menus.create({
  id: "thunderclerk-ai-add-calendar",
  parentId: "thunderclerk-ai-parent",
  title: "Add to Calendar",
  contexts: ["message_list"],
});

browser.menus.create({
  id: "thunderclerk-ai-add-task",
  parentId: "thunderclerk-ai-parent",
  title: "Add as Task",
  contexts: ["message_list"],
});

browser.menus.create({
  id: "thunderclerk-ai-sep-1",
  parentId: "thunderclerk-ai-parent",
  type: "separator",
  contexts: ["message_list"],
});

browser.menus.create({
  id: "thunderclerk-ai-draft-reply",
  parentId: "thunderclerk-ai-parent",
  title: "Draft Reply",
  contexts: ["message_list"],
});

browser.menus.create({
  id: "thunderclerk-ai-summarize-forward",
  parentId: "thunderclerk-ai-parent",
  title: "Summarize && Forward",
  contexts: ["message_list"],
});

browser.menus.create({
  id: "thunderclerk-ai-sep-2",
  parentId: "thunderclerk-ai-parent",
  type: "separator",
  contexts: ["message_list"],
});

browser.menus.create({
  id: "thunderclerk-ai-extract-contact",
  parentId: "thunderclerk-ai-parent",
  title: "Extract Contact",
  contexts: ["message_list"],
});

browser.menus.create({
  id: "thunderclerk-ai-sep-3",
  parentId: "thunderclerk-ai-parent",
  type: "separator",
  contexts: ["message_list"],
});

browser.menus.create({
  id: "thunderclerk-ai-catalog-email",
  parentId: "thunderclerk-ai-parent",
  title: "Catalog Email",
  contexts: ["message_list"],
});

browser.menus.create({
  id: "thunderclerk-ai-sep-4",
  parentId: "thunderclerk-ai-parent",
  type: "separator",
  contexts: ["message_list"],
});

browser.menus.create({
  id: "thunderclerk-ai-auto-analyze",
  parentId: "thunderclerk-ai-parent",
  title: "Auto Analyze",
  contexts: ["message_list"],
  visible: false,              // hidden until enabled in settings
});

browser.menus.create({
  id: "thunderclerk-ai-queue-analysis",
  parentId: "thunderclerk-ai-parent",
  title: "Queue for Analysis",
  contexts: ["message_list"],
  visible: false,              // hidden until enabled in settings
});

browser.menus.create({
  id: "thunderclerk-ai-bulk-triage",
  parentId: "thunderclerk-ai-parent",
  title: "Bulk Triage",
  contexts: ["message_list"],
  visible: false,              // hidden until enabled in settings
});

// Show/hide Auto Analyze menu items and message display action button
async function syncAutoAnalyzeVisibility() {
  const { autoAnalyzeEnabled } = await browser.storage.sync.get({ autoAnalyzeEnabled: DEFAULTS.autoAnalyzeEnabled });
  const enabled = !!autoAnalyzeEnabled;
  browser.menus.update("thunderclerk-ai-auto-analyze", { visible: enabled });
  browser.menus.update("thunderclerk-ai-queue-analysis", { visible: enabled });
  browser.menus.update("thunderclerk-ai-bulk-triage", { visible: enabled });
  browser.menus.update("thunderclerk-ai-sep-4", { visible: enabled });
  // Show/hide the message header toolbar button
  if (enabled) {
    browser.messageDisplayAction.enable();
  } else {
    browser.messageDisplayAction.disable();
  }
}
syncAutoAnalyzeVisibility();

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.autoAnalyzeEnabled) {
    syncAutoAnalyzeVisibility();
  }
  // Re-check Ollama immediately when the host URL changes
  if (area === "sync" && changes.ollamaHost) {
    checkOllamaStatus();
  }
});

// --- Ollama connectivity status indicator (toolbar button) ---

let ollamaReachable = null; // null=unknown, true=up, false=down
let _lastIconStatus = null; // tracks last rendered status to avoid redundant setIcon calls
const OLLAMA_CHECK_INTERVAL_MS = 30000;

// Cache loaded icon ImageBitmaps so we only decode PNGs once.
const _iconCache = {}; // { size: ImageBitmap }

async function _loadIcon(size) {
  if (_iconCache[size]) return _iconCache[size];
  const resp = await fetch(browser.runtime.getURL(`icons/icon-${size}.png`));
  const blob = await resp.blob();
  const bmp = await createImageBitmap(blob);
  _iconCache[size] = bmp;
  return bmp;
}

// Draw the base icon with a colored status dot in the top-right corner.
async function _buildStatusIcon(color) {
  const sizes = [16, 32];
  const imageData = {};

  for (const size of sizes) {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext("2d");

    // Draw the base icon at full size
    try {
      const bmp = await _loadIcon(size);
      ctx.drawImage(bmp, 0, 0, size, size);
    } catch {
      // If icon load fails, just draw the dot on a blank canvas
    }

    // Status dot: top-right corner, inset so outline isn't clipped
    const dotRadius = size <= 16 ? 3 : 5;
    const outline = 1;
    const cx = size - dotRadius - outline;
    const cy = dotRadius + outline;

    // White outline for contrast
    ctx.beginPath();
    ctx.arc(cx, cy, dotRadius + 1, 0, Math.PI * 2);
    ctx.fillStyle = "#FFFFFF";
    ctx.fill();

    // Colored dot
    ctx.beginPath();
    ctx.arc(cx, cy, dotRadius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    imageData[size] = ctx.getImageData(0, 0, size, size);
  }
  return imageData;
}

async function updateOllamaStatusIcon(reachable) {
  // Derive a status key: true, false, or null
  const statusKey = reachable === true ? "up" : reachable === false ? "down" : "unknown";

  // Skip redundant redraws — repeated setIcon calls can interfere with onClicked
  if (statusKey === _lastIconStatus) return;
  _lastIconStatus = statusKey;

  let color, title;
  if (reachable) {
    color = "#4CAF50";
    title = "ThunderClerk-AI — connected";
  } else if (reachable === false) {
    color = "#F44336";
    title = "ThunderClerk-AI — unreachable";
  } else {
    color = "#FF9800";
    title = "ThunderClerk-AI — checking...";
  }

  try {
    const imageData = await _buildStatusIcon(color);
    browser.browserAction.setIcon({ imageData });
  } catch (e) {
    if (DEBUG) console.warn("[ThunderClerk-AI] Status icon render failed:", e.message);
  }
  browser.browserAction.setTitle({ title });
}

async function checkOllamaStatus() {
  let host;
  try {
    const settings = await browser.storage.sync.get({ ollamaHost: DEFAULT_HOST });
    host = settings.ollamaHost || DEFAULT_HOST;
  } catch {
    host = DEFAULT_HOST;
  }

  if (!isValidHostUrl(host)) {
    ollamaReachable = false;
    updateOllamaStatusIcon(false);
    return;
  }

  const url = host.replace(/\/$/, "") + "/api/tags";
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  try {
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    const wasDown = ollamaReachable === false;
    ollamaReachable = resp.ok;
    updateOllamaStatusIcon(ollamaReachable);

    // Auto-resume background processor when Ollama comes back online
    if (ollamaReachable && wasDown && bgPaused) {
      console.log("[ThunderClerk-AI] Ollama back online — resuming background processor");
      bgPaused = false;
      scheduleNext();
    }
  } catch {
    clearTimeout(timeoutId);
    ollamaReachable = false;
    updateOllamaStatusIcon(false);
  }
}

function initOllamaStatusMonitor() {
  updateOllamaStatusIcon(null);
  checkOllamaStatus();
  setInterval(checkOllamaStatus, OLLAMA_CHECK_INTERVAL_MS);
}

// Wire up processor callbacks for instant status updates
bgOnOllamaError = () => {
  ollamaReachable = false;
  updateOllamaStatusIcon(false);
};
bgOnOllamaSuccess = () => {
  if (!ollamaReachable) {
    ollamaReachable = true;
    updateOllamaStatusIcon(true);
  }
};

browser.browserAction.onClicked.addListener(async () => {
  console.log("[ThunderClerk-AI] Toolbar button clicked — triageWindowId:", triageWindowId, "triageOpening:", triageOpening);
  const settings = await browser.storage.sync.get(DEFAULTS);
  if (!settings.autoAnalyzeEnabled) {
    console.log("[ThunderClerk-AI] Toolbar click blocked — autoAnalyzeEnabled is off");
    notifyError("Auto Analyze disabled",
      "Enable Auto Analyze in the extension settings to use Bulk Triage.");
    return;
  }
  try {
    const messageList = await browser.mailTabs.getSelectedMessages();
    const messages = messageList?.messages || [];
    if (messages.length === 0) {
      console.log("[ThunderClerk-AI] Toolbar click — no messages selected");
      notifyError("No messages selected",
        "Select one or more messages in the message list first.");
      return;
    }
    console.log("[ThunderClerk-AI] Toolbar click — opening triage for", messages.length, "message(s)");
    await handleBulkTriage(messages, settings);
  } catch (e) {
    console.error("[ThunderClerk-AI] Toolbar click error:", e);
    notifyError("Bulk Triage", e.message || "Could not get selected messages.");
  }
});

initOllamaStatusMonitor();

// Pure utility functions (normalizeCalDate, extractJSON, buildAttendeesHint,
// buildDescription, buildCategoryInstruction, isValidHostUrl, etc.) are
// defined in utils.js, which is loaded before this script.

function normalizeCalendarData(data) {
  if (data.startDate) data.startDate = normalizeCalDate(data.startDate);
  if (data.endDate)   data.endDate   = normalizeCalDate(data.endDate);
  data.forceAllDay = !!data.forceAllDay; // schema requires this field
  return data;
}

function normalizeTaskData(data) {
  if (data.dueDate)     data.dueDate     = normalizeCalDate(data.dueDate);
  if (data.initialDate) data.initialDate = normalizeCalDate(data.initialDate);
  if (data.InitialDate) {
    data.initialDate = normalizeCalDate(data.InitialDate);
    delete data.InitialDate;
  }
  return data;
}

// buildCalendarPrompt, buildTaskPrompt, buildDraftReplyPrompt,
// buildSummarizeForwardPrompt, buildContactPrompt are defined in utils.js,
// which is loaded before this script in the extension manifest.

async function callOllama(host, model, prompt, options = {}) {
  if (!isValidHostUrl(host)) {
    throw new Error(`Invalid Ollama host URL: "${host}". Check the extension settings.`);
  }
  const url = host.replace(/\/$/, "") + "/api/generate";
  if (DEBUG) console.log("[ThunderClerk-AI] Calling Ollama", { url, model, promptLen: prompt.length });

  const controller = new AbortController();
  const timeoutMs  = prompt.length > 5000 ? 180_000 : 60_000;
  const timeoutId  = setTimeout(() => controller.abort(), timeoutMs);

  const body = { model, prompt, stream: false };
  const ollamaOpts = {};
  if (options.num_predict) ollamaOpts.num_predict = options.num_predict;
  if (options.num_ctx) ollamaOpts.num_ctx = options.num_ctx;
  if (options.temperature !== undefined) ollamaOpts.temperature = options.temperature;
  if (Object.keys(ollamaOpts).length > 0) body.options = ollamaOpts;
  if (options.format) body.format = options.format;

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timeoutId);
    if (e.name === "AbortError") throw new Error(`Ollama request timed out after ${timeoutMs / 1000} seconds.`);
    throw e;
  }
  clearTimeout(timeoutId);

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`HTTP ${response.status}: ${body}`);
  }
  const data = await response.json();
  if (DEBUG) console.log("[ThunderClerk-AI] Ollama response length:", data.response?.length);
  return data.response;
}

function previewPrompt(prompt) {
  return new Promise((resolve, reject) => {
    browser.storage.local.set({ pendingPrompt: prompt }).then(() => {
      const listener = (msg) => {
        if (msg && msg.promptAction) {
          browser.runtime.onMessage.removeListener(listener);
          browser.storage.local.remove("pendingPrompt").catch(() => {});
          if (msg.promptAction === "ok") {
            resolve();
          } else {
            reject(new Error("Prompt cancelled by user."));
          }
        }
      };
      browser.runtime.onMessage.addListener(listener);

      browser.windows.create({
        url: browser.runtime.getURL("debug/preview.html"),
        type: "popup",
        width: 620,
        height: 520,
      }).then((win) => {
        // If the user closes the window without clicking a button, treat as cancel
        const onRemoved = (windowId) => {
          if (windowId === win.id) {
            browser.windows.onRemoved.removeListener(onRemoved);
            browser.runtime.onMessage.removeListener(listener);
            browser.storage.local.remove("pendingPrompt").catch(() => {});
            reject(new Error("Prompt preview window closed."));
          }
        };
        browser.windows.onRemoved.addListener(onRemoved);
      });
    });
  });
}

function notifyError(title, message) {
  console.error("[ThunderClerk-AI]", title, message);
  browser.notifications.create({
    type: "basic",
    title: `ThunderClerk-AI — ${title}`,
    message,
  }).catch(() => {});
}

// --- Progress notification with elapsed time ---

const THINKING_ID = "thunderclerk-ai-thinking";
const PROGRESS_INTERVAL_MS = 3000;
const STILL_WORKING_THRESHOLD_S = 60;

function createProgressNotifier(actionLabel, model) {
  let intervalId = null;
  let startTime = null;

  function buildMessage(elapsedS) {
    const base = elapsedS >= STILL_WORKING_THRESHOLD_S
      ? `Still working\u2026 ${actionLabel}`
      : `Asking ${model} to ${actionLabel}\u2026`;
    return elapsedS > 0 ? `${base} (${elapsedS}s)` : base;
  }

  return {
    start() {
      startTime = Date.now();
      browser.notifications.create(THINKING_ID, {
        type: "basic",
        title: "ThunderClerk-AI",
        message: buildMessage(0),
      }).catch(() => {});

      intervalId = setInterval(() => {
        const elapsedS = Math.round((Date.now() - startTime) / 1000);
        browser.notifications.create(THINKING_ID, {
          type: "basic",
          title: "ThunderClerk-AI",
          message: buildMessage(elapsedS),
        }).catch(() => {});
      }, PROGRESS_INTERVAL_MS);
    },

    stop() {
      if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
      }
      browser.notifications.clear(THINKING_ID).catch(() => {});
    },
  };
}

// --- Shared helper: call Ollama with a progress notification ---

async function callOllamaWithNotification(host, model, prompt, actionLabel, settings, ollamaOptions = {}) {
  // Debug: show prompt preview if enabled
  if (settings && settings.debugPromptPreview) {
    await previewPrompt(prompt);
  }

  const progress = createProgressNotifier(actionLabel, model);
  progress.start();

  let rawResponse;
  try {
    rawResponse = await callOllama(host, model, prompt, ollamaOptions);
  } finally {
    progress.stop();
  }

  const jsonStr = extractJSON(rawResponse);
  return JSON.parse(jsonStr);
}

// --- Action handlers ---

async function handleCalendar(message, emailBody, settings) {
  // Cache-first: use cached event if available from background processor
  try {
    const cached = await cacheGet(message.id);
    if (cached && cached.raw) {
      const raw = cached.raw;
      if (Array.isArray(raw.events) && raw.events.length > 0) {
        const evt = pickKeys(raw.events[0], CALENDAR_API_KEYS);
        applyEventSettings(evt, message, emailBody, settings);
        await browser.CalendarTools.openCalendarDialog(evt);
        return;
      }
      notifyError("No events found", "The cached analysis found no calendar events in this email.");
      return;
    }
  } catch (e) {
    console.warn("[ThunderClerk-AI] Cache check failed, falling back to LLM:", e.message);
  }

  // Cache miss — fall back to on-demand LLM call
  const host              = settings.ollamaHost        || DEFAULT_HOST;
  const model             = settings.ollamaModel       || DEFAULTS.ollamaModel;
  const attendeesSource   = settings.attendeesSource   || "from_to";
  const attendeesStatic   = settings.attendeesStatic   || "";
  const calendarUseCategory = !!settings.calendarUseCategory;

  const mailDatetime  = formatDatetime(message.date);
  const currentDt     = currentDatetime();
  const subject       = message.subject || "";
  const attendeeHints = buildAttendeesHint(message, attendeesSource, attendeesStatic);

  let categories = null;
  if (calendarUseCategory) {
    try {
      categories = await browser.CalendarTools.getCategories();
    } catch (e) {
      console.warn("[ThunderClerk-AI] Could not fetch categories, proceeding without:", e.message);
    }
  }

  const descriptionFormat = settings.descriptionFormat || "body_from_subject";
  const wantAiDescription = descriptionFormat === "ai_summary";
  const prompt = buildCalendarPrompt(emailBody, subject, mailDatetime, currentDt, attendeeHints, categories, wantAiDescription);

  const parsed = await callOllamaWithNotification(host, model, prompt, "extract event details", settings, buildOllamaOptions(settings));

  applyEventSettings(parsed, message, emailBody, settings);

  await browser.CalendarTools.openCalendarDialog(parsed);
}

async function handleTask(message, emailBody, settings) {
  // Cache-first: use cached task if available from background processor
  try {
    const cached = await cacheGet(message.id);
    if (cached && cached.raw) {
      const raw = cached.raw;
      if (Array.isArray(raw.tasks) && raw.tasks.length > 0) {
        const task = pickKeys(raw.tasks[0], TASK_API_KEYS);
        applyTaskSettings(task, message, emailBody, settings);
        await browser.CalendarTools.openTaskDialog(task);
        return;
      }
      notifyError("No tasks found", "The cached analysis found no tasks in this email.");
      return;
    }
  } catch (e) {
    console.warn("[ThunderClerk-AI] Cache check failed, falling back to LLM:", e.message);
  }

  // Cache miss — fall back to on-demand LLM call
  const host              = settings.ollamaHost            || DEFAULT_HOST;
  const model             = settings.ollamaModel           || DEFAULTS.ollamaModel;
  const taskUseCategory   = !!settings.taskUseCategory;

  const mailDatetime  = formatDatetime(message.date);
  const currentDt     = currentDatetime();
  const subject       = message.subject || "";

  let categories = null;
  if (taskUseCategory) {
    try {
      categories = await browser.CalendarTools.getCategories();
    } catch (e) {
      console.warn("[ThunderClerk-AI] Could not fetch categories, proceeding without:", e.message);
    }
  }

  const taskDescriptionFormat = settings.taskDescriptionFormat || "body_from_subject";
  const wantAiDescription = taskDescriptionFormat === "ai_summary";
  const prompt = buildTaskPrompt(emailBody, subject, mailDatetime, currentDt, categories, wantAiDescription);

  const parsed = await callOllamaWithNotification(host, model, prompt, "extract task details", settings, buildOllamaOptions(settings));

  applyTaskSettings(parsed, message, emailBody, settings);

  await browser.CalendarTools.openTaskDialog(parsed);
}

async function handleDraftReply(message, emailBody, settings) {
  // Cache-first: use cached reply if available from background processor
  try {
    const cached = await cacheGet(message.id);
    if (cached && cached.raw) {
      const reply = (cached.raw.reply || "").trim();
      if (reply) {
        await openComposeWithReply(message, reply, settings);
        return;
      }
      notifyError("No reply generated", "The cached analysis did not produce a reply draft for this email.");
      return;
    }
  } catch (e) {
    console.warn("[ThunderClerk-AI] Cache check failed, falling back to LLM:", e.message);
  }

  // Cache miss — fall back to on-demand LLM call
  const host   = settings.ollamaHost  || DEFAULT_HOST;
  const model  = settings.ollamaModel || DEFAULTS.ollamaModel;
  const author = message.author || "";
  const subject = message.subject || "";

  const prompt = buildDraftReplyPrompt(emailBody, subject, author);
  const parsed = await callOllamaWithNotification(host, model, prompt, "draft a reply", settings, buildOllamaOptions(settings));

  const replyBody = (parsed.body || "").trim();
  if (!replyBody) {
    notifyError("Empty reply", "The AI returned an empty reply body.");
    return;
  }

  await openComposeWithReply(message, replyBody, settings);
}

async function handleSummarizeForward(message, emailBody, settings) {
  // Cache-first: use cached forward summary if available from background processor
  try {
    const cached = await cacheGet(message.id);
    if (cached && cached.raw) {
      const summary = (cached.raw.forwardSummary || "").trim();
      if (summary) {
        const composeTab = await browser.compose.beginForward(message.id, "forwardInline");
        const details = await browser.compose.getComposeDetails(composeTab.id);
        const escapedSummary = summary
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/\n/g, "<br>");
        const newBody = `<p><strong>Summary:</strong><br>${escapedSummary}</p><hr>` + (details.body || "");
        await browser.compose.setComposeDetails(composeTab.id, { body: newBody });
        return;
      }
      notifyError("No summary generated", "The cached analysis did not produce a summary for this email.");
      return;
    }
  } catch (e) {
    console.warn("[ThunderClerk-AI] Cache check failed, falling back to LLM:", e.message);
  }

  // Cache miss — fall back to on-demand LLM call
  const host   = settings.ollamaHost  || DEFAULT_HOST;
  const model  = settings.ollamaModel || DEFAULTS.ollamaModel;
  const author = message.author || "";
  const subject = message.subject || "";

  const prompt = buildSummarizeForwardPrompt(emailBody, subject, author);
  const parsed = await callOllamaWithNotification(host, model, prompt, "summarize the email", settings, buildOllamaOptions(settings));

  const summary = (parsed.summary || "").trim();
  if (!summary) {
    notifyError("Empty summary", "The AI returned an empty summary.");
    return;
  }

  // Open compose window as inline forward
  const composeTab = await browser.compose.beginForward(message.id, "forwardInline");

  const details = await browser.compose.getComposeDetails(composeTab.id);

  const escapedSummary = summary
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");

  const newBody = `<p><strong>Summary:</strong><br>${escapedSummary}</p><hr>` + (details.body || "");
  await browser.compose.setComposeDetails(composeTab.id, { body: newBody });
}

async function handleExtractContact(message, emailBody, settings) {
  // Cache-first: use cached contact if available from background processor
  try {
    const cached = await cacheGet(message.id);
    if (cached && cached.raw) {
      const contacts = cached.raw.contacts;
      if (Array.isArray(contacts) && contacts.length > 0) {
        await browser.storage.local.set({
          pendingContact: contacts[0],
          contactAddressBook: settings.contactAddressBook || "",
        });
        await browser.windows.create({
          type: "popup",
          url: "contact/review.html",
          width: 420,
          height: 520,
        });
        return;
      }
      notifyError("No contact info found", "The cached analysis found no contact information in this email.");
      return;
    }
  } catch (e) {
    console.warn("[ThunderClerk-AI] Cache check failed, falling back to LLM:", e.message);
  }

  // Cache miss — fall back to on-demand LLM call
  const host   = settings.ollamaHost  || DEFAULT_HOST;
  const model  = settings.ollamaModel || DEFAULTS.ollamaModel;
  const author = message.author || "";
  const subject = message.subject || "";

  const prompt = buildContactPrompt(emailBody, subject, author);
  const parsed = await callOllamaWithNotification(host, model, prompt, "extract contact info", settings, buildOllamaOptions(settings));

  // Store extracted contact for the review popup to read
  await browser.storage.local.set({
    pendingContact: parsed,
    contactAddressBook: settings.contactAddressBook || "",
  });

  // Open the review popup
  await browser.windows.create({
    type: "popup",
    url: "contact/review.html",
    width: 420,
    height: 520,
  });
}

// --- Catalog email (AI-powered tagging) ---

async function catalogEmail(message, emailBody, settings, full) {
  // Cache-first: use cached tags if available from background processor
  try {
    const cached = await cacheGet(message.id);
    if (cached && cached.raw) {
      const cachedTags = cached.raw.tags;
      if (Array.isArray(cachedTags) && cachedTags.length > 0) {
        // Jump straight to tag resolution with cached tags
        const existingTags = await browser.messages.tags.list();
        return await _applyTags(message, cachedTags, existingTags);
      }
      // Silent return — catalogEmail is often fire-and-forget via autoTagAfterAction
      return;
    }
  } catch (e) {
    console.warn("[ThunderClerk-AI] Cache check failed, falling back to LLM:", e.message);
  }

  // Cache miss — fall back to on-demand LLM call
  const host  = settings.ollamaHost  || DEFAULT_HOST;
  const model = settings.ollamaModel || DEFAULTS.ollamaModel;
  const author  = message.author  || "";
  const subject = message.subject || "";

  // Fetch existing tags
  const existingTags = await browser.messages.tags.list();
  const existingTagNames = existingTags.map(t => t.tag);

  const signals = extractEmailSignals(full, message);
  const prompt = buildCatalogPrompt(emailBody, subject, author, existingTagNames, signals);
  const parsed = await callOllamaWithNotification(host, model, prompt, "catalog email", settings, buildOllamaOptions(settings));

  const aiTags = parsed.tags;
  if (!Array.isArray(aiTags) || aiTags.length === 0) {
    notifyError("No tags", "The AI did not return any tags.");
    return;
  }

  await _applyTags(message, aiTags, existingTags);
}

// Shared tag resolution + apply logic used by both cached and LLM paths.
// Options: { silent } — when true, suppresses per-message notification (for bulk ops).
async function _applyTags(message, aiTags, existingTags, { silent = false } = {}) {
  // Limit to 3 tags
  const tagNames = aiTags.slice(0, 3);

  // Resolve each tag: match existing (case-insensitive), skip unknown
  const tagKeys = [];
  const appliedNames = [];
  for (const name of tagNames) {
    const existing = existingTags.find(
      t => t.tag.toLowerCase() === name.toLowerCase()
    );
    if (existing) {
      tagKeys.push(existing.key);
      appliedNames.push(existing.tag);
    }
  }

  if (tagKeys.length === 0) return appliedNames;

  // Read-merge-write: messages.update replaces all tags, so preserve existing
  const currentMsg = await browser.messages.get(message.id);
  const currentTags = currentMsg.tags || [];
  const mergedTags = [...new Set([...currentTags, ...tagKeys])];

  await browser.messages.update(message.id, { tags: mergedTags });

  if (!silent) {
    browser.notifications.create({
      type: "basic",
      title: "ThunderClerk-AI",
      message: `Tagged: ${appliedNames.join(", ")}`,
    }).catch(() => {});
  }

  return appliedNames;
}

// --- Shared helpers for applying settings to extracted event/task data ---

function applyEventSettings(parsed, message, emailBody, settings) {
  const descriptionFormat = settings.descriptionFormat || "body_from_subject";
  const attendeesSource   = settings.attendeesSource   || "from_to";
  const attendeesStatic   = settings.attendeesStatic   || "";
  const defaultCalendar   = settings.defaultCalendar   || "";
  const author            = message.author || "";
  const subject           = message.subject || "";

  normalizeCalendarData(parsed);

  // Use the email's year as the reference for advancePastYear, not today's year.
  // This preserves correct dates when processing old emails.
  const emailYear = message.date ? new Date(message.date).getFullYear() : new Date().getFullYear();
  const refYear = emailYear;
  if (parsed.startDate) parsed.startDate = advancePastYear(parsed.startDate, refYear);
  if (parsed.endDate)   parsed.endDate   = advancePastYear(parsed.endDate,   refYear);

  if (!parsed.summary) parsed.summary = subject;

  applyCalendarDefaults(parsed);

  if (descriptionFormat === "ai_summary") {
    if (!parsed.description) parsed.description = subject;
  } else {
    const description = buildDescription(emailBody, author, subject, descriptionFormat);
    if (description) parsed.description = description;
  }

  if (defaultCalendar) parsed.calendar_name = defaultCalendar;

  if (attendeesSource === "static") {
    parsed.attendees = attendeesStatic ? [attendeesStatic] : [];
  } else if (attendeesSource === "none") {
    parsed.attendees = [];
  }

  // iCal all-day events use an exclusive DTEND
  if (parsed.forceAllDay && parsed.endDate && parsed.endDate !== parsed.startDate) {
    parsed.endDate = addHoursToCalDate(parsed.endDate, 24);
  }

  return parsed;
}

function applyTaskSettings(parsed, message, emailBody, settings) {
  const taskDescriptionFormat = settings.taskDescriptionFormat || "body_from_subject";
  const taskDefaultDue        = settings.taskDefaultDue        || "none";
  const author                = message.author || "";
  const subject               = message.subject || "";

  normalizeTaskData(parsed);

  if (!parsed.dueDate && taskDefaultDue !== "none") {
    const future = new Date();
    future.setDate(future.getDate() + parseInt(taskDefaultDue, 10));
    const y  = future.getFullYear();
    const mo = String(future.getMonth() + 1).padStart(2, "0");
    const d  = String(future.getDate()).padStart(2, "0");
    parsed.dueDate = `${y}${mo}${d}T120000`;
  }

  if (taskDescriptionFormat === "ai_summary") {
    if (!parsed.description) parsed.description = subject;
  } else {
    const taskDescription = buildDescription(emailBody, author, subject, taskDescriptionFormat);
    if (taskDescription) parsed.description = taskDescription;
  }

  return parsed;
}

// --- Auto Analyze ---

// Open a compose window with a pre-generated reply body.
// Returns the compose tab so callers can track send vs cancel.
async function openComposeWithReply(message, replyBody, settings) {
  const replyMode = settings.replyMode || "replyToSender";
  const composeTab = await browser.compose.beginReply(message.id, replyMode);
  const details = await browser.compose.getComposeDetails(composeTab.id);

  const escapedBody = replyBody
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");

  const newBody = `<p>${escapedBody}</p><br>` + (details.body || "");
  await browser.compose.setComposeDetails(composeTab.id, { body: newBody });
  return composeTab;
}

// Track whether a compose window was sent or discarded.
// Returns a Promise<boolean> — true if sent, false if closed without sending.
function trackComposeOutcome(composeTab) {
  return new Promise((resolve) => {
    let sent = false;
    const onAfterSend = (tab) => {
      if (tab.id === composeTab.id) {
        sent = true;
        cleanup();
        resolve(true);
      }
    };
    const onRemoved = (windowId) => {
      if (windowId === composeTab.windowId) {
        cleanup();
        if (!sent) resolve(false);
      }
    };
    function cleanup() {
      browser.compose.onAfterSend.removeListener(onAfterSend);
      browser.windows.onRemoved.removeListener(onRemoved);
    }
    browser.compose.onAfterSend.addListener(onAfterSend);
    browser.windows.onRemoved.addListener(onRemoved);
  });
}

// Track whether a contact review window resulted in a save or was canceled.
// Listens for the { contactSaved: true } message from review.js.
// Returns a Promise<boolean> — true if saved, false if closed without saving.
function trackContactOutcome(win) {
  return new Promise((resolve) => {
    let saved = false;
    const onMessage = (msg) => {
      if (msg && msg.contactSaved) {
        saved = true;
      }
    };
    const onRemoved = (windowId) => {
      if (windowId === win.id) {
        browser.windows.onRemoved.removeListener(onRemoved);
        browser.runtime.onMessage.removeListener(onMessage);
        resolve(saved);
      }
    };
    browser.runtime.onMessage.addListener(onMessage);
    browser.windows.onRemoved.addListener(onRemoved);
  });
}

function openAnalyzeDialog(analysis) {
  // Close any existing analyze window (singleton)
  if (analyzeWindowId !== null) {
    browser.windows.remove(analyzeWindowId).catch(() => {});
    analyzeWindowId = null;
  }

  // Guard against race: multiple calls before the window is created
  if (analyzeOpening) {
    return Promise.resolve(null);
  }
  analyzeOpening = true;

  return new Promise((resolve) => {
    browser.storage.local.set({ pendingAnalysis: analysis }).then(() => {
      const listener = (msg) => {
        if (!msg || !msg.analyzeAction) return;
        // Ignore messages handled by the scoped listener in handleAutoAnalyze
        if (msg.analyzeAction === "openItem" || msg.analyzeAction === "useReply" || msg.analyzeAction === "dialogReady") return;
        browser.runtime.onMessage.removeListener(listener);
        browser.storage.local.remove("pendingAnalysis").catch(() => {});
        if (msg.analyzeAction === "done") {
          resolve(msg.selections);
        } else {
          resolve(null);
        }
      };
      browser.runtime.onMessage.addListener(listener);

      browser.windows.create({
        url: browser.runtime.getURL("analyze/analyze.html"),
        type: "popup",
        width: 580,
        height: 760,
      }).then((win) => {
        analyzeWindowId = win.id;
        analyzeOpening = false;
        const onRemoved = (windowId) => {
          if (windowId === win.id) {
            browser.windows.onRemoved.removeListener(onRemoved);
            browser.runtime.onMessage.removeListener(listener);
            browser.storage.local.remove("pendingAnalysis").catch(() => {});
            analyzeWindowId = null;
            resolve(null);
          }
        };
        browser.windows.onRemoved.addListener(onRemoved);
      }).catch(() => {
        analyzeOpening = false;
        resolve(null);
      });
    });
  });
}

async function executeAnalysisSelections(message, selections) {
  // Items and quick actions are now handled via button clicks in the dialog.
  // This function only handles archive/delete checkboxes.

  if (selections.archive) {
    try {
      await browser.messages.archive([message.id]);
    } catch (e) {
      console.error("[ThunderClerk-AI] Auto Analyze — archive failed:", e.message);
      notifyError("Archive error", e.message);
    }
  } else if (selections.delete) {
    try {
      await browser.messages.delete([message.id], false);
    } catch (e) {
      console.error("[ThunderClerk-AI] Auto Analyze — delete failed:", e.message);
      notifyError("Delete error", e.message);
    }
  }
}

// Try to salvage a truncated analysis JSON response.
// LLMs sometimes produce valid JSON up to a point then stop mid-token.
function repairAnalysisJSON(raw) {
  if (!raw) return null;
  const start = raw.indexOf("{");
  if (start < 0) return null;

  let text = raw.slice(start);

  // Try parsing as-is first
  try { return JSON.parse(text); } catch {}

  // Strategy: scan backwards from the end, trying to find a truncation
  // point we can close. Try many possible closing suffixes at each position.
  const closers = [
    "}", "]}", "]}", '"}', '"}]', '"}]}', '"]}', "]}",
    "}]}", "]}]}", '"]}'  , '"}]}', '"}]]}',
  ];

  // First try: trim back to the last complete-looking JSON value boundary
  // (comma, closing bracket/brace, or end of string)
  for (let i = text.length; i > Math.max(0, text.length - 200); i--) {
    const slice = text.slice(0, i);
    // Try each closer
    for (const suffix of closers) {
      try { return JSON.parse(slice + suffix); } catch {}
    }
  }

  return null;
}

// Strip objects down to only the fields accepted by the CalendarTools API,
// so extra model-generated fields (like "preview") don't trigger type errors.
const CALENDAR_API_KEYS = new Set([
  "startDate", "endDate", "summary", "forceAllDay", "attendees",
  "timezone", "use_timezone", "description", "calendar_name", "category",
]);
const TASK_API_KEYS = new Set([
  "dueDate", "summary", "initialDate", "timezone", "use_timezone",
  "description", "calendar_name", "category",
]);

function pickKeys(obj, allowedKeys) {
  const result = {};
  for (const key of allowedKeys) {
    if (key in obj) result[key] = obj[key];
  }
  return result;
}

// Prepare analysis data from a cached combined extraction result.
// Applies current user settings at display time so cached data stays
// settings-independent.
function prepareCachedAnalysis(cached, message, emailBody, settings) {
  const raw = cached.raw;
  const analysis = {
    summary: raw.summary || message.subject || "(no summary)",
    _fromCache: true,
    _cacheTimestamp: cached.ts,
    _subject: message.subject || "",
    _author: message.author || "",
  };

  // Events — strip to API-safe keys, keep preview for display, apply settings
  if (Array.isArray(raw.events) && raw.events.length > 0) {
    analysis.events = raw.events.map(evt => {
      const copy = pickKeys(evt, CALENDAR_API_KEYS);
      copy.preview = evt.preview || "";
      applyEventSettings(copy, message, emailBody, settings);
      return copy;
    });
  }

  // Tasks — strip to API-safe keys, keep preview for display, apply settings
  if (Array.isArray(raw.tasks) && raw.tasks.length > 0) {
    analysis.tasks = raw.tasks.map(task => {
      const copy = pickKeys(task, TASK_API_KEYS);
      copy.preview = task.preview || "";
      applyTaskSettings(copy, message, emailBody, settings);
      return copy;
    });
  }

  // Contacts — pass through as-is (not sent to CalendarTools API)
  if (Array.isArray(raw.contacts) && raw.contacts.length > 0) {
    analysis.contacts = raw.contacts;
  }

  // Reply
  const reply = (raw.reply || "").trim();
  if (reply) {
    analysis._replyBody = reply;
  } else {
    analysis._replyFailed = true;
  }

  // Priority
  analysis.priority = raw.priority || "informational";

  // Tags, forward summary — store for quick actions
  analysis._cachedTags = Array.isArray(raw.tags) ? raw.tags : [];
  analysis._cachedForwardSummary = (raw.forwardSummary || "").trim();

  return analysis;
}

async function handleAutoAnalyze(message, emailBody, settings, full) {
  // --- Cache-first path: serve instantly from background processor cache ---
  try {
    const cached = await cacheGet(message.id);
    if (cached && cached.raw) {
      return await handleAutoAnalyzeCached(cached, message, emailBody, settings);
    }
  } catch (e) {
    console.warn("[ThunderClerk-AI] Cache check failed, falling back to live:", e.message);
  }

  // --- Cache miss: run single combined prompt (same as background processor) ---
  const host   = settings.ollamaHost  || DEFAULT_HOST;
  const model  = settings.ollamaModel || DEFAULTS.ollamaModel;
  const author = message.author || "";
  const subject = message.subject || "";
  const mailDatetime = formatDatetime(message.date);
  const currentDt    = currentDatetime();

  const MAX_ANALYSIS_BODY = 12000;
  let analysisBody = emailBody;
  if (analysisBody.length > MAX_ANALYSIS_BODY) {
    analysisBody = analysisBody.slice(0, MAX_ANALYSIS_BODY) +
      "\n\n[… email truncated — there may be additional items beyond this point]";
  }

  const attendeesSource = settings.attendeesSource || "from_to";
  const attendeesStatic = settings.attendeesStatic || "";
  const attendeeHints   = buildAttendeesHint(message, attendeesSource, attendeesStatic);
  const calendarUseCategory = !!settings.calendarUseCategory;
  let categories = null;
  if (calendarUseCategory) {
    try { categories = await browser.CalendarTools.getCategories(); } catch {}
  }
  let existingTags = [];
  try {
    const tags = await browser.messages.tags.list();
    existingTags = tags.map(t => t.tag);
  } catch {}

  const signals = extractEmailSignals(full, message);
  const prompt = buildCombinedExtractionPrompt(
    analysisBody, subject, author, mailDatetime, currentDt,
    attendeeHints, categories, existingTags, signals
  );

  if (settings && settings.debugPromptPreview) {
    await previewPrompt(prompt);
  }

  const progress = createProgressNotifier("analyze the email", model);
  progress.start();

  let rawResponse;
  try {
    rawResponse = await callOllama(host, model, prompt, autoAnalyzeOpts(settings, 16384, 16384));
  } finally {
    progress.stop();
  }

  let parsed = null;
  try {
    const jsonStr = extractJSON(rawResponse);
    parsed = JSON.parse(jsonStr);
  } catch {
    parsed = repairAnalysisJSON(rawResponse);
    if (parsed) {
      console.log("[ThunderClerk-AI] Repaired truncated analysis JSON — got", Object.keys(parsed).join(", "));
    }
  }

  if (!parsed) {
    throw new Error("invalid JSON in analysis response");
  }

  // Normalize previews — LLMs may return different key names
  for (const key of ["events", "tasks", "contacts"]) {
    if (Array.isArray(parsed[key])) {
      parsed[key] = parsed[key].map(item => {
        if (typeof item === "string") return { preview: item };
        if (!item.preview) {
          item.preview = item.title || item.name || item.description
            || item.summary || item.label || "";
        }
        return item;
      });
    }
  }

  // Cache the result, then display via the cached path
  await cacheSet(message.id, parsed);
  const cachedEntry = await cacheGet(message.id);
  return await handleAutoAnalyzeCached(cachedEntry, message, emailBody, settings);
}

// Handle Auto Analyze with cached data — instant display, no Ollama calls.
async function handleAutoAnalyzeCached(cached, message, emailBody, settings) {
  const analysis = prepareCachedAnalysis(cached, message, emailBody, settings);
  const replyBody = analysis._replyBody || null;

  // Detect List-Unsubscribe header (not AI-driven, pure header parsing)
  try {
    const full = await browser.messages.getFull(message.id);
    const unsubHeader = full.headers?.["list-unsubscribe"]?.[0];
    if (unsubHeader) {
      analysis._unsubscribe = parseListUnsubscribe(unsubHeader);
      // Clear if neither type was found
      if (!analysis._unsubscribe.mailto && !analysis._unsubscribe.https) {
        analysis._unsubscribe = null;
      }
    }
  } catch (e) {
    // Silent — dialog just won't show the unsubscribe action
  }

  // Check if AI-suggested tags are already applied to the message
  if (analysis._cachedTags?.length > 0) {
    try {
      const currentMsg = await browser.messages.get(message.id);
      const allTags = await browser.messages.tags.list();
      const currentTagKeys = new Set(currentMsg.tags || []);
      const resolved = analysis._cachedTags
        .map(name => allTags.find(t => t.tag.toLowerCase() === name.toLowerCase()))
        .filter(Boolean);
      if (resolved.length > 0 && resolved.every(t => currentTagKeys.has(t.key))) {
        analysis._tagsAlreadyApplied = true;
      }
    } catch {}
  }

  // Pre-build extraction cache from cached data for button clicks
  const extractionCache = {};

  if (Array.isArray(analysis.events) && analysis.events.length > 0) {
    extractionCache.events = { data: analysis.events, error: null };
  }
  if (Array.isArray(analysis.tasks) && analysis.tasks.length > 0) {
    extractionCache.tasks = { data: analysis.tasks, error: null };
  }
  if (Array.isArray(analysis.contacts) && analysis.contacts.length > 0) {
    extractionCache.contacts = { data: analysis.contacts, error: null };
  }

  // Quick actions from cached data
  if (analysis.events?.length > 0) {
    extractionCache.quickCalendar = { data: analysis.events[0], error: null };
  }
  if (analysis.tasks?.length > 0) {
    extractionCache.quickTask = { data: analysis.tasks[0], error: null };
  }
  if (analysis.contacts?.length > 0) {
    extractionCache.quickContact = { data: analysis.contacts[0], error: null };
  }
  if (analysis._cachedForwardSummary) {
    extractionCache.quickForward = { data: analysis._cachedForwardSummary, error: null };
  }
  if (analysis._cachedTags?.length > 0) {
    try {
      const existingTags = await browser.messages.tags.list();
      extractionCache.quickCatalog = { data: { aiTags: analysis._cachedTags, existingTags }, error: null };
    } catch {}
  }
  if (analysis._unsubscribe) {
    extractionCache.quickUnsubscribe = { data: analysis._unsubscribe, error: null };
  }

  // Register scoped listener for item button clicks, reply usage, and refresh
  const itemListener = async (msg) => {
    if (!msg) return;

    // Refresh button — delete cache, re-run combined prompt, re-display
    if (msg.analyzeAction === "refresh") {
      try {
        await cacheDelete(message.id);
        browser.runtime.onMessage.removeListener(itemListener);
        await handleAutoAnalyze(message, emailBody, settings);
      } catch (e) {
        console.error("[ThunderClerk-AI] Refresh failed:", e.message);
        notifyError("Refresh error", e.message);
      }
      return;
    }

    // Dialog signals ready — for cached data, immediately send all batch-ready signals
    if (msg.analyzeAction === "dialogReady") {
      for (const group of ["events", "tasks", "contacts", "quickCalendar", "quickTask", "quickContact", "quickForward", "quickCatalog", "quickUnsubscribe"]) {
        if (extractionCache[group]) {
          browser.runtime.sendMessage({ batchReady: true, group, success: true }).catch(() => {});
        }
      }
      return;
    }

    if (msg.analyzeAction === "openItem") {
      const group = msg.group;
      const index = msg.index;

      try {
        // Quick Actions
        if (group === "quickCalendar") {
          if (extractionCache.quickCalendar?.data) {
            await browser.CalendarTools.openCalendarDialog(pickKeys(extractionCache.quickCalendar.data, CALENDAR_API_KEYS));
          } else {
            await handleCalendar(message, emailBody, settings);
          }
          browser.runtime.sendMessage({ analyzeItemResult: true, group, index, success: true }).catch(() => {});
          return;
        }
        if (group === "quickTask") {
          if (extractionCache.quickTask?.data) {
            await browser.CalendarTools.openTaskDialog(pickKeys(extractionCache.quickTask.data, TASK_API_KEYS));
          } else {
            await handleTask(message, emailBody, settings);
          }
          browser.runtime.sendMessage({ analyzeItemResult: true, group, index, success: true }).catch(() => {});
          return;
        }
        if (group === "quickContact") {
          if (extractionCache.quickContact?.data) {
            await browser.storage.local.set({
              pendingContact: extractionCache.quickContact.data,
              contactAddressBook: settings.contactAddressBook || "",
            });
            const wasSaved = await trackContactOutcome(
              await browser.windows.create({ type: "popup", url: "contact/review.html", width: 420, height: 520 })
            );
            browser.runtime.sendMessage({ analyzeItemResult: true, group, index, success: true, canceled: !wasSaved }).catch(() => {});
          } else {
            await handleExtractContact(message, emailBody, settings);
            browser.runtime.sendMessage({ analyzeItemResult: true, group, index, success: true }).catch(() => {});
          }
          return;
        }
        if (group === "quickForward") {
          let forwardTab = null;
          if (extractionCache.quickForward?.data) {
            const summary = extractionCache.quickForward.data;
            forwardTab = await browser.compose.beginForward(message.id, "forwardInline");
            const details = await browser.compose.getComposeDetails(forwardTab.id);
            const escapedSummary = summary
              .replace(/&/g, "&amp;")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;")
              .replace(/\n/g, "<br>");
            const newBody = `<p><strong>Summary:</strong><br>${escapedSummary}</p><hr>` + (details.body || "");
            await browser.compose.setComposeDetails(forwardTab.id, { body: newBody });
          } else {
            await handleSummarizeForward(message, emailBody, settings);
          }
          if (forwardTab) {
            const wasSent = await trackComposeOutcome(forwardTab);
            browser.runtime.sendMessage({ analyzeItemResult: true, group, index, success: true, canceled: !wasSent }).catch(() => {});
          } else {
            // Fallback path (handleSummarizeForward) — no tab to track
            browser.runtime.sendMessage({ analyzeItemResult: true, group, index, success: true }).catch(() => {});
          }
          return;
        }
        if (group === "quickCatalog") {
          if (extractionCache.quickCatalog?.data) {
            const { aiTags, existingTags } = extractionCache.quickCatalog.data;
            if (!Array.isArray(aiTags) || aiTags.length === 0) {
              throw new Error("The AI did not return any tags.");
            }
            const tagNames = aiTags.slice(0, 3);
            const tagKeys = [];
            const appliedNames = [];
            for (const name of tagNames) {
              const existing = existingTags.find(
                t => t.tag.toLowerCase() === name.toLowerCase()
              );
              if (existing) {
                tagKeys.push(existing.key);
                appliedNames.push(existing.tag);
              }
            }
            if (tagKeys.length > 0) {
              const currentMsg = await browser.messages.get(message.id);
              const currentTags = currentMsg.tags || [];
              const mergedTags = [...new Set([...currentTags, ...tagKeys])];
              await browser.messages.update(message.id, { tags: mergedTags });
              browser.notifications.create({
                type: "basic",
                title: "ThunderClerk-AI",
                message: `Tagged: ${appliedNames.join(", ")}`,
              }).catch(() => {});
            }
          } else {
            await catalogEmail(message, emailBody, settings);
          }
          browser.runtime.sendMessage({ analyzeItemResult: true, group, index, success: true }).catch(() => {});
          return;
        }
        if (group === "quickUnsubscribe") {
          const unsub = extractionCache.quickUnsubscribe?.data;
          if (unsub?.https) {
            await browser.windows.openDefaultBrowser(unsub.https);
          } else if (unsub?.mailto) {
            const parsed = new URL(unsub.mailto);
            const to = decodeURIComponent(parsed.pathname);
            const subject = parsed.searchParams.get("subject") || "Unsubscribe";
            const body = parsed.searchParams.get("body") || "";
            await browser.compose.beginNew({ to, subject, body });
          }
          browser.runtime.sendMessage({ analyzeItemResult: true, group, index, success: true }).catch(() => {});
          return;
        }

        // Detected items (events, tasks, contacts)
        const cachedItem = extractionCache[group]?.data?.[index];
        if (cachedItem) {
          if (group === "events") {
            await browser.CalendarTools.openCalendarDialog(pickKeys(cachedItem, CALENDAR_API_KEYS));
          } else if (group === "tasks") {
            await browser.CalendarTools.openTaskDialog(pickKeys(cachedItem, TASK_API_KEYS));
          } else if (group === "contacts") {
            await browser.storage.local.set({
              pendingContact: cachedItem,
              contactAddressBook: settings.contactAddressBook || "",
            });
            const wasSaved = await trackContactOutcome(
              await browser.windows.create({ type: "popup", url: "contact/review.html", width: 420, height: 520 })
            );
            browser.runtime.sendMessage({ analyzeItemResult: true, group, index, success: true, canceled: !wasSaved }).catch(() => {});
            return;
          }
          browser.runtime.sendMessage({ analyzeItemResult: true, group, index, success: true }).catch(() => {});
        } else {
          notifyError("Item not available", "Item data not available — try refreshing.");
          browser.runtime.sendMessage({ analyzeItemResult: true, group, index, success: false, error: "Item data not available" }).catch(() => {});
        }
      } catch (e) {
        console.error(`[ThunderClerk-AI] Cached item action failed (${group}[${index}]):`, e.message);
        browser.runtime.sendMessage({ analyzeItemResult: true, group, index, success: false, error: e.message }).catch(() => {});
      }
      return;
    }

    if (msg.analyzeAction === "useReply" && replyBody) {
      try {
        const composeTab = await openComposeWithReply(message, replyBody, settings);
        const wasSent = await trackComposeOutcome(composeTab);
        browser.runtime.sendMessage({
          analyzeReplyResult: true, sent: wasSent,
        }).catch(() => {});
      } catch (e) {
        console.error("[ThunderClerk-AI] Reply compose failed:", e.message);
        notifyError("Reply error", e.message);
        browser.runtime.sendMessage({
          analyzeReplyResult: true, sent: false, error: e.message,
        }).catch(() => {});
      }
      return;
    }
  };
  browser.runtime.onMessage.addListener(itemListener);

  try {
    const selections = await openAnalyzeDialog(analysis);
    if (!selections) return;
    await executeAnalysisSelections(message, selections);
  } finally {
    browser.runtime.onMessage.removeListener(itemListener);
  }
}

// --- Bulk Triage ---

async function handleBulkTriage(messages, settings) {
  // Singleton — focus existing triage window if one is already open
  if (triageWindowId !== null) {
    try {
      await browser.windows.update(triageWindowId, { focused: true });
      return;
    } catch {
      triageWindowId = null; // window no longer exists
    }
  }
  // Guard against race: multiple clicks before the window is created
  if (triageOpening) return;
  triageOpening = true;

  let triageListener = null;
  try {
  // Gather triage data — cache lookup for each message (no Ollama calls)
  const triageItems = [];
  for (const msg of messages) {
    const cached = await cacheGet(msg.id);
    const item = {
      messageId: msg.id,
      subject: msg.subject || "(no subject)",
      author: msg.author || "",
      date: msg.date ? new Date(msg.date).toISOString() : null,
      cached: !!(cached && cached.raw),
      analysis: null,
    };
    if (cached && cached.raw) {
      const raw = cached.raw;
      item.analysis = {
        summary: raw.summary || "",
        priority: raw.priority || "informational",
        eventCount: Array.isArray(raw.events) ? raw.events.length : 0,
        taskCount: Array.isArray(raw.tasks) ? raw.tasks.length : 0,
        contactCount: Array.isArray(raw.contacts) ? raw.contacts.length : 0,
        tags: Array.isArray(raw.tags) ? raw.tags : [],
        cacheTimestamp: cached.ts,
      };
    }
    triageItems.push(item);
  }

  // Store triage data and open dialog
  await browser.storage.local.set({
    pendingTriage: triageItems,
    triageSelectedCount: messages.length,
  });

  // Non-async listener — returning undefined for non-triage messages avoids
  // claiming the message channel (an async listener always returns a Promise,
  // which interferes with other onMessage listeners like the analyze dialog's).
  let viewInProgress = false;
  triageListener = (msg) => {
    if (!msg || !msg.triageAction) return;

    if (msg.triageAction === "viewAnalysis") {
      if (viewInProgress) return; // prevent multiple analyze windows
      viewInProgress = true;
      (async () => {
        try {
          const message = await browser.messages.get(msg.messageId);
          const full = await browser.messages.getFull(msg.messageId);
          const emailBody = extractTextBody(full);
          if (emailBody) {
            await handleAutoAnalyze(message, emailBody, settings);
          } else {
            notifyError("Empty body", "Could not extract plain text from this message.");
          }
        } catch (e) {
          notifyError("Error", e.message);
        }
        viewInProgress = false;
        browser.runtime.sendMessage({ triageViewDone: true, messageId: msg.messageId }).catch(() => {});
      })();
      return;
    }

    if (msg.triageAction === "archive") {
      (async () => {
        try {
          await browser.messages.archive(msg.messageIds);
          for (const id of msg.messageIds) {
            browser.runtime.sendMessage({ triageArchived: true, messageId: id }).catch(() => {});
          }
        } catch (e) {
          notifyError("Archive error", e.message);
        }
      })();
      return;
    }

    if (msg.triageAction === "delete") {
      (async () => {
        try {
          await browser.messages.delete(msg.messageIds, false);
          for (const id of msg.messageIds) {
            browser.runtime.sendMessage({ triageDeleted: true, messageId: id }).catch(() => {});
          }
        } catch (e) {
          notifyError("Delete error", e.message);
        }
      })();
      return;
    }

    if (msg.triageAction === "queue") {
      bgProcessorEnqueue(msg.messageId);
      browser.runtime.sendMessage({ triageQueued: true, messageId: msg.messageId }).catch(() => {});
      return;
    }

    if (msg.triageAction === "queueAll") {
      const queued = [];
      for (const id of msg.messageIds) {
        bgProcessorEnqueue(id);
        queued.push(id);
      }
      browser.runtime.sendMessage({ triageQueuedAll: true, messageIds: queued }).catch(() => {});
      return;
    }

    if (msg.triageAction === "tagAll") {
      (async () => {
        try {
          const existingTags = await browser.messages.tags.list();
          let taggedCount = 0;
          const allApplied = [];
          for (const item of msg.items) {
            if (!Array.isArray(item.tags) || item.tags.length === 0) continue;
            try {
              const applied = await _applyTags(
                { id: item.messageId }, item.tags, existingTags, { silent: true }
              );
              if (applied && applied.length > 0) {
                taggedCount++;
                allApplied.push(...applied);
              }
            } catch (e) {
              console.warn("[ThunderClerk-AI] Tag failed for message", item.messageId, e.message);
            }
            browser.runtime.sendMessage({
              triageTagged: true, messageId: item.messageId,
            }).catch(() => {});
          }
          if (taggedCount > 0) {
            const unique = [...new Set(allApplied)];
            browser.notifications.create({
              type: "basic",
              title: "ThunderClerk-AI",
              message: `Tagged ${taggedCount} email${taggedCount > 1 ? "s" : ""}: ${unique.join(", ")}`,
            }).catch(() => {});
          }
        } catch (e) {
          notifyError("Tag error", e.message);
        }
      })();
      return;
    }

    if (msg.triageAction === "getAllCached") {
      (async () => {
        try {
          const index = await _getCacheIndex();
          const allItems = [];
          for (const [msgId, meta] of Object.entries(index.entries)) {
            if (meta.status !== "ok") continue;
            const id = Number(msgId);
            let message;
            try {
              message = await browser.messages.get(id);
            } catch {
              continue; // message deleted
            }
            const cached = await cacheGet(id);
            if (!cached || !cached.raw) continue;
            const raw = cached.raw;
            allItems.push({
              messageId: id,
              subject: message.subject || "(no subject)",
              author: message.author || "",
              date: message.date ? new Date(message.date).toISOString() : null,
              cached: true,
              analysis: {
                summary: raw.summary || "",
                priority: raw.priority || "informational",
                eventCount: Array.isArray(raw.events) ? raw.events.length : 0,
                taskCount: Array.isArray(raw.tasks) ? raw.tasks.length : 0,
                contactCount: Array.isArray(raw.contacts) ? raw.contacts.length : 0,
                tags: Array.isArray(raw.tags) ? raw.tags : [],
                cacheTimestamp: cached.ts,
              },
            });
          }
          browser.runtime.sendMessage({ triageAllCached: true, items: allItems }).catch(() => {});
        } catch (e) {
          browser.runtime.sendMessage({ triageAllCached: true, items: [], error: e.message }).catch(() => {});
        }
      })();
      return;
    }
  };
  browser.runtime.onMessage.addListener(triageListener);

  // Open popup and clean up on close
  const win = await browser.windows.create({
    url: browser.runtime.getURL("triage/triage.html"),
    type: "popup",
    width: 680,
    height: 820,
  });
  triageWindowId = win.id;
  triageOpening = false;

  await new Promise((resolve) => {
    const onRemoved = (windowId) => {
      if (windowId === win.id) {
        browser.windows.onRemoved.removeListener(onRemoved);
        triageWindowId = null;
        resolve();
      }
    };
    browser.windows.onRemoved.addListener(onRemoved);
  });

  } finally {
    triageOpening = false;
    if (triageListener) browser.runtime.onMessage.removeListener(triageListener);
    browser.storage.local.remove(["pendingTriage", "triageSelectedCount"]).catch(() => {});
  }
}

// --- Menu click handler ---

browser.menus.onClicked.addListener(async (info, tab) => {
  if (!MENU_IDS.has(info.menuItemId)) return;

  const messages = info.selectedMessages && info.selectedMessages.messages;
  if (!messages || messages.length === 0) {
    notifyError("No message selected", "Please select a message first.");
    return;
  }

  // Queue for Analysis — enqueue selected messages and return early
  if (info.menuItemId === "thunderclerk-ai-queue-analysis") {
    const status = bgProcessorGetStatus();
    if (!status.enabled) {
      notifyError("Background processing disabled",
        "Enable both Auto Analyze and background processing in settings.");
      return;
    }
    let queued = 0;
    for (const msg of messages) {
      bgProcessorEnqueue(msg.id);
      queued++;
    }
    browser.notifications.create({
      type: "basic",
      title: "ThunderClerk-AI",
      message: `Queued ${queued} message${queued === 1 ? "" : "s"} for analysis`,
    }).catch(() => {});
    // Refresh badge to show "queued" indicator on the currently displayed message
    browser.tabs.query({ active: true, currentWindow: true }).then(async (tabs) => {
      for (const t of tabs) {
        try {
          const displayed = await browser.messageDisplay.getDisplayedMessage(t.id);
          if (displayed) updateMessageDisplayBadge(t, displayed);
        } catch {}
      }
    }).catch(() => {});
    return;
  }

  // Bulk Triage — open a priority-sorted summary view for multiple emails
  if (info.menuItemId === "thunderclerk-ai-bulk-triage") {
    const settings = await browser.storage.sync.get(DEFAULTS);
    if (!settings.autoAnalyzeEnabled) {
      notifyError("Auto Analyze disabled", "Enable Auto Analyze in the extension settings to use Bulk Triage.");
      return;
    }
    await handleBulkTriage(messages, settings);
    return;
  }

  const message = messages[0];

  // Load settings
  const settings = await browser.storage.sync.get(DEFAULTS);

  // Get full message body
  let emailBody = "";
  let full = null;
  try {
    full = await browser.messages.getFull(message.id);
    emailBody = extractTextBody(full);
    if (!emailBody) {
      notifyError("Empty body", "Could not extract plain text from this message.");
      return;
    }
  } catch (e) {
    notifyError("Message read error", e.message);
    return;
  }

  // Dispatch to the appropriate handler
  const isCatalog = info.menuItemId === "thunderclerk-ai-catalog-email";
  const isAutoAnalyze = info.menuItemId === "thunderclerk-ai-auto-analyze";

  // Pause background processing while a manual action runs
  const needsManualFlag = !isAutoAnalyze;
  if (needsManualFlag) bgProcessorSetManualFlag(true);

  try {
    if (info.menuItemId === "thunderclerk-ai-add-calendar") {
      await handleCalendar(message, emailBody, settings);
    } else if (info.menuItemId === "thunderclerk-ai-add-task") {
      await handleTask(message, emailBody, settings);
    } else if (info.menuItemId === "thunderclerk-ai-draft-reply") {
      await handleDraftReply(message, emailBody, settings);
    } else if (info.menuItemId === "thunderclerk-ai-summarize-forward") {
      await handleSummarizeForward(message, emailBody, settings);
    } else if (info.menuItemId === "thunderclerk-ai-extract-contact") {
      await handleExtractContact(message, emailBody, settings);
    } else if (isCatalog) {
      await catalogEmail(message, emailBody, settings, full);
    } else if (isAutoAnalyze) {
      if (!settings.autoAnalyzeEnabled) {
        notifyError("Auto Analyze disabled", "Enable Auto Analyze in the extension settings to use this feature.");
        return;
      }
      await handleAutoAnalyze(message, emailBody, settings, full);
    }

    // Auto-tag after any non-catalog, non-analyze action (fire-and-forget)
    if (!isCatalog && !isAutoAnalyze && settings.autoTagAfterAction) {
      catalogEmail(message, emailBody, settings, full).catch(e =>
        console.warn("[ThunderClerk-AI] Auto-tag failed:", e.message)
      );
    }
  } catch (e) {
    if (e.message?.includes("invalid JSON") || e.message?.includes("No JSON object") || e.message?.includes("Unclosed JSON")) {
      console.error("[ThunderClerk-AI] JSON parse failed:", e.message);
      notifyError("Parse error", "Model returned invalid JSON. Check the browser console for details.");
    } else {
      notifyError("Error", e.message);
    }
  } finally {
    if (needsManualFlag) bgProcessorSetManualFlag(false);
  }
});

// --- Message display action button (header toolbar) ---

browser.messageDisplayAction.onClicked.addListener(async (tab) => {
  // Check if Auto Analyze is enabled
  const { autoAnalyzeEnabled } = await browser.storage.sync.get({ autoAnalyzeEnabled: DEFAULTS.autoAnalyzeEnabled });
  if (!autoAnalyzeEnabled) {
    notifyError("Auto Analyze disabled", "Enable Auto Analyze in the extension settings to use this feature.");
    return;
  }

  let message;
  try {
    message = await browser.messageDisplay.getDisplayedMessage(tab.id);
  } catch {
    // Not viewing a message
  }

  if (!message) {
    notifyError("No message displayed", "Open or select a message first.");
    return;
  }

  const settings = await browser.storage.sync.get(DEFAULTS);

  let emailBody = "";
  let full = null;
  try {
    full = await browser.messages.getFull(message.id);
    emailBody = extractTextBody(full);
    if (!emailBody) {
      notifyError("Empty body", "Could not extract plain text from this message.");
      return;
    }
  } catch (e) {
    notifyError("Message read error", e.message);
    return;
  }

  try {
    await handleAutoAnalyze(message, emailBody, settings, full);
  } catch (e) {
    if (e.message?.includes("invalid JSON") || e.message?.includes("No JSON object") || e.message?.includes("Unclosed JSON")) {
      console.error("[ThunderClerk-AI] JSON parse failed:", e.message);
      notifyError("Parse error", "Model returned invalid JSON. Check the browser console for details.");
    } else {
      notifyError("Error", e.message);
    }
  }
});

// --- Message display action badge updates ---

// Update the badge on the message display action button when a message is viewed.
// Shows the number of detected items if cached, "..." if processing, nothing otherwise.
async function updateMessageDisplayBadge(tab, message) {
  const tabId = tab.id;
  try {
    const { autoAnalyzeEnabled } = await browser.storage.sync.get({ autoAnalyzeEnabled: DEFAULTS.autoAnalyzeEnabled });
    if (!autoAnalyzeEnabled) {
      browser.messageDisplayAction.setBadgeText({ tabId, text: "" });
      return;
    }

    if (!message) {
      browser.messageDisplayAction.setBadgeText({ tabId, text: "" });
      return;
    }

    // Check if currently in the processing queue
    const inQueue = bgQueue.some(item => item.messageId === message.id);

    const cached = await cacheGet(message.id);
    if (cached && cached.raw) {
      // Count detected items
      const raw = cached.raw;
      let count = 0;
      if (Array.isArray(raw.events))   count += raw.events.length;
      if (Array.isArray(raw.tasks))    count += raw.tasks.length;
      if (Array.isArray(raw.contacts)) count += raw.contacts.length;

      if (count > 0) {
        const priorityColors = {
          urgent:          "#F44336",  // red
          "action-needed": "#FF9800",  // orange
          informational:   "#4CAF50",  // green
          low:             "#9E9E9E",  // grey
        };
        const badgeColor = priorityColors[raw.priority] || "#4CAF50";
        browser.messageDisplayAction.setBadgeText({ tabId, text: String(count) });
        browser.messageDisplayAction.setBadgeBackgroundColor({ tabId, color: badgeColor });
      } else {
        // Cached but nothing found — show a check mark via empty badge
        browser.messageDisplayAction.setBadgeText({ tabId, text: "✓" });
        browser.messageDisplayAction.setBadgeBackgroundColor({ tabId, color: "#9E9E9E" });
      }
    } else if (inQueue) {
      browser.messageDisplayAction.setBadgeText({ tabId, text: "…" });
      browser.messageDisplayAction.setBadgeBackgroundColor({ tabId, color: "#FF9800" });
    } else {
      // Check index for error status
      const index = await _getCacheIndex();
      const entry = index.entries[message.id];
      if (entry && entry.status === "error") {
        browser.messageDisplayAction.setBadgeText({ tabId, text: "!" });
        browser.messageDisplayAction.setBadgeBackgroundColor({ tabId, color: "#F44336" });
      } else {
        browser.messageDisplayAction.setBadgeText({ tabId, text: "" });
      }
    }
  } catch (e) {
    // Badge updates are best-effort
    if (DEBUG) console.warn("[ThunderClerk-AI] Badge update error:", e.message);
  }
}

browser.messageDisplay.onMessageDisplayed.addListener((tab, message) => {
  updateMessageDisplayBadge(tab, message);
});

// Also refresh badge when a background processing item finishes.
// We hook into cacheSet by listening for storage changes on cache keys.
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;

  // Check if any cache_* keys changed (a new cache entry was written)
  const cacheKeysChanged = Object.keys(changes).some(k => k.startsWith("cache_"));
  if (!cacheKeysChanged) return;

  // Refresh badge for the currently displayed message in each mail tab
  browser.tabs.query({ active: true, currentWindow: true }).then(async (tabs) => {
    for (const tab of tabs) {
      try {
        const message = await browser.messageDisplay.getDisplayedMessage(tab.id);
        if (message) {
          updateMessageDisplayBadge(tab, message);
        }
      } catch {
        // Tab might not be displaying a message
      }
    }
  }).catch(() => {});
});

// --- Background processor status handler ---

browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.action === "getBgStatus") {
    (async () => {
      const status = bgProcessorGetStatus();
      const stats = await cacheGetStats();
      sendResponse({ ...status, ...stats });
    })();
    return true;
  }
  if (msg && msg.action === "clearBgCache") {
    (async () => {
      const removed = await cacheClearAll();
      console.log(`[ThunderClerk-AI] Cache cleared: ${removed} entries removed`);
      sendResponse({ removed });
    })();
    return true;
  }
  if (msg && msg.action === "stopBgProcessor") {
    bgProcessorStop();
    sendResponse({ ok: true });
    return true;
  }
  if (msg && msg.action === "startBgProcessor") {
    bgProcessorStart();
    sendResponse({ ok: true });
    return true;
  }
  if (msg && msg.action === "stripPresetTags") {
    (async () => {
      try {
        const allTags = await browser.messages.tags.list();
        const presetKeys = new Set(allTags.filter(t => t.key.startsWith("$label_tc_")).map(t => t.key));
        if (presetKeys.size === 0) { sendResponse({ count: 0 }); return; }

        const tagsQuery = {};
        for (const key of presetKeys) tagsQuery[key] = true;
        let page = await browser.messages.query({ tags: { mode: "any", tags: tagsQuery } });
        let stripped = 0;
        do {
          for (const msg of page.messages) {
            const kept = (msg.tags || []).filter(k => !presetKeys.has(k));
            if (kept.length < (msg.tags || []).length) {
              await browser.messages.update(msg.id, { tags: kept });
              stripped++;
            }
          }
          if (page.id) { page = await browser.messages.continueList(page.id); } else break;
        } while (page.messages.length > 0);

        sendResponse({ count: stripped });
      } catch (e) {
        sendResponse({ error: e.message });
      }
    })();
    return true;
  }
});

// --- Initialize background processor ---

initBgProcessor();
