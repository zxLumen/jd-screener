/**
 * 对位 · AI 智能筛选 JD
 * 零依赖 Node 原生 http：同时发静态页与 /api。
 */
import http from 'node:http'
import crypto from 'node:crypto'
import path from 'node:path'
import { promises as fs, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseJD, parseProfile } from './lib/parse.js'
import { scoreOne } from './lib/score.js'
import { skillName } from './lib/skills.js'
import * as llm from './lib/llm.js'
import { collect, hydrate, publicSources, unavailableSources, fetchJdFromUrl, SOURCES } from './lib/sources.js'
import { extractResume, guessTitle, guessSalary, ResumeError, MAX_RESUME_BYTES } from './lib/resume.js'
import { FetchError } from './lib/http.js'
import { initAuth, allAuthStatus, saveAuth, clearAuth } from './lib/auth.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WEB_DIR = path.join(__dirname, 'web')
const DATA_DIR = path.join(__dirname, 'data')
const STATS_FILE = path.join(DATA_DIR, 'stats.json')
const VERSION = '0.2.2'
const PORT = Number(process.env.PORT) || 8790
const MAX_JDS = 8
const MAX_JD_CHARS = 20000
const MAX_BODY = 512 * 1024
const MAX_UPLOAD = Math.ceil(MAX_RESUME_BYTES * 1.4)
const AI_RATE = Number(process.env.JD_AI_RATE) || 20
const TOTAL_RATE = Number(process.env.JD_TOTAL_RATE) || 240
const AI_DAILY = Number(process.env.JD_AI_DAILY) || 500
const SEARCH_RATE = Number(process.env.JD_SEARCH_RATE) || 30
const SEARCH_DAILY = Number(process.env.JD_SEARCH_DAILY) || 300
const RESUME_RATE = Number(process.env.JD_RESUME_RATE) || 20
const MAX_SEARCH = 20
const MAX_SEARCH_CANDIDATES = 24
const MAX_RESULT_CHARS = 6000

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
}

const CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'self' https://zxlumen.cn https://*.zxlumen.cn",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ')

// ---------------- 匿名统计（不存画像/JD/IP） ----------------
const stats = {
  since: new Date().toISOString(),
  screens: 0,
  jds: 0,
  searches: 0,
  searchOk: 0,
  searchEmpty: 0,
  resumes: 0,
  imports: 0,
  resumeKinds: {},
  sourceHits: {},
  aiOk: 0,
  aiFail: 0,
  aiCached: 0,
  aiSkipped: 0,
  verdicts: { strong: 0, ok: 0, maybe: 0, no: 0 },
  tokens: { prompt: 0, completion: 0 },
  lastAt: null,
}
let persistTimer = null

async function loadStats() {
  try {
    const raw = JSON.parse(await fs.readFile(STATS_FILE, 'utf8'))
    Object.assign(stats, raw)
    stats.verdicts = { ...stats.verdicts, ...(raw.verdicts || {}) }
    stats.tokens = { ...stats.tokens, ...(raw.tokens || {}) }
    stats.resumeKinds = { ...stats.resumeKinds, ...(raw.resumeKinds || {}) }
    stats.sourceHits = { ...stats.sourceHits, ...(raw.sourceHits || {}) }
  } catch {
    /* 首次运行没有统计文件 */
  }
}

function persistStats() {
  if (persistTimer) return
  persistTimer = setTimeout(async () => {
    persistTimer = null
    try {
      await fs.mkdir(DATA_DIR, { recursive: true })
      const tmp = `${STATS_FILE}.tmp`
      await fs.writeFile(tmp, JSON.stringify(stats))
      await fs.rename(tmp, STATS_FILE)
    } catch (e) {
      console.warn('[jd] 统计落盘失败:', e?.message || e)
    }
  }, 2000)
  persistTimer.unref?.()
}

// ---------------- 限流（按 IP 滑动窗口） ----------------
const buckets = new Map()
function allow(ip, kind, limit, windowMs) {
  const key = `${ip}:${kind}`
  const now = Date.now()
  let b = buckets.get(key)
  if (!b || b.reset <= now) {
    b = { count: 0, reset: now + windowMs }
    buckets.set(key, b)
  }
  if (b.count >= limit) return false
  b.count++
  return true
}
setInterval(() => {
  const now = Date.now()
  for (const [k, b] of buckets) if (b.reset <= now) buckets.delete(k)
}, 10 * 60 * 1000).unref?.()

// 全站 AI 日限额（北京时间日切），防止公网被刷爆 token
function bjDay() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}
let aiDay = { day: bjDay(), count: 0 }
function allowGlobalAI() {
  const d = bjDay()
  if (aiDay.day !== d) aiDay = { day: d, count: 0 }
  if (aiDay.count >= AI_DAILY) return false
  aiDay.count++
  return true
}

// 搜索会真的去抓外部站点，单独限日额度，防止被刷成代理
let searchDay = { day: bjDay(), count: 0 }
function allowGlobalSearch() {
  const d = bjDay()
  if (searchDay.day !== d) searchDay = { day: d, count: 0 }
  if (searchDay.count >= SEARCH_DAILY) return false
  searchDay.count++
  return true
}

function clientIp(req) {
  const xff = req.headers['x-forwarded-for']
  if (typeof xff === 'string' && xff) return xff.split(',')[0].trim()
  return req.socket.remoteAddress || 'unknown'
}

// ---------------- HTTP 小工具 ----------------
function baseHeaders(extra = {}) {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy': CSP,
    ...extra,
  }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(
    status,
    baseHeaders({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body),
    }),
  )
  res.end(body)
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, baseHeaders({ 'Content-Type': type, 'Cache-Control': 'no-store' }))
  res.end(text)
}

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function readJson(req, max = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    let done = false
    req.on('data', (c) => {
      if (done) return
      size += c.length
      if (size > max) {
        done = true
        req.resume()
        reject(new HttpError(413, `请求体太大（上限 ${Math.round(max / 1024 / 1024)}MB）`))
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (done) return
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text ? JSON.parse(text) : {})
      } catch {
        reject(new HttpError(400, 'JSON 格式不对'))
      }
    })
    req.on('error', (e) => {
      if (!done) reject(e)
    })
  })
}

async function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname
  let filePath
  try {
    filePath = path.resolve(WEB_DIR, `.${decodeURIComponent(rel)}`)
  } catch {
    return sendText(res, 400, 'bad path')
  }
  if (filePath !== WEB_DIR && !filePath.startsWith(WEB_DIR + path.sep)) {
    return sendText(res, 404, 'not found')
  }
  try {
    const st = await fs.stat(filePath)
    if (!st.isFile()) throw new Error('not file')
    const ext = path.extname(filePath).toLowerCase()
    const body = await fs.readFile(filePath)
    const isHtml = ext === '.html'
    res.writeHead(
      200,
      baseHeaders({
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=300',
        'Content-Length': body.length,
      }),
    )
    res.end(body)
  } catch {
    sendText(res, 404, 'not found')
  }
}

// ---------------- 管理接口鉴权 ----------------
const ADMIN_TOKEN = (process.env.JD_ADMIN_TOKEN || '').trim()

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''))
  const y = Buffer.from(String(b || ''))
  if (!x.length || x.length !== y.length) return false
  return crypto.timingSafeEqual(x, y)
}

function requireAdmin(req, ip) {
  if (!ADMIN_TOKEN) throw new HttpError(503, '服务端未配置 JD_ADMIN_TOKEN，来源登录不可用')
  if (!allow(ip, 'admin', 30, 60 * 1000)) throw new HttpError(429, '尝试太频繁')
  const header = String(req.headers['x-admin-token'] || '')
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  if (!safeEqual(header || bearer, ADMIN_TOKEN)) throw new HttpError(401, '管理令牌不对')
}

// ---------------- 业务 ----------------
function validateProfile(input) {
  if (!input || typeof input !== 'object') throw new HttpError(400, '缺少候选人画像')
  const p = parseProfile(input)
  if (p.resumeText && p.resumeText.length > 12000) throw new HttpError(400, '简历摘要最多 12000 字')
  return p
}

function validateJd(text) {
  if (typeof text !== 'string') throw new HttpError(400, 'JD 必须是文本')
  const t = text.trim()
  if (t.length < 20) throw new HttpError(400, '单条 JD 至少 20 字')
  if (t.length > MAX_JD_CHARS) throw new HttpError(400, `单条 JD 最多 ${MAX_JD_CHARS} 字`)
  return t
}

async function runOne(profile, jdText, ip, useAI, id) {
  const jd = parseJD(jdText)
  let ai = null
  const meta = { used: false, cached: false, failed: false, skipped: null, reason: null, model: null }

  if (useAI) {
    const r = await llm.screen(profile, jd, {
      beforeCall: () => allow(ip, 'ai', AI_RATE, 60 * 60 * 1000) && allowGlobalAI(),
    })
    if (r.ai) {
      ai = r.ai
      meta.used = true
      meta.cached = Boolean(r.cached)
      meta.model = r.model || null
      stats.aiOk++
      if (r.cached) stats.aiCached++
      if (r.usage) {
        stats.tokens.prompt += r.usage.promptTokens || 0
        stats.tokens.completion += r.usage.completionTokens || 0
      }
    } else if (r.failed) {
      meta.failed = true
      meta.reason = r.reason || 'failed'
      stats.aiFail++
    } else {
      meta.skipped = r.skipped || 'unknown'
      stats.aiSkipped++
    }
  } else {
    meta.skipped = 'off'
  }

  const scored = scoreOne(profile, jd, ai)
  stats.jds++
  stats.verdicts[scored.verdict] = (stats.verdicts[scored.verdict] || 0) + 1
  stats.lastAt = new Date().toISOString()
  persistStats()

  return {
    id,
    title: jd.title,
    company: jd.company,
    city: jd.city,
    salary: jd.salary,
    years: jd.years,
    education: jd.education,
    skills: jd.skills,
    jdStats: jd.stats,
    ...scored,
    aiMeta: meta,
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let i = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const idx = i++
      if (idx >= items.length) return
      out[idx] = await fn(items[idx], idx)
    }
  })
  await Promise.all(workers)
  return out
}

/* ---------------- 搜岗位 ---------------- */
const CITY_EN = {
  beijing: '北京', shanghai: '上海', shenzhen: '深圳', guangzhou: '广州', hangzhou: '杭州',
  chengdu: '成都', nanjing: '南京', wuhan: '武汉', xian: '西安', suzhou: '苏州',
  tianjin: '天津', chongqing: '重庆', changsha: '长沙', zhengzhou: '郑州', hefei: '合肥',
  xiamen: '厦门', fuzhou: '福州', jinan: '济南', qingdao: '青岛', dalian: '大连',
  shenyang: '沈阳', wuxi: '无锡', ningbo: '宁波', dongguan: '东莞', foshan: '佛山',
  zhuhai: '珠海', zhongshan: '中山', huizhou: '惠州', changzhou: '常州', wenzhou: '温州',
  jiaxing: '嘉兴', shaoxing: '绍兴', taizhou: '台州', jinhua: '金华', quanzhou: '泉州',
  yantai: '烟台', weifang: '潍坊', xuzhou: '徐州', hongkong: '香港', singapore: '新加坡',
}

function normalizeCity(raw, fallback = '') {
  const s = String(raw || '').trim()
  if (!s) return fallback
  if (/remote|远程|anywhere/i.test(s)) return '远程'
  const first = s.split(/[,，·/|]/)[0].trim().toLowerCase()
  if (CITY_EN[first]) return CITY_EN[first]
  if (/[\u4e00-\u9fa5]/.test(first)) return first.replace(/[-－].*$/, '')
  return fallback || s
}

function normKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s\-_/|·,，。:：()（）[\]【】]+/g, '')
    .slice(0, 80)
}

/** 宽松关键词过滤：整串命中或多数 token 命中 */
export function matchesQuery(text, query) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return true
  const t = String(text || '').toLowerCase()
  if (t.includes(q)) return true
  const tokens = q.split(/[\s,，、/|+]+/).map((s) => s.trim()).filter((s) => s.length >= 2)
  if (!tokens.length) return true
  const hit = tokens.filter((tok) => t.includes(tok)).length
  return hit >= Math.max(1, Math.ceil(tokens.length * 0.6))
}

function makeResult(profile, item, idx) {
  const jd = parseJD(item.text)
  jd.title = item.title || jd.title
  if (item.source !== 'v2ex') jd.company = jd.company || item.company || ''
  jd.city = jd.city || normalizeCity(item.locationRaw || item.city)
  const scored = scoreOne(profile, jd)
  return {
    id: `${item.source || 'jd'}_${item.id || idx}`,
    source: item.source || '',
    sourceName: (SOURCES.find((s) => s.id === item.source) || {}).name || item.source || '',
    sourceUrl: item.url || '',
    sourceDetail: item.detail || 'list',
    postedAt: item.postedAt || '',
    title: jd.title,
    company: jd.company,
    city: jd.city,
    salary: jd.salary,
    years: jd.years,
    education: jd.education,
    skills: jd.skills,
    jdStats: jd.stats,
    text: String(item.text || '').slice(0, MAX_RESULT_CHARS),
    ...scored,
  }
}

function pickCandidates(scored, limit) {
  const perSource = new Map()
  const out = []
  for (const item of scored) {
    const n = perSource.get(item.source) || 0
    if (n >= 5) continue
    perSource.set(item.source, n + 1)
    out.push(item)
    if (out.length >= limit) break
  }
  return out
}

function validateSearchInput(body) {
  const profile = validateProfile(body.profile)
  const query = String(body.query || profile.title || '').trim().slice(0, 60)
  if (query.length < 1) throw new HttpError(400, '先填关键词或目标岗位')
  const city = String(body.city || '').trim().slice(0, 20)
  const wanted = Array.isArray(body.sources) ? body.sources.filter((s) => typeof s === 'string') : []
  const available = new Set(publicSources().filter((s) => !s.blocked).map((s) => s.id))
  const sources = [...new Set(wanted.filter((s) => available.has(s)))]
  if (!sources.length) throw new HttpError(400, '至少选一个可用来源')
  const limit = Math.min(MAX_SEARCH, Math.max(4, Number(body.limit) || 12))
  return { profile, query, city, sources, limit }
}

async function handleApi(req, res, pathname) {
  const ip = clientIp(req)

  if (req.method === 'GET' && pathname === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      version: VERSION,
      uptime: Math.round(process.uptime()),
      ai: llm.configured(),
    })
  }

  if (req.method === 'GET' && pathname === '/api/config') {
    const cfg = llm.gatewayConfig()
    return sendJson(res, 200, {
      ok: true,
      version: VERSION,
      ai: cfg.configured,
      model: cfg.model || '由网关决定',
      maxJDs: MAX_JDS,
      maxSearch: MAX_SEARCH,
      limits: {
        aiPerHour: AI_RATE,
        aiDaily: AI_DAILY,
        totalPerHour: TOTAL_RATE,
        searchPerHour: SEARCH_RATE,
        searchDaily: SEARCH_DAILY,
        resumePerHour: RESUME_RATE,
        resumeMB: MAX_RESUME_BYTES / 1024 / 1024,
      },
      sources: publicSources(),
      unavailableSources: unavailableSources(),
      privacy:
        '画像、简历与 JD 只存浏览器 localStorage；服务端解析后丢弃正文，只存来源 cookie（data/sources-auth.json，0600，接口只回掩码）与匿名计数',
    })
  }

  if (req.method === 'GET' && pathname === '/api/stats') {
    return sendJson(res, 200, { ok: true, ...stats })
  }

  if (req.method === 'GET' && pathname === '/api/sources') {
    return sendJson(res, 200, { ok: true, sources: publicSources(), unavailable: unavailableSources() })
  }

  if (req.method === 'GET' && pathname === '/api/admin/sources') {
    requireAdmin(req, ip)
    return sendJson(res, 200, { ok: true, auth: allAuthStatus(), sources: publicSources() })
  }

  if (req.method === 'POST' && pathname === '/api/admin/sources') {
    requireAdmin(req, ip)
    const body = await readJson(req, 64 * 1024)
    const source = String(body.source || '')
    if (!['boss', 'maimai'].includes(source)) throw new HttpError(400, '只支持 boss / maimai')
    let status
    try {
      status = body.clear ? await clearAuth(source) : await saveAuth(source, { cookie: body.cookie, ua: body.ua })
    } catch (e) {
      throw new HttpError(400, e.message || '保存失败')
    }
    return sendJson(res, 200, { ok: true, auth: status, sources: publicSources() })
  }

  if (req.method === 'POST' && pathname === '/api/resume') {
    if (!allow(ip, 'resume', RESUME_RATE, 60 * 60 * 1000) || !allow(ip, 'total', TOTAL_RATE, 60 * 60 * 1000)) {
      throw new HttpError(429, '解析太频繁，请稍后再试')
    }
    const started = Date.now()
    const body = await readJson(req, MAX_UPLOAD)
    let file
    try {
      file = await extractResume({ filename: body.filename, base64: body.data || body.base64 })
    } catch (e) {
      if (e instanceof ResumeError) throw new HttpError(422, e.message)
      throw e
    }
    const title = guessTitle(file.text)
    const sal = guessSalary(file.text)
    const p = parseProfile({ title, resumeText: file.text })
    stats.resumes++
    stats.resumeKinds[file.kind] = (stats.resumeKinds[file.kind] || 0) + 1
    stats.lastAt = new Date().toISOString()
    persistStats()
    return sendJson(res, 200, {
      ok: true,
      text: file.text.slice(0, 20000),
      profile: {
        title,
        years: p.years,
        education: p.education,
        cities: p.cities,
        salaryMin: sal.min ?? p.salaryMin,
        salaryMax: sal.max ?? p.salaryMax,
        skills: (p.skills || []).map(skillName),
      },
      meta: {
        kind: file.kind,
        bytes: file.bytes,
        chars: file.text.length,
        warnings: file.warnings,
        elapsedMs: Date.now() - started,
      },
    })
  }

  if (req.method === 'POST' && pathname === '/api/import-jd') {
    if (!allow(ip, 'total', TOTAL_RATE, 60 * 60 * 1000)) {
      throw new HttpError(429, '请求太频繁，请稍后再试')
    }
    const body = await readJson(req)
    const url = String(body.url || '').trim()
    if (!url) throw new HttpError(400, '缺少链接')
    try {
      const r = await fetchJdFromUrl(url)
      const jd = parseJD(r.text)
      stats.imports++
      stats.lastAt = new Date().toISOString()
      persistStats()
      return sendJson(res, 200, {
        ok: true,
        source: r.source,
        url: r.url,
        text: r.text.slice(0, 20000),
        jd: {
          title: r.title || jd.title,
          company: jd.company,
          city: jd.city,
          salary: jd.salary,
          years: jd.years,
          education: jd.education,
          skills: (jd.skills || []).map((s) => s.name),
          redFlags: jd.redFlags,
          stats: jd.stats,
        },
      })
    } catch (e) {
      if (e instanceof FetchError) {
        throw new HttpError(e.code === 'timeout' ? 504 : 422, `${e.message}（换公开链接，或直接粘贴 JD）`)
      }
      throw e
    }
  }

  if (req.method === 'POST' && pathname === '/api/search') {
    if (!allow(ip, 'search', SEARCH_RATE, 60 * 60 * 1000) || !allow(ip, 'total', TOTAL_RATE, 60 * 60 * 1000)) {
      throw new HttpError(429, '搜索太频繁，请稍后再试')
    }
    if (!allowGlobalSearch()) throw new HttpError(429, '今日全站搜索额度已用完，明天再来')
    const input = validateSearchInput(await readJson(req))
    const started = Date.now()
    stats.searches++

    const { items, diagnostics } = await collect(input)
    const seen = new Set()
    const candidates = []
    for (const item of items) {
      if (!item?.text || item.text.length < 30) continue
      if (!['liepin', 'linkedin', 'boss', 'maimai'].includes(item.source) && !matchesQuery(item.text, input.query)) continue
      const r = makeResult(input.profile, item, candidates.length)
      if (input.city === '远程') {
        if (r.city !== '远程' && !/远程|remote/i.test(item.text)) continue
      } else if (input.city && r.city && r.city !== '远程') {
        const a = r.city.replace(/-.*$/, '')
        if (!a.includes(input.city) && !input.city.includes(a)) continue
      }
      const key = `${normKey(r.title)}|${normKey(r.company || item.source)}`
      if (seen.has(key)) continue
      seen.add(key)
      candidates.push({ item, r })
    }
    candidates.sort((a, b) => b.r.score - a.r.score || String(a.r.title).localeCompare(String(b.r.title)))

    const picked = []
    const groups = new Map()
    for (const c of candidates) {
      if (!groups.has(c.item.source)) groups.set(c.item.source, [])
      groups.get(c.item.source).push(c.item)
    }
    const queue = [...groups.values()]
    // 先按来源轮转，保证每个源都有机会；再补齐剩下的名额
    let added = true
    while (picked.length < MAX_SEARCH_CANDIDATES && added) {
      added = false
      for (const g of queue) {
        if (picked.length >= MAX_SEARCH_CANDIDATES) break
        const next = g.shift()
        if (next) {
          picked.push(next)
          added = true
        }
      }
    }
    const leftover = [...groups.values()].flat()
    if (picked.length < MAX_SEARCH_CANDIDATES) picked.push(...leftover.slice(0, MAX_SEARCH_CANDIDATES - picked.length))

    const detailed = await hydrate(picked, { limit: MAX_SEARCH_CANDIDATES, concurrency: 5 })
    const scoredResults = detailed.map((item, idx) => makeResult(input.profile, item, idx)).sort((a, b) => b.score - a.score)
    // 保留少量多来源名额，避免结果被单一站点刷屏
    const results = []
    const chosen = new Set()
    const bySource = new Map()
    for (const r of scoredResults) {
      if (!bySource.has(r.source)) bySource.set(r.source, [])
      bySource.get(r.source).push(r)
    }
    const dominant = [...bySource.entries()].sort((a, b) => b[1].length - a[1].length)[0]?.[0]
    for (const [src, list] of bySource) {
      if (src === dominant) continue
      const quota = src === 'linkedin' ? 2 : 1
      for (const r of list.slice(0, quota)) {
        if (results.length >= input.limit) break
        results.push(r)
        chosen.add(r.id)
      }
    }
    for (const r of scoredResults) {
      if (results.length >= input.limit) break
      if (chosen.has(r.id)) continue
      results.push(r)
      chosen.add(r.id)
    }
    results.sort((a, b) => b.score - a.score)

    stats.jds += results.length
    for (const r of results) {
      stats.verdicts[r.verdict] = (stats.verdicts[r.verdict] || 0) + 1
      stats.sourceHits[r.source] = (stats.sourceHits[r.source] || 0) + 1
    }
    if (results.length) stats.searchOk++
    else stats.searchEmpty++
    stats.lastAt = new Date().toISOString()
    persistStats()

    return sendJson(res, 200, {
      ok: true,
      results,
      meta: {
        query: input.query,
        city: input.city,
        elapsedMs: Date.now() - started,
        candidates: candidates.length,
        detailed: detailed.length,
        returned: results.length,
        sources: diagnostics,
        ai: llm.configured(),
      },
    })
  }

  if (req.method === 'POST' && pathname === '/api/parse-profile') {
    if (!allow(ip, 'total', TOTAL_RATE, 60 * 60 * 1000)) {
      throw new HttpError(429, '请求太频繁，请稍后再试')
    }
    const body = await readJson(req)
    const p = validateProfile(body.profile)
    return sendJson(res, 200, {
      ok: true,
      profile: {
        title: p.title,
        years: p.years,
        education: p.education,
        cities: p.cities,
        salaryMin: p.salaryMin,
        salaryMax: p.salaryMax,
        skills: (p.skills || []).map(skillName),
      },
    })
  }

  if (req.method === 'POST' && pathname === '/api/parse-jd') {
    if (!allow(ip, 'total', TOTAL_RATE, 60 * 60 * 1000)) {
      throw new HttpError(429, '请求太频繁，请稍后再试')
    }
    const body = await readJson(req)
    const jd = parseJD(validateJd(body.text))
    return sendJson(res, 200, {
      ok: true,
      jd: {
        title: jd.title,
        company: jd.company,
        city: jd.city,
        salary: jd.salary,
        years: jd.years,
        education: jd.education,
        skills: (jd.skills || []).map((s) => s.name),
        redFlags: jd.redFlags,
        stats: jd.stats,
      },
    })
  }

  if (req.method === 'POST' && pathname === '/api/screen-one') {
    if (!allow(ip, 'total', TOTAL_RATE, 60 * 60 * 1000)) {
      throw new HttpError(429, '请求太频繁，请稍后再试')
    }
    const body = await readJson(req)
    const profile = validateProfile(body.profile)
    const jdText = validateJd(body.jd)
    const useAI = body.useAI !== false
    stats.screens++
    const result = await runOne(profile, jdText, ip, useAI, body.id || null)
    return sendJson(res, 200, {
      ok: true,
      result,
      meta: {
        ai: llm.configured(),
        maxJDs: MAX_JDS,
      },
    })
  }

  if (req.method === 'POST' && pathname === '/api/screen') {
    const body = await readJson(req)
    const profile = validateProfile(body.profile)
    const rawJds = Array.isArray(body.jds) ? body.jds : []
    if (rawJds.length === 0) throw new HttpError(400, '至少给 1 条 JD')
    if (rawJds.length > MAX_JDS) throw new HttpError(400, `一次最多 ${MAX_JDS} 条 JD`)
    const jds = rawJds.map((j) => ({
      id: (j && typeof j === 'object' && j.id) || null,
      text: validateJd(typeof j === 'string' ? j : j?.text),
    }))
    if (!allow(ip, 'total', TOTAL_RATE, 60 * 60 * 1000)) {
      throw new HttpError(429, '请求太频繁，请稍后再试')
    }
    const useAI = body.useAI !== false
    stats.screens++
    const started = Date.now()
    const results = await mapLimit(jds, 3, (j) => runOne(profile, j.text, ip, useAI, j.id))
    const ai = {
      configured: llm.configured(),
      used: results.filter((r) => r.aiMeta.used).length,
      cached: results.filter((r) => r.aiMeta.cached).length,
      failed: results.filter((r) => r.aiMeta.failed).length,
      skipped: results.filter((r) => r.aiMeta.skipped && r.aiMeta.skipped !== 'off').length,
      model: results.find((r) => r.aiMeta.model)?.aiMeta.model || null,
    }
    return sendJson(res, 200, {
      ok: true,
      results,
      meta: { elapsedMs: Date.now() - started, ai, maxJDs: MAX_JDS },
    })
  }

  sendJson(res, 404, { ok: false, error: 'not found' })
}

const server = http.createServer(async (req, res) => {
  const started = Date.now()
  let pathname = '/'
  try {
    const url = new URL(req.url || '/', 'http://localhost')
    pathname = url.pathname
    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname)
    } else if (req.method === 'GET' || req.method === 'HEAD') {
      await serveStatic(req, res, pathname)
    } else {
      sendText(res, 405, 'method not allowed')
    }
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500
    if (status >= 500) console.error('[jd] %s %s -> %d', req.method, pathname, status, e?.message || e)
    if (!res.headersSent) sendJson(res, status, { ok: false, error: status >= 500 ? '服务内部错误' : e.message })
    else res.end()
  } finally {
    if (pathname.startsWith('/api/')) {
      console.log('[jd] %s %s %dms', req.method, pathname, Date.now() - started)
    }
  }
})

server.requestTimeout = 120_000
server.headersTimeout = 30_000

await loadStats()
await initAuth()
server.listen(PORT, () => {
  const cfg = llm.gatewayConfig()
  console.log(`[jd] 对位 v${VERSION} on :${PORT} · AI ${cfg.configured ? 'on' : 'off(规则模式)'}`)
})

function shutdown(sig) {
  console.log(`[jd] ${sig}，正在退出`)
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(STATS_FILE, JSON.stringify(stats))
  } catch {
    /* 退出时写不进去也不阻塞 */
  }
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000).unref?.()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
