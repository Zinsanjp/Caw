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

// With the offline queue disabled, quit() on a client that is not ready is rejected and
// leaves the connection open and reconnecting, so fall back to disconnect().
export async function closeRedis(client: Redis): Promise<void> {
  try {
    await client.quit()
  } catch {
    client.disconnect()
  }
}

export const redis = createSafeRedis()
