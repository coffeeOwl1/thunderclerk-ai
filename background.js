"use strict";

const DEBUG = false;

const DEFAULT_HOST = "http://127.0.0.1:11434";

// DEFAULTS is defined in config.js, loaded before this script.

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

// Show/hide Auto Analyze menu item based on setting
async function syncAutoAnalyzeMenu() {
  const { autoAnalyzeEnabled } = await browser.storage.sync.get({ autoAnalyzeEnabled: DEFAULTS.autoAnalyzeEnabled });
  browser.menus.update("thunderclerk-ai-auto-analyze", { visible: !!autoAnalyzeEnabled });
  // Also hide/show the separator before it
  browser.menus.update("thunderclerk-ai-sep-4", { visible: !!autoAnalyzeEnabled });
}
syncAutoAnalyzeMenu();

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.autoAnalyzeEnabled) {
    syncAutoAnalyzeMenu();
  }
});

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

  const parsed = await callOllamaWithNotification(host, model, prompt, "extract event details", settings);

  applyEventSettings(parsed, message, emailBody, settings);

  await browser.CalendarTools.openCalendarDialog(parsed);
}

async function handleTask(message, emailBody, settings) {
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

  const parsed = await callOllamaWithNotification(host, model, prompt, "extract task details", settings);

  applyTaskSettings(parsed, message, emailBody, settings);

  await browser.CalendarTools.openTaskDialog(parsed);
}

async function handleDraftReply(message, emailBody, settings) {
  const host      = settings.ollamaHost  || DEFAULT_HOST;
  const model     = settings.ollamaModel || DEFAULTS.ollamaModel;
  const replyMode = settings.replyMode   || "replyToSender";
  const author    = message.author || "";
  const subject   = message.subject || "";

  const prompt = buildDraftReplyPrompt(emailBody, subject, author);
  const parsed = await callOllamaWithNotification(host, model, prompt, "draft a reply", settings);

  const replyBody = (parsed.body || "").trim();
  if (!replyBody) {
    notifyError("Empty reply", "The AI returned an empty reply body.");
    return;
  }

  // Open compose window as reply
  const composeTab = await browser.compose.beginReply(message.id, replyMode);

  // Get the existing compose body (contains quoted original)
  const details = await browser.compose.getComposeDetails(composeTab.id);

  // Convert AI reply to HTML and prepend before quoted original
  const escapedBody = replyBody
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");

  const newBody = `<p>${escapedBody}</p><br>` + (details.body || "");
  await browser.compose.setComposeDetails(composeTab.id, { body: newBody });
}

async function handleSummarizeForward(message, emailBody, settings) {
  const host   = settings.ollamaHost  || DEFAULT_HOST;
  const model  = settings.ollamaModel || DEFAULTS.ollamaModel;
  const author = message.author || "";
  const subject = message.subject || "";

  const prompt = buildSummarizeForwardPrompt(emailBody, subject, author);
  const parsed = await callOllamaWithNotification(host, model, prompt, "summarize the email", settings);

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
  const host   = settings.ollamaHost  || DEFAULT_HOST;
  const model  = settings.ollamaModel || DEFAULTS.ollamaModel;
  const author = message.author || "";
  const subject = message.subject || "";

  const prompt = buildContactPrompt(emailBody, subject, author);
  const parsed = await callOllamaWithNotification(host, model, prompt, "extract contact info", settings);

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

// --- Tag color palette for newly created tags ---

const TAG_COLORS = [
  "#3366CC", "#DC3912", "#FF9900", "#109618", "#990099",
  "#0099C6", "#DD4477", "#66AA00", "#B82E2E", "#316395",
];
let tagColorIndex = 0;

function nextTagColor() {
  const color = TAG_COLORS[tagColorIndex % TAG_COLORS.length];
  tagColorIndex++;
  return color;
}

// --- Catalog email (AI-powered tagging) ---

async function catalogEmail(message, emailBody, settings) {
  const host  = settings.ollamaHost  || DEFAULT_HOST;
  const model = settings.ollamaModel || DEFAULTS.ollamaModel;
  const author  = message.author  || "";
  const subject = message.subject || "";

  // Fetch existing tags
  const existingTags = await browser.messages.tags.list();
  const existingTagNames = existingTags.map(t => t.tag);

  const prompt = buildCatalogPrompt(emailBody, subject, author, existingTagNames);
  const parsed = await callOllamaWithNotification(host, model, prompt, "catalog email", settings);

  const aiTags = parsed.tags;
  if (!Array.isArray(aiTags) || aiTags.length === 0) {
    notifyError("No tags", "The AI did not return any tags.");
    return;
  }

  // Limit to 3 tags
  const tagNames = aiTags.slice(0, 3);

  // Resolve each tag: find existing (case-insensitive) or create new
  const allowNew = !!settings.allowNewTags;
  const tagKeys = [];
  const appliedNames = [];
  for (const name of tagNames) {
    const existing = existingTags.find(
      t => t.tag.toLowerCase() === name.toLowerCase()
    );
    if (existing) {
      tagKeys.push(existing.key);
      appliedNames.push(existing.tag);
    } else if (allowNew) {
      // Create new tag with a rotating color
      const key = "$label_tc_" + name.toLowerCase().replace(/[^a-z0-9]/g, "_");
      try {
        await browser.messages.tags.create(key, name, nextTagColor());
        tagKeys.push(key);
        appliedNames.push(name);
      } catch (e) {
        // Tag may already exist with that key (race condition)
        console.warn("[ThunderClerk-AI] Could not create tag:", e.message);
        const retry = existingTags.find(t => t.key === key);
        if (retry) {
          tagKeys.push(retry.key);
          appliedNames.push(retry.tag);
        }
      }
    }
  }

  if (tagKeys.length === 0) return;

  // Read-merge-write: messages.update replaces all tags, so preserve existing
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

function openAnalyzeDialog(analysis) {
  return new Promise((resolve) => {
    browser.storage.local.set({ pendingAnalysis: analysis }).then(() => {
      const listener = (msg) => {
        if (msg && msg.analyzeAction) {
          browser.runtime.onMessage.removeListener(listener);
          browser.storage.local.remove("pendingAnalysis").catch(() => {});
          if (msg.analyzeAction === "ok") {
            resolve(msg.selections);
          } else {
            resolve(null);
          }
        }
      };
      browser.runtime.onMessage.addListener(listener);

      browser.windows.create({
        url: browser.runtime.getURL("analyze/analyze.html"),
        type: "popup",
        width: 580,
        height: 640,
      }).then((win) => {
        const onRemoved = (windowId) => {
          if (windowId === win.id) {
            browser.windows.onRemoved.removeListener(onRemoved);
            browser.runtime.onMessage.removeListener(listener);
            browser.storage.local.remove("pendingAnalysis").catch(() => {});
            resolve(null);
          }
        };
        browser.windows.onRemoved.addListener(onRemoved);
      });
    });
  });
}

async function executeAnalysisSelections(message, emailBody, settings, analysis, selections) {
  const host    = settings.ollamaHost  || DEFAULT_HOST;
  const model   = settings.ollamaModel || DEFAULTS.ollamaModel;
  const author  = message.author  || "";
  const subject = message.subject || "";
  const mailDatetime = formatDatetime(message.date);
  const currentDt    = currentDatetime();

  // --- Calendar events ---
  if (selections.events && selections.events.length > 0 && analysis.events) {
    try {
      const attendeesSource = settings.attendeesSource || "from_to";
      const attendeesStatic = settings.attendeesStatic || "";
      const attendeeHints   = buildAttendeesHint(message, attendeesSource, attendeesStatic);
      const calendarUseCategory = !!settings.calendarUseCategory;

      let categories = null;
      if (calendarUseCategory) {
        try { categories = await browser.CalendarTools.getCategories(); } catch {}
      }

      const wantAiDescription = (settings.descriptionFormat || "body_from_subject") === "ai_summary";
      const prompt = buildCalendarArrayPrompt(
        emailBody, subject, mailDatetime, currentDt, attendeeHints,
        categories, wantAiDescription, analysis.events, selections.events
      );
      const parsed = await callOllamaWithNotification(host, model, prompt, "extract event details", settings);
      const events = parsed.events || [parsed];

      for (const evt of events) {
        applyEventSettings(evt, message, emailBody, settings);
        await browser.CalendarTools.openCalendarDialog(evt);
      }
    } catch (e) {
      console.error("[ThunderClerk-AI] Auto Analyze — calendar extraction failed:", e.message);
      notifyError("Calendar error", e.message);
    }
  }

  // --- Tasks ---
  if (selections.tasks && selections.tasks.length > 0 && analysis.tasks) {
    try {
      const taskUseCategory = !!settings.taskUseCategory;
      let categories = null;
      if (taskUseCategory) {
        try { categories = await browser.CalendarTools.getCategories(); } catch {}
      }

      const wantAiDescription = (settings.taskDescriptionFormat || "body_from_subject") === "ai_summary";
      const prompt = buildTaskArrayPrompt(
        emailBody, subject, mailDatetime, currentDt,
        categories, wantAiDescription, analysis.tasks, selections.tasks
      );
      const parsed = await callOllamaWithNotification(host, model, prompt, "extract task details", settings);
      const tasks = parsed.tasks || [parsed];

      for (const task of tasks) {
        applyTaskSettings(task, message, emailBody, settings);
        await browser.CalendarTools.openTaskDialog(task);
      }
    } catch (e) {
      console.error("[ThunderClerk-AI] Auto Analyze — task extraction failed:", e.message);
      notifyError("Task error", e.message);
    }
  }

  // --- Contacts ---
  if (selections.contacts && selections.contacts.length > 0 && analysis.contacts) {
    try {
      const prompt = buildContactArrayPrompt(
        emailBody, subject, author, analysis.contacts, selections.contacts
      );
      const parsed = await callOllamaWithNotification(host, model, prompt, "extract contact info", settings);
      const contacts = parsed.contacts || [parsed];

      for (const contact of contacts) {
        await browser.storage.local.set({
          pendingContact: contact,
          contactAddressBook: settings.contactAddressBook || "",
        });
        // Open review window and wait for it to close before the next one
        await new Promise((resolve) => {
          browser.windows.create({
            type: "popup",
            url: "contact/review.html",
            width: 420,
            height: 520,
          }).then((win) => {
            const onRemoved = (windowId) => {
              if (windowId === win.id) {
                browser.windows.onRemoved.removeListener(onRemoved);
                resolve();
              }
            };
            browser.windows.onRemoved.addListener(onRemoved);
          });
        });
      }
    } catch (e) {
      console.error("[ThunderClerk-AI] Auto Analyze — contact extraction failed:", e.message);
      notifyError("Contact error", e.message);
    }
  }

  // --- Force overrides (single-extraction fallbacks) ---
  if (selections.forceCalendar) {
    try {
      await handleCalendar(message, emailBody, settings);
    } catch (e) {
      console.error("[ThunderClerk-AI] Auto Analyze — force calendar failed:", e.message);
      notifyError("Calendar error", e.message);
    }
  }

  if (selections.forceTask) {
    try {
      await handleTask(message, emailBody, settings);
    } catch (e) {
      console.error("[ThunderClerk-AI] Auto Analyze — force task failed:", e.message);
      notifyError("Task error", e.message);
    }
  }

  if (selections.forceContact) {
    try {
      await handleExtractContact(message, emailBody, settings);
    } catch (e) {
      console.error("[ThunderClerk-AI] Auto Analyze — force contact failed:", e.message);
      notifyError("Contact error", e.message);
    }
  }

  // --- Reply ---
  if (selections.reply) {
    try {
      await handleDraftReply(message, emailBody, settings);
    } catch (e) {
      console.error("[ThunderClerk-AI] Auto Analyze — reply failed:", e.message);
      notifyError("Reply error", e.message);
    }
  }

  // --- Summarize & Forward ---
  if (selections.forward) {
    try {
      await handleSummarizeForward(message, emailBody, settings);
    } catch (e) {
      console.error("[ThunderClerk-AI] Auto Analyze — forward failed:", e.message);
      notifyError("Forward error", e.message);
    }
  }

  // --- Catalog ---
  if (selections.catalog) {
    try {
      await catalogEmail(message, emailBody, settings);
    } catch (e) {
      console.error("[ThunderClerk-AI] Auto Analyze — catalog failed:", e.message);
      notifyError("Catalog error", e.message);
    }
  }

  // --- Archive / Delete (always last, mutually exclusive) ---
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

async function handleAutoAnalyze(message, emailBody, settings) {
  const host   = settings.ollamaHost  || DEFAULT_HOST;
  const model  = settings.ollamaModel || DEFAULTS.ollamaModel;
  const author = message.author || "";
  const subject = message.subject || "";
  const mailDatetime = formatDatetime(message.date);
  const currentDt    = currentDatetime();

  // Stage 1: get summary + detected item previews
  // Use higher num_predict for analysis — reasoning/thinking models consume tokens
  // on internal chain-of-thought before producing visible output, so the budget
  // must cover both thinking and the JSON response.
  // num_ctx: 16384 ensures the full prompt + generation fits in context (default
  // is often 4096-8192 which overflows on long emails).
  const MAX_ANALYSIS_BODY = 12000;
  let analysisBody = emailBody;
  if (analysisBody.length > MAX_ANALYSIS_BODY) {
    analysisBody = analysisBody.slice(0, MAX_ANALYSIS_BODY) +
      "\n\n[… email truncated — there may be additional items beyond this point]";
  }
  const prompt = buildAnalysisPrompt(analysisBody, subject, author, mailDatetime, currentDt);

  if (settings && settings.debugPromptPreview) {
    await previewPrompt(prompt);
  }

  const MAX_ANALYSIS_ATTEMPTS = 2;
  let analysis = null;

  for (let attempt = 1; attempt <= MAX_ANALYSIS_ATTEMPTS; attempt++) {
    const actionLabel = attempt === 1
      ? "analyze the email"
      : `retry analysis (attempt ${attempt})`;
    const progress = createProgressNotifier(actionLabel, model);
    progress.start();

    let rawResponse;
    try {
      rawResponse = await callOllama(host, model, prompt, { num_predict: 12288, num_ctx: 16384 });
    } catch (e) {
      progress.stop();
      if (attempt === MAX_ANALYSIS_ATTEMPTS) throw e;
      console.warn(`[ThunderClerk-AI] Analysis attempt ${attempt} failed:`, e.message);
      continue;
    }
    progress.stop();

    try {
      const jsonStr = extractJSON(rawResponse);
      analysis = JSON.parse(jsonStr);
    } catch {
      // LLM output may be truncated — try to repair
      console.warn("[ThunderClerk-AI] Analysis raw response (first 2000 chars):", rawResponse?.substring(0, 2000));
      console.warn("[ThunderClerk-AI] Analysis raw response (last 500 chars):", rawResponse?.slice(-500));
      analysis = repairAnalysisJSON(rawResponse);
      if (analysis) {
        console.log("[ThunderClerk-AI] Repaired truncated analysis JSON — got", Object.keys(analysis).join(", "));
      }
    }

    if (analysis) break;
    console.warn(`[ThunderClerk-AI] Analysis attempt ${attempt} produced invalid JSON, retrying…`);
  }

  if (!analysis) {
    throw new Error("invalid JSON in analysis response (all attempts failed)");
  }

  if (!analysis.summary) analysis.summary = subject;

  // Normalize items — LLMs may return different key names for the preview
  for (const key of ["events", "tasks", "contacts"]) {
    if (Array.isArray(analysis[key])) {
      analysis[key] = analysis[key].map(item => {
        if (typeof item === "string") return { preview: item };
        if (!item.preview) {
          item.preview = item.title || item.name || item.description
            || item.summary || item.label || "";
        }
        return item;
      });
    }
  }

  // Open dialog for user to select items
  const selections = await openAnalyzeDialog(analysis);

  if (!selections) return; // cancelled

  // Stage 2: extract full data for selected items and execute
  await executeAnalysisSelections(message, emailBody, settings, analysis, selections);
}

// --- Menu click handler ---

browser.menus.onClicked.addListener(async (info, tab) => {
  if (!MENU_IDS.has(info.menuItemId)) return;

  const messages = info.selectedMessages && info.selectedMessages.messages;
  if (!messages || messages.length === 0) {
    notifyError("No message selected", "Please select a message first.");
    return;
  }
  const message = messages[0];

  // Load settings
  const settings = await browser.storage.sync.get(DEFAULTS);

  // Get full message body
  let emailBody = "";
  try {
    const full = await browser.messages.getFull(message.id);
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
      await catalogEmail(message, emailBody, settings);
    } else if (isAutoAnalyze) {
      if (!settings.autoAnalyzeEnabled) {
        notifyError("Auto Analyze disabled", "Enable Auto Analyze in the extension settings to use this feature.");
        return;
      }
      await handleAutoAnalyze(message, emailBody, settings);
    }

    // Auto-tag after any non-catalog, non-analyze action (fire-and-forget)
    if (!isCatalog && !isAutoAnalyze && settings.autoTagAfterAction) {
      catalogEmail(message, emailBody, settings).catch(e =>
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
  }
});

// --- Keyboard shortcut handler ---

browser.commands.onCommand.addListener(async (command) => {
  if (command !== "auto-analyze") return;

  // Check if Auto Analyze is enabled
  const { autoAnalyzeEnabled } = await browser.storage.sync.get({ autoAnalyzeEnabled: DEFAULTS.autoAnalyzeEnabled });
  if (!autoAnalyzeEnabled) {
    notifyError("Auto Analyze disabled", "Enable Auto Analyze in the extension settings to use this feature.");
    return;
  }

  let message;
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tabs || tabs.length === 0) return;
    message = await browser.messageDisplay.getDisplayedMessage(tabs[0].id);
  } catch {
    // Not viewing a message
  }

  if (!message) {
    notifyError("No message displayed", "Open or select a message first.");
    return;
  }

  const settings = await browser.storage.sync.get(DEFAULTS);

  let emailBody = "";
  try {
    const full = await browser.messages.getFull(message.id);
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
    await handleAutoAnalyze(message, emailBody, settings);
  } catch (e) {
    if (e.message?.includes("invalid JSON") || e.message?.includes("No JSON object") || e.message?.includes("Unclosed JSON")) {
      console.error("[ThunderClerk-AI] JSON parse failed:", e.message);
      notifyError("Parse error", "Model returned invalid JSON. Check the browser console for details.");
    } else {
      notifyError("Error", e.message);
    }
  }
});
