#!/usr/bin/env node

const { Command } = require('commander')
const inquirer = require('inquirer')
const chalk = require('chalk')
const ora = require('ora')
const { table } = require('table')
const bcrypt = require('bcryptjs')
const fs = require('fs')
const path = require('path')

const redis = require('../src/models/redis')
const apiKeyService = require('../src/services/apiKeyService')
const claudeAccountService = require('../src/services/claudeAccountService')
const bedrockAccountService = require('../src/services/bedrockAccountService')

const program = new Command()

// 🎨 样式
const styles = {
  title: chalk.bold.blue,
  success: chalk.green,
  error: chalk.red,
  warning: chalk.yellow,
  info: chalk.cyan,
  dim: chalk.dim
}

// 🔧 初始化
async function initialize() {
  const spinner = ora('正在连接 Redis...').start()
  try {
    await redis.connect()
    spinner.succeed('Redis 连接成功')
  } catch (error) {
    spinner.fail('Redis 连接失败')
    console.error(styles.error(error.message))
    process.exit(1)
  }
}

// 🔐 管理员账户管理
program
  .command('admin')
  .description('管理员账户操作')
  .action(async () => {
    await initialize()

    // 直接执行创建初始管理员
    await createInitialAdmin()

    await redis.disconnect()
  })

// 🔑 API Key 管理
program
  .command('keys')
  .description('API Key 管理操作')
  .action(async () => {
    await initialize()

    const { action } = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: '请选择操作:',
        choices: [
          { name: '📋 查看所有 API Keys', value: 'list' },
          { name: '🔧 修改 API Key 过期时间', value: 'update-expiry' },
          { name: '🔄 续期即将过期的 API Key', value: 'renew' },
          { name: '🗑️  删除 API Key', value: 'delete' }
        ]
      }
    ])

    switch (action) {
      case 'list':
        await listApiKeys()
        break
      case 'update-expiry':
        await updateApiKeyExpiry()
        break
      case 'renew':
        await renewApiKeys()
        break
      case 'delete':
        await deleteApiKey()
        break
    }

    await redis.disconnect()
  })

// 📊 系统状态
program
  .command('status')
  .description('查看系统状态')
  .action(async () => {
    await initialize()

    const spinner = ora('正在获取系统状态...').start()

    try {
      const [, apiKeys, accounts] = await Promise.all([
        redis.getSystemStats(),
        apiKeyService.getAllApiKeys(),
        claudeAccountService.getAllAccounts()
      ])

      spinner.succeed('系统状态获取成功')

      console.log(styles.title('\n📊 系统状态概览\n'))

      const statusData = [
        ['项目', '数量', '状态'],
        ['API Keys', apiKeys.length, `${apiKeys.filter((k) => k.isActive).length} 活跃`],
        ['Claude 账户', accounts.length, `${accounts.filter((a) => a.isActive).length} 活跃`],
        ['Redis 连接', redis.isConnected ? '已连接' : '未连接', redis.isConnected ? '🟢' : '🔴'],
        ['运行时间', `${Math.floor(process.uptime() / 60)} 分钟`, '🕐']
      ]

      console.log(table(statusData))

      // 使用统计
      const totalTokens = apiKeys.reduce((sum, key) => sum + (key.usage?.total?.tokens || 0), 0)
      const totalRequests = apiKeys.reduce((sum, key) => sum + (key.usage?.total?.requests || 0), 0)

      console.log(styles.title('\n📈 使用统计\n'))
      console.log(`总 Token 使用量: ${styles.success(totalTokens.toLocaleString())}`)
      console.log(`总请求数: ${styles.success(totalRequests.toLocaleString())}`)
    } catch (error) {
      spinner.fail('获取系统状态失败')
      console.error(styles.error(error.message))
    }

    await redis.disconnect()
  })

// ☁️ Bedrock 账户管理
program
  .command('bedrock')
  .description('Bedrock 账户管理操作')
  .action(async () => {
    await initialize()

    const { action } = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: '请选择操作:',
        choices: [
          { name: '📋 查看所有 Bedrock 账户', value: 'list' },
          { name: '➕ 创建 Bedrock 账户', value: 'create' },
          { name: '✏️  编辑 Bedrock 账户', value: 'edit' },
          { name: '🔄 切换账户状态', value: 'toggle' },
          { name: '🧪 测试账户连接', value: 'test' },
          { name: '🗑️  删除账户', value: 'delete' }
        ]
      }
    ])

    switch (action) {
      case 'list':
        await listBedrockAccounts()
        break
      case 'create':
        await createBedrockAccount()
        break
      case 'edit':
        await editBedrockAccount()
        break
      case 'toggle':
        await toggleBedrockAccount()
        break
      case 'test':
        await testBedrockAccount()
        break
      case 'delete':
        await deleteBedrockAccount()
        break
    }

    await redis.disconnect()
  })

// 实现具体功能函数

async function createInitialAdmin() {
  console.log(styles.title('\n🔐 创建初始管理员账户\n'))

  // 检查是否已存在 init.json
  const initFilePath = path.join(__dirname, '..', 'data', 'init.json')
  if (fs.existsSync(initFilePath)) {
    const existingData = JSON.parse(fs.readFileSync(initFilePath, 'utf8'))
    console.log(styles.warning('⚠️  检测到已存在管理员账户！'))
    console.log(`   用户名: ${existingData.adminUsername}`)
    console.log(`   创建时间: ${new Date(existingData.initializedAt).toLocaleString()}`)

    const { overwrite } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'overwrite',
        message: '是否覆盖现有管理员账户？',
        default: false
      }
    ])

    if (!overwrite) {
      console.log(styles.info('ℹ️  已取消创建'))
      return
    }
  }

  const adminData = await inquirer.prompt([
    {
      type: 'input',
      name: 'username',
      message: '用户名:',
      default: 'admin',
      validate: (input) => input.length >= 3 || '用户名至少3个字符'
    },
    {
      type: 'password',
      name: 'password',
      message: '密码:',
      validate: (input) => input.length >= 8 || '密码至少8个字符'
    },
    {
      type: 'password',
      name: 'confirmPassword',
      message: '确认密码:',
      validate: (input, answers) => input === answers.password || '密码不匹配'
    }
  ])

  const spinner = ora('正在创建管理员账户...').start()

  try {
    // 1. 先更新 init.json（唯一真实数据源）
    const initData = {
      initializedAt: new Date().toISOString(),
      adminUsername: adminData.username,
      adminPassword: adminData.password, // 保存明文密码
      version: '1.0.0',
      updatedAt: new Date().toISOString()
    }

    // 确保 data 目录存在
    const dataDir = path.join(__dirname, '..', 'data')
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true })
    }

    // 写入文件
    fs.writeFileSync(initFilePath, JSON.stringify(initData, null, 2))

    // 2. 再更新 Redis 缓存
    const passwordHash = await bcrypt.hash(adminData.password, 12)

    const credentials = {
      username: adminData.username,
      passwordHash,
      createdAt: new Date().toISOString(),
      lastLogin: null,
      updatedAt: new Date().toISOString()
    }

    await redis.setSession('admin_credentials', credentials, 0) // 永不过期

    spinner.succeed('管理员账户创建成功')
    console.log(`${styles.success('✅')} 用户名: ${adminData.username}`)
    console.log(`${styles.success('✅')} 密码: ${adminData.password}`)
    console.log(`${styles.info('ℹ️')} 请妥善保管登录凭据`)
    console.log(`${styles.info('ℹ️')} 凭据已保存到: ${initFilePath}`)
    console.log(`${styles.warning('⚠️')} 如果服务正在运行，请重启服务以加载新凭据`)
  } catch (error) {
    spinner.fail('创建管理员账户失败')
    console.error(styles.error(error.message))
  }
}

// API Key 管理功能
async function listApiKeys() {
  const spinner = ora('正在获取 API Keys...').start()

  try {
    const apiKeys = await apiKeyService.getAllApiKeys()
    spinner.succeed(`找到 ${apiKeys.length} 个 API Keys`)

    if (apiKeys.length === 0) {
      console.log(styles.warning('没有找到任何 API Keys'))
      return
    }

    const tableData = [['名称', 'API Key', '状态', '过期时间', '使用量', 'Token限制']]

    apiKeys.forEach((key) => {
      const now = new Date()
      const expiresAt = key.expiresAt ? new Date(key.expiresAt) : null
      let expiryStatus = '永不过期'

      if (expiresAt) {
        if (expiresAt < now) {
          expiryStatus = styles.error(`已过期 (${expiresAt.toLocaleDateString()})`)
        } else {
          const daysLeft = Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24))
          if (daysLeft <= 7) {
            expiryStatus = styles.warning(`${daysLeft}天后过期 (${expiresAt.toLocaleDateString()})`)
          } else {
            expiryStatus = styles.success(`${expiresAt.toLocaleDateString()}`)
          }
        }
      }

      tableData.push([
        key.name,
        key.apiKey ? `${key.apiKey.substring(0, 20)}...` : '-',
        key.isActive ? '🟢 活跃' : '🔴 停用',
        expiryStatus,
        `${(key.usage?.total?.tokens || 0).toLocaleString()}`,
        key.tokenLimit ? key.tokenLimit.toLocaleString() : '无限制'
      ])
    })

    console.log(styles.title('\n🔑 API Keys 列表:\n'))
    console.log(table(tableData))
  } catch (error) {
    spinner.fail('获取 API Keys 失败')
    console.error(styles.error(error.message))
  }
}

async function updateApiKeyExpiry() {
  try {
    // 获取所有 API Keys
    const apiKeys = await apiKeyService.getAllApiKeys()

    if (apiKeys.length === 0) {
      console.log(styles.warning('没有找到任何 API Keys'))
      return
    }

    // 选择要修改的 API Key
    const { selectedKey } = await inquirer.prompt([
      {
        type: 'list',
        name: 'selectedKey',
        message: '选择要修改的 API Key:',
        choices: apiKeys.map((key) => ({
          name: `${key.name} (${key.apiKey?.substring(0, 20)}...) - ${key.expiresAt ? new Date(key.expiresAt).toLocaleDateString() : '永不过期'}`,
          value: key
        }))
      }
    ])

    console.log(`\n当前 API Key: ${selectedKey.name}`)
    console.log(
      `当前过期时间: ${selectedKey.expiresAt ? new Date(selectedKey.expiresAt).toLocaleString() : '永不过期'}`
    )

    // 选择新的过期时间
    const { expiryOption } = await inquirer.prompt([
      {
        type: 'list',
        name: 'expiryOption',
        message: '选择新的过期时间:',
        choices: [
          { name: '⏰ 1分后（测试用）', value: '1m' },
          { name: '⏰ 1小时后（测试用）', value: '1h' },
          { name: '📅 1天后', value: '1d' },
          { name: '📅 7天后', value: '7d' },
          { name: '📅 30天后', value: '30d' },
          { name: '📅 90天后', value: '90d' },
          { name: '📅 365天后', value: '365d' },
          { name: '♾️  永不过期', value: 'never' },
          { name: '🎯 自定义日期时间', value: 'custom' }
        ]
      }
    ])

    let newExpiresAt = null

    if (expiryOption === 'never') {
      newExpiresAt = null
    } else if (expiryOption === 'custom') {
      const { customDate, customTime } = await inquirer.prompt([
        {
          type: 'input',
          name: 'customDate',
          message: '输入日期 (YYYY-MM-DD):',
          default: new Date().toISOString().split('T')[0],
          validate: (input) => {
            const date = new Date(input)
            return !isNaN(date.getTime()) || '请输入有效的日期格式'
          }
        },
        {
          type: 'input',
          name: 'customTime',
          message: '输入时间 (HH:MM):',
          default: '00:00',
          validate: (input) => /^\d{2}:\d{2}$/.test(input) || '请输入有效的时间格式 (HH:MM)'
        }
      ])

      newExpiresAt = new Date(`${customDate}T${customTime}:00`).toISOString()
    } else {
      // 计算新的过期时间
      const now = new Date()
      const durations = {
        '1m': 60 * 1000,
        '1h': 60 * 60 * 1000,
        '1d': 24 * 60 * 60 * 1000,
        '7d': 7 * 24 * 60 * 60 * 1000,
        '30d': 30 * 24 * 60 * 60 * 1000,
        '90d': 90 * 24 * 60 * 60 * 1000,
        '365d': 365 * 24 * 60 * 60 * 1000
      }

      newExpiresAt = new Date(now.getTime() + durations[expiryOption]).toISOString()
    }

    // 确认修改
    const confirmMsg = newExpiresAt
      ? `确认将过期时间修改为: ${new Date(newExpiresAt).toLocaleString()}?`
      : '确认设置为永不过期?'

    const { confirmed } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirmed',
        message: confirmMsg,
        default: true
      }
    ])

    if (!confirmed) {
      console.log(styles.info('已取消修改'))
      return
    }

    // 执行修改
    const spinner = ora('正在修改过期时间...').start()

    try {
      await apiKeyService.updateApiKey(selectedKey.id, { expiresAt: newExpiresAt })
      spinner.succeed('过期时间修改成功')

      console.log(styles.success(`\n✅ API Key "${selectedKey.name}" 的过期时间已更新`))
      console.log(
        `新的过期时间: ${newExpiresAt ? new Date(newExpiresAt).toLocaleString() : '永不过期'}`
      )
    } catch (error) {
      spinner.fail('修改失败')
      console.error(styles.error(error.message))
    }
  } catch (error) {
    console.error(styles.error('操作失败:', error.message))
  }
}

async function renewApiKeys() {
  const spinner = ora('正在查找即将过期的 API Keys...').start()

  try {
    const apiKeys = await apiKeyService.getAllApiKeys()
    const now = new Date()
    const sevenDaysLater = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)

    // 筛选即将过期的 Keys（7天内）
    const expiringKeys = apiKeys.filter((key) => {
      if (!key.expiresAt) {
        return false
      }
      const expiresAt = new Date(key.expiresAt)
      return expiresAt > now && expiresAt <= sevenDaysLater
    })

    spinner.stop()

    if (expiringKeys.length === 0) {
      console.log(styles.info('没有即将过期的 API Keys（7天内）'))
      return
    }

    console.log(styles.warning(`\n找到 ${expiringKeys.length} 个即将过期的 API Keys:\n`))

    expiringKeys.forEach((key, index) => {
      const daysLeft = Math.ceil((new Date(key.expiresAt) - now) / (1000 * 60 * 60 * 24))
      console.log(
        `${index + 1}. ${key.name} - ${daysLeft}天后过期 (${new Date(key.expiresAt).toLocaleDateString()})`
      )
    })

    const { renewOption } = await inquirer.prompt([
      {
        type: 'list',
        name: 'renewOption',
        message: '选择续期方式:',
        choices: [
          { name: '📅 全部续期30天', value: 'all30' },
          { name: '📅 全部续期90天', value: 'all90' },
          { name: '🎯 逐个选择续期', value: 'individual' }
        ]
      }
    ])

    if (renewOption.startsWith('all')) {
      const days = renewOption === 'all30' ? 30 : 90
      const renewSpinner = ora(`正在为所有 API Keys 续期 ${days} 天...`).start()

      for (const key of expiringKeys) {
        try {
          const newExpiresAt = new Date(
            new Date(key.expiresAt).getTime() + days * 24 * 60 * 60 * 1000
          ).toISOString()
          await apiKeyService.updateApiKey(key.id, { expiresAt: newExpiresAt })
        } catch (error) {
          renewSpinner.fail(`续期 ${key.name} 失败: ${error.message}`)
        }
      }

      renewSpinner.succeed(`成功续期 ${expiringKeys.length} 个 API Keys`)
    } else {
      // 逐个选择续期
      for (const key of expiringKeys) {
        console.log(`\n处理: ${key.name}`)

        const { action } = await inquirer.prompt([
          {
            type: 'list',
            name: 'action',
            message: '选择操作:',
            choices: [
              { name: '续期30天', value: '30' },
              { name: '续期90天', value: '90' },
              { name: '跳过', value: 'skip' }
            ]
          }
        ])

        if (action !== 'skip') {
          const days = parseInt(action)
          const newExpiresAt = new Date(
            new Date(key.expiresAt).getTime() + days * 24 * 60 * 60 * 1000
          ).toISOString()

          try {
            await apiKeyService.updateApiKey(key.id, { expiresAt: newExpiresAt })
            console.log(styles.success(`✅ 已续期 ${days} 天`))
          } catch (error) {
            console.log(styles.error(`❌ 续期失败: ${error.message}`))
          }
        }
      }
    }
  } catch (error) {
    spinner.fail('操作失败')
    console.error(styles.error(error.message))
  }
}

async function deleteApiKey() {
  try {
    const apiKeys = await apiKeyService.getAllApiKeys()

    if (apiKeys.length === 0) {
      console.log(styles.warning('没有找到任何 API Keys'))
      return
    }

    const { selectedKeys } = await inquirer.prompt([
      {
        type: 'checkbox',
        name: 'selectedKeys',
        message: '选择要删除的 API Keys (空格选择，回车确认):',
        choices: apiKeys.map((key) => ({
          name: `${key.name} (${key.apiKey?.substring(0, 20)}...)`,
          value: key.id
        }))
      }
    ])

    if (selectedKeys.length === 0) {
      console.log(styles.info('未选择任何 API Key'))
      return
    }

    const { confirmed } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirmed',
        message: styles.warning(`确认删除 ${selectedKeys.length} 个 API Keys?`),
        default: false
      }
    ])

    if (!confirmed) {
      console.log(styles.info('已取消删除'))
      return
    }

    const spinner = ora('正在删除 API Keys...').start()
    let successCount = 0

    for (const keyId of selectedKeys) {
      try {
        await apiKeyService.deleteApiKey(keyId)
        successCount++
      } catch (error) {
        spinner.fail(`删除失败: ${error.message}`)
      }
    }

    spinner.succeed(`成功删除 ${successCount}/${selectedKeys.length} 个 API Keys`)
  } catch (error) {
    console.error(styles.error('删除失败:', error.message))
  }
}

// async function listClaudeAccounts() {
//   const spinner = ora('正在获取 Claude 账户...').start();

//   try {
//     const accounts = await claudeAccountService.getAllAccounts();
//     spinner.succeed(`找到 ${accounts.length} 个 Claude 账户`);

//     if (accounts.length === 0) {
//       console.log(styles.warning('没有找到任何 Claude 账户'));
//       return;
//     }

//     const tableData = [
//       ['ID', '名称', '邮箱', '状态', '代理', '最后使用']
//     ];

//     accounts.forEach(account => {
//       tableData.push([
//         account.id.substring(0, 8) + '...',
//         account.name,
//         account.email || '-',
//         account.isActive ? (account.status === 'active' ? '🟢 活跃' : '🟡 待激活') : '🔴 停用',
//         account.proxy ? '🌐 是' : '-',
//         account.lastUsedAt ? new Date(account.lastUsedAt).toLocaleDateString() : '-'
//       ]);
//     });

//     console.log('\n🏢 Claude 账户列表:\n');
//     console.log(table(tableData));

//   } catch (error) {
//     spinner.fail('获取 Claude 账户失败');
//     console.error(styles.error(error.message));
//   }
// }

// ☁️ Bedrock 账户管理函数

async function listBedrockAccounts() {
  const spinner = ora('正在获取 Bedrock 账户...').start()

  try {
    const result = await bedrockAccountService.getAllAccounts()
    if (!result.success) {
      throw new Error(result.error)
    }

    const accounts = result.data
    spinner.succeed(`找到 ${accounts.length} 个 Bedrock 账户`)

    if (accounts.length === 0) {
      console.log(styles.warning('没有找到任何 Bedrock 账户'))
      return
    }

    const tableData = [['ID', '名称', '区域', '模型', '状态', '凭证类型', '创建时间']]

    accounts.forEach((account) => {
      tableData.push([
        `${account.id.substring(0, 8)}...`,
        account.name,
        account.region,
        account.defaultModel?.split('.').pop() || 'default',
        account.isActive ? (account.schedulable ? '🟢 活跃' : '🟡 不可调度') : '🔴 停用',
        account.credentialType,
        account.createdAt ? new Date(account.createdAt).toLocaleDateString() : '-'
      ])
    })

    console.log('\n☁️ Bedrock 账户列表:\n')
    console.log(table(tableData))
  } catch (error) {
    spinner.fail('获取 Bedrock 账户失败')
    console.error(styles.error(error.message))
  }
}

async function createBedrockAccount() {
  console.log(styles.title('\n➕ 创建 Bedrock 账户\n'))

  const questions = [
    {
      type: 'input',
      name: 'name',
      message: '账户名称:',
      validate: (input) => input.trim() !== ''
    },
    {
      type: 'input',
      name: 'description',
      message: '描述 (可选):'
    },
    {
      type: 'list',
      name: 'region',
      message: '选择 AWS 区域:',
      choices: [
        { name: 'us-east-1 (北弗吉尼亚)', value: 'us-east-1' },
        { name: 'us-west-2 (俄勒冈)', value: 'us-west-2' },
        { name: 'eu-west-1 (爱尔兰)', value: 'eu-west-1' },
        { name: 'ap-southeast-1 (新加坡)', value: 'ap-southeast-1' }
      ]
    },
    {
      type: 'list',
      name: 'credentialType',
      message: '凭证类型:',
      choices: [
        { name: '默认凭证链 (环境变量/AWS配置)', value: 'default' },
        { name: '访问密钥 (Access Key)', value: 'access_key' },
        { name: 'Bearer Token (API Key)', value: 'bearer_token' }
      ]
    }
  ]

  // 根据凭证类型添加额外问题
  const answers = await inquirer.prompt(questions)

  if (answers.credentialType === 'access_key') {
    const credQuestions = await inquirer.prompt([
      {
        type: 'input',
        name: 'accessKeyId',
        message: 'AWS Access Key ID:',
        validate: (input) => input.trim() !== ''
      },
      {
        type: 'password',
        name: 'secretAccessKey',
        message: 'AWS Secret Access Key:',
        validate: (input) => input.trim() !== ''
      },
      {
        type: 'input',
        name: 'sessionToken',
        message: 'Session Token (可选，用于临时凭证):'
      }
    ])

    answers.awsCredentials = {
      accessKeyId: credQuestions.accessKeyId,
      secretAccessKey: credQuestions.secretAccessKey
    }

    if (credQuestions.sessionToken) {
      answers.awsCredentials.sessionToken = credQuestions.sessionToken
    }
  }

  const spinner = ora('正在创建 Bedrock 账户...').start()

  try {
    const result = await bedrockAccountService.createAccount(answers)

    if (!result.success) {
      throw new Error(result.error)
    }

    spinner.succeed('Bedrock 账户创建成功')
    console.log(styles.success(`账户 ID: ${result.data.id}`))
    console.log(styles.info(`名称: ${result.data.name}`))
    console.log(styles.info(`区域: ${result.data.region}`))
  } catch (error) {
    spinner.fail('创建 Bedrock 账户失败')
    console.error(styles.error(error.message))
  }
}

async function testBedrockAccount() {
  const spinner = ora('正在获取 Bedrock 账户...').start()

  try {
    const result = await bedrockAccountService.getAllAccounts()
    if (!result.success || result.data.length === 0) {
      spinner.fail('没有可测试的 Bedrock 账户')
      return
    }

    spinner.succeed('账户列表获取成功')

    const choices = result.data.map((account) => ({
      name: `${account.name} (${account.region})`,
      value: account.id
    }))

    const { accountId } = await inquirer.prompt([
      {
        type: 'list',
        name: 'accountId',
        message: '选择要测试的账户:',
        choices
      }
    ])

    const testSpinner = ora('正在测试账户连接...').start()

    const testResult = await bedrockAccountService.testAccount(accountId)

    if (testResult.success) {
      testSpinner.succeed('账户连接测试成功')
      console.log(styles.success(`状态: ${testResult.data.status}`))
      console.log(styles.info(`区域: ${testResult.data.region}`))
      console.log(styles.info(`可用模型数量: ${testResult.data.modelsCount || 'N/A'}`))
    } else {
      testSpinner.fail('账户连接测试失败')
      console.error(styles.error(testResult.error))
    }
  } catch (error) {
    spinner.fail('测试过程中发生错误')
    console.error(styles.error(error.message))
  }
}

async function toggleBedrockAccount() {
  const spinner = ora('正在获取 Bedrock 账户...').start()

  try {
    const result = await bedrockAccountService.getAllAccounts()
    if (!result.success || result.data.length === 0) {
      spinner.fail('没有可操作的 Bedrock 账户')
      return
    }

    spinner.succeed('账户列表获取成功')

    const choices = result.data.map((account) => ({
      name: `${account.name} (${account.isActive ? '🟢 活跃' : '🔴 停用'})`,
      value: account.id
    }))

    const { accountId } = await inquirer.prompt([
      {
        type: 'list',
        name: 'accountId',
        message: '选择要切换状态的账户:',
        choices
      }
    ])

    const toggleSpinner = ora('正在切换账户状态...').start()

    // 获取当前状态
    const accountResult = await bedrockAccountService.getAccount(accountId)
    if (!accountResult.success) {
      throw new Error('无法获取账户信息')
    }

    const newStatus = !accountResult.data.isActive
    const updateResult = await bedrockAccountService.updateAccount(accountId, {
      isActive: newStatus
    })

    if (updateResult.success) {
      toggleSpinner.succeed('账户状态切换成功')
      console.log(styles.success(`新状态: ${newStatus ? '🟢 活跃' : '🔴 停用'}`))
    } else {
      throw new Error(updateResult.error)
    }
  } catch (error) {
    spinner.fail('切换账户状态失败')
    console.error(styles.error(error.message))
  }
}

async function editBedrockAccount() {
  const spinner = ora('正在获取 Bedrock 账户...').start()

  try {
    const result = await bedrockAccountService.getAllAccounts()
    if (!result.success || result.data.length === 0) {
      spinner.fail('没有可编辑的 Bedrock 账户')
      return
    }

    spinner.succeed('账户列表获取成功')

    const choices = result.data.map((account) => ({
      name: `${account.name} (${account.region})`,
      value: account.id
    }))

    const { accountId } = await inquirer.prompt([
      {
        type: 'list',
        name: 'accountId',
        message: '选择要编辑的账户:',
        choices
      }
    ])

    const accountResult = await bedrockAccountService.getAccount(accountId)
    if (!accountResult.success) {
      throw new Error('无法获取账户信息')
    }

    const account = accountResult.data

    const updates = await inquirer.prompt([
      {
        type: 'input',
        name: 'name',
        message: '账户名称:',
        default: account.name
      },
      {
        type: 'input',
        name: 'description',
        message: '描述:',
        default: account.description
      },
      {
        type: 'number',
        name: 'priority',
        message: '优先级 (1-100):',
        default: account.priority,
        validate: (input) => input >= 1 && input <= 100
      }
    ])

    const updateSpinner = ora('正在更新账户...').start()

    const updateResult = await bedrockAccountService.updateAccount(accountId, updates)

    if (updateResult.success) {
      updateSpinner.succeed('账户更新成功')
    } else {
      throw new Error(updateResult.error)
    }
  } catch (error) {
    spinner.fail('编辑账户失败')
    console.error(styles.error(error.message))
  }
}

async function deleteBedrockAccount() {
  const spinner = ora('正在获取 Bedrock 账户...').start()

  try {
    const result = await bedrockAccountService.getAllAccounts()
    if (!result.success || result.data.length === 0) {
      spinner.fail('没有可删除的 Bedrock 账户')
      return
    }

    spinner.succeed('账户列表获取成功')

    const choices = result.data.map((account) => ({
      name: `${account.name} (${account.region})`,
      value: { id: account.id, name: account.name }
    }))

    const { account } = await inquirer.prompt([
      {
        type: 'list',
        name: 'account',
        message: '选择要删除的账户:',
        choices
      }
    ])

    const { confirm } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: `确定要删除账户 "${account.name}" 吗？此操作无法撤销！`,
        default: false
      }
    ])

    if (!confirm) {
      console.log(styles.info('已取消删除'))
      return
    }

    const deleteSpinner = ora('正在删除账户...').start()

    const deleteResult = await bedrockAccountService.deleteAccount(account.id)

    if (deleteResult.success) {
      deleteSpinner.succeed('账户删除成功')
    } else {
      throw new Error(deleteResult.error)
    }
  } catch (error) {
    spinner.fail('删除账户失败')
    console.error(styles.error(error.message))
  }
}

// 🔒 隐身 API Key 管理
program
  .command('hidden-keys')
  .description('🔒 隐身 API Key 管理（仅限服务器管理员）')
  .action(async () => {
    await initialize()

    const { action } = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: '请选择操作:',
        choices: [
          { name: '➕ 创建隐身 API Key', value: 'create' },
          { name: '📋 查看隐身 API Keys', value: 'list' },
          { name: '🔓 转换为普通 Key', value: 'unhide' },
          { name: '🗑️  删除隐身 Key', value: 'delete' }
        ]
      }
    ])

    switch (action) {
      case 'create':
        await createHiddenApiKey()
        break
      case 'list':
        await listHiddenApiKeys()
        break
      case 'unhide':
        await unhideApiKey()
        break
      case 'delete':
        await deleteHiddenApiKey()
        break
    }

    await redis.disconnect()
  })

// 创建隐身 API Key
async function createHiddenApiKey() {
  console.log(styles.title('\n➕ 创建隐身 API Key\n'))
  console.log(styles.warning('⚠️  隐身 API Key 将不会在 Web 管理界面中显示\n'))

  // 0. 选择创建模式
  const { mode } = await inquirer.prompt([
    {
      type: 'list',
      name: 'mode',
      message: '选择创建模式:',
      choices: [
        { name: '快速创建（无限制，推荐）', value: 'quick' },
        { name: '高级创建（配置详细限制）', value: 'advanced' }
      ],
      default: 'quick'
    }
  ])

  // 1. 基本信息
  const basicInfo = await inquirer.prompt([
    {
      type: 'input',
      name: 'name',
      message: 'API Key 名称:',
      validate: (input) => input.length >= 3 || '名称至少3个字符'
    },
    {
      type: 'input',
      name: 'description',
      message: '描述:',
      default: '系统内部服务使用'
    },
    {
      type: 'list',
      name: 'permissions',
      message: '服务权限:',
      choices: [
        { name: '全部服务', value: 'all' },
        { name: 'Claude 服务', value: 'claude' },
        { name: 'Gemini 服务', value: 'gemini' },
        { name: 'OpenAI 服务', value: 'openai' }
      ]
    }
  ])

  // 快速创建模式：跳过所有额外配置
  if (mode === 'quick') {
    const spinner = ora('正在创建隐身 API Key...').start()

    try {
      const newKey = await apiKeyService.generateApiKey({
        name: basicInfo.name,
        description: basicInfo.description,
        permissions: basicInfo.permissions,
        isHidden: true,
        createdBy: 'cli',
        // 所有限制都设为默认值（无限制）
        concurrencyLimit: 0,
        rateLimitWindow: null,
        rateLimitRequests: null,
        rateLimitCost: null,
        dailyCostLimit: 0,
        totalCostLimit: 0,
        weeklyOpusCostLimit: 0,
        expirationMode: 'fixed',
        expiresAt: null
      })

      spinner.succeed('隐身 API Key 创建成功')

      console.log(styles.success('\n✅ 创建成功！'))
      console.log(styles.warning('⚠️  请立即保存以下信息，无法再次查看完整 Key：\n'))
      console.log(styles.title(`API Key: ${newKey.apiKey}`))
      console.log(styles.info(`名称: ${newKey.name}`))
      console.log(styles.info(`ID: ${newKey.id}`))
      console.log(styles.info(`权限: ${newKey.permissions}`))
      console.log(styles.info(`限制: 无限制（永不过期）`))
    } catch (error) {
      spinner.fail('创建失败')
      console.error(styles.error(error.message))
    }
    return
  }

  // 2. 并发和速率限制
  const concurrencyConfig = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'enableConcurrency',
      message: '是否设置并发限制？',
      default: false
    },
    {
      type: 'number',
      name: 'concurrencyLimit',
      message: '最大并发数:',
      default: 5,
      when: (answers) => answers.enableConcurrency,
      validate: (input) => input > 0 || '并发数必须大于0'
    },
    {
      type: 'confirm',
      name: 'enableRateLimit',
      message: '是否设置速率限制？',
      default: false
    },
    {
      type: 'number',
      name: 'rateLimitWindow',
      message: '速率限制时间窗口（秒）:',
      default: 60,
      when: (answers) => answers.enableRateLimit,
      validate: (input) => input > 0 || '时间窗口必须大于0'
    },
    {
      type: 'number',
      name: 'rateLimitRequests',
      message: '时间窗口内最大请求数:',
      default: 100,
      when: (answers) => answers.enableRateLimit,
      validate: (input) => input > 0 || '请求数必须大于0'
    },
    {
      type: 'confirm',
      name: 'enableRateLimitCost',
      message: '是否设置速率限制费用（美元）？',
      default: false,
      when: (answers) => answers.enableRateLimit
    },
    {
      type: 'number',
      name: 'rateLimitCost',
      message: '时间窗口内最大费用（美元）:',
      default: 10.0,
      when: (answers) => answers.enableRateLimitCost,
      validate: (input) => input > 0 || '费用必须大于0'
    }
  ])

  // 3. 费用限制
  const costLimits = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'enableDailyCostLimit',
      message: '是否设置每日费用限制？',
      default: false
    },
    {
      type: 'number',
      name: 'dailyCostLimit',
      message: '每日最大费用（美元）:',
      default: 50.0,
      when: (answers) => answers.enableDailyCostLimit,
      validate: (input) => input > 0 || '费用必须大于0'
    },
    {
      type: 'confirm',
      name: 'enableTotalCostLimit',
      message: '是否设置总费用限制？',
      default: false
    },
    {
      type: 'number',
      name: 'totalCostLimit',
      message: '总费用限制（美元）:',
      default: 1000.0,
      when: (answers) => answers.enableTotalCostLimit,
      validate: (input) => input > 0 || '费用必须大于0'
    },
    {
      type: 'confirm',
      name: 'enableWeeklyOpusCostLimit',
      message: '是否设置每周 Opus 模型费用限制？',
      default: false
    },
    {
      type: 'number',
      name: 'weeklyOpusCostLimit',
      message: '每周 Opus 模型最大费用（美元）:',
      default: 100.0,
      when: (answers) => answers.enableWeeklyOpusCostLimit,
      validate: (input) => input > 0 || '费用必须大于0'
    }
  ])

  // 4. 过期时间配置
  const expiryConfig = await inquirer.prompt([
    {
      type: 'list',
      name: 'expirationMode',
      message: '过期模式:',
      choices: [
        { name: '永不过期', value: 'never' },
        { name: '固定过期时间', value: 'fixed' },
        { name: '首次使用后激活（激活后计时）', value: 'activation' }
      ],
      default: 'never'
    },
    {
      type: 'number',
      name: 'expiryDays',
      message: '过期天数:',
      default: 30,
      when: (answers) => answers.expirationMode === 'fixed',
      validate: (input) => input > 0 || '天数必须大于0'
    },
    {
      type: 'number',
      name: 'activationDays',
      message: '激活后有效天数:',
      default: 30,
      when: (answers) => answers.expirationMode === 'activation',
      validate: (input) => input > 0 || '天数必须大于0'
    },
    {
      type: 'list',
      name: 'activationUnit',
      message: '激活时间单位:',
      choices: [
        { name: '天', value: 'days' },
        { name: '小时', value: 'hours' }
      ],
      default: 'days',
      when: (answers) => answers.expirationMode === 'activation'
    }
  ])

  const spinner = ora('正在创建隐身 API Key...').start()

  try {
    // 计算过期时间
    let expiresAt = null
    if (expiryConfig.expirationMode === 'fixed' && expiryConfig.expiryDays) {
      const now = new Date()
      expiresAt = new Date(now.getTime() + expiryConfig.expiryDays * 24 * 60 * 60 * 1000)
    }

    // 构建 API Key 创建选项
    const options = {
      name: basicInfo.name,
      description: basicInfo.description,
      permissions: basicInfo.permissions,
      isHidden: true, // 关键：设置为隐身
      createdBy: 'cli',
      // 并发和速率限制
      concurrencyLimit: concurrencyConfig.enableConcurrency
        ? concurrencyConfig.concurrencyLimit
        : 0,
      rateLimitWindow: concurrencyConfig.enableRateLimit ? concurrencyConfig.rateLimitWindow : null,
      rateLimitRequests: concurrencyConfig.enableRateLimit
        ? concurrencyConfig.rateLimitRequests
        : null,
      rateLimitCost: concurrencyConfig.enableRateLimitCost ? concurrencyConfig.rateLimitCost : null,
      // 费用限制
      dailyCostLimit: costLimits.enableDailyCostLimit ? costLimits.dailyCostLimit : 0,
      totalCostLimit: costLimits.enableTotalCostLimit ? costLimits.totalCostLimit : 0,
      weeklyOpusCostLimit: costLimits.enableWeeklyOpusCostLimit
        ? costLimits.weeklyOpusCostLimit
        : 0,
      // 过期时间配置
      expirationMode:
        expiryConfig.expirationMode === 'never' ? 'fixed' : expiryConfig.expirationMode,
      expiresAt,
      activationDays:
        expiryConfig.expirationMode === 'activation' ? expiryConfig.activationDays : 0,
      activationUnit:
        expiryConfig.expirationMode === 'activation' ? expiryConfig.activationUnit : 'days'
    }

    const newKey = await apiKeyService.generateApiKey(options)

    spinner.succeed('隐身 API Key 创建成功')

    console.log(styles.success('\n✅ 创建成功！'))
    console.log(styles.warning('⚠️  请立即保存以下信息，无法再次查看完整 Key：\n'))
    console.log(styles.title(`API Key: ${newKey.apiKey}`))
    console.log(styles.info(`名称: ${newKey.name}`))
    console.log(styles.info(`ID: ${newKey.id}`))
    console.log(styles.info(`权限: ${newKey.permissions}`))

    // 显示配置的限制
    console.log(styles.title('\n📊 配置的限制:'))
    if (concurrencyConfig.enableConcurrency) {
      console.log(styles.info(`  并发限制: ${concurrencyConfig.concurrencyLimit}`))
    }
    if (concurrencyConfig.enableRateLimit) {
      console.log(
        styles.info(
          `  速率限制: ${concurrencyConfig.rateLimitRequests} 请求/${concurrencyConfig.rateLimitWindow}秒`
        )
      )
      if (concurrencyConfig.enableRateLimitCost) {
        console.log(
          styles.info(
            `  速率费用限制: $${concurrencyConfig.rateLimitCost}/${concurrencyConfig.rateLimitWindow}秒`
          )
        )
      }
    }
    if (costLimits.enableDailyCostLimit) {
      console.log(styles.info(`  每日费用限制: $${costLimits.dailyCostLimit}`))
    }
    if (costLimits.enableTotalCostLimit) {
      console.log(styles.info(`  总费用限制: $${costLimits.totalCostLimit}`))
    }
    if (costLimits.enableWeeklyOpusCostLimit) {
      console.log(styles.info(`  每周 Opus 费用限制: $${costLimits.weeklyOpusCostLimit}`))
    }
    if (expiryConfig.expirationMode === 'fixed') {
      console.log(styles.info(`  过期时间: ${expiresAt.toLocaleString()}`))
    } else if (expiryConfig.expirationMode === 'activation') {
      console.log(
        styles.info(
          `  激活模式: 首次使用后 ${expiryConfig.activationDays} ${expiryConfig.activationUnit === 'days' ? '天' : '小时'}`
        )
      )
    } else {
      console.log(styles.info(`  过期时间: 永不过期`))
    }
  } catch (error) {
    spinner.fail('创建失败')
    console.error(styles.error(error.message))
  }
}

// 查看隐身 API Keys
async function listHiddenApiKeys() {
  const spinner = ora('正在获取隐身 API Keys...').start()

  try {
    const allKeys = await apiKeyService.getAllApiKeys()
    const hiddenKeys = allKeys.filter((k) => k.isHidden === 'true')

    spinner.succeed(`找到 ${hiddenKeys.length} 个隐身 API Keys`)

    if (hiddenKeys.length === 0) {
      console.log(styles.warning('\n没有找到隐身 API Keys'))
      return
    }

    // 获取每个隐身 Key 的费用统计
    const tableData = [['名称', 'ID', '状态', '权限', '创建时间', '总费用']]

    for (const key of hiddenKeys) {
      const costStats = await redis.getCostStats(key.id)
      const totalCost = costStats?.total || 0

      tableData.push([
        key.name,
        key.id.substring(0, 16) + '...',
        key.isActive ? '🟢 活跃' : '🔴 停用',
        key.permissions || 'all',
        new Date(key.createdAt).toLocaleDateString(),
        `$${totalCost.toFixed(2)}` // 显示费用
      ])
    }

    console.log(styles.title('\n🔒 隐身 API Keys 列表:\n'))
    console.log(table(tableData))

    // 显示隐身 Key 的总费用（不计入全局统计）
    let hiddenTotalCost = 0
    for (const key of hiddenKeys) {
      const costStats = await redis.getCostStats(key.id)
      hiddenTotalCost += costStats?.total || 0
    }
    console.log(styles.info(`\n💰 隐身 Keys 总费用: $${hiddenTotalCost.toFixed(2)}`))
    console.log(styles.warning('⚠️  此费用不计入全局统计'))
  } catch (error) {
    spinner.fail('获取失败')
    console.error(styles.error(error.message))
  }
}

// 转换为普通 Key
async function unhideApiKey() {
  const spinner = ora('正在获取隐身 API Keys...').start()

  try {
    const allKeys = await apiKeyService.getAllApiKeys()
    const hiddenKeys = allKeys.filter((k) => k.isHidden === 'true')

    spinner.stop()

    if (hiddenKeys.length === 0) {
      console.log(styles.warning('没有找到隐身 API Keys'))
      return
    }

    const { selectedKey } = await inquirer.prompt([
      {
        type: 'list',
        name: 'selectedKey',
        message: '选择要转换为普通 Key 的隐身 Key:',
        choices: hiddenKeys.map((key) => ({
          name: `${key.name} (${key.id.substring(0, 16)}...)`,
          value: key
        }))
      }
    ])

    const { confirm } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: `确认将 "${selectedKey.name}" 转换为普通 Key？`,
        default: false
      }
    ])

    if (!confirm) {
      console.log(styles.info('已取消转换'))
      return
    }

    const convertSpinner = ora('正在转换...').start()
    await apiKeyService.updateApiKey(selectedKey.id, { isHidden: false })
    convertSpinner.succeed('转换成功')

    console.log(styles.success(`\n✅ "${selectedKey.name}" 已转换为普通 Key`))
  } catch (error) {
    spinner.fail('转换失败')
    console.error(styles.error(error.message))
  }
}

// 删除隐身 Key
async function deleteHiddenApiKey() {
  const spinner = ora('正在获取隐身 API Keys...').start()

  try {
    const allKeys = await apiKeyService.getAllApiKeys()
    const hiddenKeys = allKeys.filter((k) => k.isHidden === 'true')

    spinner.stop()

    if (hiddenKeys.length === 0) {
      console.log(styles.warning('没有找到隐身 API Keys'))
      return
    }

    const { selectedKey } = await inquirer.prompt([
      {
        type: 'list',
        name: 'selectedKey',
        message: '选择要删除的隐身 Key:',
        choices: hiddenKeys.map((key) => ({
          name: `${key.name} (${key.id.substring(0, 16)}...)`,
          value: key
        }))
      }
    ])

    const { confirm } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: `确认删除 "${selectedKey.name}"？此操作为软删除，可恢复。`,
        default: false
      }
    ])

    if (!confirm) {
      console.log(styles.info('已取消删除'))
      return
    }

    const deleteSpinner = ora('正在删除...').start()
    await apiKeyService.deleteApiKey(selectedKey.id, 'cli', 'admin')
    deleteSpinner.succeed('删除成功')

    console.log(styles.success(`\n✅ "${selectedKey.name}" 已删除`))
  } catch (error) {
    spinner.fail('删除失败')
    console.error(styles.error(error.message))
  }
}

// 程序信息
program.name('claude-relay-cli').description('Claude Relay Service 命令行管理工具').version('1.0.0')

// 解析命令行参数
program.parse()

// 如果没有提供命令，显示帮助
if (!process.argv.slice(2).length) {
  console.log(styles.title('🚀 Claude Relay Service CLI\n'))
  console.log('使用以下命令管理服务:\n')
  console.log('  claude-relay-cli admin         - 创建初始管理员账户')
  console.log('  claude-relay-cli keys          - API Key 管理（查看/修改过期时间/续期/删除）')
  console.log('  claude-relay-cli bedrock       - Bedrock 账户管理（创建/查看/编辑/测试/删除）')
  console.log('  claude-relay-cli status        - 查看系统状态')
  console.log('\n使用 --help 查看详细帮助信息')
}
