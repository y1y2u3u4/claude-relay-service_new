const axios = require('axios')
const redis = require('../models/redis')
const logger = require('./logger')
const config = require('../../config/config')

// Redis缓存键
const PUBLIC_IP_CACHE_KEY = 'public_ip:server'

/**
 * 检测IP是否为内网地址
 * @param {string} ip - IP地址
 * @returns {boolean} - 是否为内网IP
 */
function isPrivateIP(ip) {
  if (!ip || ip === 'unknown') {
    return false
  }

  // 移除IPv6映射的IPv4地址前缀 (::ffff:xxx.xxx.xxx.xxx)
  const cleanIp = ip.replace(/^::ffff:/, '')

  // IPv4 内网地址检测
  if (cleanIp.includes('.')) {
    const parts = cleanIp.split('.').map(Number)

    // 检查格式是否有效
    if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
      return false
    }

    const [a, b] = parts

    // 127.0.0.0/8 - Loopback
    if (a === 127) {
      return true
    }

    // 10.0.0.0/8 - Private Network
    if (a === 10) {
      return true
    }

    // 172.16.0.0/12 - Private Network
    if (a === 172 && b >= 16 && b <= 31) {
      return true
    }

    // 192.168.0.0/16 - Private Network
    if (a === 192 && b === 168) {
      return true
    }

    // 169.254.0.0/16 - Link-Local
    if (a === 169 && b === 254) {
      return true
    }

    // 0.0.0.0/8 - Current network
    if (a === 0) {
      return true
    }

    return false
  }

  // IPv6 内网地址检测
  if (cleanIp.includes(':')) {
    const lowerIp = cleanIp.toLowerCase()

    // ::1 - Loopback
    if (lowerIp === '::1' || lowerIp === '::1/128') {
      return true
    }

    // fc00::/7 - Unique Local Address (ULA)
    if (lowerIp.startsWith('fc') || lowerIp.startsWith('fd')) {
      return true
    }

    // fe80::/10 - Link-Local
    if (lowerIp.startsWith('fe80:')) {
      return true
    }

    // :: - Unspecified
    if (lowerIp === '::' || lowerIp === '::/128') {
      return true
    }

    return false
  }

  return false
}

/**
 * 从外部API获取服务器公网IP
 * @returns {Promise<string|null>} - 公网IP或null
 */
async function fetchPublicIPFromAPI() {
  const apiUrl = config.ipResolve?.apiUrl || 'https://api.ipify.org'
  const timeout = 5000

  try {
    logger.debug(`🌐 Fetching public IP from ${apiUrl}...`)
    const response = await axios.get(apiUrl, {
      timeout,
      headers: { 'User-Agent': 'Claude-Relay-Service/1.0' }
    })

    const ip = response.data.trim()
    if (ip && !isPrivateIP(ip)) {
      logger.info(`✅ Fetched public IP from API: ${ip}`)
      return ip
    }
  } catch (error) {
    logger.warn(`⚠️ Failed to fetch public IP from ${apiUrl}: ${error.message}`)
  }

  // 备用API: ipinfo.io
  try {
    logger.debug('🌐 Trying backup API: ipinfo.io...')
    const response = await axios.get('https://ipinfo.io/ip', {
      timeout,
      headers: { 'User-Agent': 'Claude-Relay-Service/1.0' }
    })

    const ip = response.data.trim()
    if (ip && !isPrivateIP(ip)) {
      logger.info(`✅ Fetched public IP from backup API: ${ip}`)
      return ip
    }
  } catch (error) {
    logger.warn(`⚠️ Failed to fetch public IP from backup API: ${error.message}`)
  }

  return null
}

/**
 * 从白名单中获取第一个公网IP作为兜底
 * @returns {string|null}
 */
function getFallbackIPFromWhitelist() {
  const whitelist = config.security?.ipWhitelist?.allowedIps || []

  for (const ip of whitelist) {
    if (!isPrivateIP(ip)) {
      logger.info(`ℹ️ Using fallback IP from whitelist: ${ip}`)
      return ip
    }
  }

  return null
}

/**
 * 获取服务器公网IP（带缓存）
 * @returns {Promise<string>} - 公网IP
 */
async function getServerPublicIP() {
  try {
    // 1. 尝试从Redis缓存读取
    const cachedIP = await redis.get(PUBLIC_IP_CACHE_KEY)
    if (cachedIP) {
      logger.debug(`📦 Using cached public IP: ${cachedIP}`)
      return cachedIP
    }

    // 2. 从外部API获取
    const fetchedIP = await fetchPublicIPFromAPI()
    if (fetchedIP) {
      // 缓存到Redis（默认1小时）
      const cacheDuration = config.ipResolve?.cacheDuration || 3600
      await redis.setex(PUBLIC_IP_CACHE_KEY, cacheDuration, fetchedIP)
      return fetchedIP
    }

    // 3. 使用白名单中的第一个公网IP作为兜底
    const fallbackIP = getFallbackIPFromWhitelist()
    if (fallbackIP) {
      // 缓存较短时间（10分钟）
      await redis.setex(PUBLIC_IP_CACHE_KEY, 600, fallbackIP)
      return fallbackIP
    }

    // 4. 完全失败，返回unknown
    logger.error('❌ Failed to determine server public IP from all sources')
    return 'unknown'
  } catch (error) {
    logger.error(`❌ Error getting server public IP: ${error.message}`)
    // 尝试使用兜底IP
    return getFallbackIPFromWhitelist() || 'unknown'
  }
}

/**
 * 解析客户端真实IP
 * @param {Object} req - Express request对象
 * @returns {Promise<string>} - 解析后的IP地址
 */
async function resolveClientIP(req) {
  // 获取原始IP
  const originalIP =
    req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress || 'unknown'

  // 检查策略配置
  const strategy = config.ipResolve?.strategy || 'auto'

  // 如果策略为raw，直接返回原始IP
  if (strategy === 'raw') {
    logger.debug(`🔍 IP resolve strategy: raw, returning original IP: ${originalIP}`)
    return originalIP
  }

  // 策略为auto：检测内网IP并替换
  if (isPrivateIP(originalIP)) {
    logger.debug(`🏠 Detected private IP: ${originalIP}, fetching server public IP...`)
    const publicIP = await getServerPublicIP()
    logger.info(`🔄 Resolved private IP ${originalIP} to server public IP: ${publicIP}`)
    return publicIP
  }

  // 公网IP，直接返回
  logger.debug(`🌐 Detected public IP: ${originalIP}`)
  return originalIP
}

/**
 * 清除公网IP缓存（用于强制刷新）
 */
async function clearPublicIPCache() {
  try {
    await redis.del(PUBLIC_IP_CACHE_KEY)
    logger.info('🗑️ Cleared public IP cache')
    return true
  } catch (error) {
    logger.error(`❌ Failed to clear public IP cache: ${error.message}`)
    return false
  }
}

module.exports = {
  isPrivateIP,
  getServerPublicIP,
  resolveClientIP,
  clearPublicIPCache
}
