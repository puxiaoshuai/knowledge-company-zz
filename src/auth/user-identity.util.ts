import { BadRequestException } from '@nestjs/common';
import { AuthMessage } from './constants/auth.constant.js';

/**
 * kh_user「身份字段」的共享工具：邮箱归一、唯一键冲突翻译。
 *
 * 从 auth.service.ts 提到文件级，是因为「注册」与「管理员后台建号」这两条链路
 * 必须逐字同源：同一句话术、同一个索引名、同一套大小写归一方式。任何一处分叉
 * 都会造出无法解释的现象 ——「自己注册说用户名重复，管理员建号却说成功」。
 *
 * 用 *.util.ts 后缀，与 document/parser/utils/ 下的同类文件保持一致。
 */

/** Postgres 唯一键冲突错误码 */
export const PG_UNIQUE_VIOLATION = '23505';

/** 未删除唯一索引名，与 init-scripts/postgresql/init.sql 保持一致 */
export const UK_USERNAME = 'uk_kh_user_username';
export const UK_EMAIL = 'uk_kh_user_email';

/** 判断是否为 Postgres 唯一键冲突，且冲突来自指定索引 */
export function isUniqueViolationOn(
  error: unknown,
  constraint: string,
): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const { code, constraint: hit } = error as {
    code?: string;
    constraint?: string;
  };
  return code === PG_UNIQUE_VIOLATION && hit === constraint;
}

/**
 * 唯一键冲突 → 对外的 400；不是唯一键冲突则**原样抛回**。
 *
 * 返回类型是 never，所以调用方在 catch 块里直接写
 * `catch (error) { rethrowUserUniqueViolation(error); }` 即可，
 * 既不会吞掉其它异常（数据库连不上、字段超长等仍按 500 冒泡），
 * 也不会在函数返回后继续执行。
 *
 * 之所以要它兜底：并发写入时 service 里的预检会漏，最终拦住的是唯一索引本身。
 */
export function rethrowUserUniqueViolation(error: unknown): never {
  if (isUniqueViolationOn(error, UK_USERNAME)) {
    throw new BadRequestException(AuthMessage.UsernameAlreadyTaken);
  }
  if (isUniqueViolationOn(error, UK_EMAIL)) {
    throw new BadRequestException(AuthMessage.EmailAlreadyRegistered);
  }
  throw error;
}

/** 邮箱入库前统一归一，与 uk_kh_user_email 的大小写敏感唯一索引配合 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
