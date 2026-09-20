#!/usr/bin/env node
/**
 * 重置 PostgreSQL：清空 public schema → 重跑 init.sql。
 *
 * 为什么需要它：init-scripts/postgresql/ 挂到容器的 /docker-entrypoint-initdb.d，
 * 但官方入口脚本**只在 PGDATA 为空时**（数据目录首次初始化）才执行这些脚本。
 * volumes/postgres 是 bind mount、永久保留，所以初始化过一次之后再改 init.sql
 * 都不会生效，容器重启 / docker compose up 也不行。
 *
 * 本脚本把「开发期可删数据」这条路固化下来：数据全丢，schema 对齐 init.sql。
 * 需要保留数据的场景走 migrations/ 下的 ALTER 脚本，那是另一条路。
 *
 * 用法：
 *   pnpm db:reset             # 清库重建
 *   pnpm db:reset --dry-run   # 只打印要执行的命令，不动数据
 *   pnpm db:reset --force     # POSTGRES_HOST 非本机时放行
 *
 * 注意：执行后数据回到 init.sql 的预置状态（admin / reviewer / user，密码 123456），
 * 迁移前注册的用户与 refresh token 全部消失。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Node 20.12+ 内置，不额外引 dotenv（.env 不存在时保持进程环境变量）
const envFile = path.join(ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const CONTAINER = process.env.POSTGRES_CONTAINER ?? 'knowledge_hub_postgres';
const USER = process.env.POSTGRES_USER ?? 'user';
const DB = process.env.POSTGRES_DB ?? 'knowledge_hub';
const HOST = process.env.POSTGRES_HOST ?? 'localhost';

// 从仓库读 init.sql 再走 stdin 灌给 psql，而不是让 psql 去读容器内的
// /docker-entrypoint-initdb.d/init.sql：后者在 Git Bash 里会被 MSYS 做路径转换，
// 变成 C:/Program Files/Git/docker-entrypoint-initdb.d/init.sql 而报 No such file。
// 顺带也摆脱了对「容器挂载路径」的依赖，跑的就是仓库里这份文件。
const INIT_SQL = path.join(ROOT, 'init-scripts', 'postgresql', 'init.sql');

const dryRun = process.argv.includes('--dry-run');

/**
 * 打印或执行一条 PSQL。
 * 用 execFileSync 传数组（不经 shell）避开引号转义；SQL 文件走 input 灌 stdin。
 */
function psql(args, input) {
  const full = ['exec', '-i', CONTAINER, 'psql', '-U', USER, '-d', DB, '-v', 'ON_ERROR_STOP=1', ...args];
  if (dryRun) {
    const quoted = full.map((a) => (a.includes(';') || a.includes(' ') ? `"${a}"` : a));
    const pipe = input ? ' < init-scripts/postgresql/init.sql' : '';
    console.log(`  docker ${quoted.join(' ')}${pipe}`);
    return '';
  }
  try {
    const out = execFileSync('docker', full, {
      encoding: 'utf8',
      input,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (out.trim()) process.stdout.write(out);
    return out;
  } catch (err) {
    process.stdout.write(err.stdout ?? '');
    process.stderr.write(err.stderr ?? '');
    fail(`psql 执行失败（退出码 ${err.status}）。上面的 ERROR 就是原因`);
  }
}

function fail(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

// ---- 前置检查 ----
let running = false;
try {
  running =
    execFileSync('docker', ['inspect', '-f', '{{.State.Running}}', CONTAINER], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() === 'true';
} catch {
  fail(`找不到容器 ${CONTAINER}。先启动：docker compose up -d postgres`);
}
if (!running) fail(`容器 ${CONTAINER} 没在运行。先启动：docker compose up -d postgres`);

// 防止 .env 被改成远端地址后对着生产库 DROP SCHEMA
const isLocal = ['localhost', '127.0.0.1', '::1'].includes(HOST);
if (!isLocal && !process.argv.includes('--force')) {
  fail(`POSTGRES_HOST=${HOST} 不是本机，拒绝执行。确认要清空该库请加 --force`);
}

console.log(`\n重置 ${CONTAINER} / ${DB}（用户 ${USER}）${dryRun ? ' [dry-run]' : ''}\n`);

// ---- 1. 清空 public schema（表 / 索引 / 序列 / 外键一起没）----
console.log('1. 清空 public schema');
// 当前库没装 pgvector 等扩展；将来若装了，扩展建在 public 下会被一并删掉，
// 记得在 init.sql 里补 CREATE EXTENSION。
psql(['-c', 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;']);

// ---- 2. 重跑 init.sql ----
if (!existsSync(INIT_SQL)) fail(`找不到 ${INIT_SQL}`);
console.log('2. 重跑 init.sql');
psql([], readFileSync(INIT_SQL, 'utf8'));

if (dryRun) {
  console.log('\ndry-run 结束，未改动数据。\n');
  process.exit(0);
}

// ---- 3. 回显结果 ----
console.log('3. 当前表：\n');
psql(['-c', '\\dt']);
console.log(`✓ 完成。预置账号 admin / reviewer / user，密码均为 123456\n`);
