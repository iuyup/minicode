import { TextDecoder } from "node:util";

// ignoreBOM=true 表示把 UTF-8 BOM 保留为 U+FEFF，整文件改写时不会静默删除原 BOM。
const STRICT_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export class InvalidUtf8Error extends Error {
  constructor() {
    super("文件不是有效的 UTF-8 文本。");
    this.name = "InvalidUtf8Error";
  }
}

/** 严格解码 UTF-8；不会用 U+FFFD 静默替换损坏的字节。 */
export function decodeUtf8Strict(content: Uint8Array): string {
  try {
    return STRICT_UTF8_DECODER.decode(content);
  } catch {
    throw new InvalidUtf8Error();
  }
}
