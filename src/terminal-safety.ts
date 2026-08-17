const UNSAFE_TERMINAL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]|\p{Cf}/u;
const UNSAFE_TERMINAL_CHARACTER_GLOBAL_PATTERN = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]|\p{Cf}/gu;

export function hasUnsafeTerminalText(value: string): boolean {
  return UNSAFE_TERMINAL_CHARACTER_PATTERN.test(value);
}

/** 把换行、终端控制与双向文本控制字符转成可见的 Unicode 转义。 */
export function escapeTerminalText(value: string): string {
  return value.replace(UNSAFE_TERMINAL_CHARACTER_GLOBAL_PATTERN, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return `\\u${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
  });
}
