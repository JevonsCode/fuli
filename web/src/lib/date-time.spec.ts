import { describe, expect, it } from "vitest";

import { DATE_TIME_FULL, formatDateTime } from "./date-time";

const labels = { missing: "not recorded" };

describe("formatDateTime", () => {
  it("formats a recorded instant in the given locale", () => {
    const value = "2026-03-04T05:06:07Z";
    expect(formatDateTime(value, "en-US", DATE_TIME_FULL, labels)).toBe(
      new Date(value).toLocaleString("en-US"),
    );
    expect(formatDateTime(value, "en-US", { month: "short", timeZone: "UTC" }, labels)).toBe("Mar");
  });

  it("uses the missing label for empty values", () => {
    expect(formatDateTime(null, "en-US", DATE_TIME_FULL, labels)).toBe("not recorded");
    expect(formatDateTime("", "en-US", DATE_TIME_FULL, labels)).toBe("not recorded");
  });

  it("keeps an unparseable value unless an invalid label is given", () => {
    expect(formatDateTime("someday", "en-US", DATE_TIME_FULL, labels)).toBe("someday");
    expect(formatDateTime("someday", "en-US", DATE_TIME_FULL, { ...labels, invalid: "?" })).toBe("?");
  });
});
