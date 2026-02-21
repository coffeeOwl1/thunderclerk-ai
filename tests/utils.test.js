"use strict";

const {
  normalizeCalDate,
  addHoursToCalDate,
  applyCalendarDefaults,
  extractJSON,
  buildAttendeesHint,
  buildDescription,
  buildCategoryInstruction,
  isValidHostUrl,
  extractTextBody,
  formatDatetime,
} = require("../utils.js");

// ---------------------------------------------------------------------------
// normalizeCalDate
// ---------------------------------------------------------------------------
describe("normalizeCalDate", () => {
  test("returns null/undefined unchanged", () => {
    expect(normalizeCalDate(null)).toBe(null);
    expect(normalizeCalDate(undefined)).toBe(undefined);
    expect(normalizeCalDate("")).toBe("");
  });

  test("passes already-correct compact format through", () => {
    expect(normalizeCalDate("20260225T140000")).toBe("20260225T140000");
  });

  test("strips ISO 8601 dashes and colons", () => {
    expect(normalizeCalDate("2026-02-25T14:00:00")).toBe("20260225T140000");
  });

  test("strips trailing Z", () => {
    expect(normalizeCalDate("2026-02-25T14:00:00Z")).toBe("20260225T140000");
  });

  test("strips timezone offset", () => {
    expect(normalizeCalDate("2026-02-25T14:00:00+0530")).toBe("20260225T140000");
    expect(normalizeCalDate("2026-02-25T09:30:00-0500")).toBe("20260225T093000");
  });

  test("strips fractional seconds", () => {
    expect(normalizeCalDate("2026-02-25T14:00:00.000Z")).toBe("20260225T140000");
  });

  test("pads truncated time to 6 digits", () => {
    // Model returned only hours
    expect(normalizeCalDate("2028-01-10T13")).toBe("20280110T130000");
    // Model returned hours:minutes with trailing colons stripped
    expect(normalizeCalDate("2028-01-10T13::")).toBe("20280110T130000");
  });

  test("date-only string gets midnight time", () => {
    expect(normalizeCalDate("20260225")).toBe("20260225T000000");
    expect(normalizeCalDate("2026-02-25")).toBe("20260225T000000");
  });
});

// ---------------------------------------------------------------------------
// addHoursToCalDate
// ---------------------------------------------------------------------------
describe("addHoursToCalDate", () => {
  test("adds hours within the same day", () => {
    expect(addHoursToCalDate("20260225T090000", 1)).toBe("20260225T100000");
  });

  test("rolls over midnight correctly", () => {
    expect(addHoursToCalDate("20260225T230000", 2)).toBe("20260226T010000");
  });

  test("adds zero hours (no change)", () => {
    expect(addHoursToCalDate("20260225T140000", 0)).toBe("20260225T140000");
  });
});

// ---------------------------------------------------------------------------
// applyCalendarDefaults
// ---------------------------------------------------------------------------
describe("applyCalendarDefaults", () => {
  test("sets start to 9am when time is missing (T000000)", () => {
    const data = { startDate: "20260225T000000", endDate: "20260225T000000" };
    applyCalendarDefaults(data);
    expect(data.startDate).toBe("20260225T090000");
  });

  test("sets end to start + 1 hour when end is missing", () => {
    const data = { startDate: "20260225T140000", endDate: "" };
    applyCalendarDefaults(data);
    expect(data.endDate).toBe("20260225T150000");
  });

  test("sets end to start + 1 hour when end has no time (T000000)", () => {
    const data = { startDate: "20260225T090000", endDate: "20260225T000000" };
    applyCalendarDefaults(data);
    expect(data.endDate).toBe("20260225T100000");
  });

  test("sets end to start + 1 hour when end is null", () => {
    const data = { startDate: "20260225T090000", endDate: null };
    applyCalendarDefaults(data);
    expect(data.endDate).toBe("20260225T100000");
  });

  test("overrides AI end-of-day guess (23:59) when start was date-only", () => {
    // AI returned T235900 as a guess — should be ignored when email had no time
    const data = { startDate: "20260225T000000", endDate: "20260225T235900" };
    applyCalendarDefaults(data);
    expect(data.startDate).toBe("20260225T090000");
    expect(data.endDate).toBe("20260225T100000");
  });

  test("does not modify times that are already set", () => {
    const data = { startDate: "20260225T140000", endDate: "20260225T153000" };
    applyCalendarDefaults(data);
    expect(data.startDate).toBe("20260225T140000");
    expect(data.endDate).toBe("20260225T153000");
  });

  test("skips all defaults for all-day events", () => {
    const data = { startDate: "20260225T000000", endDate: "", forceAllDay: true };
    applyCalendarDefaults(data);
    expect(data.startDate).toBe("20260225T000000");
    expect(data.endDate).toBe("");
  });

  test("handles missing startDate gracefully", () => {
    const data = { startDate: "", endDate: "" };
    expect(() => applyCalendarDefaults(data)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// extractJSON
// ---------------------------------------------------------------------------
describe("extractJSON", () => {
  test("extracts a plain JSON object", () => {
    const raw = '{"summary":"Team lunch","startDate":"20260301T120000"}';
    expect(extractJSON(raw)).toBe(raw);
  });

  test("strips markdown json fence", () => {
    const raw = '```json\n{"a":1}\n```';
    expect(extractJSON(raw)).toBe('{"a":1}');
  });

  test("strips plain markdown fence", () => {
    const raw = "```\n{\"a\":1}\n```";
    expect(extractJSON(raw)).toBe('{"a":1}');
  });

  test("ignores preamble text before {", () => {
    const raw = 'Here is the JSON:\n{"a":1}';
    expect(extractJSON(raw)).toBe('{"a":1}');
  });

  test("handles nested objects", () => {
    const raw = '{"outer":{"inner":42},"x":1}';
    expect(extractJSON(raw)).toBe(raw);
  });

  test("throws on no JSON object", () => {
    expect(() => extractJSON("no braces here")).toThrow("No JSON object found");
  });

  test("throws on unclosed object", () => {
    expect(() => extractJSON('{"a":1')).toThrow("Unclosed JSON object");
  });

  test("parse round-trip", () => {
    const obj = { summary: "Test", startDate: "20260301T090000", forceAllDay: false };
    const raw = JSON.stringify(obj);
    expect(JSON.parse(extractJSON(raw))).toEqual(obj);
  });
});

// ---------------------------------------------------------------------------
// buildAttendeesHint
// ---------------------------------------------------------------------------
describe("buildAttendeesHint", () => {
  const msg = {
    author: "alice@example.com",
    recipients: ["bob@example.com", "carol@example.com"],
  };

  test("from_to returns author + recipients", () => {
    expect(buildAttendeesHint(msg, "from_to", "")).toEqual([
      "alice@example.com", "bob@example.com", "carol@example.com",
    ]);
  });

  test("from returns only author", () => {
    expect(buildAttendeesHint(msg, "from", "")).toEqual(["alice@example.com"]);
  });

  test("to returns only recipients", () => {
    expect(buildAttendeesHint(msg, "to", "")).toEqual(["bob@example.com", "carol@example.com"]);
  });

  test("static returns the configured email", () => {
    expect(buildAttendeesHint(msg, "static", "me@example.com")).toEqual(["me@example.com"]);
  });

  test("static with empty string returns []", () => {
    expect(buildAttendeesHint(msg, "static", "")).toEqual([]);
  });

  test("none returns []", () => {
    expect(buildAttendeesHint(msg, "none", "")).toEqual([]);
  });

  test("unknown source defaults to from_to", () => {
    expect(buildAttendeesHint(msg, "unknown", "")).toEqual([
      "alice@example.com", "bob@example.com", "carol@example.com",
    ]);
  });

  test("handles missing author gracefully", () => {
    const noAuthor = { recipients: ["bob@example.com"] };
    expect(buildAttendeesHint(noAuthor, "from_to", "")).toEqual(["bob@example.com"]);
  });
});

// ---------------------------------------------------------------------------
// buildDescription
// ---------------------------------------------------------------------------
describe("buildDescription", () => {
  const body    = "Please join us for the Q1 review.";
  const author  = "alice@example.com";
  const subject = "Q1 Review Meeting";

  test("body_from_subject (default) includes from, subject, and body", () => {
    const result = buildDescription(body, author, subject, "body_from_subject");
    expect(result).toContain(`From: ${author}`);
    expect(result).toContain(`Subject: ${subject}`);
    expect(result).toContain(body);
  });

  test("body returns only the email body", () => {
    expect(buildDescription(body, author, subject, "body")).toBe(body);
  });

  test("none returns null", () => {
    expect(buildDescription(body, author, subject, "none")).toBeNull();
  });

  test("unknown format defaults to body_from_subject", () => {
    const result = buildDescription(body, author, subject, "unknown");
    expect(result).toContain(`From: ${author}`);
  });
});

// ---------------------------------------------------------------------------
// buildCategoryInstruction
// ---------------------------------------------------------------------------
describe("buildCategoryInstruction", () => {
  test("returns empty strings when no categories", () => {
    expect(buildCategoryInstruction([])).toEqual({ instruction: "", jsonLine: "" });
    expect(buildCategoryInstruction(null)).toEqual({ instruction: "", jsonLine: "" });
  });

  test("includes all category names in instruction", () => {
    const cats = ["Family", "Work", "Personal"];
    const { instruction, jsonLine } = buildCategoryInstruction(cats);
    expect(instruction).toContain("Family");
    expect(instruction).toContain("Work");
    expect(instruction).toContain("Personal");
    expect(jsonLine).toContain("category");
  });
});

// ---------------------------------------------------------------------------
// isValidHostUrl
// ---------------------------------------------------------------------------
describe("isValidHostUrl", () => {
  test("accepts http URLs", () => {
    expect(isValidHostUrl("http://127.0.0.1:11434")).toBe(true);
    expect(isValidHostUrl("http://localhost:11434")).toBe(true);
  });

  test("accepts https URLs", () => {
    expect(isValidHostUrl("https://ollama.example.com")).toBe(true);
  });

  test("rejects non-URL strings", () => {
    expect(isValidHostUrl("not a url")).toBe(false);
    expect(isValidHostUrl("")).toBe(false);
  });

  test("rejects other protocols", () => {
    expect(isValidHostUrl("ftp://example.com")).toBe(false);
    expect(isValidHostUrl("file:///etc/passwd")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractTextBody
// ---------------------------------------------------------------------------
describe("extractTextBody", () => {
  test("returns body of a plain text part", () => {
    const part = { contentType: "text/plain", body: "Hello world" };
    expect(extractTextBody(part)).toBe("Hello world");
  });

  test("prefers text/plain over text/html when both exist", () => {
    const part = {
      contentType: "multipart/alternative",
      parts: [
        { contentType: "text/html", body: "<p>Hello HTML</p>" },
        { contentType: "text/plain", body: "Hello plain" },
      ],
    };
    expect(extractTextBody(part)).toBe("Hello plain");
  });

  test("falls back to text/html when no text/plain exists", () => {
    const part = {
      contentType: "multipart/mixed",
      parts: [
        { contentType: "text/html", body: "<p>Hello</p>" },
        { contentType: "application/octet-stream", body: "" },
      ],
    };
    expect(extractTextBody(part)).toBe("Hello");
  });

  test("strips HTML tags from fallback html body", () => {
    const part = { contentType: "text/html", body: "<p>Hello <b>world</b></p>" };
    expect(extractTextBody(part)).toBe("Hello world");
  });

  test("strips style and script blocks", () => {
    const part = {
      contentType: "text/html",
      body: "<style>body{color:red}</style><p>Keep this</p><script>alert(1)</script>",
    };
    expect(extractTextBody(part)).toContain("Keep this");
    expect(extractTextBody(part)).not.toContain("color");
    expect(extractTextBody(part)).not.toContain("alert");
  });

  test("decodes common HTML entities", () => {
    const part = { contentType: "text/html", body: "<p>AT&amp;T &lt;test&gt;</p>" };
    expect(extractTextBody(part)).toBe("AT&T <test>");
  });

  test("converts br and block tags to newlines", () => {
    const part = { contentType: "text/html", body: "<p>Line 1</p><p>Line 2</p>" };
    const result = extractTextBody(part);
    expect(result).toContain("Line 1");
    expect(result).toContain("Line 2");
  });

  test("returns empty string when no text parts found", () => {
    const part = { contentType: "application/pdf", body: "" };
    expect(extractTextBody(part)).toBe("");
  });

  test("handles null input", () => {
    expect(extractTextBody(null)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// formatDatetime
// ---------------------------------------------------------------------------
describe("formatDatetime", () => {
  test("returns only a date string (no time component)", () => {
    // A known timestamp: 2026-02-25 at 15:07 local time
    const result = formatDatetime(new Date(2026, 1, 25, 15, 7, 0).getTime());
    expect(result).toMatch(/02\/25\/2026/);
    // Must not contain hour digits like "15" or "03" that would indicate a time
    expect(result).not.toMatch(/\d{2}:\d{2}/);
  });

  test("accepts an ISO date string", () => {
    const result = formatDatetime("2026-03-10T09:00:00");
    expect(result).toMatch(/03\/10\/2026/);
    expect(result).not.toMatch(/\d{2}:\d{2}/);
  });

  test("falls back to today when given null", () => {
    const result = formatDatetime(null);
    // Should be a non-empty date string
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    expect(result).not.toMatch(/\d{2}:\d{2}/);
  });
});
