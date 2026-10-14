import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(process.cwd(), "src/components/chat");
const QUOTED_CAPABILITY = /['"`](?:inquiry|product|supplier)\./;

function filesIn(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...filesIn(full));
    else found.push(full);
  }
  return found;
}

describe("chat capability purity", () => {
  it("does not hardcode capability ids under src/components/chat", () => {
    const files = filesIn(ROOT).filter((file) => /\.(ts|tsx)$/.test(file));
    expect(files.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      if (QUOTED_CAPABILITY.test(source)) {
        offenders.push(path.relative(ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
