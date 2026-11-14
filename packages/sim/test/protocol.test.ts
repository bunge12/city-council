import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, parseToSimMessage } from "../src/index";

describe("parseToSimMessage", () => {
  it("refuses other protocol versions and unknown types", () => {
    expect(parseToSimMessage({ v: 1, type: "requestSnapshot" })).toMatch(/version 1 is not supported, expected 6/);
    expect(parseToSimMessage({ v: PROTOCOL_VERSION, type: "explode" })).toMatch(/unknown/);
    expect(parseToSimMessage(null)).toMatch(/object/);
    expect(parseToSimMessage({ v: PROTOCOL_VERSION, type: "command" })).toMatch(/command object/);
  });

  it("keeps only the known fields of a command", () => {
    expect(
      parseToSimMessage({
        v: PROTOCOL_VERSION,
        type: "command",
        extra: 1,
        command: { seq: 1, playerId: "p", type: "NoOp", payload: {}, admin: true },
      }),
    ).toEqual({
      v: PROTOCOL_VERSION,
      type: "command",
      command: { seq: 1, playerId: "p", type: "NoOp", payload: {} },
    });
  });
});
