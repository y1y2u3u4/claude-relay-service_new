/**
 * 403错误熔断机制服务
 * 当账户遇到403错误时，自动暂停该账户一段时间，防止继续发送请求导致永久封禁
 *
 * 熔断器状态机：
 * - closed（正常）: 账户正常运行
 * - open（熔断打开）: 账户被暂停，不接受新请求
 * - half_open（半开）: 冷却期结束，进行探测
 */

const redis = require('../models/redis')
const config = require('../../config/config')
const logger = require('../utils/logger')

// 自动恢复任务间隔（5分钟）
const AUTO_RECOVERY_INTERVAL_MS = 5 * 60 * 1000

class Error403CircuitBreakerService {
  constructor() {
    this.autoRecoveryTimer = null
  }

  /**
   * 获取当前配置（支持 Web 界面配置优先）
   * @returns {Promise<Object>} 配置对象
   */
  async getConfig() {
    // 默认配置
    const breakerConfig = config.error403CircuitBreaker || {}
    const defaults = {
      enabled: breakerConfig.enabled ?? true,
      threshold: breakerConfig.threshold ?? 3,
      windowSeconds: breakerConfig.windowSeconds ?? 300,
      breakerDurationMinutes: breakerConfig.breakerDurationMinutes ?? 30,
      autoRecovery: breakerConfig.autoRecovery ?? true
    }

    // 尝试从 claudeRelayConfigService 获取 Web 界面配置
    try {
      const claudeRelayConfigService = require('./claudeRelayConfigService')
      const webConfig = await claudeRelayConfigService.getConfig()

      return {
        enabled:
          webConfig.error403BreakerEnabled !== undefined
            ? webConfig.error403BreakerEnabled
            : defaults.enabled,
        threshold:
          webConfig.error403Threshold !== undefined
            ? webConfig.error403Threshold
            : defaults.threshold,
        windowSeconds:
          webConfig.error403WindowSeconds !== undefined
            ? webConfig.error403WindowSeconds
            : defaults.windowSeconds,
        breakerDurationMinutes:
          webConfig.error403BreakerDurationMinutes !== undefined
            ? webConfig.error403BreakerDurationMinutes
            : defaults.breakerDurationMinutes,
        autoRecovery:
          webConfig.error403AutoRecovery !== undefined
            ? webConfig.error403AutoRecovery
            : defaults.autoRecovery
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
            accountData.error403BreakerEnabled !== undefined
              ? accountData.error403BreakerEnabled === 'true' ||
                accountData.error403BreakerEnabled === true
              : globalConfig.enabled,
          threshold:
            accountData.error403Threshold !== undefined
              ? parseInt(accountData.error403Threshold)
              : globalConfig.threshold,
          windowSeconds: globalConfig.windowSeconds, // 窗口大小不支持账户级配置
          breakerDurationMinutes:
            accountData.error403BreakerDurationMinutes !== undefined
              ? parseInt(accountData.error403BreakerDurationMinutes)
              : globalConfig.breakerDurationMinutes,
          autoRecovery: globalConfig.autoRecovery // 自动恢复不支持账户级配置
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
   * 记录403错误并检查是否需要触发熔断
   * @param {string} accountId - 账户ID
   * @returns {Promise<{triggered: boolean, errorCount: number, threshold: number, state: string}>}
   */
  async record403Error(accountId) {
    const cfg = await this.getAccountConfig(accountId)

    if (!cfg.enabled) {
      return { triggered: false, errorCount: 0, threshold: cfg.threshold, state: 'disabled' }
    }

    // 记录错误到 Redis（使用滑动窗口）
    const errorCount = await redis.record403Error(accountId, cfg.windowSeconds)

    logger.warn(
      `🚫 403 Circuit Breaker: recorded error for account ${accountId} (${errorCount}/${cfg.threshold})`,
      {
        accountId,
        errorCount,
        threshold: cfg.threshold,
        windowSeconds: cfg.windowSeconds
      }
    )

    // 检查是否达到阈值
    if (errorCount >= cfg.threshold) {
      // 触发熔断
      await this.openCircuitBreaker(accountId, cfg)

      logger.error(
        `🔥 403 Circuit Breaker: TRIGGERED for account ${accountId} (${errorCount} errors in ${cfg.windowSeconds}s)`,
        {
          accountId,
          errorCount,
          threshold: cfg.threshold,
          breakerDurationMinutes: cfg.breakerDurationMinutes
        }
      )

      return { triggered: true, errorCount, threshold: cfg.threshold, state: 'open' }
    }

    return { triggered: false, errorCount, threshold: cfg.threshold, state: 'closed' }
  }

  /**
   * 打开熔断器（暂停账户）
   * @param {string} accountId - 账户ID
   * @param {Object} cfg - 配置对象
   * @returns {Promise<boolean>}
   */
  async openCircuitBreaker(accountId, cfg) {
    const now = Date.now()
    const openUntil = now + cfg.breakerDurationMinutes * 60 * 1000

    try {
      // 更新账户熔断状态
      await this._updateAccountBreakerState(accountId, {
        error403BreakerState: 'open',
        error403BreakerOpenAt: now.toString(),
        error403BreakerOpenUntil: openUntil.toString()
      })

      logger.error(
        `🔥 403 Circuit Breaker: OPENED for account ${accountId}, duration: ${cfg.breakerDurationMinutes} minutes`,
        {
          accountId,
          openAt: new Date(now).toISOString(),
          openUntil: new Date(openUntil).toISOString()
        }
      )

      return true
    } catch (error) {
      logger.error(`Failed to open circuit breaker for account ${accountId}:`, error)
      return false
    }
  }

  /**
   * 将熔断器状态设为半开（探测状态）
   * @param {string} accountId - 账户ID
   * @returns {Promise<boolean>}
   */
  async halfOpenCircuitBreaker(accountId) {
    try {
      await this._updateAccountBreakerState(accountId, {
        error403BreakerState: 'half_open'
      })

      logger.info(`🟡 403 Circuit Breaker: half-open for account ${accountId}`, {
        accountId
      })

      return true
    } catch (error) {
      logger.error(`Failed to half-open circuit breaker for account ${accountId}:`, error)
      return false
    }
  }

  /**
   * 关闭熔断器（恢复账户）
   * @param {string} accountId - 账户ID
   * @returns {Promise<boolean>}
   */
  async closeCircuitBreaker(accountId) {
    try {
      // 清除错误历史
      await redis.clear403Errors(accountId)

      // 更新账户熔断状态
      await this._updateAccountBreakerState(accountId, {
        error403BreakerState: 'closed',
        error403BreakerOpenAt: null,
        error403BreakerOpenUntil: null
      })

      logger.info(`✅ 403 Circuit Breaker: CLOSED for account ${accountId}`, {
        accountId
      })

      return true
    } catch (error) {
      logger.error(`Failed to close circuit breaker for account ${accountId}:`, error)
      return false
    }
  }

  /**
   * 检查并恢复熔断器（冷却期结束后）
   * @param {string} accountId - 账户ID
   * @returns {Promise<{recovered: boolean, state: string}>}
   */
  async checkAndRecoverBreaker(accountId) {
    try {
      const accountData = await this._getAccountData(accountId)

      if (!accountData || accountData.error403BreakerState !== 'open') {
        return { recovered: false, state: accountData?.error403BreakerState || 'closed' }
      }

      const now = Date.now()
      const openUntil = parseInt(accountData.error403BreakerOpenUntil || '0')

      // 检查冷却期是否结束
      if (now >= openUntil) {
        // 进入半开状态
        await this.halfOpenCircuitBreaker(accountId)

        logger.info(
          `🟡 403 Circuit Breaker: cooldown ended, entering half-open state for account ${accountId}`,
          {
            accountId,
            cooledDownAt: new Date(now).toISOString()
          }
        )

        return { recovered: true, state: 'half_open' }
      }

      return { recovered: false, state: 'open', remainingMs: openUntil - now }
    } catch (error) {
      logger.error(`Failed to check/recover circuit breaker for account ${accountId}:`, error)
      return { recovered: false, state: 'error' }
    }
  }

  /**
   * 获取账户熔断状态
   * @param {string} accountId - 账户ID
   * @returns {Promise<Object>} 熔断状态信息
   */
  async getBreakerStatus(accountId) {
    try {
      const accountData = await this._getAccountData(accountId)
      const errorCount = await redis.get403ErrorCount(accountId, 300)
      const cfg = await this.getAccountConfig(accountId)

      if (!accountData) {
        return {
          accountId,
          state: 'closed',
          errorCount,
          threshold: cfg.threshold,
          enabled: cfg.enabled
        }
      }

      const state = accountData.error403BreakerState || 'closed'
      const openAt = accountData.error403BreakerOpenAt
        ? parseInt(accountData.error403BreakerOpenAt)
        : null
      const openUntil = accountData.error403BreakerOpenUntil
        ? parseInt(accountData.error403BreakerOpenUntil)
        : null

      return {
        accountId,
        state,
        errorCount,
        threshold: cfg.threshold,
        enabled: cfg.enabled,
        openAt: openAt ? new Date(openAt).toISOString() : null,
        openUntil: openUntil ? new Date(openUntil).toISOString() : null,
        remainingMs: openUntil && state === 'open' ? Math.max(0, openUntil - Date.now()) : 0
      }
    } catch (error) {
      logger.error(`Failed to get breaker status for account ${accountId}:`, error)
      return { accountId, state: 'error', errorCount: 0 }
    }
  }

  /**
   * 启动自动恢复任务
   * 定期检查所有打开的熔断器，冷却期结束后自动恢复
   */
  startAutoRecoveryTask() {
    if (this.autoRecoveryTimer) {
      logger.debug('403 Circuit Breaker: auto-recovery task already running')
      return
    }

    this.autoRecoveryTimer = setInterval(async () => {
      const cfg = await this.getConfig()

      // 检查功能是否启用
      if (!cfg.enabled || !cfg.autoRecovery) {
        return
      }

      await this._runAutoRecovery()
    }, AUTO_RECOVERY_INTERVAL_MS)

    // 避免阻止进程退出
    if (typeof this.autoRecoveryTimer.unref === 'function') {
      this.autoRecoveryTimer.unref()
    }

    logger.info(
      `🔄 403 Circuit Breaker: auto-recovery task started (interval: ${AUTO_RECOVERY_INTERVAL_MS / 1000}s)`
    )
  }

  /**
   * 停止自动恢复任务
   */
  stopAutoRecoveryTask() {
    if (this.autoRecoveryTimer) {
      clearInterval(this.autoRecoveryTimer)
      this.autoRecoveryTimer = null
      logger.info('403 Circuit Breaker: auto-recovery task stopped')
    }
  }

  /**
   * 执行自动恢复逻辑（扫描所有账户）
   * @private
   */
  async _runAutoRecovery() {
    try {
      // 扫描所有账户类型的熔断状态
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

      let recoveredCount = 0

      for (const accountType of accountTypes) {
        const accountIds = await this._scanAccountsByType(accountType)

        for (const accountId of accountIds) {
          const result = await this.checkAndRecoverBreaker(accountId)

          if (result.recovered) {
            recoveredCount++
          }
        }
      }

      if (recoveredCount > 0) {
        logger.info(
          `🔄 403 Circuit Breaker: auto-recovery completed, recovered ${recoveredCount} account(s)`
        )
      }
    } catch (error) {
      logger.error('403 Circuit Breaker: auto-recovery task error:', error)
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
   * 更新账户熔断状态（跨账户类型）
   * @param {string} accountId - 账户ID
   * @param {Object} updates - 更新字段
   * @returns {Promise<boolean>}
   * @private
   */
  async _updateAccountBreakerState(accountId, updates) {
    const accountData = await this._getAccountData(accountId)

    if (!accountData) {
      logger.warn(`Cannot update breaker state: account ${accountId} not found`)
      return false
    }

    // 确定账户类型
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
        const exists = await redis.client.exists(`${accountType}:${accountId}`)
        if (exists) {
          // 更新字段
          const updateObj = {}
          for (const [key, value] of Object.entries(updates)) {
            if (value === null) {
              // 删除字段
              await redis.client.hdel(`${accountType}:${accountId}`, key)
            } else {
              updateObj[key] = value
            }
          }

          if (Object.keys(updateObj).length > 0) {
            await redis.client.hmset(`${accountType}:${accountId}`, updateObj)
          }

          return true
        }
      } catch (error) {
        // 继续尝试下一个类型
      }
    }

    return false
  }

  /**
   * 扫描特定类型的所有账户ID
   * @param {string} accountType - 账户类型前缀
   * @returns {Promise<string[]>}
   * @private
   */
  async _scanAccountsByType(accountType) {
    const accountIds = []
    let cursor = '0'
    let iterations = 0
    const MAX_ITERATIONS = 1000

    try {
      do {
        const [newCursor, keys] = await redis.client.scan(
          cursor,
          'MATCH',
          `${accountType}:*`,
          'COUNT',
          100
        )
        cursor = newCursor
        iterations++

        for (const key of keys) {
          const accountId = key.replace(`${accountType}:`, '')
          accountIds.push(accountId)
        }

        if (iterations >= MAX_ITERATIONS) {
          logger.warn(
            `403 Circuit Breaker: SCAN reached max iterations for ${accountType}, stopping early`
          )
          break
        }
      } while (cursor !== '0')

      return accountIds
    } catch (error) {
      logger.error(`Failed to scan accounts for type ${accountType}:`, error)
      return []
    }
  }
}

module.exports = new Error403CircuitBreakerService()
