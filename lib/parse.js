/**
 * JD / 简历解析：全部是确定性规则，不调模型。
 * 目标不是 100% 抽取，而是把「年限 / 学历 / 城市 / 薪资 / 技能 / 风险」这些
 * 真正影响投递决策的字段稳定拿出来，拿不到就标 unknown。
 */
import { norm, hasAlias, evidence, clip } from './text.js'
import { detectSkills } from './skills.js'

const REQ_HEAD = /^(任职要求|岗位要求|任职资格|职位要求|技能要求|我们希望你|你需要具备|任职条件|岗位需求|要求)/
const RESP_HEAD = /^(岗位职责|工作职责|职位描述|工作内容|你将负责|职责描述|工作描述)/
const NICE_HEAD = /^(加分项|优先条件|nice to have|bonus|加分)/
const OTHER_HEAD = /^(福利待遇|薪资待遇|公司介绍|关于我们|团队介绍|工作地点|办公地点|联系方式|投递方式)/

const CITIES = [
  '哈尔滨', '呼和浩特', '乌鲁木齐', '石家庄', '秦皇岛', '三亚', '海口', '兰州', '银川', '西宁',
  '北京', '上海', '深圳', '广州', '杭州', '成都', '南京', '武汉', '西安', '苏州', '天津', '重庆',
  '长沙', '郑州', '合肥', '厦门', '福州', '济南', '青岛', '大连', '沈阳', '长春', '太原', '南昌',
  '南宁', '昆明', '贵阳', '无锡', '宁波', '东莞', '佛山', '珠海', '中山', '惠州', '常州', '温州',
  '嘉兴', '绍兴', '台州', '金华', '泉州', '烟台', '潍坊', '徐州', '香港', '澳门', '台北', '新加坡', '远程',
].sort((a, b) => b.length - a.length)

const EDU = [
  ['博士', 4, '博士'],
  ['硕士', 3, '硕士'],
  ['研究生', 3, '硕士'],
  ['本科', 2, '本科'],
  ['学士', 2, '本科'],
  ['大专', 1, '大专'],
  ['专科', 1, '大专'],
]

const RED_FLAGS = [
  { id: 'outsource', label: '外包/驻场', weight: 15, re: /外包|驻场|派遣|人力外包/ },
  { id: 'overtime', label: '加班文化', weight: 12, re: /996|大小周|单休|每周6天|周六上班|早10晚10|10106/ },
  { id: 'age', label: '年龄限制', weight: 12, re: /(?:年龄|不超过)\s*(?:35|30)\s*岁|(?:35|30)\s*岁(?:以下|以内)/ },
  { id: 'opaque-salary', label: '薪资面议', weight: 6, re: /薪资面议|待遇面谈|工资面议/ },
  { id: 'travel', label: '频繁出差', weight: 6, re: /频繁出差|长期出差|出差\s*(?:30|50|70|80|90)\s*%/ },
  { id: 'pressure', label: '高压文化', weight: 5, re: /抗压|狼性|奋斗|拼搏|all in|随时响应|24小时/ },
  { id: 'multirole', label: '职责过杂', weight: 6, re: /一人多岗|身兼多职|全栈.{0,6}(?:运营|销售)|兼.{0,4}(?:运营|设计|测试)/ },
  { id: 'urgency', label: '急招', weight: 2, re: /急招|急聘|大量招聘|高薪诚聘/ },
  { id: 'probation', label: '长试用期', weight: 4, re: /试用期\s*(?:6|六)\s*个月|试用期半年/ },
  { id: 'equity', label: '期权/股权', weight: 2, re: /期权|股权激励|原始股/ },
  { id: 'oncall', label: 'On-call', weight: 4, re: /on[- ]?call|值班|7\*24/ },
]

function cleanHeading(line) {
  return line
    .replace(/^[\s#>*\-—–\d.、:：()（）【】[\]]+/, '')
    .trim()
}

/** 把 JD 切成 标题/职责/要求/加分/其他 五段 */
export function splitSections(raw) {
  const lines = String(raw || '')
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .split('\n')
  const out = { title: '', resp: [], req: [], nice: [], other: [] }
  let cur = 'other'
  let firstContent = ''
  for (const line of lines) {
    const t = line.trim()
    if (!t) continue
    if (!firstContent) firstContent = t
    const head = cleanHeading(t)
    const heading = head.replace(/[:：].*$/, '')
    let matched = false
    if (REQ_HEAD.test(heading)) {
      cur = 'req'
      matched = true
    } else if (RESP_HEAD.test(heading)) {
      cur = 'resp'
      matched = true
    } else if (NICE_HEAD.test(heading)) {
      cur = 'nice'
      matched = true
    } else if (OTHER_HEAD.test(heading)) {
      cur = 'other'
      matched = true
    }
    if (matched) {
      const rest = head.slice(heading.length).replace(/^[:：\s]+/, '')
      if (rest) out[cur].push(rest)
      continue
    }
    out[cur].push(t)
  }
  out.title = firstContent
  return out
}

function pickTitle(sections) {
  const first = sections.title
  if (first && first.length <= 60 && !REQ_HEAD.test(cleanHeading(first)) && !RESP_HEAD.test(cleanHeading(first))) {
    return first.replace(/^#+\s*/, '').trim()
  }
  const pool = [sections.title, ...sections.resp, ...sections.req, ...sections.other]
  const hit = pool.find((l) => /工程师|开发|产品|运营|设计|经理|专家|负责人|架构师|分析师|研究员|顾问|实习生|总监/.test(l))
  return (hit || first || '未命名 JD').replace(/^#+\s*/, '').trim().slice(0, 60)
}

function pickCompanyCity(sections) {
  const pool = [sections.title, ...sections.other.slice(0, 6)]
  for (const line of pool) {
    if (!line || line.length > 80) continue
    const parts = line.split(/[·•｜|]/).map((s) => s.trim()).filter(Boolean)
    if (parts.length >= 2) {
      const city = parts.find((p) => CITIES.includes(p) || CITIES.some((c) => p.startsWith(c) && p.length <= c.length + 2))
      const company = parts.find((p) => p !== city && !/^\d/.test(p) && p.length <= 30)
      return { company: company || '', city: city || '' }
    }
  }
  const m = String(sections.title || '').match(/公司[:：]\s*([^\s，,。;；|｜·]{2,30})/)
  return { company: m ? m[1] : '', city: '' }
}

export function parseSalary(text) {
  const t = norm(text)
  const monthsM = t.match(/[·x*×\s](\d{1,2})\s*薪/)
  const months = monthsM ? Number(monthsM[1]) : 12
  const mk = (min, max) => ({
    min: Math.round(Number(min) * 10) / 10,
    max: Math.round(Number(max) * 10) / 10,
    months,
    raw: `${min}-${max}K${months !== 12 ? `·${months}薪` : ''}`,
    negotiable: false,
  })
  let m
  m = t.match(/(\d{4,5})\s*[-~—–至到]\s*(\d{4,5})\s*(?:k|千)/)
  if (m) return mk(Number(m[1]) / 1000, Number(m[2]) / 1000)
  m = t.match(/(\d{4,5})\s*[-~—–至到]\s*(\d{4,5})\s*元\s*\/?\s*月/)
  if (m) return mk(Number(m[1]) / 1000, Number(m[2]) / 1000)
  m = t.match(/(\d{1,3}(?:\.\d+)?)\s*[-~—–至到]\s*(\d{1,3}(?:\.\d+)?)\s*(?:k|千)/)
  if (m) return mk(m[1], m[2])
  m = t.match(/(\d{1,3}(?:\.\d+)?)\s*(?:k|千)\s*[-~—–至到]\s*(\d{1,3}(?:\.\d+)?)\s*(?:k|千)/)
  if (m) return mk(m[1], m[2])
  m = t.match(/年薪\s*(\d{1,3}(?:\.\d+)?)\s*[-~—–至到]\s*(\d{1,3}(?:\.\d+)?)\s*万/)
  if (m) return mk((Number(m[1]) * 10) / 12, (Number(m[2]) * 10) / 12)
  m = t.match(/(\d{1,3}(?:\.\d+)?)\s*[-~—–至到]\s*(\d{1,3}(?:\.\d+)?)\s*万\s*\/?\s*年/)
  if (m) return mk((Number(m[1]) * 10) / 12, (Number(m[2]) * 10) / 12)
  m = t.match(/(\d{1,4})\s*[-~—–至到]\s*(\d{1,4})\s*元\s*\/?\s*天/)
  if (m) return mk((Number(m[1]) * 21.75) / 1000, (Number(m[2]) * 21.75) / 1000)
  if (/面议|薪资面谈|待遇面谈/.test(t)) return { min: null, max: null, months, raw: '面议', negotiable: true }
  return null
}

export function parseYears(text) {
  const t = norm(text)
  if (/经验不限|不限经验|应届生|应届|无经验要求/.test(t)) {
    return { min: 0, max: null, raw: '经验不限', unlimited: true }
  }
  let m
  m = t.match(/(\d{1,2})\s*[-~—–至到]\s*(\d{1,2})\s*年/)
  if (m) return { min: Number(m[1]), max: Number(m[2]), raw: m[0].trim(), unlimited: false }
  m = t.match(/(\d{1,2})\s*年(?:及)?以上(?:的)?(?:工作|开发|后端|前端|相关|从业|产品|运营)?(?:经验)?/)
  if (m) return { min: Number(m[1]), max: null, raw: m[0].trim(), unlimited: false }
  m = t.match(/至少\s*(\d{1,2})\s*年/)
  if (m) return { min: Number(m[1]), max: null, raw: m[0].trim(), unlimited: false }
  m = t.match(/(\d{1,2})\s*年(?:以上)?(?:的)?(?:工作|开发|后端|前端|相关|从业|产品|运营)?(?:经验)/)
  if (m) return { min: Number(m[1]), max: null, raw: m[0].trim(), unlimited: false }
  m = t.match(/(\d{1,2})\s*年以内/)
  if (m) return { min: 0, max: Number(m[1]), raw: m[0].trim(), unlimited: false }
  m = t.match(/(?:经验|工作)\s*(\d{1,2})\s*年/)
  if (m) return { min: Number(m[1]), max: null, raw: m[0].trim(), unlimited: false }
  return null
}

export function parseEducation(text) {
  const t = norm(text)
  if (/学历不限|不限学历|学历要求不限/.test(t)) return { level: '不限', rank: 0, raw: '学历不限' }
  let best = null
  for (const [word, rank, level] of EDU) {
    const re = new RegExp(`${word}(?:及)?以上`)
    if (re.test(t)) {
      if (!best || rank < best.rank) best = { level, rank, raw: `${word}及以上` }
    }
  }
  if (best) return best
  for (const [word, rank, level] of EDU) {
    if (t.includes(word)) {
      if (!best || rank < best.rank) best = { level, rank, raw: word }
    }
  }
  return best
}

function findCity(text) {
  const t = String(text || '')
  const explicit = t.match(/(?:工作地点|办公地点|城市|base|地点)\s*[:：]?\s*([\u4e00-\u9fa5]{2,8})/)
  if (explicit) {
    const hit = CITIES.find((c) => explicit[1].startsWith(c))
    if (hit) return hit
  }
  const head = t.slice(0, 500)
  for (const c of CITIES) {
    if (head.includes(c)) return c
  }
  return ''
}

export function findRedFlags(text) {
  const t = norm(text)
  const out = []
  for (const f of RED_FLAGS) {
    const m = t.match(f.re)
    if (m && typeof m.index === 'number') {
      out.push({ id: f.id, label: f.label, weight: f.weight, evidence: evidence(t, m.index) })
    }
  }
  return out
}

/** 解析单条 JD */
export function parseJD(raw) {
  const text = String(raw || '').trim()
  const sections = splitSections(text)
  const reqText = sections.req.join('\n')
  const respText = sections.resp.join('\n')
  const title = pickTitle(sections)
  const { company, city: lineCity } = pickCompanyCity(sections)

  const salary = parseSalary(text)
  const years = parseYears(reqText) || parseYears(text)
  const education = parseEducation(reqText) || parseEducation(text)
  const city = lineCity || findCity(text)
  const skills = detectSkills(text, { title, requirement: reqText })
  const redFlags = findRedFlags(text)

  return {
    raw: text,
    title,
    company,
    city,
    salary,
    years,
    education,
    skills,
    redFlags,
    sections: {
      resp: respText,
      req: reqText,
      nice: sections.nice.join('\n'),
      other: sections.other.join('\n'),
    },
    stats: {
      chars: text.length,
      lines: text.split('\n').filter((l) => l.trim()).length,
      reqCount: sections.req.filter((l) => l.trim()).length,
      respCount: sections.resp.filter((l) => l.trim()).length,
    },
  }
}

function str(v) {
  return typeof v === 'string' ? v.trim() : ''
}

function numOrNull(v) {
  if (v === '' || v === null || v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/** 解析候选人画像；简历文本只用于抽技能/年限/学历/城市，不落库 */
export function parseProfile(input = {}) {
  const title = str(input.title)
  const resumeText = str(input.resumeText)
  const skillsText = str(input.skillsText)
  const all = [title, skillsText, resumeText].join('\n')

  const detected = detectSkills(all, { title })
  const explicit = str(input.skills)
  const explicitIds = explicit
    ? detectSkills(explicit).map((s) => s.id)
    : []
  const skillIds = [...new Set([...detected.map((s) => s.id), ...explicitIds])]

  const yearsParsed = parseYears(resumeText || all)
  const years = numOrNull(input.years) ?? (yearsParsed ? yearsParsed.min : null)

  const eduParsed = parseEducation(resumeText || all)
  const cityRaw = str(input.city)
  const cityFromResume = cityRaw ? '' : findCity(resumeText)
  const cities = cityRaw
    ? cityRaw.split(/[,，、/|\s]+/).map((s) => s.trim()).filter(Boolean)
    : cityFromResume
      ? [cityFromResume]
      : []

  const educationInput = str(input.education)
  const education = educationInput === '不限' ? '' : educationInput || (eduParsed ? eduParsed.level : '')
  const eduRank =
    education === '' || education === '不限'
      ? null
      : eduParsed && eduParsed.level === education
        ? eduParsed.rank
        : ({ 大专: 1, 本科: 2, 硕士: 3, 博士: 4 }[education] ?? null)

  return {
    title,
    years,
    education,
    eduRank,
    cities,
    salaryMin: numOrNull(input.salaryMin),
    salaryMax: numOrNull(input.salaryMax),
    remoteOk: input.remoteOk === true || input.remoteOk === '1' || input.remoteOk === 'on',
    skills: skillIds,
    skillsText,
    resumeText: clip(resumeText, 12000),
  }
}

/** 把一大段粘贴文本拆成多条 JD（分隔线 --- / ===） */
export function splitJDs(raw) {
  return String(raw || '')
    .split(/\n\s*(?:-{3,}|={3,})\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 20)
}
