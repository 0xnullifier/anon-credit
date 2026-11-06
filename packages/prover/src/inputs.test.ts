import { describe, expect, it } from "vitest";
import { inputMapSchema, parseCircuit } from "./inputs.ts";

describe("circuit inputs", () => {
  it("accepts nested Noir inputs", () => {
    const inputs = { secret: "0x01", epoch: 999, flag: true, siblings: ["1", "2"], point: { x: "1", y: ["2"] } };
    expect(inputMapSchema.parse(inputs)).toEqual(inputs);
  });

  it("rejects values that are not Noir inputs", () => {
    expect(inputMapSchema.safeParse({ secret: null }).success).toBe(false);
    expect(inputMapSchema.safeParse({ secret: 1n }).success).toBe(false);
  });
});

describe("parseCircuit", () => {
  it("reads the ProveKit circuit JSON", () => {
    const json = JSON.stringify({
      abi: {
        parameters: [
          { name: "secret", type: { kind: "field" }, visibility: "private" },
          { name: "epoch", type: { kind: "integer", sign: "unsigned", width: 64 }, visibility: "public" },
          { name: "siblings", type: { kind: "array", length: 2, type: { kind: "field" } }, visibility: "private" },
        ],
        return_type: null,
        error_types: { "123": { error_kind: "string", string: "batch expired" } },
      },
      bytecode: "H4sIAAAAAAAA",
    });
    const circuit = parseCircuit(json);
    expect(circuit.abi.parameters).toHaveLength(3);
    expect(circuit.bytecode).toBe("H4sIAAAAAAAA");
  });

  it("rejects a circuit without bytecode", () => {
    expect(() => parseCircuit(JSON.stringify({ abi: { parameters: [], return_type: null, error_types: {} } }))).toThrow();
  });
});
