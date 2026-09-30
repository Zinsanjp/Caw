import Redis, { RedisOptions } from 'ioredis'

const DEFAULT_OPTIONS: RedisOptions = {
  enableOfflineQueue: false,
  commandTimeout: 2000,
  connectTimeout: 2000,
  maxRetriesPerRequest: 1,
  retryStrategy(times: number) {
    return Math.min(times * 200, 2000)
  },
}

export function createSafeRedis(customUrl?: string): Redis {
  const url = customUrl || process.env.REDIS_URL || 'redis://127.0.0.1:6379'
  const client = new Redis(url, DEFAULT_OPTIONS)

  client.on('error', (err) => {
    if (process.env.NODE_ENV !== 'test') {
      console.warn(`[Redis] Connection warning: ${err.message}`)
    }
  })

  return client
}

export const redis = createSafeRedis()
