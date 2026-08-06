import type { JsonObject, JsonValue, ValidationResult } from "../agent/contracts.ts";

export function validateObjectWithKeys(
  input: JsonValue,
  allowedKeys: readonly string[],
): ValidationResult<JsonObject> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: "工具参数必须是 JSON 对象。" };
  }

  const unexpectedKey = Object.keys(input).find((key) => !allowedKeys.includes(key));
  if (unexpectedKey) {
    return { ok: false, error: `不支持的参数：${unexpectedKey}` };
  }

  return { ok: true, value: input };
}

export function validateOptionalPath(
  input: JsonObject,
  key = "path",
): ValidationResult<string | undefined> {
  const value = input[key];
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (typeof value !== "string" || value.trim() === "") {
    return { ok: false, error: `${key} 必须是非空字符串。` };
  }
  return { ok: true, value };
}

export function validateLineNumber(
  input: JsonObject,
  key: string,
): ValidationResult<number | undefined> {
  const value = input[key];
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return { ok: false, error: `${key} 必须是大于等于 1 的整数。` };
  }
  return { ok: true, value };
}
