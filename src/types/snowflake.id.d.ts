declare module 'snowflake-id' {
  interface SnowflakeIdOptions {
    /** 机器 ID（0–1023），分布式部署时各实例需唯一 */
    mid?: number;
    /** 纪元偏移（毫秒），会从当前时间中减去 */
    offset?: number;
  }

  /**
   * 包产物是 Babel 编译的 CJS，带 `__esModule: true`，类挂在 `exports.default` 上。
   *
   * 在 esModuleInterop 下这恰好等价于「默认导出就是 SnowflakeId」：
   * `import SnowflakeId from 'snowflake-id'` 会编译成
   * `__importDefault(require(...)).default`，而 `__importDefault` 见
   * `__esModule` 为 true 会原样返回 module.exports，再取 `.default` 正好拿到类本身。
   *
   * 注意不要再写 `.default.default`：那是 undefined，`new` 会报
   * "SnowflakeId is not a constructor"。
   */
  export default class SnowflakeId {
    constructor(options?: SnowflakeIdOptions);
    /** 生成雪花 ID 字符串（JS number 无法安全表示 64 位整数） */
    generate(): string;
  }
}
