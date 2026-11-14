/**
 * 招聘 JD 来源适配器。
 *
 * 只接「公开可抓、不需要登录」的源：
 * - 猎聘：SEO 列表页 + 职位详情页（服务端渲染）
 * - LinkedIn：guest 公开职位接口（无需登录；有 429 限流）
 * - V2EX 酷工作：公开 API
 * - 电鸭社区：公开 API（远程/兼职为主）
 * - Remote OK：公开 API（英文远程岗，需回链）
 *
 * BOSS 直聘 / 脉脉明确未接：前者返回 code 37（环境异常），后者强制登录。
 * 不伪造数据、不硬闯验证码；源失败就在诊断里返回原因。
 */
import { fetchPage, fetchJson, fetchCurl, mapLimit, FetchError } from './http.js'
import { stripHtml, pageText, pageTitle, innerByClass } from './html.js'
import { TTLCache } from './cache.js'
import { getAuth, isConfigured, markResult } from './auth.js'
import { exitTarget, requestViaProxy } from './exit.js'

const listCache = new TTLCache({ max: 120, ttl: 10 * 60 * 1000 })
const detailCache = new TTLCache({ max: 400, ttl: 30 * 60 * 1000 })

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

const LIEPIN_CITY = {
  北京: 'bj', 上海: 'sh', 深圳: 'sz', 广州: 'gz', 杭州: 'hz', 成都: 'cd', 南京: 'nj',
  武汉: 'wh', 西安: 'xa', 苏州: 'su', 天津: 'tj', 重庆: 'cq', 长沙: 'cs', 郑州: 'zz',
  合肥: 'hf', 厦门: 'xm', 福州: 'fz', 济南: 'jn', 青岛: 'qd', 大连: 'dl', 沈阳: 'sy',
  无锡: 'wx', 宁波: 'nb', 东莞: 'dg', 佛山: 'fs', 珠海: 'zh', 中山: 'zs', 惠州: 'hui',
  常州: 'cz', 温州: 'wz', 嘉兴: 'jx', 绍兴: 'sx', 台州: 'tz', 金华: 'jh', 泉州: 'qz',
  烟台: 'yt', 潍坊: 'wf', 徐州: 'xz', 香港: 'hk', 新加坡: 'sg',
}

export const SOURCES = [
  {
    id: 'liepin',
    name: '猎聘',
    region: '中国',
    available: true,
    enabled: true,
    detail: true,
    note: '公开列表 + 详情页，按城市+关键词搜',
  },
  {
    id: 'linkedin',
    name: 'LinkedIn',
    region: '中国/全球',
    available: true,
    enabled: true,
    detail: true,
    note: 'guest 公开职位接口，无需登录；偶发 429',
  },
  {
    id: 'v2ex',
    name: 'V2EX 酷工作',
    region: '中国',
    available: true,
    enabled: true,
    detail: false,
    note: '公开 API，创业公司/远程岗偏多',
  },
  {
    id: 'eleduck',
    name: '电鸭社区',
    region: '远程',
    available: true,
    enabled: true,
    detail: true,
    note: '公开 API，远程/兼职为主',
  },
  {
    id: 'remoteok',
    name: 'Remote OK',
    region: '全球远程',
    available: true,
    enabled: false,
    detail: false,
    note: '英文远程岗，需回链；默认关闭',
  },
  {
    id: 'jobui',
    name: '职友集',
    region: '中国',
    available: true,
    enabled: true,
    detail: false,
    note: '公开列表（聚合 BOSS 等），含薪资/年限/学历；详情跳原站',
  },
  {
    id: 'zhaopin',
    name: '智联招聘',
    region: '中国',
    available: false,
    enabled: false,
    blocked: true,
    detail: false,
    reason: '风控：列表页 Security Verification；fe-api 返回 isVerification=1、0 条',
    note: '未接：Security Verification 风控',
  },
  {
    id: '51job',
    name: '前程无忧',
    region: '中国',
    available: false,
    enabled: false,
    blocked: true,
    detail: false,
    reason: '无 SSR；API 需登录 user-token，且被 Aliyun WAF 拦截',
    note: '未接：需登录 + Aliyun WAF',
  },
  {
    id: 'lagou',
    name: '拉勾',
    region: '中国',
    available: false,
    enabled: false,
    blocked: true,
    detail: false,
    reason: 'Aliyun WAF 验证页（captcha），列表页与 positionAjax 均拦截',
    note: '未接：Aliyun WAF 验证',
  },
  {
    id: 'boss',
    name: 'BOSS直聘',
    region: '中国',
    available: isConfigured('boss'),
    enabled: isConfigured('boss'),
    detail: true,
    note: isConfigured('boss') ? '已配置 cookie，按关键词+城市搜' : '需登录 cookie + 大陆出口 IP（境外 IP 会 code 37）',
    auth: 'cookie',
  },
  {
    id: 'maimai',
    name: '脉脉',
    region: '中国',
    available: true,
    enabled: true,
    detail: true,
    note: '公开推荐流（非站内搜索），只覆盖公开岗位；关键词本地命中',
    auth: 'public',
  },
]

const SOURCE_MAP = Object.fromEntries(SOURCES.map((s) => [s.id, s]))

export function publicSources() {
  return SOURCES.filter((s) => {
    if (s.id === 'boss') return isConfigured('boss')
    return true
  }).map((s) => ({
    id: s.id,
    name: s.name,
    region: s.region,
    enabled: s.id === 'boss' ? isConfigured('boss') : Boolean(s.enabled && !s.blocked),
    detail: s.detail,
    blocked: Boolean(s.blocked),
    reason: s.reason || '',
    note:
      s.id === 'boss'
        ? isConfigured('boss')
          ? '已配置 cookie，按关键词+城市搜'
          : '需登录 cookie + 大陆出口 IP（境外 IP 会 code 37）'
        : s.note,
    auth: s.auth || null,
  }))
}

export function unavailableSources() {
  return SOURCES.filter((s) => s.id === 'boss' && !isConfigured('boss')).map((s) => ({
    id: s.id,
    name: s.name,
    note: s.note,
  }))
}

export function defaultSourceIds() {
  return publicSources()
    .filter((s) => s.enabled && !s.blocked)
    .map((s) => s.id)
}

function clean(s) {
  return stripHtml(String(s || '')).replace(/\s+/g, ' ').trim()
}

function splitCards(html, marker) {
  const parts = String(html || '').split(marker)
  return parts.slice(1)
}

function excerpt(s, n = 60) {
  const t = clean(s)
  return t.length > n ? t.slice(0, n) + '…' : t
}

async function fetchRetry(url, opts = {}, attempts = 2) {
  let last
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetchPage(url, opts)
    } catch (e) {
      last = e
      if (!['network', 'timeout'].includes(e?.code) || i === attempts - 1) throw e
      await new Promise((r) => setTimeout(r, 250))
    }
  }
  throw last
}

function header({ title, company, city, salary, extra }) {
  const line = [company, city, salary, extra].filter(Boolean).join(' · ')
  return `${title}${line ? `\n${line}` : ''}`
}

/* ---------------- 猎聘 ---------------- */
function liepinUrl(query, city) {
  const raw = String(query || '').trim()
  // 猎聘对 key 里的 %20 会返回挑战页；中文去空格，英文用 +
  const q = /[\u4e00-\u9fa5]/.test(raw) ? raw.replace(/\s+/g, '') : raw.split(/\s+/).join('+')
  const slug = LIEPIN_CITY[city]
  if (slug) return `https://www.liepin.com/city-${slug}/zhaopin/?key=${encodeURIComponent(q).replace(/%2B/g, '+')}`
  // 全国 SEO 页只认英文/拼音关键词；中文关键词需要城市
  if (/^[a-zA-Z0-9+#.\s/-]{1,40}$/.test(raw)) return `https://www.liepin.com/zhaopin/${encodeURIComponent(raw.trim().toLowerCase())}/`
  return null
}

export function parseLiepinList(html) {
  const out = []
  for (const card of splitCards(html, '<div class="job-list-item"')) {
    const id = (card.match(/data-jobId="(\d+)"/) || [])[1]
    const href = (card.match(/href="(https:\/\/www\.liepin\.com\/a\/\d+\.shtml)"/) || card.match(/href="([^"]+\.shtml)"/) || [])[1]
    const tm = card.match(/class="job-title-box"[^>]*>[\s\S]*?<div[^>]*class="ellipsis-1"[^>]*>([^<]+)</)
    const title = clean(tm?.[1] || '')
    if (!title) continue
    const cityBlock = card.match(/<div class="job-dq-box">([\s\S]*?)<\/div>/)
    const city = clean(cityBlock?.[1] || '').replace(/[【】]/g, '').replace(/\s+/g, ' ').trim()
    const salary = clean((card.match(/class="job-salary"[^>]*>([^<]+)</) || [])[1] || '')
    const company = clean((card.match(/class="company-name[^"]*"[^>]*>([^<]*)</) || [])[1] || '')
    const labels = [...card.matchAll(/class="labels-tag"[^>]*>([^<]+)</g)].map((m) => clean(m[1]))
    const text = header({ title, company, city, salary, extra: labels.join(' / ') })
    out.push({
      source: 'liepin',
      id: id || href || title,
      url: href || '',
      title,
      company,
      city,
      salaryRaw: salary,
      postedAt: '',
      text,
      light: text,
    })
  }
  return out
}

async function liepinSearch(query, city) {
  const url = liepinUrl(query, city)
  if (!url) {
    throw new FetchError('need-city', '猎聘中文关键词需要先填城市')
  }
  const r = await fetchCurl(url, { timeout: 12_000, ua: UA, headers: { Referer: 'https://www.liepin.com/' } })
  const items = parseLiepinList(r.text)
  if (!items.length) throw new FetchError('empty', '猎聘页面没有解析到职位（可能改版或被限流）')
  return items
}

async function liepinDetail(item) {
  if (!item.url) return item
  const key = 'liepin:' + item.url
  const hit = detailCache.get(key)
  if (hit) return { ...item, text: hit, detailCached: true }
  const r = await fetchCurl(item.url, { timeout: 12_000, ua: UA, headers: { Referer: 'https://www.liepin.com/' } })
  const m = r.text.match(/data-selector="job-intro-content"[^>]*>([\s\S]*?)<\/dd>/i)
  const body = stripHtml(m?.[1] || '')
  if (body.length < 40) throw new FetchError('empty', '详情页没取到职位正文')
  const text = `${header({ ...item, salary: item.salaryRaw })}${body ? `\n\n职位描述\n${body}` : ''}`
  detailCache.set(key, text)
  return { ...item, text }
}

/* ---------------- LinkedIn ---------------- */
function linkedinSearchUrl(query, city, start) {
  const params = new URLSearchParams()
  if (query) params.set('keywords', query)
  if (city && !/远程|remote/i.test(city)) params.set('location', `${city}, China`)
  else params.set('location', 'China')
  if (city && /远程|remote/i.test(city)) params.set('f_WT', '2')
  params.set('start', String(start))
  return `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?${params}`
}

export function parseLinkedinList(html) {
  const out = []
  for (const card of splitCards(html, '<li>')) {
    const id = (card.match(/urn:li:jobPosting:(\d+)/) || [])[1]
    const title = clean((card.match(/base-search-card__title[^>]*>([\s\S]*?)<\/h3>/) || [])[1] || '')
    if (!id || !title) continue
    const company = clean((card.match(/base-search-card__subtitle[\s\S]*?>([\s\S]*?)<\/(?:a|h4)>/) || [])[1] || '')
    const location = clean((card.match(/job-search-card__location[^>]*>([\s\S]*?)<\/span>/) || [])[1] || '')
    const postedAt = (card.match(/datetime="([^"]+)"/) || [])[1] || ''
    const href = (card.match(/href="(https:\/\/[^"]*\/jobs\/view\/[^"]+)"/) || [])[1] || ''
    const url = href ? href.split('?')[0] : `https://www.linkedin.com/jobs/view/${id}`
    const city = location.split(',')[0].trim()
    const text = header({ title, company, city: location, extra: postedAt })
    out.push({
      source: 'linkedin',
      id,
      url,
      title,
      company,
      city,
      locationRaw: location,
      salaryRaw: '',
      postedAt,
      text,
      light: text,
    })
  }
  return out
}

let liBlockedUntil = 0
let liBlockReason = ''

async function linkedinSearch(query, city) {
  if (Date.now() < liBlockedUntil) {
    const mins = Math.ceil((liBlockedUntil - Date.now()) / 60000)
    throw new FetchError('cooldown', liBlockReason || `LinkedIn 429 冷却中，约 ${mins} 分钟后再试`)
  }
  const settled = await Promise.allSettled(
    [0, 10].map(async (start) => {
      const r = await fetchPage(linkedinSearchUrl(query, city, start), {
        timeout: 12_000,
        ua: UA,
        headers: { Referer: 'https://www.linkedin.com/jobs/' },
      })
      return parseLinkedinList(r.text)
    }),
  )
  const pages = settled.filter((x) => x.status === 'fulfilled').flatMap((x) => x.value)
  const items = pages
  if (!items.length) {
    const err = settled.find((x) => x.status === 'rejected')?.reason
    if (err?.code === 'http-429') {
      liBlockedUntil = Date.now() + 10 * 60 * 1000
      liBlockReason = 'LinkedIn 429 限流，冷却 10 分钟（期间用其他来源或稍后再搜）'
    }
    throw new FetchError(err?.code || 'empty', err?.message || 'LinkedIn 没有返回职位（可能 429 限流）')
  }
  return items
}

async function linkedinDetail(item) {
  const key = 'linkedin:' + item.id
  const hit = detailCache.get(key)
  if (hit) return { ...item, text: hit, detailCached: true }
  const r = await fetchPage(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${item.id}`, {
    timeout: 12_000,
    ua: UA,
    headers: { Referer: item.url },
  })
  const html = r.text
  const desc = stripHtml(innerByClass(html, 'show-more-less-html__markup'))
  if (desc.length < 80) throw new FetchError('empty', 'LinkedIn 详情正文太短（可能需要登录）')
  const title = clean((html.match(/top-card-layout__title[^>]*>([\s\S]*?)<\/h2>/) || [])[1] || item.title)
  const company = clean((html.match(/topcard__org-name-link[^>]*>([\s\S]*?)<\/a>/) || [])[1] || item.company)
  const location = clean((html.match(/topcard__flavor--bullet[^>]*>([\s\S]*?)<\/span>/) || [])[1] || '')
  const city = location ? location.split(',')[0].trim() : item.city
  const text = `${header({ ...item, title, company, city })}${desc ? `\n\n职位描述\n${desc}` : ''}`
  detailCache.set(key, text)
  return { ...item, title, company, city, locationRaw: location, text }
}

/* ---------------- V2EX 酷工作 ---------------- */
async function v2exSearch(query) {
  const data = await fetchJson('https://www.v2ex.com/api/topics/show.json?node_name=jobs', {
    timeout: 10_000,
    ua: UA,
  })
  if (!Array.isArray(data)) throw new FetchError('empty', 'V2EX 返回格式异常')
  const items = []
  for (const topic of data) {
    if (!topic?.id || !topic.title) continue
    const body = stripHtml(topic.content_rendered || topic.content || '')
    const text = `${topic.title}\n\n${body}`
    items.push({
      source: 'v2ex',
      id: String(topic.id),
      url: topic.url || `https://www.v2ex.com/t/${topic.id}`,
      title: clean(topic.title),
      company: clean(topic.member?.username || ''),
      city: '',
      salaryRaw: '',
      postedAt: topic.created ? new Date(topic.created * 1000).toISOString() : '',
      text,
      light: text.slice(0, 1200),
    })
  }
  if (!items.length) throw new FetchError('empty', 'V2EX 酷工作当前没有帖子')
  return items
}

/* ---------------- 电鸭社区 ---------------- */
async function eleduckSearch(query) {
  const data = await fetchJson('https://svc.eleduck.com/api/v1/posts?category=5&page=1&page_size=30', {
    timeout: 10_000,
    ua: UA,
  })
  const posts = Array.isArray(data?.posts) ? data.posts : []
  const items = []
  for (const p of posts) {
    if (!p?.id || !p.title || p.deleted || p.closed) continue
    const tags = (p.tags || []).map((t) => t.name).filter(Boolean)
    const remote = /远程|线上|兼职|外包/.test(`${p.title} ${tags.join(' ')}`)
    const text = header({ title: p.title, city: remote ? '远程' : '', extra: tags.join(' / ') }) + `\n\n${clean(p.summary || '')}`
    items.push({
      source: 'eleduck',
      id: p.id,
      url: `https://eleduck.com/posts/${p.id}`,
      title: clean(p.title),
      company: '',
      city: remote ? '远程' : '',
      salaryRaw: '',
      postedAt: p.published_at || '',
      text,
      light: text,
      tags,
    })
  }
  if (!items.length) throw new FetchError('empty', '电鸭没有返回帖子')
  return items
}

async function eleduckDetail(item) {
  const key = 'eleduck:' + item.id
  const hit = detailCache.get(key)
  if (hit) return { ...item, text: hit, detailCached: true }
  const data = await fetchJson(`https://svc.eleduck.com/api/v1/posts/${encodeURIComponent(item.id)}`, {
    timeout: 10_000,
    ua: UA,
  })
  const p = data?.post
  const body = clean(p?.raw_content || '')
  if (body.length < 30) throw new FetchError('empty', '电鸭详情正文太短')
  const text = `${header(item)}\n\n${body}`
  detailCache.set(key, text)
  return { ...item, text }
}

/* ---------------- Remote OK ---------------- */
async function remoteokSearch(query) {
  const data = await fetchJson('https://remoteok.com/api', { timeout: 15_000, ua: UA })
  const rows = Array.isArray(data) ? data.filter((x) => x && x.id && x.position) : []
  const items = rows.slice(0, 100).map((j) => {
    const body = stripHtml(j.description || '')
    const title = clean(j.position)
    const company = clean(j.company)
    const text = `${header({ title, company, city: '远程', extra: j.location || '' })}\n\n${body}`
    return {
      source: 'remoteok',
      id: String(j.id),
      url: j.url || `https://remoteok.com/remote-jobs/${j.id}`,
      title,
      company,
      city: '远程',
      salaryRaw: '',
      postedAt: j.date || '',
      text,
      light: text.slice(0, 1500),
      tags: j.tags || [],
    }
  })
  if (!items.length) throw new FetchError('empty', 'Remote OK 没有返回职位')
  return items
}

/* ---------------- 职友集（公开 RSS，无详情正文） ---------------- */
function jobuiSalary(raw) {
  const s = clean(raw).replace(/^工资待遇：/, '')
  let m = s.match(/(\d+(?:\.\d+)?)\s*[-~—–]\s*(\d+(?:\.\d+)?)\s*万/)
  if (m) return `${Math.round(Number(m[1]) * 10)}-${Math.round(Number(m[2]) * 10)}K`
  m = s.match(/^(\d{4,6})\s*[-~—–]\s*(\d{4,6})$/)
  if (m) return `${Math.round(Number(m[1]) / 1000)}-${Math.round(Number(m[2]) / 1000)}K`
  return s
}

/** 解析职友集 RSS；description 里带公司/年限/薪资/学历/地区/工作简介 */
export function parseJobuiRss(xml) {
  const out = []
  for (const item of String(xml || '').matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const raw = item[1]
    const titleRaw = clean((raw.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) || raw.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '')
    if (!titleRaw) continue
    const link = ((raw.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '').trim()
    const id = (link.match(/\/job\/(\d+)/) || [])[1] || link
    const sep = titleRaw.lastIndexOf(' - ')
    const title = (sep > 0 ? titleRaw.slice(0, sep) : titleRaw).trim()
    const company = (sep > 0 ? titleRaw.slice(sep + 3) : '').trim()
    const descHtml = (raw.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/) || [])[1] || ''
    const desc = stripHtml(descHtml)
    const city = (desc.match(/工作地区：([^\n]+)/) || [])[1]?.trim() || ''
    const salary = jobuiSalary((desc.match(/工资待遇：([^|\n]+)/) || [])[1]?.trim() || '')
    const exp = (desc.match(/工作经验：([^|\n]+)/) || [])[1]?.trim() || ''
    const edu = (desc.match(/学历要求：([^\n]+)/) || [])[1]?.trim() || ''
    const posted = (desc.match(/发布时间：([^\n]+)/) || [])[1]?.trim() || ''
    const intro = (desc.match(/工作简介：([\s\S]*?)(?:查看详情|$)/) || [])[1]?.trim() || ''
    const text = header({
      title,
      company,
      city,
      salary,
      extra: [exp, edu].filter(Boolean).join(' / '),
    }) + (intro ? `\n\n工作简介\n${intro}` : '')
    out.push({
      source: 'jobui',
      id: String(id),
      url: link ? link.replace('//job/', '/job/').replace(/\?refer=rss$/, '') : '',
      title,
      company,
      city,
      salaryRaw: salary,
      postedAt: posted,
      text,
      light: text,
    })
  }
  return out
}

async function jobuiSearch(query, city) {
  const q = String(query || '').replace(/\s+/g, '')
  const c = String(city || '').replace(/市$/, '').replace(/\s+/g, '')
  let inner = `jobKw@${encodeURIComponent(q)}`
  if (c && !/远程|remote/i.test(c)) inner += `|cityKw@${encodeURIComponent(c)}`
  const url = `https://www.jobui.com/rss/job/?rss=${encodeURIComponent(inner)}`
  const r = await fetchCurl(url, { timeout: 5_000, ua: UA, headers: { Referer: 'https://www.jobui.com/jobs' } })
  const items = parseJobuiRss(r.text)
  if (!items.length) throw new FetchError('empty', '职友集 RSS 没有解析到职位（可能改版或被限流）')
  return items
}

/* ---------------- BOSS 直聘（需要 cookie） ---------------- */
const BOSS_CITY = {
  北京: '101010100', 上海: '101020100', 广州: '101280100', 深圳: '101280600',
  杭州: '101210100', 成都: '101270100', 南京: '101190100', 武汉: '101200100',
  西安: '101110100', 苏州: '101190400', 天津: '101030100', 重庆: '101040100',
  长沙: '101250100', 郑州: '101180100', 合肥: '101220100', 厦门: '101230200',
  福州: '101230100', 济南: '101120100', 青岛: '101120200', 大连: '101070200',
  沈阳: '101070100', 无锡: '101190200', 宁波: '101210400', 东莞: '101281600',
  佛山: '101280800', 珠海: '101280700', 中山: '101281700', 惠州: '101280300',
  香港: '101320100',
}
const BOSS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** 大陆出口：BOSS 对境外 IP 一律 code 37；配了代理就走代理（curl -x） */
function bossProxy() {
  return String(process.env.JD_BOSS_PROXY || '').trim()
}

function bossRiskHint() {
  return (
    process.env.JD_EGRESS_HINT ||
    'cookie 失效，或出口 IP 与登录地不一致（服务器在香港/境外时 BOSS 会直接判「环境异常」）'
  )
}

function bossHeaders(auth, referer) {
  return {
    Cookie: auth.cookie,
    Referer: referer,
    Origin: 'https://www.zhipin.com',
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
  }
}

export function parseBossList(data) {
  const list = data?.zpData?.jobList
  if (!Array.isArray(list)) return []
  const out = []
  for (const j of list) {
    if (!j?.jobName) continue
    const city = [j.cityName, j.areaDistrict, j.businessDistrict].filter(Boolean).join(' ')
    const text = header({
      title: j.jobName,
      company: j.brandName || j.bossName || '',
      city,
      salary: j.salaryDesc || '',
      extra: [j.jobExperience, j.jobDegree, ...(j.jobLabels || []), ...(j.skills || [])].filter(Boolean).join(' / '),
    })
    out.push({
      source: 'boss',
      id: j.encryptJobId || j.securityId || j.jobName,
      url: j.encryptJobId
        ? `https://www.zhipin.com/job_detail/${j.encryptJobId}.html?lid=${encodeURIComponent(j.lid || '')}&securityId=${encodeURIComponent(j.securityId || '')}`
        : '',
      title: clean(j.jobName),
      company: clean(j.brandName || j.bossName || ''),
      city: clean(j.cityName || ''),
      salaryRaw: clean(j.salaryDesc || ''),
      postedAt: '',
      text,
      light: text,
      securityId: j.securityId || '',
      lid: j.lid || '',
      encryptJobId: j.encryptJobId || '',
      skills: j.skills || [],
      welfare: j.welfareList || [],
      industry: j.brandIndustry || '',
    })
  }
  return out
}

async function bossFetch(url, auth, referer, { timeout = 15_000, json = true } = {}) {
  const accept = json
    ? 'application/json, text/plain, */*'
    : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
  const headers = { ...bossHeaders(auth, referer), Accept: accept }
  const opts = {
    timeout,
    ua: auth.ua || BOSS_UA,
    headers,
  }
  const proxy = bossProxy()
  if (proxy) return fetchCurl(url, { ...opts, proxy })
  // 没有显式 BOSS 代理时，优先走大陆出口（新 SSH 隧道 / unix bridge）
  const exit = exitTarget()
  if (exit) {
    try {
      const r = await requestViaProxy(exit, url, { timeoutMs: timeout, headers, accept, ua: auth.ua || BOSS_UA })
      if (r.status < 200 || r.status >= 300) throw new FetchError('http-' + r.status, `HTTP ${r.status}`)
      return { status: r.status, url: r.url, headers: new Headers(), text: r.body }
    } catch (e) {
      if (e instanceof FetchError) throw e
      throw new FetchError(e?.code || 'network', e?.message || '出口请求失败')
    }
  }
  return fetchPage(url, opts)
}

async function bossSearch(query, city) {
  const auth = getAuth('boss')
  if (!auth?.cookie) throw new FetchError('no-cookie', 'BOSS 需要先在「来源登录」配置 cookie')
  const cityName = String(city || '').replace(/市$/, '')
  const cityCode = BOSS_CITY[cityName] || '100010000'
  const url = `https://www.zhipin.com/wapi/zpgeek/search/joblist.json?scene=1&query=${encodeURIComponent(
    String(query || '').trim(),
  )}&city=${cityCode}&page=1&pageSize=30`
  const referer = `https://www.zhipin.com/web/geek/job?query=${encodeURIComponent(String(query || ''))}&city=${cityCode}`
  try {
    const r = await bossFetch(url, auth, referer)
    let data
    try {
      data = JSON.parse(r.text)
    } catch {
      throw new FetchError('html', 'BOSS 返回了登录/验证页（不是 JSON），cookie 可能失效')
    }
    if (Number(data?.code) !== 0) {
      const msg = String(data?.message || '')
      if (Number(data.code) === 37) {
        throw new FetchError('risk', `BOSS 返回 code 37（环境异常）：${bossRiskHint()}`)
      }
      throw new FetchError('api', `BOSS 接口返回 code ${data?.code}${msg ? `：${msg}` : ''}`)
    }
    const items = parseBossList(data)
    if (!items.length) throw new FetchError('empty', 'BOSS 没有返回职位（可能关键词太窄或被风控）')
    markResult('boss', true)
    return items
  } catch (e) {
    markResult('boss', false, e?.message || 'failed')
    throw e
  }
}

/**
 * BOSS 体检：拿当前（或传入的）cookie 真打一次搜索接口，把病因分清楚。
 * 不改状态、不落盘，给「来源登录」里的体检按钮用。
 */
export async function bossCheck({ cookie, ua } = {}) {
  const stored = getAuth('boss') || {}
  const auth = { cookie: String(cookie || stored.cookie || '').trim(), ua: String(ua || stored.ua || '').trim() }
  const started = Date.now()
  const base = { proxy: Boolean(bossProxy()), exit: Boolean(exitTarget()), ms: 0 }
  if (!auth.cookie) {
    return { ok: false, code: 'no-cookie', message: '还没有 BOSS cookie：先在浏览器登录 www.zhipin.com，复制整串 Cookie', ...base, ms: Date.now() - started }
  }
  const referer = 'https://www.zhipin.com/web/geek/job?query=%E5%90%8E%E7%AB%AF&city=101010100'
  const url = 'https://www.zhipin.com/wapi/zpgeek/search/joblist.json?scene=1&query=%E5%90%8E%E7%AB%AF&city=101010100&page=1&pageSize=5'
  try {
    const r = await bossFetch(url, auth, referer, { timeout: 12_000 })
    let data = null
    try {
      data = JSON.parse(r.text)
    } catch {
      /* 不是 JSON 就是验证页 */
    }
    const ms = Date.now() - started
    if (!data) {
      return { ok: false, code: 'html', message: 'BOSS 返回了网页而不是接口数据：cookie 失效或被验证页拦住', ...base, ms }
    }
    const code = Number(data?.code)
    if (code === 0) {
      const jobs = parseBossList(data).length
      return { ok: true, code: 'ok', message: `BOSS 接口正常，样例返回 ${jobs} 条`, jobs, ...base, ms }
    }
    if (code === 37) {
      return { ok: false, code: 'risk', message: `code 37：${bossRiskHint()}`, ...base, ms }
    }
    return { ok: false, code: 'api', message: `BOSS 返回 code ${data?.code}${data?.message ? `：${data.message}` : ''}`, ...base, ms }
  } catch (e) {
    return { ok: false, code: e?.code || 'error', message: e?.message || String(e), ...base, ms: Date.now() - started }
  }
}

async function bossDetail(item) {
  const auth = getAuth('boss')
  if (!auth?.cookie || !item.encryptJobId) return item
  const key = 'boss:' + item.encryptJobId
  const hit = detailCache.get(key)
  if (hit) return { ...item, text: hit, detailCached: true }
  const url = `https://www.zhipin.com/job_detail/${item.encryptJobId}.html?lid=${encodeURIComponent(item.lid || '')}&securityId=${encodeURIComponent(item.securityId || '')}`
  const r = await bossFetch(url, auth, 'https://www.zhipin.com/web/geek/job', { json: false })
  let body = ''
  for (const m of r.text.matchAll(/<div[^>]*class="[^"]*job-sec-text[^"]*"[^>]*>([\s\S]*?)<\/div>/gi)) {
    const t = stripHtml(m[1])
    if (t) body += `${t}\n`
  }
  if (body.length < 50) {
    const sec = innerByClass(r.text, 'job-detail-section')
    if (sec) body = stripHtml(sec)
  }
  if (body.length < 50) throw new FetchError('empty', 'BOSS 详情页没取到正文（可能需要重新登录）')
  const text = `${header({ ...item, salary: item.salaryRaw })}${item.industry ? ` · ${item.industry}` : ''}\n\n职位描述\n${body.slice(0, 12000)}`
  detailCache.set(key, text)
  return { ...item, text }
}

/* ---------------- 脉脉（公开岗位页） ---------------- */
const MAIMAI_DIRECTIONS = [
  [/人工智能|大模型|算法|机器学习|深度学习|llm|agent|rag|aigc|ai\b/i, 'ai'],
  [/产品|pm\b/i, 'product'],
  [/运营/i, 'operations'],
  [/设计|ui\b|ux\b/i, 'design'],
  [/市场|销售|商务/i, 'market'],
  [/芯片|半导体/i, 'chip'],
  [/生物|医药|医疗/i, 'bio'],
  [/智能制造|制造/i, 'manufacture'],
  [/前端|后端|全栈|开发|研发|工程师|架构|python|java|golang|go\b|rust|c\+\+/i, 'development'],
]

function maimaiDirection(query) {
  for (const [re, val] of MAIMAI_DIRECTIONS) if (re.test(String(query || ''))) return val
  return ''
}

export function parseMaimaiListing(html) {
  const m = String(html || '').match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)
  if (!m) return null
  try {
    const data = JSON.parse(m[1])
    return data?.props?.pageProps?.listing || null
  } catch {
    return null
  }
}

function maimaiItem(j) {
  const text = header({
    title: j.title,
    company: j.companyName || '',
    city: j.city || j.locationText || '',
    salary: j.salaryText || '',
    extra: [j.experienceText, j.educationText, ...(j.tags || [])].filter(Boolean).join(' / '),
  })
  return {
    source: 'maimai',
    id: j.id,
    url: j.detailUrl ? new URL(j.detailUrl, 'https://maimai.cn').toString() : '',
    title: clean(j.title),
    company: clean(j.companyName || ''),
    city: clean(j.city || ''),
    salaryRaw: clean(j.salaryText || ''),
    postedAt: '',
    text,
    light: text,
    tags: j.tags || [],
  }
}

const MAIMAI_MAX_PAGES = 6
const MAIMAI_TARGET_HITS = 8
const MAIMAI_LOOSE_MAX = 6
const ROLE_SUFFIX = /(工程师|开发|专家|经理|架构师|研究员|总监|实习生|实习|主管|岗位|职位|方向|岗)$/

/**
 * 关键词切分：整串 + 空格/标点切分 + 去掉「工程师/开发/专家…」后缀的词根。
 * 脉脉公开页只有推荐流、没有站内搜索，只能靠这层本地匹配；
 * 既不切词的话「后端开发」会一条都命中不了（标题里写的是「后端工程师」）。
 */
export function keywordTokens(query) {
  const raw = String(query || '').trim().toLowerCase()
  if (!raw) return []
  const out = new Set([raw])
  for (const part of raw.split(/[\s,，、/|+·\-—–_()（）[\]【】]+/)) {
    const p = part.trim()
    if (p.length < 2) continue
    out.add(p)
    const stem = p.replace(ROLE_SUFFIX, '').trim()
    if (stem.length >= 2) out.add(stem)
  }
  return [...out]
}

const TOKEN_ALIAS = { go: ['golang'], js: ['javascript'], ts: ['typescript'], k8s: ['kubernetes'], vue: ['vue.js'] }

function tokenHit(text, token) {
  if (/^[a-z0-9+#.]+$/i.test(token)) {
    // 英文/技术词按词边界，避免 ai 命中 domain、go 命中 google
    for (const word of [token, ...(TOKEN_ALIAS[token] || [])]) {
      const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      if (new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, 'i').test(text)) return true
    }
    return false
  }
  return text.includes(token)
}

export function keywordHit(text, query) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return true
  const t = String(text || '').toLowerCase()
  // 纯英文/技术词走词边界，避免 go 命中 google、ai 命中 domain
  const asciiOnly = /^[a-z0-9+#. ]+$/.test(q)
  if (!asciiOnly && t.includes(q)) return true
  return keywordTokens(q).some((tok) => tokenHit(t, tok))
}

async function maimaiSearch(query, city) {
  const direction = maimaiDirection(query)
  const items = []
  const seen = new Set()
  let scanned = 0
  let pages = 0
  let hits = 0
  for (let page = 1; page <= MAIMAI_MAX_PAGES; page++) {
    const params = new URLSearchParams({ page: String(page) })
    if (direction) params.set('direction', direction)
    if (city && !/远程|remote/i.test(city)) params.set('city', String(city).replace(/市$/, ''))
    const r = await fetchRetry(`https://maimai.cn/n/platform/job-list?${params}`, {
      timeout: 2_500,
      ua: UA,
      headers: { Referer: 'https://maimai.cn/n/platform/job-list' },
    })
    pages = page
    const listing = parseMaimaiListing(r.text)
    if (!listing?.items?.length) break
    for (const j of listing.items) {
      if (!j?.id || !j.title || seen.has(j.id)) continue
      seen.add(j.id)
      items.push(maimaiItem(j))
      scanned++
    }
    hits = items.filter((it) => keywordHit(it.text, query)).length
    if (hits >= MAIMAI_TARGET_HITS) break
  }
  const exact = items.filter((it) => keywordHit(it.text, query))
  if (!exact.length) {
    throw new FetchError(
      'no-match',
      `脉脉公开页是推荐流、没有站内搜索：扫了 ${scanned} 条 / ${pages} 页，没命中「${query}」。普通岗位建议用猎聘或职友集`,
    )
  }
  // 命中太少时补几条同方向公开岗位，明确标 loose，避免看起来像「脉脉没结果」
  const loose = []
  if (exact.length < 3) {
    for (const it of items) {
      if (loose.length >= MAIMAI_LOOSE_MAX) break
      if (keywordHit(it.text, query)) continue
      loose.push({ ...it, loose: true })
    }
  }
  const out = [...exact, ...loose].slice(0, 30)
  if (loose.length) {
    out.note = `脉脉只给公开推荐流：关键词命中 ${exact.length} 条，另附 ${loose.length} 条同方向岗位（标「脉脉推荐」）`
  }
  return out
}

async function maimaiDetail(item) {
  if (!item.url) return item
  const key = 'maimai:' + item.id
  const hit = detailCache.get(key)
  if (hit) return { ...item, text: hit, detailCached: true }
  const r = await fetchPage(item.url, {
    timeout: 12_000,
    ua: UA,
    headers: { Referer: 'https://maimai.cn/n/platform/job-list' },
  })
  let job = null
  for (const m of r.text.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(m[1])
      const list = Array.isArray(parsed) ? parsed : parsed['@graph'] || [parsed]
      job = list.find((x) => String(x?.['@type'] || '').includes('JobPosting')) || job
    } catch {
      /* 跳过坏 JSON */
    }
  }
  if (!job) throw new FetchError('empty', '脉脉详情页没取到 JSON-LD')
  const desc = stripHtml(job.description || '')
  if (desc.length < 30) throw new FetchError('empty', '脉脉详情正文太短')
  const title = clean(job.title || item.title)
  const company = clean(job.hiringOrganization?.name || item.company)
  const city = clean(job.jobLocation?.address?.addressLocality || item.city)
  const text = `${header({ ...item, title, company, city, salary: item.salaryRaw })}${job.datePosted ? ` · ${job.datePosted}` : ''}\n\n职位描述\n${desc.slice(0, 12000)}`
  detailCache.set(key, text)
  return { ...item, text, title, company, city }
}

const ADAPTERS = {
  liepin: { search: liepinSearch, detail: liepinDetail },
  linkedin: { search: linkedinSearch, detail: linkedinDetail },
  v2ex: { search: v2exSearch, detail: null },
  eleduck: { search: eleduckSearch, detail: eleduckDetail },
  remoteok: { search: remoteokSearch, detail: null },
  jobui: { search: jobuiSearch, detail: null },
  boss: { search: bossSearch, detail: bossDetail },
  maimai: { search: maimaiSearch, detail: maimaiDetail },
}

function cacheKey(source, query, city) {
  return `${source}|${String(query || '').trim().toLowerCase()}|${String(city || '').trim()}`
}

/** 并行抓多个源的列表；单源失败不影响其他源 */
export async function collect({ query, city = '', sources }) {
  const ids = (sources?.length ? sources : defaultSourceIds()).filter((id) => ADAPTERS[id])
  const started = Date.now()
  const diagnostics = await mapLimit(ids, 4, async (id) => {
    const meta = SOURCE_MAP[id]
    const t0 = Date.now()
    const key = cacheKey(id, query, city)
    try {
      const cached = listCache.get(key)
      if (cached) {
        return { id, name: meta.name, count: cached.length, ms: Date.now() - t0, cached: true, error: null }
      }
      const items = await ADAPTERS[id].search(query, city)
      const note = typeof items?.note === 'string' ? items.note : ''
      const seen = new Set()
      const unique = items.filter((it) => {
        const k = `${it.id}`
        if (seen.has(k)) return false
        seen.add(k)
        return true
      })
      listCache.set(key, unique, ['linkedin', 'maimai', 'jobui', 'zhaopin', '51job', 'lagou'].includes(id) ? 30 * 60 * 1000 : undefined)
      return { id, name: meta.name, count: unique.length, ms: Date.now() - t0, cached: false, error: null, note }
    } catch (e) {
      return {
        id,
        name: meta.name,
        count: 0,
        ms: Date.now() - t0,
        cached: false,
        error: e instanceof FetchError ? e.code : 'error',
        message: e?.message || String(e),
      }
    }
  })

  const lists = await Promise.all(
    ids.map(async (id) => {
      const items = listCache.get(cacheKey(id, query, city)) || []
      return { source: id, items }
    }),
  )
  const items = lists.flatMap((l) => l.items.map((it) => ({ ...it, source: l.source })))
  const diag = diagnostics.map((d) => ({ ...d, elapsedMs: d.ms }))
  return { items, diagnostics: diag, elapsedMs: Date.now() - started }
}

/** 给挑中的条目补详情正文；detail 失败保留列表摘要 */
export async function hydrate(items, { limit = 24, concurrency = 5 } = {}) {
  const picked = items.slice(0, limit)
  const results = await mapLimit(picked, concurrency, async (item) => {
    const adapter = ADAPTERS[item.source]?.detail
    if (!adapter) return { ...item, detail: 'list' }
    try {
      const full = await adapter(item)
      return { ...full, detail: 'ok' }
    } catch (e) {
      return { ...item, detailError: e instanceof FetchError ? e.code : 'error', detail: 'fallback' }
    }
  })
  return results
}

/* ---------------- 单条 URL 导入 ---------------- */
export async function fetchJdFromUrl(rawUrl) {
  const url = String(rawUrl || '').trim()
  if (!/^https?:\/\//i.test(url)) throw new FetchError('bad-url', '请输入以 http(s):// 开头的链接')

  // LinkedIn 职位页 → 走 guest 详情接口，避开登录墙
  const li = url.match(/linkedin\.com\/jobs\/view\/(?:[^/?#]*-)?(\d{6,})/)
  if (li) {
    const item = { id: li[1], source: 'linkedin', url, title: '', company: '', city: '', postedAt: '' }
    const full = await linkedinDetail(item)
    if (full.text.length < 80) throw new FetchError('empty', '这个 LinkedIn 职位页需要登录，换一个公开链接试试')
    return { url, title: full.title, text: full.text, source: 'linkedin' }
  }

  // 猎聘详情页 → 直接抽 job-intro-content
  const lp = url.match(/liepin\.com\/a\/(\d+)\.shtml/)
  if (lp) {
    const r = await fetchCurl(url, { timeout: 12_000, ua: UA })
    const m = r.text.match(/data-selector="job-intro-content"[^>]*>([\s\S]*?)<\/dd>/i)
    const body = stripHtml(m?.[1] || '')
    if (body.length < 40) throw new FetchError('empty', '猎聘详情页没取到正文')
    const rawTitle = pageTitle(r.text)
    const tm = rawTitle.match(/^【(.+?)招聘】/)
    let title = (tm ? tm[1] : rawTitle).trim()
    title = title.replace(/^[\u4e00-\u9fa5]{2,6}\s+(?=[A-Za-z])/, '').replace(/招聘$/, '').trim()
    return { url, title, text: `${title}\n\n${body}`, source: 'liepin' }
  }

  const r = await fetchPage(url, { timeout: 12_000, ua: UA })
  const text = pageText(r.text)
  if (text.length < 80) throw new FetchError('empty', '页面正文太短，可能需要登录或用 JS 渲染；请直接粘贴 JD')
  return { url, title: pageTitle(r.text), text, source: 'url' }
}
