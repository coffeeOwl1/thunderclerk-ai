"use strict";

const DEBUG = false;

const DEFAULT_HOST = "http://127.0.0.1:11434";

const DEFAULTS = {
  ollamaHost:              DEFAULT_HOST,
  ollamaModel:             "mistral:7b",
  // Calendar event settings
  attendeesSource:         "from_to",          // "from_to" | "from" | "to" | "static" | "none"
  attendeesStatic:         "",
  defaultCalendar:         "",                 // "" = use currently selected
  descriptionFormat:       "body_from_subject", // "body_from_subject" | "body" | "none" | "ai_summary"
  // Task settings
  taskDescriptionFormat:   "body_from_subject", // "body_from_subject" | "body" | "none" | "ai_summary"
  taskDefaultDue:          "none",             // "none" | "7" | "14" | "30" (days from now)
  // Category settings
  calendarUseCategory:     false,
  taskUseCategory:         false,
  // Debug settings
  debugPromptPreview:      false,
};

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

browser.menus.create({
  id: "thunderclerk-ai-add-calendar",
  title: "Add to Calendar",
  contexts: ["message_list"],
});

browser.menus.create({
  id: "thunderclerk-ai-add-task",
  title: "Add as Task",
  contexts: ["message_list"],
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

// buildCalendarPrompt and buildTaskPrompt are defined in utils.js,
// which is loaded before this script in the extension manifest.

async function callOllama(host, model, prompt) {
  if (!isValidHostUrl(host)) {
    throw new Error(`Invalid Ollama host URL: "${host}". Check the extension settings.`);
  }
  const url = host.replace(/\/$/, "") + "/api/generate";
  if (DEBUG) console.log("[ThunderClerk-AI] Calling Ollama", { url, model, promptLen: prompt.length });

  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), 60_000);

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt, stream: false }),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timeoutId);
    if (e.name === "AbortError") throw new Error("Ollama request timed out after 60 seconds.");
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

// --- Menu click handler ---

browser.menus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "thunderclerk-ai-add-calendar" && info.menuItemId !== "thunderclerk-ai-add-task") {
    return;
  }

  const isCalendar = info.menuItemId === "thunderclerk-ai-add-calendar";

  const messages = info.selectedMessages && info.selectedMessages.messages;
  if (!messages || messages.length === 0) {
    notifyError("No message selected", "Please select a message first.");
    return;
  }
  const message = messages[0];

  // Load settings
  const settings = await browser.storage.sync.get(DEFAULTS);
  const host                  = settings.ollamaHost            || DEFAULT_HOST;
  const model                 = settings.ollamaModel           || DEFAULTS.ollamaModel;
  const attendeesSource       = settings.attendeesSource       || "from_to";
  const attendeesStatic       = settings.attendeesStatic       || "";
  const defaultCalendar       = settings.defaultCalendar       || "";
  const descriptionFormat     = settings.descriptionFormat     || "body_from_subject";
  const taskDescriptionFormat = settings.taskDescriptionFormat || "body_from_subject";
  const taskDefaultDue        = settings.taskDefaultDue        || "none";
  const calendarUseCategory   = !!settings.calendarUseCategory;
  const taskUseCategory       = !!settings.taskUseCategory;

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

  // Build context values
  const mailDatetime  = formatDatetime(message.date);
  const currentDt     = currentDatetime();
  const author        = message.author || "";
  const subject       = message.subject || "";
  const attendeeHints = buildAttendeesHint(message, attendeesSource, attendeesStatic);

  // Fetch categories if the user opted in for this action type
  let categories = null;
  const wantCategories = isCalendar ? calendarUseCategory : taskUseCategory;
  if (wantCategories) {
    try {
      categories = await browser.CalendarTools.getCategories();
    } catch (e) {
      console.warn("[ThunderClerk-AI] Could not fetch categories, proceeding without:", e.message);
    }
  }

  // Build prompt
  const wantAiDescription = isCalendar
    ? descriptionFormat === "ai_summary"
    : taskDescriptionFormat === "ai_summary";
  const prompt = isCalendar
    ? buildCalendarPrompt(emailBody, subject, mailDatetime, currentDt, attendeeHints, categories, wantAiDescription)
    : buildTaskPrompt(emailBody, subject, mailDatetime, currentDt, categories, wantAiDescription);

  // Debug: show prompt preview if enabled
  if (settings.debugPromptPreview) {
    try {
      await previewPrompt(prompt);
    } catch (e) {
      // User cancelled or closed the preview window
      return;
    }
  }

  // Call Ollama — show a progress notification while we wait
  const THINKING_ID = "thunderclerk-ai-thinking";
  browser.notifications.create(THINKING_ID, {
    type: "basic",
    title: "ThunderClerk-AI",
    message: `Asking ${model} to extract ${isCalendar ? "event" : "task"} details…`,
  }).catch(() => {});

  let rawResponse;
  try {
    rawResponse = await callOllama(host, model, prompt);
  } catch (e) {
    browser.notifications.clear(THINKING_ID).catch(() => {});
    notifyError("Ollama error", e.message);
    return;
  }
  browser.notifications.clear(THINKING_ID).catch(() => {});

  // Parse JSON
  let parsed;
  try {
    const jsonStr = extractJSON(rawResponse);
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    console.error("[ThunderClerk-AI] JSON parse failed:", e.message, "\nRaw response:", rawResponse);
    notifyError("Parse error", "Model returned invalid JSON. Check the browser console for details.");
    return;
  }

  // Open dialog
  if (isCalendar) {
    normalizeCalendarData(parsed);

    // If the model returned a training-data year older than the email year, fix it.
    const refYear = parseInt(currentDt.slice(-4), 10);
    if (parsed.startDate) parsed.startDate = advancePastYear(parsed.startDate, refYear);
    if (parsed.endDate)   parsed.endDate   = advancePastYear(parsed.endDate,   refYear);

    // Fall back to email subject when the model omits the summary field.
    if (!parsed.summary) parsed.summary = subject;

    applyCalendarDefaults(parsed);

    // Inject description
    if (descriptionFormat === "ai_summary") {
      // Keep the AI-extracted description; fall back to subject if absent
      if (!parsed.description) parsed.description = subject;
    } else {
      const description = buildDescription(emailBody, author, subject, descriptionFormat);
      if (description) parsed.description = description;
    }

    // Inject calendar preference
    if (defaultCalendar) parsed.calendar_name = defaultCalendar;

    // For "static" or "none" attendees, override whatever the AI returned
    if (attendeesSource === "static") {
      parsed.attendees = attendeesStatic ? [attendeesStatic] : [];
    } else if (attendeesSource === "none") {
      parsed.attendees = [];
    }
  } else {
    normalizeTaskData(parsed);

    // Apply default due date if the model didn't find one and user configured a fallback
    if (!parsed.dueDate && taskDefaultDue !== "none") {
      const future = new Date();
      future.setDate(future.getDate() + parseInt(taskDefaultDue, 10));
      const y  = future.getFullYear();
      const mo = String(future.getMonth() + 1).padStart(2, "0");
      const d  = String(future.getDate()).padStart(2, "0");
      parsed.dueDate = `${y}${mo}${d}T120000`;
    }

    // Description for tasks
    if (taskDescriptionFormat === "ai_summary") {
      if (!parsed.description) parsed.description = subject;
    } else {
      const taskDescription = buildDescription(emailBody, author, subject, taskDescriptionFormat);
      if (taskDescription) parsed.description = taskDescription;
    }
  }

  // iCal all-day events use an exclusive DTEND (the day *after* the last
  // visible day). Advance endDate by 1 day for multi-day all-day events so
  // Thunderbird displays the correct last day.  Single-day events
  // (startDate === endDate) are left alone — Thunderbird handles those correctly.
  if (isCalendar && parsed.forceAllDay && parsed.endDate && parsed.endDate !== parsed.startDate) {
    parsed.endDate = addHoursToCalDate(parsed.endDate, 24);
  }

  try {
    if (isCalendar) {
      await browser.CalendarTools.openCalendarDialog(parsed);
    } else {
      await browser.CalendarTools.openTaskDialog(parsed);
    }
  } catch (e) {
    notifyError("Dialog error", e.message);
  }
});
