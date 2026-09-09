(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.VoiceMemoRules = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const PARSER_VERSION = "rules-v1";
  const CATEGORY_RULES = Object.freeze({
    repair: ["修理"],
    estimate: ["見積", "見積り"],
    inspection: ["点検"],
    order: ["発注"],
    visit: ["訪問"],
    contact: ["連絡"],
  });
  const CATEGORY_PRIORITY = Object.freeze([
    "repair", "estimate", "inspection", "order", "visit", "contact",
  ]);
  const LOW_PRIORITY_WORDS = Object.freeze(["急がない", "低優先", "後回し"]);
  const URGENT_WORDS = Object.freeze(["大至急", "なるべく早く", "至急", "緊急", "急ぎ"]);

  function normalizeJapaneseText(value) {
    return String(value ?? "").normalize("NFKC").replace(/[\u3000\t\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  }

  function jstDate(now = new Date(), offset = 0) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(now);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return new Date(Date.UTC(+values.year, +values.month - 1, +values.day + offset)).toISOString().slice(0, 10);
  }

  // v1 intentionally handles relative dates only. Concrete dates can be added here later.
  function parseRelativeDate(text, now = new Date()) {
    if (/(?:明日|あした)/.test(text)) return { kind: "tomorrow", dueDate: jstDate(now, 1) };
    if (/(?:今日中|今日|本日)/.test(text)) return { kind: "today", dueDate: jstDate(now) };
    if (/(?:今週中|今週)/.test(text)) {
      const today = jstDate(now);
      const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
      return { kind: "this_week", dueDate: jstDate(now, weekday === 0 ? 0 : 7 - weekday) };
    }
    if (/期限なし/.test(text)) return { kind: "none", dueDate: null };
    return { kind: null, dueDate: null };
  }

  function parseTime(text) {
    let match = text.match(/(?:^|[^0-9])([01]?\d|2[0-3])\s*時\s*半/);
    if (match) return `${String(Number(match[1])).padStart(2, "0")}:30`;
    match = text.match(/(?:^|[^0-9])([01]?\d|2[0-3])\s*[:：]\s*([0-5]\d)(?!\d)/);
    if (match) return `${String(Number(match[1])).padStart(2, "0")}:${match[2]}`;
    match = text.match(/(?:^|[^0-9])([01]?\d|2[0-3])\s*時(?!\s*半)/);
    return match ? `${String(Number(match[1])).padStart(2, "0")}:00` : null;
  }

  function parseDue(text, now = new Date()) {
    const date = parseRelativeDate(text, now);
    const dueTime = parseTime(text);
    const period = /午前中|午前/.test(text) ? "morning" : /午後/.test(text) ? "afternoon" : null;
    if (date.kind === "this_week") return { dueDate: date.dueDate, dueTime: null, duePeriod: "this_week", duePreset: "this_week" };
    if (date.kind === "none" && !dueTime && !period) return { dueDate: null, dueTime: null, duePeriod: "none", duePreset: "none" };
    const dueDate = date.dueDate || (dueTime || period ? jstDate(now) : null);
    if (!dueDate) return { dueDate: null, dueTime: null, duePeriod: "none", duePreset: "none" };
    const duePreset = date.kind === "tomorrow" ? "tomorrow" : "today";
    if (dueTime) return { dueDate, dueTime, duePeriod: "exact", duePreset };
    if (period) return { dueDate, dueTime: null, duePeriod: period, duePreset };
    return { dueDate, dueTime: null, duePeriod: "all_day", duePreset };
  }

  function parsePriority(text) {
    if (LOW_PRIORITY_WORDS.some((word) => text.includes(word))) return "low";
    if (URGENT_WORDS.some((word) => text.includes(word))) return "urgent";
    return "normal";
  }

  function parseCategory(text) {
    return CATEGORY_PRIORITY.find((category) => CATEGORY_RULES[category].some((word) => text.includes(word))) || "other";
  }

  function buildTextCandidate(rawText) {
    const raw = normalizeJapaneseText(rawText);
    let candidate = raw
      .replace(/(?:今日中|今日|本日|明日|あした)(?:の)?/g, " ")
      .replace(/(?:今週中|今週|期限なし)/g, " ")
      .replace(/(?:午前中|午前|午後)(?:まで|に)?/g, " ")
      .replace(/(?:[01]?\d|2[0-3])\s*時\s*半(?:まで|に)?/g, " ")
      .replace(/(?:[01]?\d|2[0-3])\s*[:：]\s*[0-5]\d(?:まで|に)?/g, " ")
      .replace(/(?:[01]?\d|2[0-3])\s*時(?:まで|に)?/g, " ")
      .replace(/(?:急がない|低優先|後回し|大至急|なるべく早く|至急|緊急|急ぎ)/g, " ")
      .replace(/[、。，．,]+/g, " ")
      .replace(/\s+/g, " ")
      .replace(/^[にへでをはがのまで]+|[にへでをはがのまで]+$/g, "")
      .trim();
    const meaningful = candidate.replace(/[\s。、，．,.!！?？・「」『』（）()\-ー]/g, "");
    if (meaningful.length < 2 || /^(?:に|へ|で|を|は|が|の|まで)+$/.test(candidate)) candidate = raw;
    return candidate || raw;
  }

  function parseVoiceMemo(rawText, now = new Date()) {
    const original = String(rawText ?? "").trim();
    const normalized = normalizeJapaneseText(original);
    if (!normalized) return null;
    return {
      rawText: original,
      text: buildTextCandidate(normalized),
      category: parseCategory(normalized),
      priority: parsePriority(normalized),
      ...parseDue(normalized, now),
      parserVersion: PARSER_VERSION,
    };
  }

  return { PARSER_VERSION, CATEGORY_RULES, CATEGORY_PRIORITY, normalizeJapaneseText, jstDate, parseRelativeDate, parseTime, parseDue, parsePriority, parseCategory, buildTextCandidate, parseVoiceMemo };
});
