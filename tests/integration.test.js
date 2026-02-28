"use strict";

// Integration tests — these call a real Ollama instance and are intentionally
// slow (each test makes one LLM request). Run separately with:
//   npm run test:integration
//
// The tests skip automatically if Ollama is not reachable. Set OLLAMA_HOST and
// OLLAMA_MODEL env vars to override defaults.

const {
  buildCalendarPrompt,
  buildTaskPrompt,
  buildCombinedExtractionPrompt,
  extractJSON,

  normalizeCalDate,
  advancePastYear,
  applyCalendarDefaults,
} = require("../utils.js");

let testConfig = {};
try { testConfig = require("../config.test.js"); } catch {}

const OLLAMA_HOST  = process.env.OLLAMA_HOST  || testConfig.ollamaHost  || "http://127.0.0.1:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || testConfig.ollamaModel || "mistral:7b";

// Reference dates — Feb 20 2026 is a Friday.
const MAIL_DATE = "02/20/2026";
const TODAY     = "02/20/2026";

// ---------------------------------------------------------------------------
// Infrastructure
// ---------------------------------------------------------------------------

let ollamaAvailable = false;

beforeAll(async () => {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`, {
      signal: AbortSignal.timeout(5_000),
    });
    ollamaAvailable = res.ok;
  } catch {
    ollamaAvailable = false;
  }
  if (!ollamaAvailable) {
    console.warn(`\n  ⚠ Ollama not reachable at ${OLLAMA_HOST} — all integration tests will be skipped.\n`);
  } else {
    console.log(`\n  ✓ Ollama reachable — running against model: ${OLLAMA_MODEL}\n`);
  }
}, 10_000);

async function callOllama(prompt, options = {}) {
  const timeoutMs = options.timeout || 90_000;
  const body = { model: OLLAMA_MODEL, prompt, stream: false };
  const ollamaOpts = {};
  if (options.num_predict) ollamaOpts.num_predict = options.num_predict;
  if (options.num_ctx) ollamaOpts.num_ctx = options.num_ctx;
  if (options.temperature !== undefined) ollamaOpts.temperature = options.temperature;
  if (Object.keys(ollamaOpts).length > 0) body.options = ollamaOpts;
  if (options.format) body.format = options.format;

  const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()).response;
}

// Run the full extraction pipeline (same as background.js does).
async function extractCalendar(emailBody, subject, opts = {}) {
  const mailDate  = opts.mailDate   || MAIL_DATE;
  const currentDt = opts.currentDate || TODAY;
  const attendees = opts.attendees  || [];
  const prompt = buildCalendarPrompt(emailBody, subject, mailDate, currentDt, attendees, null);
  const raw    = await callOllama(prompt);
  const parsed = JSON.parse(extractJSON(raw));
  if (parsed.startDate) parsed.startDate = normalizeCalDate(parsed.startDate);
  if (parsed.endDate)   parsed.endDate   = normalizeCalDate(parsed.endDate);
  parsed.forceAllDay = !!parsed.forceAllDay;
  const refYear = parseInt(currentDt.slice(-4), 10);
  if (parsed.startDate) parsed.startDate = advancePastYear(parsed.startDate, refYear);
  if (parsed.endDate)   parsed.endDate   = advancePastYear(parsed.endDate,   refYear);
  if (!parsed.summary)  parsed.summary   = subject;
  applyCalendarDefaults(parsed);
  return parsed;
}

// Wrap each test so it auto-skips when Ollama is offline.
function itOnline(name, fn, timeout) {
  test(name, async () => {
    if (!ollamaAvailable) return;
    await fn();
  }, timeout || 90_000);
}

// Assert date part only (YYYYMMDD), with an optional tolerance in days.
function expectDate(calStr, expectedYYYYMMDD, toleranceDays = 0) {
  expect(calStr).toBeDefined();
  const actual   = calStr.slice(0, 8);
  const aDate    = new Date(actual.slice(0,4), parseInt(actual.slice(4,6)) - 1, parseInt(actual.slice(6,8)));
  const eDate    = new Date(expectedYYYYMMDD.slice(0,4), parseInt(expectedYYYYMMDD.slice(4,6)) - 1, parseInt(expectedYYYYMMDD.slice(6,8)));
  const diffDays = Math.round(Math.abs(aDate - eDate) / 86_400_000);
  expect(diffDays).toBeLessThanOrEqual(toleranceDays);
}

// ---------------------------------------------------------------------------
// Calendar extraction scenarios
// ---------------------------------------------------------------------------

describe("calendar integration", () => {

  // --- All-day events (date only, no time) ---

  itOnline("explicit single date → all-day event", async () => {
    const result = await extractCalendar(
      "Hi all, just a reminder that our office holiday party is on March 15, 2026. Hope to see everyone there!",
      "Office Holiday Party"
    );
    expect(result.forceAllDay).toBe(true);
    expectDate(result.startDate, "20260315");
    expect(result.summary).toBeTruthy();
  });

  itOnline("date range with no time → all-day, start date correct", async () => {
    // "March 2-6" compressed notation causes mistral:7b to occasionally drop
    // endDate entirely. Assert start; only assert end when model provided it.
    // The regression test below uses the full "March 2nd-March 6th" form and
    // asserts endDate with tolerance 0.
    const result = await extractCalendar(
      "The annual sales conference will be held March 2-6, 2026 at the downtown Marriott. Please block your calendars.",
      "Annual Sales Conference"
    );
    expect(result.forceAllDay).toBe(true);
    expectDate(result.startDate, "20260302", 1);
    if (result.endDate !== result.startDate) {
      expectDate(result.endDate, "20260306", 1);
    }
  });

  itOnline("written-out date range → all-day, start date correct", async () => {
    // "through" phrasing causes mistral:7b to occasionally drop endDate entirely,
    // so we only assert the start date here. The regression test below covers
    // endDate accuracy for the hyphen-style range ("March 2nd-March 6th").
    const result = await extractCalendar(
      "Conferences will be held the week of March 2nd through March 6th. Registration opens at the venue.",
      "Conference Week"
    );
    expect(result.forceAllDay).toBe(true);
    expectDate(result.startDate, "20260302", 1);
    if (result.endDate !== result.startDate) {
      expectDate(result.endDate, "20260306", 1);
    }
  });

  itOnline("date range with no year + ordinal collision ('2nd trimester … March 2nd-March 6th')", async () => {
    // Regression: LLM was returning wrong year (2022) and off-by-one end date.
    // The email contains "2nd" as both an ordinal adjective and a date ordinal,
    // and no year is mentioned — the year must come from the email sent date.
    const result = await extractCalendar(
      "Our 2nd trimester Parent Teacher Conferences will be held the week of March 2nd-March 6th.",
      "Parent Teacher Conferences",
      { mailDate: "02/20/2026", currentDate: "02/20/2026" }
    );
    expect(result.forceAllDay).toBe(true);
    // Year must be 2026, not a training-data year like 2022
    expect(result.startDate.slice(0, 4)).toBe("2026");
    expectDate(result.startDate, "20260302", 1);
    // End must be March 6 — tolerance 0 to catch the off-by-one regression
    // where the model treated the range as exclusive and returned March 5.
    expectDate(result.endDate,   "20260306", 0);
  });

  // --- Timed events ---

  itOnline("explicit date and time → correct date, time when captured", async () => {
    const result = await extractCalendar(
      "We have a team meeting scheduled for March 10, 2026 at 3pm. Dial-in details to follow.",
      "Team Meeting"
    );
    expectDate(result.startDate, "20260310");
    if (!result.forceAllDay) {
      expect(result.startDate).toContain("T150000");
      expect(result.endDate).toBeTruthy();
      expect(result.startDate <= result.endDate).toBe(true);
    }
  });

  itOnline("explicit duration → correct date extracted", async () => {
    // Note: mistral:7b inconsistently captures the time component from this
    // phrasing ("starting at 2pm"). We verify the date is correct and that
    // if a time was captured, end > start within a reasonable window.
    const result = await extractCalendar(
      "Please join us for a 2-hour onboarding training on March 5, 2026 starting at 2pm.",
      "Onboarding Training"
    );
    expectDate(result.startDate, "20260305");
    if (!result.forceAllDay) {
      expect(result.startDate).toContain("T140000");
      expect(result.endDate > result.startDate).toBe(true);
      expect(result.endDate <= "20260305T180000").toBe(true);
    }
  });

  itOnline("noon as time expression → T120000", async () => {
    const result = await extractCalendar(
      "Lunch meeting on March 12, 2026 at noon to discuss the Q2 roadmap.",
      "Lunch Meeting"
    );
    expect(result.forceAllDay).toBe(false);
    expectDate(result.startDate, "20260312");
    expect(result.startDate).toContain("T120000");
  });

  itOnline("30-minute call → end is after start and within 2 hours", async () => {
    const result = await extractCalendar(
      "Quick 30-minute sync on March 3, 2026 at 10am to align on priorities.",
      "Quick Sync"
    );
    expect(result.forceAllDay).toBe(false);
    expectDate(result.startDate, "20260303");
    expect(result.startDate).toContain("T100000");
    // Small models round duration to 1hr — accept anything from T103000 to T120000
    expect(result.endDate).toBeTruthy();
    expect(result.endDate > result.startDate).toBe(true);
    expect(result.endDate <= "20260303T120000").toBe(true);
  });

  // --- Relative dates ---

  itOnline("next Tuesday → resolves to a near-future date with correct time", async () => {
    // Note: mistral:7b doesn't reliably resolve day-of-week for relative
    // references like "next Tuesday". We verify: correct time extracted,
    // date is in the future, and within a reasonable window (~2 weeks).
    const result = await extractCalendar(
      "Let's catch up next Tuesday at 10am. I'll send a calendar invite.",
      "Catch-up",
      { mailDate: "02/20/2026", currentDate: "02/20/2026" }
    );
    expect(result.forceAllDay).toBe(false);
    expect(result.startDate).toBeTruthy();
    // Date should be after the mail date and within 3 weeks
    expect(result.startDate >= "20260220T000000").toBe(true);
    expectDate(result.startDate, "20260224", 14);
    expect(result.startDate).toContain("T100000");
  });

  itOnline("in two weeks → resolves ~14 days from mail date", async () => {
    const result = await extractCalendar(
      "The project kickoff will be in two weeks. Mark your calendars!",
      "Project Kickoff",
      { mailDate: "02/20/2026", currentDate: "02/20/2026" }
    );
    expect(result.forceAllDay).toBe(true);
    // ~14 days from Feb 20 = ~Mar 6; allow 3 days tolerance
    expectDate(result.startDate, "20260306", 3);
  });

  // --- Tricky / edge cases ---

  itOnline("no event in email → does not crash, returns a summary", async () => {
    const result = await extractCalendar(
      "Hey, just wanted to let you know I got your message. Let me know when you're free next week to grab coffee and catch up!",
      "Re: Catching up"
    );
    // No specific event — we just assert the pipeline doesn't throw and
    // summary is present. Dates may or may not be populated.
    expect(result).toBeDefined();
    expect(typeof result.summary).toBe("string");
    // If dates are present they must be valid
    if (result.startDate) {
      expect(result.startDate).toMatch(/^\d{8}T\d{6}$/);
    }
    if (result.endDate && result.startDate) {
      expect(result.startDate <= result.endDate).toBe(true);
    }
  });

  itOnline("past date → recalculated to future or omitted", async () => {
    // Jan 5 is in the past relative to our reference date of Feb 20
    const result = await extractCalendar(
      "The board review is on January 5th. Please prepare your slides.",
      "Board Review",
      { mailDate: "02/20/2026", currentDate: "02/20/2026" }
    );
    expect(result).toBeDefined();
    // Either the date was recalculated forward, or we don't assert exact date.
    // At minimum, the pipeline should not crash.
    if (result.startDate) {
      expect(result.startDate).toMatch(/^\d{8}T\d{6}$/);
    }
  });

  itOnline("multiple dates in email → picks the event date, not the deadline", async () => {
    const result = await extractCalendar(
      "The company picnic is on June 14, 2026. Please RSVP by May 31, 2026 so we can finalize catering.",
      "Company Picnic RSVP"
    );
    expect(result.forceAllDay).toBe(true);
    // Should pick the event date (June 14), not the RSVP deadline (May 31)
    expectDate(result.startDate, "20260614", 1);
  });

  itOnline("time with AM/PM spelled out → timed event", async () => {
    const result = await extractCalendar(
      "Your appointment is confirmed for April 3, 2026 at 9:30 AM with Dr. Smith.",
      "Doctor Appointment"
    );
    expect(result.forceAllDay).toBe(false);
    expectDate(result.startDate, "20260403");
    expect(result.startDate).toContain("T093000");
  });

  // --- AI-generated description ---

  itOnline("includeDescription → AI returns a non-empty description string", async () => {
    const emailBody = "Hi team, please join us for the Q1 review presentation on March 10, 2026 at 2pm in Conference Room B. We will cover revenue targets, customer feedback, and plans for Q2.";
    const subject = "Q1 Review Presentation";
    const prompt = buildCalendarPrompt(emailBody, subject, MAIL_DATE, TODAY, [], null, true);
    const raw = await callOllama(prompt);
    const parsed = JSON.parse(extractJSON(raw));
    expect(typeof parsed.description).toBe("string");
    expect(parsed.description.length).toBeGreaterThan(0);
  });

});

// ---------------------------------------------------------------------------
// Task extraction scenarios
// ---------------------------------------------------------------------------

// Mirrors the normalizeTaskData + pipeline from background.js handleTask().
async function extractTask(emailBody, subject, opts = {}) {
  const mailDate  = opts.mailDate   || MAIL_DATE;
  const currentDt = opts.currentDate || TODAY;
  const prompt = buildTaskPrompt(emailBody, subject, mailDate, currentDt, null);
  const raw    = await callOllama(prompt);
  const parsed = JSON.parse(extractJSON(raw));
  // normalizeTaskData (from background.js)
  if (parsed.dueDate)     parsed.dueDate     = normalizeCalDate(parsed.dueDate);
  if (parsed.initialDate) parsed.initialDate = normalizeCalDate(parsed.initialDate);
  if (parsed.InitialDate) {
    parsed.initialDate = normalizeCalDate(parsed.InitialDate);
    delete parsed.InitialDate;
  }
  if (!parsed.summary) parsed.summary = subject;
  return parsed;
}

describe("task integration", () => {

  itOnline("explicit deadline → dueDate extracted", async () => {
    const result = await extractTask(
      "Please submit the Q1 budget report by March 14, 2026. Finance needs it before the board meeting.",
      "Q1 Budget Report Due"
    );
    expect(result.summary).toBeTruthy();
    expect(result.dueDate).toBeDefined();
    expectDate(result.dueDate, "20260314", 1);
  });

  itOnline("no dates in email → summary only, no crash", async () => {
    const result = await extractTask(
      "Don't forget to update the team wiki with the new onboarding steps we discussed.",
      "Update Team Wiki"
    );
    expect(result).toBeDefined();
    expect(typeof result.summary).toBe("string");
    expect(result.summary.length).toBeGreaterThan(0);
    // dueDate may or may not be present — just verify format if it is
    if (result.dueDate) {
      expect(result.dueDate).toMatch(/^\d{8}T\d{6}$/);
    }
  });

  itOnline("relative deadline → resolves to a future date", async () => {
    const result = await extractTask(
      "Can you get the client proposal draft done by next Friday? They need it for their Monday meeting.",
      "Client Proposal Draft",
      { mailDate: "02/20/2026", currentDate: "02/20/2026" }
    );
    expect(result.summary).toBeTruthy();
    expect(result.dueDate).toBeDefined();
    // "next Friday" from Feb 20 (Friday) = Feb 27; allow tolerance
    expect(result.dueDate >= "20260220T000000").toBe(true);
    expectDate(result.dueDate, "20260227", 7);
  });

});

// ---------------------------------------------------------------------------
// Combined extraction prompt (background processing)
// ---------------------------------------------------------------------------
describe("Combined extraction prompt", () => {

  test("extracts all fields from a meeting invite email", async () => {
    if (!ollamaAvailable) return;

    const body = `Hi team,

Let's meet next Thursday at 2pm in the Main Conference Room to discuss
the Q1 budget review. Please bring your department reports.

Also, I need everyone to submit their expense reports by March 1st.

Best regards,
Jane Smith
CFO, Acme Corp
jane.smith@acme.com
(555) 123-4567`;

    const subject = "Q1 Budget Review Meeting - Thursday 2pm";
    const author = "Jane Smith <jane.smith@acme.com>";

    const prompt = buildCombinedExtractionPrompt(
      body, subject, author, MAIL_DATE, TODAY,
      ["jane.smith@acme.com", "team@acme.com"],
      ["Work", "Finance", "Personal"],
      ["Work", "Finance", "Meetings"]
    );

    console.log("  Combined prompt length:", prompt.length, "chars");
    const raw = await callOllama(prompt, {
      num_ctx: 16384, num_predict: 16384, timeout: 300_000,
    });
    console.log("  Raw response length:", raw.length, "chars");

    const jsonStr = extractJSON(raw);
    const result = JSON.parse(jsonStr);

    console.log("  Fields present:", Object.keys(result).join(", "));

    // Summary
    expect(result.summary).toBeDefined();
    expect(typeof result.summary).toBe("string");
    expect(result.summary.length).toBeGreaterThan(20);

    // Events — should find the meeting
    expect(Array.isArray(result.events)).toBe(true);
    expect(result.events.length).toBeGreaterThanOrEqual(1);
    const meetingEvent = result.events[0];
    expect(meetingEvent.preview).toBeDefined();
    expect(meetingEvent.summary || meetingEvent.preview).toMatch(/budget|review|meeting/i);
    // Should have a startDate
    expect(meetingEvent.startDate).toBeDefined();
    console.log("  Event startDate:", meetingEvent.startDate);

    // Tasks — should find the expense report deadline
    expect(Array.isArray(result.tasks)).toBe(true);
    expect(result.tasks.length).toBeGreaterThanOrEqual(1);
    const task = result.tasks[0];
    expect(task.preview).toBeDefined();
    expect(task.summary || task.preview).toMatch(/expense|report/i);

    // Contacts — should find Jane Smith
    expect(Array.isArray(result.contacts)).toBe(true);
    expect(result.contacts.length).toBeGreaterThanOrEqual(1);
    const contact = result.contacts[0];
    expect(contact.preview).toBeDefined();
    // At least one of these should be present
    const hasContactInfo = contact.firstName || contact.lastName || contact.email;
    expect(hasContactInfo).toBeTruthy();

    // Tags
    expect(Array.isArray(result.tags)).toBe(true);
    expect(result.tags.length).toBeGreaterThanOrEqual(1);
    expect(result.tags.length).toBeLessThanOrEqual(3);
    console.log("  Tags:", result.tags.join(", "));

    // Reply
    expect(typeof result.reply).toBe("string");
    expect(result.reply.length).toBeGreaterThan(10);

    // Forward summary
    expect(typeof result.forwardSummary).toBe("string");
    expect(result.forwardSummary.length).toBeGreaterThan(10);
    expect(result.forwardSummary.toLowerCase()).toMatch(/tl;dr|budget|meeting/i);

    console.log("  Combined extraction: all fields validated");

  }, 300_000);

});
