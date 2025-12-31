/**
 * 账号级速率限制服务
 * 限制每个账号在时间窗口内的总请求数
 *
 * 与并发控制的区别：
 * - 并发控制：限制同时进行的请求数（释放时主动释放）
 * - 速率限制：限制时间窗口内的总请求数（自动过期）
 *
 * 超限行为：
 * - 排队等待（指数退避轮询）
 * - 超时返回429错误
 */

const { v4: uuidv4 } = require('uuid')
const redis = require('../models/redis')
const config = require('../../config/config')
const logger = require('../utils/logger')

// 轮询等待配置
const POLL_INTERVAL_BASE_MS = 50 // 基础轮询间隔
const POLL_INTERVAL_MAX_MS = 500 // 最大轮询间隔
const POLL_BACKOFF_FACTOR = 1.5 // 退避因子

class AccountRateLimitService {
  constructor() {
    // 无需清理任务，依赖 Redis 自动过期
  }

  /**
   * 获取当前配置（支持 Web 界面配置优先）
   * @returns {Promise<Object>} 配置对象
   */
  async getConfig() {
    // 默认配置
    const rateLimitConfig = config.accountRateLimit || {}
    const defaults = {
      enabled: rateLimitConfig.enabled ?? false,
      windowSeconds: rateLimitConfig.windowSeconds ?? 60,
      maxRequests: rateLimitConfig.maxRequests ?? 20,
      queueTimeoutMs: rateLimitConfig.queueTimeoutMs ?? 30000,
      enableQueueing: rateLimitConfig.enableQueueing ?? true
    }

    // 尝试从 claudeRelayConfigService 获取 Web 界面配置
    try {
      const claudeRelayConfigService = require('./claudeRelayConfigService')
      const webConfig = await claudeRelayConfigService.getConfig()

      return {
        enabled:
          webConfig.accountRateLimitEnabled !== undefined
            ? webConfig.accountRateLimitEnabled
            : defaults.enabled,
        windowSeconds:
          webConfig.accountRateLimitWindowSeconds !== undefined
            ? webConfig.accountRateLimitWindowSeconds
            : defaults.windowSeconds,
        maxRequests:
          webConfig.accountRateLimitMaxRequests !== undefined
            ? webConfig.accountRateLimitMaxRequests
            : defaults.maxRequests,
        queueTimeoutMs:
          webConfig.accountRateLimitQueueTimeoutMs !== undefined
            ? webConfig.accountRateLimitQueueTimeoutMs
            : defaults.queueTimeoutMs,
        enableQueueing:
          webConfig.accountRateLimitEnableQueueing !== undefined
            ? webConfig.accountRateLimitEnableQueueing
            : defaults.enableQueueing
      }
    } catch {
      // 回退到环境变量配置
      return defaults
    }
  }

  /**
   * 获取账户级配置（支持账户级覆盖）
   * @param {string} accountId - 账户ID
   * @returns {Promise<Object>} 账户配置
   */
  async getAccountConfig(accountId) {
    const globalConfig = await this.getConfig()

    try {
      // 尝试获取账户级配置（从 Redis 中账户数据）
      const accountData = await this._getAccountData(accountId)

      if (accountData) {
        return {
          enabled:
            accountData.rateLimitEnabled !== undefined
              ? accountData.rateLimitEnabled === 'true' || accountData.rateLimitEnabled === true
              : globalConfig.enabled,
          windowSeconds:
            accountData.rateLimitWindowSeconds !== undefined
              ? parseInt(accountData.rateLimitWindowSeconds)
              : globalConfig.windowSeconds,
          maxRequests:
            accountData.rateLimitMaxRequests !== undefined
              ? parseInt(accountData.rateLimitMaxRequests)
              : globalConfig.maxRequests,
          queueTimeoutMs: globalConfig.queueTimeoutMs, // 队列超时不支持账户级配置
          enableQueueing: globalConfig.enableQueueing // 排队开关不支持账户级配置
        }
      }
    } catch (error) {
      logger.debug(`Failed to get account config for ${accountId}, using global config`, error)
    }

    return globalConfig
  }

  /**
   * 检查功能是否启用
   * @returns {Promise<boolean>}
   */
  async isEnabled() {
    const cfg = await this.getConfig()
    return cfg.enabled === true
  }

  /**
   * 获取速率限制槽位（阻塞等待）
   * @param {string} accountId - 账户ID
   * @param {string} requestId - 请求ID（可选，会自动生成）
   * @returns {Promise<{acquired: boolean, requestId: string, error?: string, waitedMs?: number}>}
   */
  async acquireRateLimit(accountId, requestId = null) {
    const cfg = await this.getAccountConfig(accountId)

    if (!cfg.enabled) {
      return { acquired: true, requestId: requestId || uuidv4(), skipped: true }
    }

    const reqId = requestId || uuidv4()
    const startTime = Date.now()
    let retryCount = 0

    logger.debug(
      `📊 Account rate limit: attempting to acquire for account ${accountId} (${cfg.maxRequests} requests/${cfg.windowSeconds}s)`,
      { requestId: reqId }
    )

    while (Date.now() - startTime < cfg.queueTimeoutMs) {
      try {
        const result = await redis.acquireAccountRateLimit(
          accountId,
          reqId,
          cfg.windowSeconds,
          cfg.maxRequests
        )

        if (result.acquired) {
          const waitedMs = Date.now() - startTime
          logger.debug(
            `✅ Account rate limit: acquired for account ${accountId} (${result.currentCount}/${cfg.maxRequests})`,
            { requestId: reqId, waitedMs, retries: retryCount }
          )
          return { acquired: true, requestId: reqId, waitedMs }
        }

        // 未获取到槽位
        if (!cfg.enableQueueing) {
          // 不启用排队，直接返回失败
          logger.warn(
            `⏳ Account rate limit: exceeded for account ${accountId}, queueing disabled`,
            { requestId: reqId, currentCount: result.currentCount, maxRequests: cfg.maxRequests }
          )
          return { acquired: false, requestId: reqId, error: 'rate_limit_exceeded' }
        }

        // 计算等待时间
        let waitMs = 0
        if (result.oldestRequestTime) {
          // 计算最旧请求何时过期
          const oldestExpiresAt = result.oldestRequestTime + cfg.windowSeconds * 1000
          waitMs = Math.max(0, oldestExpiresAt - Date.now())
        }

        // 如果等待时间太长，直接返回失败
        const remainingTimeout = cfg.queueTimeoutMs - (Date.now() - startTime)
        if (waitMs > remainingTimeout) {
          logger.warn(
            `⏳ Account rate limit: timeout for account ${accountId} (wait ${waitMs}ms > remaining ${remainingTimeout}ms)`,
            { requestId: reqId }
          )
          return { acquired: false, requestId: reqId, error: 'queue_timeout' }
        }

        // 等待（使用指数退避 + 抖动）
        if (waitMs > 0) {
          // 有明确的等待时间，使用该时间
          await this._sleep(Math.min(waitMs, remainingTimeout))
        } else {
          // 使用指数退避轮询
          const basePollInterval = Math.min(
            POLL_INTERVAL_BASE_MS * Math.pow(POLL_BACKOFF_FACTOR, retryCount),
            POLL_INTERVAL_MAX_MS
          )
          // 添加 ±15% 随机抖动，避免高并发下的周期性碰撞
          const jitter = basePollInterval * (0.85 + Math.random() * 0.3)
          const pollInterval = Math.min(jitter, POLL_INTERVAL_MAX_MS)
          await this._sleep(pollInterval)
          retryCount++
        }
      } catch (error) {
        logger.error(`Account rate limit: Redis error for account ${accountId}:`, error)
        return {
          acquired: false,
          requestId: reqId,
          error: 'rate_limit_backend_error',
          errorMessage: error.message
        }
      }
    }

    // 超时
    logger.warn(`⏳ Account rate limit: timeout waiting for account ${accountId}`, {
      accountId,
      requestId: reqId,
      timeoutMs: cfg.queueTimeoutMs
    })

    return {
      acquired: false,
      requestId: reqId,
      error: 'queue_timeout'
    }
  }

  /**
   * 释放速率限制槽位（可选，通常依赖自动过期）
   * @param {string} accountId - 账户ID
   * @param {string} requestId - 请求ID
   * @returns {Promise<boolean>}
   */
  async releaseRateLimit(accountId, requestId) {
    if (!accountId || !requestId) {
      return false
    }

    const released = await redis.releaseAccountRateLimit(accountId, requestId)

    if (released) {
      logger.debug(`📊 Account rate limit: released for account ${accountId}`, { requestId })
    }

    return released
  }

  /**
   * 获取速率限制状态
   * @param {string} accountId - 账户ID
   * @returns {Promise<Object>}
   */
  async getRateLimitStatus(accountId) {
    const cfg = await this.getAccountConfig(accountId)
    const status = await redis.getAccountRateLimitStatus(accountId, cfg.windowSeconds)

    return {
      accountId,
      enabled: cfg.enabled,
      currentCount: status.currentCount,
      maxRequests: cfg.maxRequests,
      windowSeconds: cfg.windowSeconds,
      oldestRequestTime: status.oldestRequestTime
        ? new Date(status.oldestRequestTime).toISOString()
        : null,
      isLimited: status.currentCount >= cfg.maxRequests
    }
  }

  /**
   * 获取账户数据（跨账户类型）
   * @param {string} accountId - 账户ID
   * @returns {Promise<Object|null>}
   * @private
   */
  async _getAccountData(accountId) {
    // 尝试所有可能的账户类型
    const accountTypes = [
      'claude_account',
      'claude_console_account',
      'gemini_account',
      'bedrock_account',
      'azure_openai_account',
      'droid_account',
      'ccr_account',
      'openai_responses_account'
    ]

    for (const accountType of accountTypes) {
      try {
        const accountData = await redis.client.hgetall(`${accountType}:${accountId}`)
        if (accountData && Object.keys(accountData).length > 0) {
          return accountData
        }
      } catch (error) {
        // 继续尝试下一个类型
      }
    }

    return null
  }

  /**
   * 睡眠辅助函数
   * @param {number} ms - 毫秒
   * @private
   */
  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}

module.exports = new AccountRateLimitService()
