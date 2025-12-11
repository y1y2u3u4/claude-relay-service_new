const config = require('../../config/config')
const logger = require('../utils/logger')
const ipHelper = require('../utils/ipHelper')

/**
 * IP白名单中间件
 * 只允许配置的IP地址访问服务
 */
async function ipWhitelistMiddleware(req, res, next) {
  // 如果未启用IP白名单，直接通过
  if (!config.security?.ipWhitelist?.enabled) {
    return next()
  }

  // 获取客户端IP地址
  // 使用 ipHelper 进行智能IP解析：
  // - 检测内网IP并自动替换为服务器公网IP
  // - 支持 X-Forwarded-For 等代理头部
  const clientIp = await ipHelper.resolveClientIP(req)

  // 获取白名单列表
  const whitelist = config.security.ipWhitelist.allowedIps || []

  // 如果白名单为空，记录警告并拒绝所有访问
  if (whitelist.length === 0) {
    logger.warn(
      `🚫 IP Whitelist enabled but no IPs configured. Blocking request from ${clientIp}`
    )
    return res.status(403).json({
      error: 'Forbidden',
      message: 'Access denied. IP address not whitelisted.',
      clientIp: clientIp
    })
  }

  // 检查IP是否在白名单中
  const isAllowed = whitelist.some((allowedIp) => {
    // 精确匹配
    if (clientIp === allowedIp) {
      return true
    }

    // 处理IPv6映射的IPv4地址 (::ffff:xxx.xxx.xxx.xxx)
    const ipv4Match = clientIp.match(/::ffff:(.+)/)
    if (ipv4Match && ipv4Match[1] === allowedIp) {
      return true
    }

    return false
  })

  if (isAllowed) {
    logger.debug(`✅ IP Whitelist: Allowed request from ${clientIp}`)
    return next()
  }

  // IP不在白名单中，拒绝访问
  logger.warn(
    `🚫 IP Whitelist: Blocked request from ${clientIp} - not in whitelist [${whitelist.join(', ')}]`
  )

  return res.status(403).json({
    error: 'Forbidden',
    message: 'Access denied. Your IP address is not whitelisted.',
    clientIp: clientIp
  })
}

module.exports = {
  ipWhitelistMiddleware
}
