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
    id: 'boss',
    name: 'BOSS直聘',
    region: '中国',
    available: false,
    enabled: false,
    detail: false,
    note: '未接：接口返回 code 37（环境异常），需登录态',
  },
  {
    id: 'maimai',
    name: '脉脉',
    region: '中国',
    available: false,
    enabled: false,
    detail: false,
    note: '未接：职位搜索需登录',
  },
]

const SOURCE_MAP = Object.fromEntries(SOURCES.map((s) => [s.id, s]))

export function publicSources() {
  return SOURCES.filter((s) => s.available).map((s) => ({
    id: s.id,
    name: s.name,
    region: s.region,
    enabled: s.enabled,
    detail: s.detail,
    note: s.note,
  }))
}

export function unavailableSources() {
  return SOURCES.filter((s) => !s.available).map((s) => ({ id: s.id, name: s.name, note: s.note }))
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

const ADAPTERS = {
  liepin: { search: liepinSearch, detail: liepinDetail },
  linkedin: { search: linkedinSearch, detail: linkedinDetail },
  v2ex: { search: v2exSearch, detail: null },
  eleduck: { search: eleduckSearch, detail: eleduckDetail },
  remoteok: { search: remoteokSearch, detail: null },
}

function cacheKey(source, query, city) {
  return `${source}|${String(query || '').trim().toLowerCase()}|${String(city || '').trim()}`
}

/** 并行抓多个源的列表；单源失败不影响其他源 */
export async function collect({ query, city = '', sources }) {
  const ids = (sources?.length ? sources : SOURCES.filter((s) => s.enabled).map((s) => s.id)).filter((id) => ADAPTERS[id])
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
      const seen = new Set()
      const unique = items.filter((it) => {
        const k = `${it.id}`
        if (seen.has(k)) return false
        seen.add(k)
        return true
      })
      listCache.set(key, unique, id === 'linkedin' ? 30 * 60 * 1000 : undefined)
      return { id, name: meta.name, count: unique.length, ms: Date.now() - t0, cached: false, error: null }
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
