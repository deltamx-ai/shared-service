import { z } from 'zod';

/**
 * 共享数据契约：
 * - 只定义结构，不承载真实业务数据
 * - 基座和子应用统一引用这份契约
 * - schema 同时用于运行时校验
 */
export const sharedSchemas = {
  userInfo: z.object({
    id: z.number(),
    name: z.string(),
    avatarUrl: z.string().url().optional(),
  }),
  token: z.string(),
  featureFlags: z.record(z.boolean()),
  permissions: z.array(z.string()),
} as const;

export type SharedSchemaMap = typeof sharedSchemas;
export type SharedDataMap = {
  [K in keyof SharedSchemaMap]: z.infer<SharedSchemaMap[K]>;
};

export type SharedKey = keyof SharedDataMap;

export function getSharedSchema<K extends SharedKey>(key: K): SharedSchemaMap[K] {
  return sharedSchemas[key];
}

export function validateSharedValue<K extends SharedKey>(key: K, value: unknown): SharedDataMap[K] {
  return getSharedSchema(key).parse(value);
}

export function safeValidateSharedValue<K extends SharedKey>(
  key: K,
  value: unknown
): { success: true; data: SharedDataMap[K] } | { success: false; error: unknown } {
  const result = getSharedSchema(key).safeParse(value);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}
