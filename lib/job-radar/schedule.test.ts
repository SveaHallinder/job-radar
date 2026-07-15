import { describe, expect, it } from "vitest";

import { getNextStockholmRun } from "./schedule";

describe("getNextStockholmRun", () => {
  it("returns 08:00 Stockholm on a summer morning", () => {
    const now = new Date("2026-07-15T05:30:00.000Z");
    expect(getNextStockholmRun(now).toISOString()).toBe("2026-07-15T06:00:00.000Z");
  });

  it("returns 16:00 after the morning run", () => {
    const now = new Date("2026-07-15T06:01:00.000Z");
    expect(getNextStockholmRun(now).toISOString()).toBe("2026-07-15T14:00:00.000Z");
  });

  it("returns the next day's 08:00 after the afternoon run", () => {
    const now = new Date("2026-07-15T14:01:00.000Z");
    expect(getNextStockholmRun(now).toISOString()).toBe("2026-07-16T06:00:00.000Z");
  });

  it("uses the winter UTC offset", () => {
    const now = new Date("2026-01-15T06:30:00.000Z");
    expect(getNextStockholmRun(now).toISOString()).toBe("2026-01-15T07:00:00.000Z");
  });
});
