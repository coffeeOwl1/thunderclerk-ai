"use strict";

const DEFAULTS = {
  ollamaHost:            "http://127.0.0.1:11434",
  ollamaModel:           "mistral:7b",
  // Calendar event settings
  attendeesSource:       "from_to",          // "from_to" | "from" | "to" | "static" | "none"
  attendeesStatic:       "",
  defaultCalendar:       "",                  // "" = use currently selected
  descriptionFormat:     "body_from_subject", // "body_from_subject" | "body" | "none" | "ai_summary"
  // Task settings
  taskDescriptionFormat: "body_from_subject", // "body_from_subject" | "body" | "none" | "ai_summary"
  taskDefaultDue:        "none",              // "none" | "7" | "14" | "30" (days from now)
  // Category settings
  calendarUseCategory:   false,
  taskUseCategory:       false,
  // Compose action settings
  replyMode:             "replyToSender",     // "replyToSender" | "replyToAll"
  // Contact settings
  contactAddressBook:    "",                  // "" = first writable address book
  // Email cataloging settings
  autoTagAfterAction:    true,
  allowNewTags:          false,
  // Auto Analyze settings
  autoAnalyzeEnabled:    false,
  // Background processing settings
  bgProcessingEnabled:   false,
  bgCacheMaxDays:        1,
  // LLM parameter settings
  numCtx:                0,              // 0 = use model default
  numPredict:            0,              // 0 = use model default
  // Debug settings
  debugPromptPreview:    false,
};
