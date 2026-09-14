/** UTF-8 严格模式：非法字节抛错，而不是像 Buffer#toString 那样静默替换成 U+FFFD */
const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true });
/** GB18030 是 GBK / GB2312 的超集，中文场景可安全兜底 */
const GB18030 = new TextDecoder('gb18030');

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/**
 * 按字节推断编码并解码为字符串。
 *
 * 顺序：BOM → 严格 UTF-8 → GB18030 兜底。
 * 中文文档几乎不可能整篇字节都恰好是合法 UTF-8，故该启发式足够可靠。
 *
 * 注意不能用 Buffer#toString('utf8')：它对非法字节不报错，直接替换为 U+FFFD，
 * 会把 GBK 编码的中文写成不可逆的乱码。
 */
export function decodeTextBuffer(buffer: Buffer): string {
  if (buffer.subarray(0, 3).equals(UTF8_BOM)) {
    return buffer.subarray(3).toString('utf8');
  }
  try {
    return UTF8_STRICT.decode(buffer);
  } catch {
    return GB18030.decode(buffer);
  }
}
