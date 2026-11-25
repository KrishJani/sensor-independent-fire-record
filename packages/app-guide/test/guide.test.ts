import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { GITHUB_URL, GUIDE, GUIDE_LINKS, GUIDE_TOPICS, guideMarkdown, TEAM_CREDIT } from "../src/index.ts";

const root = new URL("../../../", import.meta.url);

test("every topic has exactly one section, in order", () => {
  assert.deepEqual(GUIDE.map((s) => s.id), [...GUIDE_TOPICS]);
});

test("the team credit matches the README word for word", () => {
  assert.ok(readFileSync(new URL("README.md", root), "utf8").includes(TEAM_CREDIT));
});

test("docs/APP_GUIDE.md is up to date (run: pnpm --filter @repo/app-guide docs)", () => {
  assert.equal(readFileSync(new URL("docs/APP_GUIDE.md", root), "utf8"), guideMarkdown());
});

test("copy has no em dashes", () => {
  for (const s of GUIDE) {
    assert.doesNotMatch(s.body + s.summary, /—/, s.id);
  }
});

test("GUIDE_LINKS lists the guide's links (GitHub and the team profiles)", () => {
  assert.ok(GUIDE_LINKS.includes(GITHUB_URL));
  assert.ok(GUIDE_LINKS.includes("https://github.com/riddhixraina"));
});
