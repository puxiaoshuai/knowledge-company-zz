declare module 'snowflake-id' {
  interface SnowflakeIdOptions {
    /** 机器 ID（0–1023），分布式部署时各实例需唯一 */
    mid?: number;
    /** 纪元偏移（毫秒），会从当前时间中减去 */
    offset?: number;
  }

  class SnowflakeId {
    constructor(options?: SnowflakeIdOptions);
    /** 生成雪花 ID 字符串（JS number 无法安全表示 64 位整数） */
    generate(): string;
  }

  /**
   * 该包是 Babel 编译的 CJS 产物，实际导出 `exports.default = SnowflakeId`
   * （且带 `__esModule: true`）。在 "type": "module" 下 Node 会把整个
   * module.exports 当作 default 导出，所以必须经 `.default` 取值，
   * 否则拿到的是命名空间对象，`new` 会报 "not a constructor"。
   */
  const _exports: { default: typeof SnowflakeId };
  export = _exports;
}
