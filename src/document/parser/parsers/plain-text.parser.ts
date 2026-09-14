import { decodeTextBuffer } from '../utils/encoding.util.js';

/**
 * 将 TXT / MD 解析为文本。
 *
 * 不做结构转换：按推断出的编码（UTF-8 / GB18030）读出，后续由调用方直接当作 Markdown/纯文本使用。
 */
export function parsePlainText(buffer: Buffer): string {
  return decodeTextBuffer(buffer);
}
