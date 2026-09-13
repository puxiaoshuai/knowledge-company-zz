import snowflakeIdModule from 'snowflake-id';

// 该包是 CJS 产物，真正的类是 exports.default；ESM 互操作下 default 指向整个
// module.exports，直接 new 会报 "not a constructor"，所以这里显式取一次 .default。
const SnowflakeId = snowflakeIdModule.default;

const snowflake = new SnowflakeId({
  mid: Number(process.env.SNOWFLAKE_WORKER_ID ?? 1),
  offset: Number(process.env.SNOWFLAKE_OFFSET ?? 1704067200000),
});

/** 生成雪花 ID（string），对应 Java long / Postgres BIGINT */
export function nextSnowflakeId(): string {
  return snowflake.generate();
}