import { describe, expect, it } from "vitest";
import { formatTimestamp } from "./format";

describe("formatTimestamp", () => {
  it("formats under an hour as m:ss", () => {
    expect(formatTimestamp(0)).toBe("0:00");
    expect(formatTimestamp(124)).toBe("2:04");
    expect(formatTimestamp(3599)).toBe("59:59");
  });

  it("formats an hour or more as h:mm:ss", () => {
    expect(formatTimestamp(3600)).toBe("1:00:00");
    expect(formatTimestamp(5489)).toBe("1:31:29");
  });

  it("guards non-finite input", () => {
    expect(formatTimestamp(Number.NaN)).toBe("0:00");
    expect(formatTimestamp(-3)).toBe("0:00");
  });
});
