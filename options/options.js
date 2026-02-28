"use strict";

// DEFAULTS is defined in config.js, loaded before this script.

// --- Model size + info caches ---

const modelSizeMap = {};    // modelName → file size in bytes
let modelInfoCache = {};    // modelName → { blockCount, headCount, headCountKv, embeddingLength }

// --- Model list from Ollama ---

async function populateModels(selectEl, savedModel) {
  const host = document.getElementById("ollamaHost").value.trim() || DEFAULTS.ollamaHost;

  while (selectEl.options.length > 0) selectEl.remove(0);

  let models = [];
  try {
    const resp = await fetch(host.replace(/\/$/, "") + "/api/tags");
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    // Capture model sizes for VRAM estimation
    for (const m of (data.models || [])) {
      if (m.name && m.size) modelSizeMap[m.name] = m.size;
    }
    models = (data.models || []).map(m => m.name).sort();
  } catch (e) {
    console.error("[ThunderClerk-AI] Could not fetch models:", e);
    // Show saved model so the user isn't left with an empty select
    if (savedModel) {
      const opt = document.createElement("option");
      opt.value = savedModel;
      opt.textContent = savedModel;
      selectEl.appendChild(opt);
    }
    const err = document.createElement("option");
    err.value = "";
    err.textContent = "(could not reach Ollama — check host URL)";
    err.disabled = true;
    selectEl.appendChild(err);
    if (savedModel) selectEl.value = savedModel;
    return;
  }

  if (models.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "(no models found — run: ollama pull <model>)";
    opt.disabled = true;
    selectEl.appendChild(opt);
    return;
  }

  for (const name of models) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    selectEl.appendChild(opt);
  }

  // If the saved model isn't in the list (e.g. was deleted), add it with a note
  if (savedModel && !models.includes(savedModel)) {
    const opt = document.createElement("option");
    opt.value = savedModel;
    opt.textContent = savedModel + " (not in Ollama)";
    selectEl.insertBefore(opt, selectEl.firstChild);
  }

  if (savedModel) {
    selectEl.value = savedModel;
    if (!selectEl.value) selectEl.selectedIndex = 0;
  } else {
    selectEl.selectedIndex = 0;
  }
}

// --- Calendar list ---

async function populateCalendars(selectEl, savedName) {
  while (selectEl.options.length > 1) selectEl.remove(1);

  let calendars = [];
  try {
    calendars = await browser.CalendarTools.getCalendars();
  } catch (e) {
    console.error("[ThunderClerk-AI] getCalendars failed:", e);
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "(could not read calendars — is the extension fully loaded?)";
    opt.disabled = true;
    selectEl.appendChild(opt);
    return;
  }

  for (const cal of calendars) {
    const opt = document.createElement("option");
    opt.value = cal.name;
    opt.textContent = cal.name;
    selectEl.appendChild(opt);
  }

  if (savedName) {
    selectEl.value = savedName;
    if (selectEl.value !== savedName) selectEl.value = "";
  }
}

// --- Address book list ---

async function populateAddressBooks(selectEl, savedId) {
  while (selectEl.options.length > 1) selectEl.remove(1);

  let books = [];
  try {
    books = await browser.addressBooks.list();
  } catch (e) {
    console.error("[ThunderClerk-AI] Could not list address books:", e);
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "(could not read address books)";
    opt.disabled = true;
    selectEl.appendChild(opt);
    return;
  }

  const writable = books.filter(b => !b.readOnly);

  for (const book of writable) {
    const opt = document.createElement("option");
    opt.value = book.id;
    opt.textContent = book.name;
    selectEl.appendChild(opt);
  }

  if (savedId) {
    selectEl.value = savedId;
    if (selectEl.value !== savedId) selectEl.value = "";
  }
}

// --- Attendees source show/hide ---

function syncAttendeesUI(source) {
  document.getElementById("static-email-wrap").style.display =
    source === "static" ? "block" : "none";
}

// --- Background Processing UI sync ---

function syncBgProcessingUI(autoAnalyzeEnabled) {
  const bgCheckbox = document.getElementById("bgProcessingEnabled");
  const bgSelect = document.getElementById("bgCacheMaxDays");

  if (!autoAnalyzeEnabled) {
    bgCheckbox.disabled = true;
    bgSelect.disabled = true;
    bgCheckbox.parentElement.style.opacity = "0.5";
  } else {
    bgCheckbox.disabled = false;
    bgSelect.disabled = false;
    bgCheckbox.parentElement.style.opacity = "";
  }

  updateBgStats();
}

async function updateBgStats() {
  const statsEl = document.getElementById("bg-stats");
  const statsText = document.getElementById("bg-stats-text");
  const stopBtn = document.getElementById("bg-stop-btn");
  const startBtn = document.getElementById("bg-start-btn");

  try {
    const status = await browser.runtime.sendMessage({ action: "getBgStatus" });
    if (!status) {
      statsEl.style.display = "none";
      return;
    }
    const parts = [];
    if (status.count !== undefined) parts.push(`Cached: ${status.count} emails`);
    if (status.queueLength > 0) parts.push(`Queued: ${status.queueLength}`);
    if (status.processing) parts.push("processing…");
    if (status.processedCount > 0) parts.push(`Processed this session: ${status.processedCount}`);
    if (status.errorCount > 0) parts.push(`Errors: ${status.errorCount}`);
    if (status.paused) parts.push("(paused — Ollama unreachable)");
    if (!status.enabled) parts.push("(stopped)");

    statsText.textContent = parts.length > 0 ? parts.join(" | ") : "No cached data";
    statsEl.style.display = "block";

    // Toggle Stop/Start button states
    stopBtn.disabled = !status.enabled;
    startBtn.disabled = status.enabled;
  } catch (e) {
    console.warn("[ThunderClerk-AI Settings] updateBgStats failed:", e.message);
    statsEl.style.display = "none";
  }
}

// --- VRAM estimation ---

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(1) + " GB";
  if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(0) + " MB";
  return (bytes / 1024).toFixed(0) + " KB";
}

async function fetchModelInfo(host, modelName) {
  if (!modelName) return null;
  if (modelInfoCache[modelName]) return modelInfoCache[modelName];

  try {
    const resp = await fetch(host.replace(/\/$/, "") + "/api/show", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: modelName }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const arch = data.model_info || {};

    // Architecture keys use a prefix like "llama." or "qwen2."
    // Find them by suffix matching
    let blockCount = 0, headCount = 0, headCountKv = 0, embeddingLength = 0;
    let contextLength = 0;
    for (const [key, val] of Object.entries(arch)) {
      if (key.endsWith(".block_count")) blockCount = val;
      else if (key.endsWith(".attention.head_count")) headCount = val;
      else if (key.endsWith(".attention.head_count_kv")) headCountKv = val;
      else if (key.endsWith(".embedding_length")) embeddingLength = val;
      else if (key.endsWith(".context_length")) contextLength = val;
    }

    // Detect thinking/reasoning models by checking for .Think in the template
    const template = data.template || "";
    const isThinkingModel = template.includes(".Think");

    const info = { blockCount, headCount, headCountKv, embeddingLength, contextLength, isThinkingModel };
    modelInfoCache[modelName] = info;
    return info;
  } catch {
    return null;
  }
}

function formatCtxLabel(tokens) {
  return tokens >= 1024 ? (tokens / 1024) + "K" : String(tokens);
}

async function updateVramEstimate() {
  const estimateEl = document.getElementById("vram-estimate");
  const totalEl = document.getElementById("vram-total");
  const breakdownEl = document.getElementById("vram-breakdown");
  const recEl = document.getElementById("llm-recommendation");
  const ctxSelect = document.getElementById("numCtx");
  const predictSelect = document.getElementById("numPredict");

  const modelName = document.getElementById("ollamaModel").value;
  const numCtxVal = parseInt(ctxSelect.value, 10) || 0;
  const numPredictVal = parseInt(predictSelect.value, 10) || 0;

  if (!modelName || !modelSizeMap[modelName]) {
    estimateEl.style.display = "none";
    recEl.style.display = "none";
    return;
  }

  const host = document.getElementById("ollamaHost").value.trim() || DEFAULTS.ollamaHost;
  const modelInfo = await fetchModelInfo(host, modelName);

  // Update "Model default" option text with actual context length
  const defaultOpt = ctxSelect.options[0];
  if (modelInfo && modelInfo.contextLength) {
    defaultOpt.textContent = "Model default (" + formatCtxLabel(modelInfo.contextLength) + ")";
  } else {
    defaultOpt.textContent = "Model default";
  }

  if (!modelInfo || !modelInfo.blockCount) {
    totalEl.textContent = "VRAM estimate unavailable — cannot reach Ollama";
    breakdownEl.textContent = "";
    estimateEl.style.display = "block";
    recEl.style.display = "none";
    return;
  }

  // Use actual model default when "Model default" is selected
  const effectiveCtx = numCtxVal || modelInfo.contextLength || 0;
  const result = estimateVRAM(modelInfo, modelSizeMap[modelName], effectiveCtx);

  totalEl.textContent = "Estimated VRAM usage: ~" + formatBytes(result.total);
  const parts = ["Model: ~" + formatBytes(result.weights)];
  if (result.kvCache > 0) {
    parts.push("Context window: ~" + formatBytes(result.kvCache));
  }
  breakdownEl.textContent = parts.join(" | ") + " (based on model size and context window)";
  estimateEl.style.display = "block";

  // Build recommendation based on model + settings
  const autoAnalyze = document.getElementById("autoAnalyzeEnabled").checked;
  const recommendations = [];

  if (modelInfo.isThinkingModel && (numPredictVal > 0 && numPredictVal < 8192)) {
    recommendations.push("This is a thinking model — it needs at least 8K output tokens to work reliably.");
  }

  if (autoAnalyze) {
    if (numCtxVal > 0 && numCtxVal < 16384) {
      recommendations.push("Auto Analyze works best with a 16K+ context window.");
    }
    if (numPredictVal > 0 && numPredictVal < 8192) {
      recommendations.push("Auto Analyze works best with 8K+ output tokens (12K for thinking models).");
    }
  }

  if (recommendations.length > 0) {
    recEl.textContent = recommendations.join(" ");
    recEl.style.display = "block";
  } else {
    recEl.style.display = "none";
  }
}

// --- Restore all settings on load ---

async function restoreOptions() {
  const s = await browser.storage.sync.get(DEFAULTS);

  document.getElementById("ollamaHost").value            = s.ollamaHost;
  document.getElementById("attendeesSource").value       = s.attendeesSource;
  document.getElementById("attendeesStatic").value       = s.attendeesStatic;
  document.getElementById("descriptionFormat").value     = s.descriptionFormat;
  document.getElementById("taskDescriptionFormat").value    = s.taskDescriptionFormat;
  document.getElementById("taskDefaultDue").value           = s.taskDefaultDue;
  document.getElementById("calendarUseCategory").checked    = !!s.calendarUseCategory;
  document.getElementById("taskUseCategory").checked        = !!s.taskUseCategory;
  document.getElementById("replyMode").value                = s.replyMode;
  document.getElementById("autoTagAfterAction").checked      = !!s.autoTagAfterAction;
  document.getElementById("allowNewTags").checked            = !!s.allowNewTags;
  document.getElementById("autoAnalyzeEnabled").checked      = !!s.autoAnalyzeEnabled;
  document.getElementById("bgProcessingEnabled").checked     = !!s.bgProcessingEnabled;
  document.getElementById("bgCacheMaxDays").value            = String(s.bgCacheMaxDays || 1);
  document.getElementById("debugPromptPreview").checked     = !!s.debugPromptPreview;

  // Sync background processing UI state
  syncBgProcessingUI(!!s.autoAnalyzeEnabled);
  document.getElementById("numCtx").value        = String(s.numCtx || 0);
  document.getElementById("numPredict").value    = String(s.numPredict || 0);

  syncAttendeesUI(s.attendeesSource);

  // Populate dropdowns (these fetch from external sources)
  await Promise.all([
    populateModels(document.getElementById("ollamaModel"), s.ollamaModel),
    populateCalendars(document.getElementById("defaultCalendar"), s.defaultCalendar),
    populateAddressBooks(document.getElementById("contactAddressBook"), s.contactAddressBook),
  ]);

  // Update VRAM estimate after models are loaded
  updateVramEstimate();
}

// --- Save all settings at once ---

async function saveOptions() {
  const host          = document.getElementById("ollamaHost").value.trim() || DEFAULTS.ollamaHost;
  const staticEmail   = document.getElementById("attendeesStatic").value.trim();
  const attendeeSrc   = document.getElementById("attendeesSource").value;

  // Validate host URL
  try {
    const u = new URL(host);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
  } catch {
    const el = document.getElementById("status");
    el.style.color = "red";
    el.textContent = "Invalid host URL — must start with http:// or https://";
    setTimeout(() => { el.textContent = ""; el.style.color = "green"; }, 3000);
    return;
  }

  // Validate static email
  if (attendeeSrc === "static" && staticEmail && !staticEmail.includes("@")) {
    const el = document.getElementById("status");
    el.style.color = "red";
    el.textContent = "Static email address doesn't look valid.";
    setTimeout(() => { el.textContent = ""; el.style.color = "green"; }, 3000);
    return;
  }

  const settings = {
    ollamaHost:            host,
    ollamaModel:           document.getElementById("ollamaModel").value,
    attendeesSource:       attendeeSrc,
    attendeesStatic:       staticEmail,
    defaultCalendar:       document.getElementById("defaultCalendar").value,
    descriptionFormat:     document.getElementById("descriptionFormat").value,
    taskDescriptionFormat: document.getElementById("taskDescriptionFormat").value,
    taskDefaultDue:        document.getElementById("taskDefaultDue").value,
    calendarUseCategory:   document.getElementById("calendarUseCategory").checked,
    taskUseCategory:       document.getElementById("taskUseCategory").checked,
    replyMode:             document.getElementById("replyMode").value,
    contactAddressBook:    document.getElementById("contactAddressBook").value,
    autoTagAfterAction:    document.getElementById("autoTagAfterAction").checked,
    allowNewTags:          document.getElementById("allowNewTags").checked,
    autoAnalyzeEnabled:    document.getElementById("autoAnalyzeEnabled").checked,
    bgProcessingEnabled:   document.getElementById("bgProcessingEnabled").checked,
    bgCacheMaxDays:        Number(document.getElementById("bgCacheMaxDays").value) || 1,
    numCtx:                Number(document.getElementById("numCtx").value) || 0,
    numPredict:            Number(document.getElementById("numPredict").value) || 0,
    debugPromptPreview:    document.getElementById("debugPromptPreview").checked,
  };

  await browser.storage.sync.set(settings);

  const el = document.getElementById("status");
  el.style.color = "green";
  el.textContent = "Saved.";
  setTimeout(() => { el.textContent = ""; }, 2000);
}

// --- Wire up events ---

async function maybeShowFirstRunNotice() {
  const { firstRun } = await browser.storage.local.get({ firstRun: false });
  if (!firstRun) return;
  const notice = document.getElementById("first-run-notice");
  notice.style.display = "block";
  document.getElementById("first-run-dismiss").addEventListener("click", async (e) => {
    e.preventDefault();
    notice.style.display = "none";
    await browser.storage.local.remove("firstRun");
  });
}

document.addEventListener("DOMContentLoaded", () => {
  maybeShowFirstRunNotice();
  restoreOptions();

  // Auto-refresh stats every 2 seconds so you can watch progress
  setInterval(updateBgStats, 2000);

  document.getElementById("attendeesSource").addEventListener("change", e =>
    syncAttendeesUI(e.target.value));

  document.getElementById("refresh-models").addEventListener("click", async () => {
    const sel = document.getElementById("ollamaModel");
    modelInfoCache = {};
    await populateModels(sel, sel.value);
    updateVramEstimate();
  });

  document.getElementById("ollamaModel").addEventListener("change", () => {
    updateVramEstimate();
  });

  document.getElementById("numCtx").addEventListener("change", () => {
    updateVramEstimate();
  });

  document.getElementById("numPredict").addEventListener("change", () => {
    updateVramEstimate();
  });

  document.getElementById("autoAnalyzeEnabled").addEventListener("change", () => {
    updateVramEstimate();
    syncBgProcessingUI(document.getElementById("autoAnalyzeEnabled").checked);
  });

  document.getElementById("refresh-calendars").addEventListener("click", async () => {
    const sel = document.getElementById("defaultCalendar");
    await populateCalendars(sel, sel.value);
  });

  document.getElementById("refresh-addressbooks").addEventListener("click", async () => {
    const sel = document.getElementById("contactAddressBook");
    await populateAddressBooks(sel, sel.value);
  });

  document.getElementById("bg-stop-btn").addEventListener("click", async () => {
    await browser.runtime.sendMessage({ action: "stopBgProcessor" });
    await updateBgStats();
  });

  document.getElementById("bg-start-btn").addEventListener("click", async () => {
    await browser.runtime.sendMessage({ action: "startBgProcessor" });
    await updateBgStats();
  });

  document.getElementById("clear-cache-btn").addEventListener("click", async () => {
    const btn = document.getElementById("clear-cache-btn");
    btn.disabled = true;
    btn.textContent = "Clearing\u2026";
    try {
      const result = await browser.runtime.sendMessage({ action: "clearBgCache" });
      btn.textContent = `Cleared ${result.removed} entries`;
      await updateBgStats();
      setTimeout(() => {
        btn.textContent = "Clear Cache";
        btn.disabled = false;
      }, 2000);
    } catch {
      btn.textContent = "Error";
      setTimeout(() => {
        btn.textContent = "Clear Cache";
        btn.disabled = false;
      }, 2000);
    }
  });

  document.getElementById("save-btn").addEventListener("click", saveOptions);
});
