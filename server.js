/**
 * 对位 · AI 智能筛选 JD
 * 零依赖 Node 原生 http：同时发静态页与 /api。
 */
import http from 'node:http'
import path from 'node:path'
import { promises as fs, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseJD, parseProfile } from './lib/parse.js'
import { scoreOne } from './lib/score.js'
import { skillName } from './lib/skills.js'
import * as llm from './lib/llm.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WEB_DIR = path.join(__dirname, 'web')
const DATA_DIR = path.join(__dirname, 'data')
const STATS_FILE = path.join(DATA_DIR, 'stats.json')
const VERSION = '0.1.0'
const PORT = Number(process.env.PORT) || 8790
const MAX_JDS = 8
const MAX_JD_CHARS = 20000
const MAX_BODY = 512 * 1024
const AI_RATE = Number(process.env.JD_AI_RATE) || 20
const TOTAL_RATE = Number(process.env.JD_TOTAL_RATE) || 240
const AI_DAILY = Number(process.env.JD_AI_DAILY) || 500

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

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    let done = false
    req.on('data', (c) => {
      if (done) return
      size += c.length
      if (size > MAX_BODY) {
        done = true
        req.resume()
        reject(new HttpError(413, '请求体太大'))
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
      limits: { aiPerHour: AI_RATE, aiDaily: AI_DAILY, totalPerHour: TOTAL_RATE },
      privacy: '画像与 JD 只在浏览器 localStorage；服务端不落库，只记匿名计数',
    })
  }

  if (req.method === 'GET' && pathname === '/api/stats') {
    return sendJson(res, 200, { ok: true, ...stats })
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
