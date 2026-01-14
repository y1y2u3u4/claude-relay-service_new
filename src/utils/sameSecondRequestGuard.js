const redis = require('../models/redis')
const logger = require('./logger')

/**
 * Request Interval Guard - 请求间隔防护
 * 防止同一账户请求过于频繁，避免触发Claude的反滥用检测
 *
 * 支持两种模式：
 * 1. 同秒防护模式（minIntervalMs = 0）：确保请求不在同一秒内
 * 2. 最小间隔模式（minIntervalMs > 0）：确保请求间隔不小于指定毫秒数
 */
class SameSecondRequestGuard {
  constructor() {
    this.REDIS_KEY_PREFIX = 'request_interval_guard:'
    this.MEMORY_CACHE = new Map() // 内存缓存作为Redis的备份
    this.CACHE_CLEANUP_INTERVAL = 60000 // 每分钟清理一次过期缓存
    this.startCleanupTimer()
  }

  /**
   * 获取当前秒级时间戳
   */
  getCurrentSecond() {
    return Math.floor(Date.now() / 1000)
  }

  /**
   * 获取账户的Redis键
   */
  getRedisKey(accountId, accountType) {
    return `${this.REDIS_KEY_PREFIX}${accountType}:${accountId}`
  }

  /**
   * 检查并等待：确保请求满足间隔要求
   * @param {string} accountId - 账户ID
   * @param {string} accountType - 账户类型 (claude-official, gemini, etc.)
   * @param {number} maxWaitMs - 最大等待时间（毫秒），默认1000ms
   * @param {number} minIntervalMs - 最小间隔（毫秒），0表示仅防同秒，默认0
   * @returns {Promise<{allowed: boolean, waitedMs: number}>}
   */
  async checkAndWait(accountId, accountType, maxWaitMs = 1000, minIntervalMs = 0) {
    const startTime = Date.now()
    const redisKey = this.getRedisKey(accountId, accountType)

    try {
      const client = redis.getClient()

      if (client) {
        return await this._checkAndWaitWithRedis(
          client,
          redisKey,
          accountId,
          accountType,
          maxWaitMs,
          minIntervalMs,
          startTime
        )
      } else {
        return this._checkAndWaitWithMemory(
          redisKey,
          accountId,
          accountType,
          maxWaitMs,
          minIntervalMs,
          startTime
        )
      }
    } catch (error) {
      logger.error(`❌ Request interval guard error for ${accountId}: ${error.message}`)
      return this._checkAndWaitWithMemory(
        redisKey,
        accountId,
        accountType,
        maxWaitMs,
        minIntervalMs,
        startTime
      )
    }
  }

  /**
   * 使用Redis的核心检查逻辑（Lua脚本确保原子性）
   * @private
   */
  async _checkAndWaitWithRedis(
    client,
    redisKey,
    accountId,
    accountType,
    maxWaitMs,
    minIntervalMs,
    startTime
  ) {
    const currentTimeMs = Date.now()

    // Lua脚本：原子性地检查时间戳并计算等待时间
    // 返回值：[需要等待的毫秒数, 是否可以立即执行(1=是,0=否)]
    const luaScript = `
      local key = KEYS[1]
      local currentTimeMs = tonumber(ARGV[1])
      local minIntervalMs = tonumber(ARGV[2])
      local ttl = tonumber(ARGV[3])

      local lastTimeMs = redis.call('GET', key)

      if lastTimeMs then
        lastTimeMs = tonumber(lastTimeMs)
        local elapsedMs = currentTimeMs - lastTimeMs

        if minIntervalMs > 0 then
          -- 最小间隔模式
          if elapsedMs < minIntervalMs then
            local waitMs = minIntervalMs - elapsedMs
            return {waitMs, 0}  -- 需要等待waitMs毫秒
          end
        else
          -- 同秒防护模式
          local currentSecond = math.floor(currentTimeMs / 1000)
          local lastSecond = math.floor(lastTimeMs / 1000)
          if currentSecond == lastSecond then
            local waitMs = 1000 - (currentTimeMs % 1000)
            return {waitMs, 0}  -- 需要等到下一秒
          end
        end
      end

      -- 可以执行，更新时间戳
      redis.call('SETEX', key, ttl, tostring(currentTimeMs))
      return {0, 1}  -- 不需要等待，可以立即执行
    `

    const ttlSeconds = 5 // 足够覆盖各种间隔场景

    try {
      const result = await client.eval(luaScript, {
        keys: [redisKey],
        arguments: [currentTimeMs.toString(), minIntervalMs.toString(), ttlSeconds.toString()]
      })

      const waitMs = result[0]
      const canExecute = result[1]

      if (canExecute === 1) {
        // 可以立即执行
        this.MEMORY_CACHE.set(redisKey, currentTimeMs)
        return { allowed: true, waitedMs: 0 }
      }

      // 需要等待
      if (waitMs > maxWaitMs) {
        logger.warn(
          `🚫 Request interval blocked for account ${accountId} (${accountType}), ` +
            `required wait ${waitMs}ms exceeds max ${maxWaitMs}ms`
        )
        return { allowed: false, waitedMs: 0 }
      }

      const modeDesc = minIntervalMs > 0 ? `interval ${minIntervalMs}ms` : 'same-second'
      logger.info(
        `⏱️ Request ${modeDesc} detected for account ${accountId} (${accountType}), waiting ${waitMs}ms`
      )

      await this.sleep(waitMs)
      const actualWaitedMs = Date.now() - startTime

      // 等待后更新时间戳
      const newTimeMs = Date.now()
      try {
        await client.setex(redisKey, ttlSeconds, newTimeMs.toString())
      } catch (retryError) {
        logger.warn(`⚠️ Failed to update timestamp after wait: ${retryError.message}`)
      }

      this.MEMORY_CACHE.set(redisKey, newTimeMs)

      logger.info(
        `✅ Wait completed for account ${accountId} (${accountType}), waited ${actualWaitedMs}ms`
      )

      return { allowed: true, waitedMs: actualWaitedMs }
    } catch (luaError) {
      // Lua 脚本失败，降级到内存缓存
      logger.warn(
        `⚠️ Lua script failed for ${accountId}, falling back to memory: ${luaError.message}`
      )
      return this._checkAndWaitWithMemory(
        redisKey,
        accountId,
        accountType,
        maxWaitMs,
        minIntervalMs,
        startTime
      )
    }
  }

  /**
   * 使用内存缓存的降级方案
   * @private
   */
  async _checkAndWaitWithMemory(
    redisKey,
    accountId,
    accountType,
    maxWaitMs,
    minIntervalMs,
    startTime
  ) {
    const currentTimeMs = Date.now()
    const lastTimeMs = this.MEMORY_CACHE.get(redisKey)

    let waitMs = 0

    if (lastTimeMs) {
      const elapsedMs = currentTimeMs - lastTimeMs

      if (minIntervalMs > 0) {
        // 最小间隔模式
        if (elapsedMs < minIntervalMs) {
          waitMs = minIntervalMs - elapsedMs
        }
      } else {
        // 同秒防护模式
        const currentSecond = Math.floor(currentTimeMs / 1000)
        const lastSecond = Math.floor(lastTimeMs / 1000)
        if (currentSecond === lastSecond) {
          waitMs = 1000 - (currentTimeMs % 1000)
        }
      }
    }

    if (waitMs === 0) {
      this.MEMORY_CACHE.set(redisKey, currentTimeMs)
      return { allowed: true, waitedMs: 0 }
    }

    if (waitMs > maxWaitMs) {
      logger.warn(`🚫 [Memory] Request interval blocked for account ${accountId} (${accountType})`)
      return { allowed: false, waitedMs: 0 }
    }

    const modeDesc = minIntervalMs > 0 ? `interval ${minIntervalMs}ms` : 'same-second'
    logger.info(
      `⏱️ [Memory] Request ${modeDesc} detected for account ${accountId} (${accountType}), waiting ${waitMs}ms`
    )

    await this.sleep(waitMs)
    const actualWaitedMs = Date.now() - startTime
    this.MEMORY_CACHE.set(redisKey, Date.now())

    return { allowed: true, waitedMs: actualWaitedMs }
  }

  /**
   * 记录请求时间（不等待，仅记录）
   * @param {string} accountId - 账户ID
   * @param {string} accountType - 账户类型
   */
  async recordRequest(accountId, accountType) {
    const currentTimeMs = Date.now()
    const redisKey = this.getRedisKey(accountId, accountType)

    try {
      const client = redis.getClient()
      if (client) {
        await client.setex(redisKey, 5, currentTimeMs.toString())
      }
      this.MEMORY_CACHE.set(redisKey, currentTimeMs)
    } catch (error) {
      logger.error(`❌ Failed to record request time for ${accountId}: ${error.message}`)
      // 降级到内存缓存
      this.MEMORY_CACHE.set(redisKey, currentTimeMs)
    }
  }

  /**
   * 清理过期的内存缓存
   */
  cleanupMemoryCache() {
    const currentTimeMs = Date.now()
    const keysToDelete = []
    const maxAge = 10000 // 10秒后清理

    for (const [key, timestamp] of this.MEMORY_CACHE.entries()) {
      if (currentTimeMs - timestamp > maxAge) {
        keysToDelete.push(key)
      }
    }

    keysToDelete.forEach((key) => this.MEMORY_CACHE.delete(key))

    if (keysToDelete.length > 0) {
      logger.debug(`🧹 Cleaned up ${keysToDelete.length} expired interval cache entries`)
    }
  }

  /**
   * 启动定时清理任务
   */
  startCleanupTimer() {
    this.cleanupTimer = setInterval(() => {
      this.cleanupMemoryCache()
    }, this.CACHE_CLEANUP_INTERVAL)

    // 防止定时器阻止进程退出
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref()
    }
  }

  /**
   * 停止定时清理任务
   */
  stopCleanupTimer() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
  }

  /**
   * 睡眠函数
   */
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      memoryCacheSize: this.MEMORY_CACHE.size,
      currentTimeMs: Date.now()
    }
  }
}

// 导出单例
const instance = new SameSecondRequestGuard()

module.exports = instance
