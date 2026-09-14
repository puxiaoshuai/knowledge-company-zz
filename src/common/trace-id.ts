import { randomUUID } from 'crypto';

/**
 * traceId 长度（hex 字符数）。
 * 12 位 ≈ 2.8e14 取值空间，单机日志窗口内不会撞，且比完整 UUID 好读。
 */
const TRACE_ID_LENGTH = 12;

/**
 * 生成链路追踪 ID。
 *
 * <p>一次「发布文档」在 HTTP 侧生成，随 MQ 消息体传到消费端，
 * 同步段（[发布]）与异步段（[RAG]）的每一步日志都带上它，
 * 便于 grep 出单次发布的完整路径。</p>
 */
export function newTraceId(): string {
  return randomUUID().replace(/-/g, '').slice(0, TRACE_ID_LENGTH);
}
