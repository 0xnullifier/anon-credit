// Check that the generated constant files agree with the shared fixtures.
// This test is the equality check for the Noir constants file.

import { describe, expect, it } from "vitest";
import { readRepoFile, renderAll } from "./constants.ts";

describe("generated constant files", () => {
  for (const [path, text] of renderAll()) {
    it(`${path} is up to date`, () => {
      expect(readRepoFile(path)).toBe(text);
    });
  }
});
