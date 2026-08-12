import assert from "node:assert/strict";
import test from "node:test";

import { formatGreeting } from "../src/greeting.js";

test("formatGreeting returns a complete greeting", () => {
  assert.equal(formatGreeting("MiniCode"), "Hello, MiniCode!");
});
