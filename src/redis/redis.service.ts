import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/** 从任意异常里取一句可读信息 */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Redis 连接（邮箱激活 token / 频率限制等短时状态）。
 *
 * 降级策略与 RustfsService 同构、但与其它外部依赖**相反**：
 * - 启动阶段连不上只告警，**不阻断进程**——登录、刷新、文档全链路都不依赖 Redis，
 *   没有理由为了一个缓存把所有功能拖下水。ioredis 会按 retryStrategy 在后台持续重连，
 *   恢复后无需重启进程。
 * - 真正要用它的时候（写入激活 token）才 `require()` 抛 503。这一点和 RustFS 一致：
 *   依赖不可用时让调用方**显式失败**，而不是静默产出一个语义不完整的结果
 *   （注册成功但没有 token = 一个永远无法激活、也无法登录的僵尸账号）。
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly enabled: boolean;
  private readonly connectTimeoutMs: number;
  private client: Redis | null = null;

  constructor(private readonly config: ConfigService) {
    // 与 RABBITMQ_ENABLED / RUSTFS_ENABLED 保持一致的开关键名与判定方式
    this.enabled = config.get<string>('REDIS_ENABLED', 'true') !== 'false';
    this.connectTimeoutMs = Number(
      config.get<string>('REDIS_CONNECT_TIMEOUT_MS', '5000'),
    );
  }

  async onModuleInit() {
    if (!this.enabled) {
      this.logger.warn('Redis 已禁用（REDIS_ENABLED=false），邮箱激活将不可用');
      return;
    }

    const host = this.config.get<string>('REDIS_HOST', 'localhost');
    const port = Number(this.config.get<string>('REDIS_PORT', '6379'));
    const password = this.config.get<string>('REDIS_PASSWORD', '');
    const db = Number(this.config.get<string>('REDIS_DB', '0'));

    this.client = new Redis({
      host,
      port,
      // 必须给 undefined 而不是空串：docker-compose 的 redis 没有设密码，
      // 传空串会被 ioredis 当成「用空密码 AUTH」，报 ERR Client sent AUTH, but no password is set
      password: password || undefined,
      db,
      // 由这里显式 connect()，失败才能被 catch 到；否则连接在构造时就发起，异常无处可接
      lazyConnect: true,
      // 断连时让命令**立即 reject** 而不是排队重试二十次（默认 20 会让 HTTP 请求挂十几秒）。
      // 配合下面的 require() 转成干脆的 503，前端能马上拿到明确错误。
      maxRetriesPerRequest: 1,
      // 必须与 lazyConnect 成对出现：没 ready 时立刻拒绝，而不是把命令静默排队到超时
      enableOfflineQueue: false,
      connectTimeout: this.connectTimeoutMs,
      // 有界退避（200ms 起，封顶 3s），永不放弃重连 —— 服务恢复后自动接上
      retryStrategy: (times: number) => Math.min(times * 200, 3000),
    });

    // 这个监听是必需的，不是可选的：Node 对没有监听者的 'error' 事件会直接终止进程，
    // 一次连接抖动就能把整个服务打挂，与「降级不阻断主流程」的约定直接冲突。
    this.client.on('error', (error: Error) => {
      this.logger.warn(`Redis 错误：${reason(error)}`);
    });
    this.client.on('ready', () => {
      this.logger.log(`Redis 已连接：${host}:${port} db=${db}`);
    });
    this.client.on('reconnecting', () => {
      this.logger.warn('Redis 重连中…');
    });
    this.client.on('end', () => {
      this.logger.warn('Redis 连接已关闭');
    });

    try {
      // connect() 自身在 connectTimeout 后也会失败，这里再兜一层超时，
      // 避免某些网络故障下它挂得比预期久、拖慢整个应用启动
      await Promise.race([
        this.client.connect(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`连接超时（${this.connectTimeoutMs}ms）`)),
            this.connectTimeoutMs,
          ),
        ),
      ]);
    } catch (error) {
      // 软降级：不抛。后台仍会按 retryStrategy 重连，恢复后无需重启
      this.logger.warn(
        `Redis 初始化失败（相关功能将返回 503，后台持续重连）：${reason(error)}`,
      );
    }
  }

  async onModuleDestroy() {
    // 项目没有 app.enableShutdownHooks()，onModuleDestroy 就是当前的清理时机
    // （RabbitMqService / VectorIndexService 同样只实现它）
    try {
      await this.client?.quit();
    } catch {
      // quit() 会等在途命令跑完，卡住时直接断，避免退出流程被拖住
      this.client?.disconnect();
    }
    this.client = null;
  }

  /** Redis 是否可用。调用方可据此做降级分支，而不是靠 try/catch 探路 */
  isEnabled(): boolean {
    return this.enabled && this.client?.status === 'ready';
  }

  /**
   * 断言 Redis 可用，否则抛 503。
   *
   * 需要「先检查、后做别的事」的场景（如注册：Redis 不可用就不该建号）用它；
   * 直接读写命令的场景不用调，各方法内部已经走 require() 了。
   */
  assertReady(): void {
    this.require();
  }

  async get(key: string): Promise<string | null> {
    return this.require().get(key);
  }

  /** @param ttlSeconds 省略则不过期 */
  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    const client = this.require();
    if (ttlSeconds === undefined) {
      await client.set(key, value);
      return;
    }
    await client.set(key, value, 'EX', ttlSeconds);
  }

  /**
   * 仅当 key 不存在时写入，返回是否写入成功。
   *
   * 用单条 `SET key value EX ttl NX` 而不是 `SETNX` + `EXPIRE` 两步：
   * 后者中间崩掉会留下一个**永不过期**的锁，把用户永久挡在门外。
   */
  async setIfAbsent(
    key: string,
    value: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    return (await this.require().set(key, value, 'EX', ttlSeconds, 'NX')) === 'OK';
  }

  async del(...keys: string[]): Promise<void> {
    if (!keys.length) {
      return;
    }
    await this.require().del(...keys);
  }

  /** 剩余存活秒数；-1 无过期时间，-2 key 不存在 */
  async ttl(key: string): Promise<number> {
    return this.require().ttl(key);
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.require().ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  /** 取连接；不可用时抛 503。集中在这里判定，调用点不必四处写 if */
  private require(): Redis {
    if (!this.enabled || !this.client || this.client.status !== 'ready') {
      throw new ServiceUnavailableException(
        'Redis 未启用或未连接，该操作需要 Redis 支持',
      );
    }
    return this.client;
  }
}
