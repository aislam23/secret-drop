import test from "node:test";
import assert from "node:assert/strict";
import { containsSecret, SAFE_REPLACEMENT } from "../detect.js";

test("recognizes synthetic token formats", () => {
  assert.equal(containsSecret("api key sk-proj-" + "x".repeat(40)), true);
  assert.equal(containsSecret("telegram token 1234567890:AA" + "y".repeat(33)), true);
  assert.equal(containsSecret("токен: Zq81kLm02XpR7tYv9wQe"), true);
});
test("does not flag typical metadata", () => {
  for (const text of [
    "set OPENAI_API_KEY in .env",
    "key commit 3f2a9c1e5b7d4f6a8c0e2b4d6f8a1c3e5b7d9f0a broke the build",
    "voice uuAEb8aX4QXTwh8CAexT and key in .env",
  ]) assert.equal(containsSecret(text), false);
});
test("the safe replacement does not echo any input", () => {
  const fake = "sk-ant-" + "z".repeat(40);
  assert.equal(containsSecret(fake), true);
  assert.equal(SAFE_REPLACEMENT.includes(fake), false);
});
