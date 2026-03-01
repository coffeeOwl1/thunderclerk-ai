"use strict";

document.addEventListener("DOMContentLoaded", async () => {
  const { pendingTriage } = await browser.storage.local.get({ pendingTriage: null });

  if (!pendingTriage || pendingTriage.length === 0) {
    document.getElementById("loading").textContent = "No triage data found.";
    return;
  }

  // --- State ---
  const items = pendingTriage; // array of { messageId, subject, author, date, cached, analysis }
  let sortMode = "priority";   // "priority" or "date"

  // Track card states (archived/deleted/queued)
  const cardState = {}; // messageId → { archived, deleted, queued }
  for (const item of items) {
    cardState[item.messageId] = { archived: false, deleted: false, queued: false };
  }

  // --- Priority sort order ---
  const PRIORITY_ORDER = {
    "urgent": 0,
    "action-needed": 1,
    "informational": 2,
    "low": 3,
  };

  function sortItems(arr, mode) {
    return [...arr].sort((a, b) => {
      if (mode === "priority") {
        const pa = a.cached ? (PRIORITY_ORDER[a.analysis.priority] ?? 2) : 5;
        const pb = b.cached ? (PRIORITY_ORDER[b.analysis.priority] ?? 2) : 5;
        if (pa !== pb) return pa - pb;
        // Secondary: date descending
        return (b.date || "").localeCompare(a.date || "");
      } else {
        // Date sort: newest first, uncached mixed by date
        return (b.date || "").localeCompare(a.date || "");
      }
    });
  }

  // --- Render ---
  const cardListEl = document.getElementById("card-list");
  const selectAllCb = document.getElementById("select-all");
  const archiveBtn = document.getElementById("archive-selected-btn");
  const deleteBtn = document.getElementById("delete-selected-btn");
  const queueUnanalyzedBtn = document.getElementById("queue-unanalyzed-btn");

  function renderCards() {
    cardListEl.innerHTML = "";
    const sorted = sortItems(items, sortMode);

    for (const item of sorted) {
      const state = cardState[item.messageId];
      const card = document.createElement("div");
      card.className = "triage-card";
      card.dataset.messageId = item.messageId;

      if (!item.cached) card.classList.add("uncached");
      if (state.archived) card.classList.add("archived");
      if (state.deleted) card.classList.add("deleted");

      // Top row: checkbox + subject
      const top = document.createElement("div");
      top.className = "card-top";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "card-cb";
      cb.dataset.messageId = item.messageId;
      cb.disabled = state.archived || state.deleted;
      cb.addEventListener("change", updateToolbarState);

      const body = document.createElement("div");
      body.className = "card-body";

      // Subject line (with priority badge if cached)
      const subjectLine = document.createElement("div");
      subjectLine.className = "card-subject";
      if (item.cached && item.analysis.priority && item.analysis.priority !== "informational") {
        const badge = document.createElement("span");
        badge.className = `priority-badge priority-${item.analysis.priority}`;
        badge.textContent = item.analysis.priority === "action-needed"
          ? "Action Needed"
          : item.analysis.priority.charAt(0).toUpperCase() + item.analysis.priority.slice(1);
        badge.style.marginRight = "6px";
        subjectLine.appendChild(badge);
      }
      const subjectText = document.createTextNode(item.subject);
      subjectLine.appendChild(subjectText);

      // Author
      const authorEl = document.createElement("div");
      authorEl.className = "card-author";
      authorEl.textContent = item.author;

      body.appendChild(subjectLine);
      body.appendChild(authorEl);

      // Summary (cached only)
      if (item.cached && item.analysis.summary) {
        const summaryEl = document.createElement("div");
        summaryEl.className = "card-summary";
        summaryEl.textContent = item.analysis.summary;
        body.appendChild(summaryEl);
      }

      // Meta row: count chips + action buttons
      const meta = document.createElement("div");
      meta.className = "card-meta";

      if (item.cached) {
        const a = item.analysis;
        if (a.eventCount > 0) meta.appendChild(makeChip(`${a.eventCount} event${a.eventCount > 1 ? "s" : ""}`));
        if (a.taskCount > 0) meta.appendChild(makeChip(`${a.taskCount} task${a.taskCount > 1 ? "s" : ""}`));
        if (a.contactCount > 0) meta.appendChild(makeChip(`${a.contactCount} contact${a.contactCount > 1 ? "s" : ""}`));
      } else {
        const na = document.createElement("span");
        na.className = "not-analyzed";
        na.textContent = "not analyzed";
        meta.appendChild(na);
      }

      // Status label (if archived/deleted)
      if (state.archived || state.deleted) {
        const statusLabel = document.createElement("span");
        statusLabel.className = `card-status status-${state.archived ? "archived" : "deleted"}`;
        statusLabel.textContent = state.archived ? "Archived" : "Deleted";
        meta.appendChild(statusLabel);
      }

      // Action buttons
      const actions = document.createElement("div");
      actions.className = "card-actions";

      if (state.archived || state.deleted) {
        // No action buttons for archived/deleted
      } else if (item.cached) {
        const viewBtn = document.createElement("button");
        viewBtn.textContent = "View";
        viewBtn.addEventListener("click", () => {
          viewBtn.disabled = true;
          viewBtn.textContent = "Opening\u2026";
          browser.runtime.sendMessage({ triageAction: "viewAnalysis", messageId: item.messageId });
        });
        actions.appendChild(viewBtn);

        const archBtn = document.createElement("button");
        archBtn.textContent = "Archive";
        archBtn.addEventListener("click", () => {
          browser.runtime.sendMessage({ triageAction: "archive", messageIds: [item.messageId] });
        });
        actions.appendChild(archBtn);
      } else {
        // Uncached — show Queue button
        if (state.queued) {
          const qBtn = document.createElement("button");
          qBtn.textContent = "Queued";
          qBtn.className = "queued";
          qBtn.disabled = true;
          actions.appendChild(qBtn);
        } else {
          const qBtn = document.createElement("button");
          qBtn.textContent = "Queue";
          qBtn.addEventListener("click", () => {
            browser.runtime.sendMessage({ triageAction: "queue", messageId: item.messageId });
          });
          actions.appendChild(qBtn);
        }
      }

      meta.appendChild(actions);
      body.appendChild(meta);

      top.appendChild(cb);
      top.appendChild(body);
      card.appendChild(top);
      cardListEl.appendChild(card);
    }
  }

  function makeChip(text) {
    const chip = document.createElement("span");
    chip.className = "count-chip";
    chip.textContent = text;
    return chip;
  }

  function updateToolbarState() {
    const checkboxes = getActiveCheckboxes();
    const checkedCount = checkboxes.filter(cb => cb.checked).length;

    archiveBtn.disabled = checkedCount === 0;
    deleteBtn.disabled = checkedCount === 0;

    // Update select-all state
    selectAllCb.checked = checkboxes.length > 0 && checkedCount === checkboxes.length;
    selectAllCb.indeterminate = checkedCount > 0 && checkedCount < checkboxes.length;
  }

  function getActiveCheckboxes() {
    return [...cardListEl.querySelectorAll(".card-cb:not(:disabled)")];
  }

  function getCheckedMessageIds() {
    return getActiveCheckboxes()
      .filter(cb => cb.checked)
      .map(cb => Number(cb.dataset.messageId));
  }

  // --- Email count ---
  document.getElementById("email-count").textContent =
    `${items.length} email${items.length === 1 ? "" : "s"}`;

  // --- Queue Unanalyzed button ---
  const uncachedIds = items.filter(i => !i.cached).map(i => i.messageId);
  queueUnanalyzedBtn.disabled = uncachedIds.length === 0;

  // --- Wire up toolbar ---
  selectAllCb.addEventListener("change", () => {
    const checked = selectAllCb.checked;
    for (const cb of getActiveCheckboxes()) {
      cb.checked = checked;
    }
    updateToolbarState();
  });

  archiveBtn.addEventListener("click", () => {
    const ids = getCheckedMessageIds();
    if (ids.length === 0) return;
    browser.runtime.sendMessage({ triageAction: "archive", messageIds: ids });
  });

  deleteBtn.addEventListener("click", () => {
    const ids = getCheckedMessageIds();
    if (ids.length === 0) return;
    browser.runtime.sendMessage({ triageAction: "delete", messageIds: ids });
  });

  queueUnanalyzedBtn.addEventListener("click", () => {
    const unqueued = items
      .filter(i => !i.cached && !cardState[i.messageId].queued)
      .map(i => i.messageId);
    if (unqueued.length === 0) return;
    browser.runtime.sendMessage({ triageAction: "queueAll", messageIds: unqueued });
  });

  // --- Sort toggle ---
  const sortBtn = document.getElementById("sort-btn");
  sortBtn.addEventListener("click", () => {
    sortMode = sortMode === "priority" ? "date" : "priority";
    sortBtn.textContent = sortMode === "priority" ? "Sort: Priority" : "Sort: Date";
    renderCards();
  });

  // --- Done button ---
  document.getElementById("done-btn").addEventListener("click", () => {
    window.close();
  });

  // --- Listen for responses from background ---
  browser.runtime.onMessage.addListener((msg) => {
    if (!msg) return;

    if (msg.triageArchived) {
      cardState[msg.messageId].archived = true;
      renderCards();
      updateToolbarState();
    }

    if (msg.triageDeleted) {
      cardState[msg.messageId].deleted = true;
      renderCards();
      updateToolbarState();
    }

    if (msg.triageViewDone) {
      renderCards();
    }

    if (msg.triageQueued) {
      cardState[msg.messageId].queued = true;
      renderCards();
      // Update queue unanalyzed button state
      const stillUnqueued = items.filter(i => !i.cached && !cardState[i.messageId].queued);
      queueUnanalyzedBtn.disabled = stillUnqueued.length === 0;
      startCachePolling();
    }

    if (msg.triageQueuedAll) {
      for (const id of (msg.messageIds || [])) {
        cardState[id].queued = true;
      }
      renderCards();
      queueUnanalyzedBtn.disabled = true;
      startCachePolling();
    }
  });

  // --- Poll for queued items becoming cached ---
  const CACHE_VERSION = 1;
  const POLL_INTERVAL_MS = 3000;
  let pollTimer = null;

  function startCachePolling() {
    if (pollTimer) return; // already polling
    pollTimer = setInterval(pollForCacheUpdates, POLL_INTERVAL_MS);
  }

  function stopCachePolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function pollForCacheUpdates() {
    const queued = items.filter(i => !i.cached && cardState[i.messageId].queued);
    if (queued.length === 0) {
      stopCachePolling();
      return;
    }

    const keys = queued.map(i => "cache_" + i.messageId);
    const defaults = {};
    for (const k of keys) defaults[k] = null;
    const result = await browser.storage.local.get(defaults);

    let updated = false;
    for (const item of queued) {
      const entry = result["cache_" + item.messageId];
      if (!entry || entry.version !== CACHE_VERSION || !entry.raw) continue;

      const raw = entry.raw;
      item.cached = true;
      item.analysis = {
        summary: raw.summary || "",
        priority: raw.priority || "informational",
        eventCount: Array.isArray(raw.events) ? raw.events.length : 0,
        taskCount: Array.isArray(raw.tasks) ? raw.tasks.length : 0,
        contactCount: Array.isArray(raw.contacts) ? raw.contacts.length : 0,
        cacheTimestamp: entry.ts,
      };
      cardState[item.messageId].queued = false;
      updated = true;
    }

    if (updated) {
      renderCards();
      // Update toolbar state — newly cached items have active checkboxes
      updateToolbarState();
      // Update queue unanalyzed button
      const stillUnqueued = items.filter(i => !i.cached && !cardState[i.messageId].queued);
      queueUnanalyzedBtn.disabled = stillUnqueued.length === 0;
    }
  }

  // --- Show content, hide loading ---
  document.getElementById("loading").style.display = "none";
  document.getElementById("content").style.display = "";
  renderCards();
});
