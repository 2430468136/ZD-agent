export type SkillProfile = {
  id: string
  name: string
  category: string
  description: string
  scope: string
  verification: string
  tools: string[]
  tone: string
}

export const skillCatalog: SkillProfile[] = [
  {
    id: 'task-decomposition',
    name: '任务拆解与路由',
    category: '协作管理',
    description: '把目标拆成可交接的子任务，并为每个子任务选择合适岗位。',
    scope: '目标、依赖、交接条件',
    verification: '每个子任务都有负责人、输入、产出和验收标准。',
    tools: ['任务队列', '上下文索引'],
    tone: 'skill-green',
  },
  {
    id: 'acceptance-planning',
    name: '验收标准设计',
    category: '协作管理',
    description: '为交付物定义可观察的检查项，避免只凭主观描述判断完成。',
    scope: '验收条件、风险、回归范围',
    verification: '验收项可以映射到测试命令、截图或文件证据。',
    tools: ['任务记录', '执行日志'],
    tone: 'skill-lime',
  },
  {
    id: 'react-typescript',
    name: 'React + TypeScript',
    category: '前端开发',
    description: '实现组件、状态管理和类型安全的前端功能。',
    scope: 'React、TypeScript、Vite',
    verification: '通过类型检查、lint，并覆盖关键交互状态。',
    tools: ['代码搜索', '类型检查'],
    tone: 'skill-blue',
  },
  {
    id: 'browser-debugging',
    name: '浏览器调试',
    category: '前端开发',
    description: '定位布局、交互、网络请求和响应式视图中的问题。',
    scope: 'DOM、CSS、Network、Console',
    verification: '在目标桌面和移动视口复现并验证修复。',
    tools: ['浏览器检查', '截图验证'],
    tone: 'skill-cyan',
  },
  {
    id: 'design-system',
    name: '设计系统实现',
    category: '前端开发',
    description: '按既有视觉规范实现可复用组件、状态和无障碍交互。',
    scope: '组件、间距、颜色、响应式',
    verification: '检查文本不溢出、控件可操作、状态视觉一致。',
    tools: ['组件目录', '视觉检查'],
    tone: 'skill-pink',
  },
  {
    id: 'node-api',
    name: 'Node.js API',
    category: '后端开发',
    description: '设计并实现稳定的 Node.js API、错误处理和请求校验。',
    scope: 'Node.js、HTTP、JSON、鉴权',
    verification: '覆盖成功、参数错误、权限失败和异常路径。',
    tools: ['接口探测', '日志排查'],
    tone: 'skill-purple',
  },
  {
    id: 'database-auth',
    name: '数据库与鉴权',
    category: '后端开发',
    description: '处理数据模型、迁移、权限边界和敏感字段保护。',
    scope: '数据模型、权限、密钥、迁移',
    verification: '检查最小权限、重复请求和敏感信息是否泄露。',
    tools: ['Schema 检查', 'API 测试'],
    tone: 'skill-indigo',
  },
  {
    id: 'security-audit',
    name: '安全审计',
    category: '安全研究',
    description: '在获得授权的范围内分析攻击面、输入边界和高风险路径。',
    scope: '依赖、输入、权限、数据流',
    verification: '记录复现条件、影响范围和可回滚的修复建议。',
    tools: ['代码搜索', '依赖审计'],
    tone: 'skill-red',
  },
  {
    id: 'reverse-analysis',
    name: '逆向分析',
    category: '安全研究',
    description: '针对用户拥有或明确授权的程序进行结构、协议和行为分析。',
    scope: '反编译、协议、调用链、样本行为',
    verification: '保留原始哈希、分析记录和不会破坏原件的复现步骤。',
    tools: ['静态分析', '行为记录'],
    tone: 'skill-orange',
  },
  {
    id: 'unit-testing',
    name: '单元与回归测试',
    category: '测试验收',
    description: '补充高价值测试，验证新逻辑并防止已有行为回归。',
    scope: '单元测试、集成测试、边界条件',
    verification: '测试失败时给出最小复现和明确失败原因。',
    tools: ['测试发现', '命令执行'],
    tone: 'skill-coral',
  },
  {
    id: 'playwright-ci',
    name: 'Playwright 与 CI',
    category: '测试验收',
    description: '验证关键用户流程、响应式布局和持续集成配置。',
    scope: 'Playwright、CI、构建产物',
    verification: '在本地和 CI 环境执行同一组关键检查。',
    tools: ['浏览器测试', 'CI 日志'],
    tone: 'skill-yellow',
  },
  {
    id: 'source-research',
    name: '资料检索与比较',
    category: '研究分析',
    description: '整理来源、比较方案，并把不确定性和结论依据记录下来。',
    scope: '来源、版本、限制、决策依据',
    verification: '结论可追溯到来源，区分事实、推断和待验证项。',
    tools: ['资料索引', '决策记录'],
    tone: 'skill-teal',
  },
  {
    id: 'release-monitoring',
    name: '发布与监控',
    category: '运营交付',
    description: '检查发布前条件、运行状态和变更后的异常信号。',
    scope: '版本、部署、日志、回滚',
    verification: '发布记录包含版本、检查结果和恢复路径。',
    tools: ['CI 状态', '运行日志'],
    tone: 'skill-slate',
  },
]

export const defaultSkillIds: Record<string, string[]> = {
  ceo: ['task-decomposition', 'acceptance-planning'],
  frontend: ['react-typescript', 'browser-debugging', 'design-system'],
  backend: ['node-api', 'database-auth'],
  qa: ['unit-testing', 'playwright-ci', 'acceptance-planning'],
  research: ['source-research', 'acceptance-planning'],
  design: ['design-system', 'browser-debugging'],
  ops: ['release-monitoring', 'playwright-ci'],
}

export function getSkills(skillIds: string[]) {
  return skillIds.map((id) => skillCatalog.find((skill) => skill.id === id)).filter((skill): skill is SkillProfile => Boolean(skill))
}
