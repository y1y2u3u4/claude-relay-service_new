const redis = require('../models/redis')
const logger = require('./logger')

/**
 * Same Second Request Guard - 同秒请求防护
 * 防止同一账户在同一秒内发送多次请求，避免触发Claude的反滥用检测
 */
class SameSecondRequestGuard {
  constructor() {
    this.REDIS_KEY_PREFIX = 'same_second_guard:'
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
   * 检查并等待：确保不在同一秒内发送请求
   * @param {string} accountId - 账户ID
   * @param {string} accountType - 账户类型 (claude-official, gemini, etc.)
   * @param {number} maxWaitMs - 最大等待时间（毫秒），默认1000ms
   * @returns {Promise<{allowed: boolean, waitedMs: number}>}
   */
  async checkAndWait(accountId, accountType, maxWaitMs = 1000) {
    const startTime = Date.now()
    const currentSecond = this.getCurrentSecond()
    const redisKey = this.getRedisKey(accountId, accountType)

    try {
      const client = redis.getClient()

      if (client) {
        // 使用Redis存储最后请求时间
        const lastRequestSecond = await client.get(redisKey)

        if (lastRequestSecond && parseInt(lastRequestSecond) === currentSecond) {
          // 同一秒内有请求，需要等待
          const waitMs = 1000 - (Date.now() % 1000)

          if (waitMs > maxWaitMs) {
            logger.warn(
              `🚫 Same-second request blocked for account ${accountId} (${accountType}), wait time ${waitMs}ms exceeds max ${maxWaitMs}ms`
            )
            return { allowed: false, waitedMs: 0 }
          }

          logger.info(
            `⏱️ Same-second request detected for account ${accountId} (${accountType}), waiting ${waitMs}ms`
          )

          await this.sleep(waitMs)
          const actualWaitedMs = Date.now() - startTime

          logger.info(
            `✅ Wait completed for account ${accountId} (${accountType}), waited ${actualWaitedMs}ms`
          )

          // 更新为新的秒
          const newSecond = this.getCurrentSecond()
          await client.setex(redisKey, 2, newSecond.toString()) // 2秒过期
          this.MEMORY_CACHE.set(redisKey, newSecond)

          return { allowed: true, waitedMs: actualWaitedMs }
        } else {
          // 不同秒或首次请求，直接允许
          await client.setex(redisKey, 2, currentSecond.toString())
          this.MEMORY_CACHE.set(redisKey, currentSecond)
          return { allowed: true, waitedMs: 0 }
        }
      } else {
        // Redis不可用，使用内存缓存
        return this.checkAndWaitWithMemory(accountId, accountType, maxWaitMs, startTime)
      }
    } catch (error) {
      logger.error(`❌ Same-second guard error for ${accountId}: ${error.message}`)
      // 出错时使用内存缓存作为降级方案
      return this.checkAndWaitWithMemory(accountId, accountType, maxWaitMs, startTime)
    }
  }

  /**
   * 使用内存缓存的降级方案
   */
  async checkAndWaitWithMemory(accountId, accountType, maxWaitMs, startTime) {
    const currentSecond = this.getCurrentSecond()
    const redisKey = this.getRedisKey(accountId, accountType)
    const lastRequestSecond = this.MEMORY_CACHE.get(redisKey)

    if (lastRequestSecond && lastRequestSecond === currentSecond) {
      const waitMs = 1000 - (Date.now() % 1000)

      if (waitMs > maxWaitMs) {
        logger.warn(
          `🚫 [Memory] Same-second request blocked for account ${accountId} (${accountType})`
        )
        return { allowed: false, waitedMs: 0 }
      }

      logger.info(
        `⏱️ [Memory] Same-second request detected for account ${accountId} (${accountType}), waiting ${waitMs}ms`
      )

      await this.sleep(waitMs)
      const actualWaitedMs = Date.now() - startTime

      const newSecond = this.getCurrentSecond()
      this.MEMORY_CACHE.set(redisKey, newSecond)

      return { allowed: true, waitedMs: actualWaitedMs }
    } else {
      this.MEMORY_CACHE.set(redisKey, currentSecond)
      return { allowed: true, waitedMs: 0 }
    }
  }

  /**
   * 记录请求时间（不等待，仅记录）
   * @param {string} accountId - 账户ID
   * @param {string} accountType - 账户类型
   */
  async recordRequest(accountId, accountType) {
    const currentSecond = this.getCurrentSecond()
    const redisKey = this.getRedisKey(accountId, accountType)

    try {
      const client = redis.getClient()
      if (client) {
        await client.setex(redisKey, 2, currentSecond.toString())
      }
      this.MEMORY_CACHE.set(redisKey, currentSecond)
    } catch (error) {
      logger.error(`❌ Failed to record request time for ${accountId}: ${error.message}`)
      // 降级到内存缓存
      this.MEMORY_CACHE.set(redisKey, currentSecond)
    }
  }

  /**
   * 清理过期的内存缓存
   */
  cleanupMemoryCache() {
    const currentSecond = this.getCurrentSecond()
    const keysToDelete = []

    for (const [key, timestamp] of this.MEMORY_CACHE.entries()) {
      // 删除超过5秒的缓存
      if (currentSecond - timestamp > 5) {
        keysToDelete.push(key)
      }
    }

    keysToDelete.forEach((key) => this.MEMORY_CACHE.delete(key))

    if (keysToDelete.length > 0) {
      logger.debug(`🧹 Cleaned up ${keysToDelete.length} expired cache entries`)
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
      currentSecond: this.getCurrentSecond()
    }
  }
}

// 导出单例
const instance = new SameSecondRequestGuard()

module.exports = instance
