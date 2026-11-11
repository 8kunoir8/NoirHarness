import { describe, expect, it } from "vitest";
import { base64ToBytes } from "../src/renderer/preview/bytes.js";

describe("base64ToBytes", () => {
  it("decodes base64 into the raw bytes, not a binary string", () => {
    const bytes = base64ToBytes("JVBERg==");

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(bytes)).toEqual([0x25, 0x50, 0x44, 0x46]);
    expect(new TextDecoder().decode(bytes)).toBe("%PDF");
  });

  it("decodes high bytes without mangling them", () => {
    expect(Array.from(base64ToBytes("//4="))).toEqual([0xff, 0xfe]);
  });
});
