import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(process.cwd(), "src/smart-ui");
const SPECIFIER =
  /(?:import|export)\s+(?:type\s+)?(?:[^"'`;]*?\s+from\s+)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)/g;

function filesIn(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...filesIn(full));
    else found.push(full);
  }
  return found;
}

function specifiers(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(SPECIFIER)) {
    const value = match[1] ?? match[2] ?? match[3];
    if (value) found.push(value);
  }
  return found;
}

function isBanned(specifier: string): boolean {
  return (
    specifier === "next" ||
    specifier.startsWith("next/") ||
    specifier === "@/lib/server" ||
    specifier.startsWith("@/lib/server/")
  );
}

describe("smart-ui purity", () => {
  it("does not import next or the server runtime", () => {
    const files = filesIn(ROOT).filter((file) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file));
    expect(files.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const specifier of specifiers(source)) {
        if (isBanned(specifier)) {
          offenders.push(`${path.relative(ROOT, file)} -> ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
