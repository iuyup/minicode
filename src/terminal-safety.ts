const UNSAFE_TERMINAL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]|\p{Cf}/u;
const UNSAFE_TERMINAL_CHARACTER_GLOBAL_PATTERN = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]|\p{Cf}/gu;
const UNSAFE_MULTILINE_TERMINAL_CHARACTER_GLOBAL_PATTERN =
  /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u2028\u2029]|\p{Cf}/gu;

function visibleUnicodeEscape(character: string): string {
  const codePoint = character.codePointAt(0) ?? 0;
  const hexadecimal = codePoint.toString(16).toUpperCase();
  return codePoint <= 0xffff
    ? `\\u${hexadecimal.padStart(4, "0")}`
    : `\\u{${hexadecimal}}`;
}

export function hasUnsafeTerminalText(value: string): boolean {
  return UNSAFE_TERMINAL_CHARACTER_PATTERN.test(value);
}

/** 把换行、终端控制与双向文本控制字符转成可见的 Unicode 转义。 */
export function escapeTerminalText(value: string): string {
  return value.replace(UNSAFE_TERMINAL_CHARACTER_GLOBAL_PATTERN, visibleUnicodeEscape);
}

/**
 * 保留可信布局所需的换行，同时把不可信文本中的终端与文本方向控制符转成可见转义。
 * 所有平台换行先规范为 LF，避免孤立 CR 被终端解释为回到行首。
 */
export function escapeMultilineTerminalText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(UNSAFE_MULTILINE_TERMINAL_CHARACTER_GLOBAL_PATTERN, visibleUnicodeEscape);
}
