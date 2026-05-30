import { test } from "node:test";
import assert from "node:assert/strict";
import { wallClockInTz, pad2 } from "../services/schedule-time";

test("wallClockInTz converts a UTC instant into US Eastern wall clock (DST)", () => {
  // 22:00 UTC on Jun 3 is 18:00 EDT (UTC-4) the same day.
  const wc = wallClockInTz(new Date("2026-06-03T22:00:00Z"), "America/New_York");
  assert.deepEqual(wc, { y: 2026, mo: 6, d: 3, h: 18, mi: 0 });
});

test("wallClockInTz rolls the date forward when the zone is ahead of UTC", () => {
  // 22:00 UTC on Jun 3 is 00:00 CEST (UTC+2) on Jun 4 in Berlin.
  const wc = wallClockInTz(new Date("2026-06-03T22:00:00Z"), "Europe/Berlin");
  assert.deepEqual(wc, { y: 2026, mo: 6, d: 4, h: 0, mi: 0 });
});

test("wallClockInTz respects standard (winter) offsets", () => {
  // 09:30 UTC on Jan 15 is 04:30 EST (UTC-5) in winter.
  const wc = wallClockInTz(new Date("2026-01-15T09:30:00Z"), "America/New_York");
  assert.deepEqual(wc, { y: 2026, mo: 1, d: 15, h: 4, mi: 30 });
});

test("pad2 zero-pads single digits", () => {
  assert.equal(pad2(5), "05");
  assert.equal(pad2(12), "12");
  assert.equal(pad2(0), "00");
});
