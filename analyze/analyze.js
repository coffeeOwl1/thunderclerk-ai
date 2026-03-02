"use strict";

document.addEventListener("DOMContentLoaded", async () => {
  const { pendingAnalysis } = await browser.storage.local.get({ pendingAnalysis: null });

  if (!pendingAnalysis) {
    document.getElementById("loading").textContent = "No analysis data found.";
    return;
  }

  const analysis = pendingAnalysis;
  const isFromCache = !!analysis._fromCache;

  // --- Populate title with email subject and author ---
  document.getElementById("title-subject").textContent =
    analysis._subject || "Analysis";
  document.getElementById("title-author").textContent =
    analysis._author || "";

  // --- Show cache age and Refresh button when showing cached data ---
  if (isFromCache && analysis._cacheTimestamp) {
    const cacheAgeEl = document.getElementById("cache-age");
    const refreshBtn = document.getElementById("refresh-btn");
    cacheAgeEl.textContent = formatCacheAge(analysis._cacheTimestamp);
    cacheAgeEl.style.display = "";
    refreshBtn.style.display = "";

    refreshBtn.addEventListener("click", async () => {
      refreshBtn.disabled = true;
      refreshBtn.textContent = "Re-analyzing\u2026";
      await browser.runtime.sendMessage({ analyzeAction: "refresh" });
      // The background will close and reopen the dialog; if it doesn't, restore button
      setTimeout(() => {
        refreshBtn.disabled = false;
        refreshBtn.textContent = "Re-analyze";
      }, 5000);
    });
  }

  // --- Render summary ---
  document.getElementById("summary").textContent = analysis.summary || "(no summary)";

  // --- Render priority badge (prepend after textContent is set) ---
  if (analysis.priority && analysis.priority !== "informational") {
    const badge = document.createElement("span");
    badge.className = `priority-badge priority-${analysis.priority}`;
    badge.textContent = analysis.priority === "action-needed"
      ? "Action Needed"
      : analysis.priority.charAt(0).toUpperCase() + analysis.priority.slice(1);
    document.getElementById("summary").prepend(badge);
  }

  // --- Render detected items ("What I Found") ---
  const detectedEl = document.getElementById("detected-items");
  const detectedSection = document.getElementById("detected-section");
  let hasDetected = false;
  const foundGroups = new Set(); // track which groups have items, to hide redundant quick actions

  const groups = [
    { key: "events",   label: "Calendar Events" },
    { key: "tasks",    label: "Tasks" },
    { key: "contacts", label: "Contacts" },
  ];

  for (const group of groups) {
    const items = analysis[group.key];
    if (!Array.isArray(items) || items.length === 0) continue;

    hasDetected = true;
    foundGroups.add(group.key);
    const groupDiv = document.createElement("div");
    groupDiv.className = "group";

    const groupLabel = document.createElement("div");
    groupLabel.className = "group-label";
    groupLabel.textContent = group.label;
    groupDiv.appendChild(groupLabel);

    items.forEach((item, idx) => {
      const row = document.createElement("div");
      row.className = "item-row";

      const text = document.createElement("span");
      text.className = "item-text";
      const previewText = typeof item === "string" ? item
        : item.preview || item.title || item.name || item.description
          || item.summary || item.label || null;
      text.textContent = previewText || `${group.label} item ${idx + 1}`;

      const btn = document.createElement("button");
      btn.dataset.group = group.key;
      btn.dataset.index = idx;

      if (isFromCache) {
        // Cached data — buttons are immediately active
        btn.className = "add-btn";
        btn.textContent = "Add";
        btn.disabled = false;
      } else {
        // Live data — buttons start as waiting
        btn.className = "add-btn processing";
        btn.textContent = "Waiting\u2026";
        btn.disabled = true;
      }

      btn.addEventListener("click", () => handleItemClick(btn, group.key, idx));

      row.appendChild(text);
      row.appendChild(btn);
      groupDiv.appendChild(row);
    });

    detectedEl.appendChild(groupDiv);
  }

  // Tags — show cached AI tags as chips with an actionable "Tag" button
  const cachedTags = analysis._cachedTags;
  if (Array.isArray(cachedTags) && cachedTags.length > 0) {
    hasDetected = true;
    const groupDiv = document.createElement("div");
    groupDiv.className = "group";

    const groupLabel = document.createElement("div");
    groupLabel.className = "group-label";
    groupLabel.textContent = "Tags";
    groupDiv.appendChild(groupLabel);

    const row = document.createElement("div");
    row.className = "item-row";

    const chipWrap = document.createElement("div");
    chipWrap.className = "tag-chip-wrap item-text";
    for (const tag of cachedTags) {
      const chip = document.createElement("span");
      chip.className = "tag-chip";
      chip.textContent = tag;
      chipWrap.appendChild(chip);
    }
    row.appendChild(chipWrap);

    const btn = document.createElement("button");
    btn.dataset.group = "quickCatalog";
    btn.dataset.index = "0";
    btn.dataset.btnText = "Tag";

    if (analysis._tagsAlreadyApplied) {
      btn.className = "add-btn done";
      btn.textContent = "Tagged";
      btn.disabled = true;
    } else if (isFromCache) {
      btn.className = "add-btn";
      btn.textContent = "Tag";
      btn.disabled = false;
    } else {
      btn.className = "add-btn processing";
      btn.textContent = "Waiting\u2026";
      btn.disabled = true;
    }

    btn.addEventListener("click", () => handleItemClick(btn, "quickCatalog", 0));

    row.appendChild(btn);
    groupDiv.appendChild(row);
    detectedEl.appendChild(groupDiv);
  }

  // Unsubscribe — detected from List-Unsubscribe header, not AI-driven
  if (analysis._unsubscribe) {
    hasDetected = true;
    const groupDiv = document.createElement("div");
    groupDiv.className = "group";

    const groupLabel = document.createElement("div");
    groupLabel.className = "group-label";
    groupLabel.textContent = "Unsubscribe";
    groupDiv.appendChild(groupLabel);

    const row = document.createElement("div");
    row.className = "item-row";

    const text = document.createElement("span");
    text.className = "item-text";
    if (analysis._unsubscribe.https) {
      try {
        const domain = new URL(analysis._unsubscribe.https).hostname;
        text.append("Unsubscribe via ");
        const bold = document.createElement("b");
        bold.textContent = domain;
        text.appendChild(bold);
      } catch {
        text.textContent = "Unsubscribe link found";
      }
    } else {
      text.textContent = "Unsubscribe (opens compose)";
    }

    const btn = document.createElement("button");
    btn.className = "add-btn";
    btn.dataset.group = "quickUnsubscribe";
    btn.dataset.index = "0";
    btn.dataset.btnText = "Unsub";
    btn.textContent = "Unsub";
    btn.disabled = false;
    btn.addEventListener("click", () => handleItemClick(btn, "quickUnsubscribe", 0));

    row.appendChild(text);
    row.appendChild(btn);
    groupDiv.appendChild(row);
    detectedEl.appendChild(groupDiv);
  }

  if (hasDetected) {
    detectedSection.style.display = "";
  }

  // --- Render reply section ---
  if (analysis._replyBody) {
    const replySection = document.getElementById("reply-section");
    const replyText = document.getElementById("reply-text");
    const useReplyBtn = document.getElementById("use-reply-btn");

    replyText.textContent = analysis._replyBody;
    replySection.style.display = "";

    useReplyBtn.addEventListener("click", async () => {
      useReplyBtn.disabled = true;
      useReplyBtn.textContent = "Opening\u2026";
      await browser.runtime.sendMessage({ analyzeAction: "useReply" });
      // Result arrives via analyzeReplyResult listener below
    });
  } else if (analysis._replyFailed) {
    const replySection = document.getElementById("reply-section");
    const replyText = document.getElementById("reply-text");

    replyText.textContent = "Could not generate a reply. You can try again using the Quick Actions below.";
    replyText.classList.add("error-text");
    replySection.style.display = "";
    document.getElementById("use-reply-btn").style.display = "none";
  }

  // --- Render Quick Actions ---
  // Skip quick actions whose detected-item group already appears in "What I Found"
  const quickActionsEl = document.getElementById("quick-actions");
  const quickDefs = [
    { group: "quickCalendar", label: "Create a calendar event", btnText: "Add",     coveredBy: "events" },
    { group: "quickTask",     label: "Create a task",           btnText: "Add",     coveredBy: "tasks" },
    { group: "quickContact",  label: "Extract contact info",    btnText: "Add",     coveredBy: "contacts" },
    { group: "quickForward",  label: "Summarize & forward",     btnText: "Forward", coveredBy: null },
  ];

  for (const def of quickDefs) {
    if (def.coveredBy && foundGroups.has(def.coveredBy)) continue;
    const row = document.createElement("div");
    row.className = "item-row";

    const text = document.createElement("span");
    text.className = "item-text";
    text.textContent = def.label;

    const btn = document.createElement("button");
    btn.dataset.group = def.group;
    btn.dataset.index = "0";
    btn.dataset.btnText = def.btnText;

    if (isFromCache) {
      // Cached data — buttons are immediately active
      btn.className = "add-btn";
      btn.textContent = def.btnText;
      btn.disabled = false;
    } else {
      // Live data — buttons start as waiting
      btn.className = "add-btn processing";
      btn.textContent = "Waiting\u2026";
      btn.disabled = true;
    }

    btn.addEventListener("click", () => handleItemClick(btn, def.group, 0));

    row.appendChild(text);
    row.appendChild(btn);
    quickActionsEl.appendChild(row);
  }

  // --- Archive/Delete checkbox mutual exclusion ---
  const archiveCb = document.getElementById("archive-cb");
  const deleteCb = document.getElementById("delete-cb");
  archiveCb.addEventListener("change", () => {
    if (archiveCb.checked) deleteCb.checked = false;
  });
  deleteCb.addEventListener("change", () => {
    if (deleteCb.checked) archiveCb.checked = false;
  });

  // --- Listen for batch pre-extraction readiness from background ---
  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.batchReady) return;
    const buttons = document.querySelectorAll(`.add-btn[data-group="${msg.group}"]`);
    buttons.forEach(btn => {
      if (btn.classList.contains("done")) return; // already clicked
      const btnText = btn.dataset.btnText || "Add";
      btn.classList.remove("processing");
      if (msg.success) {
        btn.textContent = btnText;
        btn.disabled = false;
      } else {
        btn.classList.add("error");
        btn.textContent = "\u2717 Error";
        btn.title = msg.error || "Pre-extraction failed";
        btn.disabled = false;
        // Auto-revert to clickable state after 4s (clicking triggers live fallback)
        setTimeout(() => {
          if (btn.classList.contains("error")) {
            btn.classList.remove("error");
            btn.textContent = btnText;
            btn.title = "";
          }
        }, 4000);
      }
    });
  });

  // --- Listen for catastrophic batch error (all extractions failed to start) ---
  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.batchError) return;
    document.querySelectorAll(".add-btn.processing").forEach(btn => {
      const btnText = btn.dataset.btnText || "Add";
      btn.classList.remove("processing");
      btn.classList.add("error");
      btn.textContent = "\u2717 Error";
      btn.title = msg.error || "Extraction failed";
      btn.disabled = false;
      setTimeout(() => {
        if (btn.classList.contains("error")) {
          btn.classList.remove("error");
          btn.textContent = btnText;
          btn.title = "";
        }
      }, 4000);
    });
  });

  // --- Listen for item extraction results from background ---
  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.analyzeItemResult) return;
    const btn = document.querySelector(
      `.add-btn[data-group="${msg.group}"][data-index="${msg.index}"]`
    );
    if (!btn) return;

    const btnText = btn.dataset.btnText || "Add";
    if (msg.canceled) {
      // User closed without completing — re-enable for retry
      btn.classList.remove("processing");
      btn.textContent = btnText;
      btn.disabled = false;
      btn.title = "";
    } else if (msg.success) {
      btn.classList.remove("processing");
      btn.classList.add("done");
      btn.textContent = "\u2713 Done";
      btn.title = "";
      // Calendar/task dialogs can't report save vs cancel — keep clickable
      const g = msg.group;
      if (g === "events" || g === "tasks" || g === "quickCalendar" || g === "quickTask") {
        btn.disabled = false;
      }
    } else {
      btn.classList.remove("processing");
      btn.classList.add("error");
      btn.textContent = "\u2717 Error";
      btn.title = msg.error || "Action failed";
      btn.disabled = false;
      // Auto-revert to normal state after 4s for retry
      setTimeout(() => {
        if (btn.classList.contains("error")) {
          btn.classList.remove("error");
          btn.textContent = btnText;
          btn.title = "";
        }
      }, 4000);
    }
  });

  // --- Listen for reply compose outcome from background ---
  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.analyzeReplyResult) return;
    const btn = document.getElementById("use-reply-btn");
    if (!btn) return;
    if (msg.sent) {
      btn.textContent = "Sent";
    } else {
      // User closed compose without sending — re-enable
      btn.disabled = false;
      btn.textContent = "Send Reply";
    }
  });

  // --- Show content, hide loading ---
  document.getElementById("loading").style.display = "none";
  document.getElementById("content").style.display = "";

  // --- Button handlers ---
  document.getElementById("ok-btn").addEventListener("click", async () => {
    const selections = buildSelections();
    await browser.runtime.sendMessage({ analyzeAction: "done", selections });
    window.close();
  });

  // Signal background to start batch pre-extractions (or send cached readiness)
  browser.runtime.sendMessage({ analyzeAction: "dialogReady" }).catch(() => {});
});

async function handleItemClick(btn, group, index) {
  if (btn.disabled) return;

  btn.disabled = true;
  btn.classList.remove("error", "done");
  btn.classList.add("processing");
  btn.textContent = "Adding\u2026";

  // Send request to background — result comes back via the onMessage listener
  await browser.runtime.sendMessage({ analyzeAction: "openItem", group, index });
}

function buildSelections() {
  const selections = {};
  if (document.getElementById("archive-cb").checked) selections.archive = true;
  if (document.getElementById("delete-cb").checked) selections.delete = true;
  return selections;
}

function formatCacheAge(timestamp) {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "Cached just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Cached ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Cached ${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `Cached ${days} day${days > 1 ? "s" : ""} ago`;
}
