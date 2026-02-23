"use strict";

document.addEventListener("DOMContentLoaded", async () => {
  const textarea = document.getElementById("prompt");
  const charCount = document.getElementById("char-count");

  // Load the pending prompt from local storage
  const { pendingPrompt } = await browser.storage.local.get({ pendingPrompt: "" });
  textarea.value = pendingPrompt;
  charCount.textContent = pendingPrompt.length.toLocaleString();

  document.getElementById("send-btn").addEventListener("click", () => {
    browser.runtime.sendMessage({ promptAction: "ok" });
    window.close();
  });

  document.getElementById("cancel-btn").addEventListener("click", () => {
    browser.runtime.sendMessage({ promptAction: "cancel" });
    window.close();
  });
});
