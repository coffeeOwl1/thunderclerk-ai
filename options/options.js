"use strict";

// DEFAULTS is defined in config.js, loaded before this script.

// --- Model list from Ollama ---

async function populateModels(selectEl, savedModel) {
  const host = document.getElementById("ollamaHost").value.trim() || DEFAULTS.ollamaHost;

  while (selectEl.options.length > 0) selectEl.remove(0);

  let models = [];
  try {
    const resp = await fetch(host.replace(/\/$/, "") + "/api/tags");
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
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
  document.getElementById("debugPromptPreview").checked     = !!s.debugPromptPreview;

  syncAttendeesUI(s.attendeesSource);

  // Populate dropdowns (these fetch from external sources)
  await Promise.all([
    populateModels(document.getElementById("ollamaModel"), s.ollamaModel),
    populateCalendars(document.getElementById("defaultCalendar"), s.defaultCalendar),
    populateAddressBooks(document.getElementById("contactAddressBook"), s.contactAddressBook),
  ]);
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

  document.getElementById("attendeesSource").addEventListener("change", e =>
    syncAttendeesUI(e.target.value));

  document.getElementById("refresh-models").addEventListener("click", async () => {
    const sel = document.getElementById("ollamaModel");
    await populateModels(sel, sel.value);
  });

  document.getElementById("refresh-calendars").addEventListener("click", async () => {
    const sel = document.getElementById("defaultCalendar");
    await populateCalendars(sel, sel.value);
  });

  document.getElementById("refresh-addressbooks").addEventListener("click", async () => {
    const sel = document.getElementById("contactAddressBook");
    await populateAddressBooks(sel, sel.value);
  });

  document.getElementById("save-btn").addEventListener("click", saveOptions);
});
