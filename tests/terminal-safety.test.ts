import assert from "node:assert/strict";
import test from "node:test";

import {
  escapeMultilineTerminalText,
  escapeTerminalText,
} from "../src/terminal-safety.ts";

test("多行终端文本统一平台换行并保留普通 Unicode 与 Markdown", () => {
  const input = "标题\r\n\r**中文** 😀\n`code`";

  assert.equal(
    escapeMultilineTerminalText(input),
    "标题\n\n**中文** 😀\n`code`",
  );
});

test("多行终端文本把控制序列、方向控制和 Unicode 行分隔符变为可见转义", () => {
  const input = [
    "safe",
    "\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007",
    "\u009dtitle\u009c",
    "left\u202Eright\u2066isolated\u2069",
    "tab\tvalue\u2028next\u2029last",
    "tag\u{E0001}",
  ].join("\n");

  const escaped = escapeMultilineTerminalText(input);

  assert.equal(escaped.includes("\u001b"), false);
  assert.equal(escaped.includes("\u0007"), false);
  assert.equal(escaped.includes("\u009d"), false);
  assert.equal(escaped.includes("\u202e"), false);
  assert.equal(escaped.includes("\u2066"), false);
  assert.match(escaped, /\\u001B]8;;https:\/\/example\.com\\u0007link/);
  assert.match(escaped, /\\u009Dtitle\\u009C/);
  assert.match(escaped, /left\\u202Eright\\u2066isolated\\u2069/);
  assert.match(escaped, /tab\\u0009value\\u2028next\\u2029last/);
  assert.match(escaped, /tag\\u\{E0001\}/);
  assert.equal(escaped.split("\n").length, input.split("\n").length);
});

test("单行终端转义继续把换行转成可见文本", () => {
  assert.equal(escapeTerminalText("a\r\nb"), "a\\u000D\\u000Ab");
});
