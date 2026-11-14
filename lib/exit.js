/**
 * 大陆出口探测（只读）。
 *
 * 服务器在境外时，BOSS/智联/前程/拉勾会按 IP 风控。这里不写爬虫，
 * 只负责回答一个问题：现在的出口是谁、在不在线、归属地是不是大陆。
 *
 * 出口地址由 JD_EXIT_PROXY 指定，支持两种写法：
 *   socks5h://127.0.0.1:1080      家里的 SSH 反向隧道（server 侧 loopback）
 *   unix:/run/jd-exit/bridge.sock Docker 容器通过 unix socket 连到宿主机 loopback
 *
 * 没配置时立刻返回 offline（毫秒级），绝不让搜索或页面等网络。
 */
import net from 'node:net'
import tls from 'node:tls'
import http from 'node:http'
import https from 'node:https'

const DEFAULT_TIMEOUT = 2_000
const MAX_BODY = 512 * 1024
const ONLINE_TTL = 15_000
const OFFLINE_TTL = 3_000
const UA = 'jd-screener-exit/0.2.4'

export const EXIT_TIMEOUT_MS = (() => {
  const n = Number(process.env.JD_EXIT_TIMEOUT_MS)
  if (!Number.isFinite(n)) return DEFAULT_TIMEOUT
  return Math.min(2_000, Math.max(300, Math.round(n)))
})()

/** 解析 JD_EXIT_PROXY；空值 = 未配置出口。 */
export function exitTarget(env = process.env) {
  const raw = String(env.JD_EXIT_PROXY || '').trim()
  if (!raw) return null
  if (raw.startsWith('unix:')) {
    const path = raw.slice(5).trim()
    if (!path) return null
    return { type: 'unix', path, label: `unix:${path}` }
  }
  let u
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (!/^socks5h?:$/.test(u.protocol)) return null
  const port = Number(u.port) || 1080
  if (!u.hostname || !Number.isInteger(port) || port <= 0 || port > 65535) return null
  return { type: 'tcp', host: u.hostname, port, label: `${u.protocol}//${u.host}` }
}

/** ipip.net / ipinfo.io 的返回归一化。 */
export function parseExitInfo(raw) {
  if (!raw || typeof raw !== 'object') return null
  if (raw.ret === 'ok' && raw.data) {
    const ip = String(raw.data.ip || '').trim()
    if (!ip) return null
    const loc = Array.isArray(raw.data.location) ? raw.data.location.map((x) => String(x || '').trim()) : []
    const country = loc[0] || ''
    const region = loc[1] || ''
    const city = loc[2] || region
    const org = loc[4] || ''
    return {
      ip,
      country,
      region,
      city,
      org,
      location: [country, region, city].filter(Boolean).join(' '),
    }
  }
  const ip = String(raw.ip || '').trim()
  if (!ip) return null
  const city = String(raw.city || '').trim()
  const region = String(raw.region || '').trim()
  const country = String(raw.country || '').trim()
  return {
    ip,
    country,
    region,
    city: city || region,
    org: String(raw.org || '').trim(),
    location: [city || region, region, country].filter(Boolean).join(', '),
  }
}

export function isBeijing(info) {
  if (!info) return false
  return /北京|beijing/i.test(`${info.city || ''} ${info.region || ''} ${info.location || ''}`)
}

function timeoutError() {
  return Object.assign(new Error('timeout'), { code: 'timeout' })
}

function withTimeout(promise, ms) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(timeoutError()), Math.max(1, ms))
    }),
  ]).finally(() => clearTimeout(timer))
}

function connectSocket(target, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = target.type === 'unix'
      ? net.connect(target.path)
      : net.connect({ host: target.host, port: target.port })
    const timer = setTimeout(() => {
      sock.destroy()
      reject(timeoutError())
    }, Math.max(1, timeoutMs))
    sock.once('connect', () => {
      clearTimeout(timer)
      sock.setNoDelay?.(true)
      resolve(sock)
    })
    sock.once('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
  })
}

function createReader(socket) {
  let buf = Buffer.alloc(0)
  let pending = null
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk])
    flush()
  }
  const onError = (e) => {
    if (!pending) return
    const p = pending
    pending = null
    p.reject(e)
  }
  const onClose = () => {
    if (!pending) return
    const p = pending
    pending = null
    p.reject(Object.assign(new Error('closed'), { code: 'closed' }))
  }
  function flush() {
    if (!pending || buf.length < pending.n) return
    const p = pending
    pending = null
    const out = buf.subarray(0, p.n)
    buf = buf.subarray(p.n)
    p.resolve(out)
  }
  socket.on('data', onData)
  socket.on('error', onError)
  socket.on('close', onClose)
  return {
    read(n) {
      return new Promise((resolve, reject) => {
        pending = { n, resolve, reject }
        flush()
      })
    },
    cleanup() {
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
    },
  }
}

/** SOCKS5 no-auth + CONNECT；返回已完成握手的裸 TCP socket。 */
export async function socks5Connect(target, host, port, timeoutMs = DEFAULT_TIMEOUT) {
  const deadline = Date.now() + timeoutMs
  const remain = () => Math.max(1, deadline - Date.now())
  const sock = await connectSocket(target, remain())
  const reader = createReader(sock)
  try {
    sock.write(Buffer.from([5, 1, 0]))
    const hello = await withTimeout(reader.read(2), remain())
    if (hello[0] !== 5 || hello[1] !== 0) {
      throw Object.assign(new Error('socks-auth'), { code: 'socks-auth' })
    }
    const hostBuf = Buffer.from(String(host))
    if (hostBuf.length > 255) throw Object.assign(new Error('host-too-long'), { code: 'host-too-long' })
    const req = Buffer.alloc(7 + hostBuf.length)
    req[0] = 5
    req[1] = 1
    req[2] = 0
    req[3] = 3
    req[4] = hostBuf.length
    hostBuf.copy(req, 5)
    req.writeUInt16BE(port, 5 + hostBuf.length)
    sock.write(req)
    const head = await withTimeout(reader.read(4), remain())
    if (head[0] !== 5) throw Object.assign(new Error('socks-version'), { code: 'socks-version' })
    if (head[1] !== 0) {
      const code = head[1] === 5 ? 'socks-refused' : `socks-reply-${head[1]}`
      throw Object.assign(new Error(code), { code })
    }
    const atyp = head[3]
    let addrLen = 0
    if (atyp === 1) addrLen = 4
    else if (atyp === 4) addrLen = 16
    else if (atyp === 3) addrLen = (await withTimeout(reader.read(1), remain()))[0]
    else throw Object.assign(new Error('socks-atyp'), { code: 'socks-atyp' })
    await withTimeout(reader.read(addrLen + 2), remain())
    reader.cleanup()
    return sock
  } catch (e) {
    reader.cleanup()
    sock.destroy()
    throw e
  }
}

function readBody(res, req, limit, resolve, reject) {
  let size = 0
  const chunks = []
  res.on('data', (d) => {
    size += d.length
    if (size > limit) {
      req.destroy(Object.assign(new Error('too-large'), { code: 'too-large' }))
      return
    }
    chunks.push(d)
  })
  res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
  res.on('error', reject)
}

function httpOverSocket(sock, url, timeoutMs, opts) {
  const isHttps = url.protocol === 'https:'
  const mod = isHttps ? https : http
  const port = Number(url.port) || (isHttps ? 443 : 80)
  const agent = new mod.Agent({ keepAlive: false })
  agent.createConnection = () =>
    isHttps ? tls.connect({ socket: sock, servername: url.hostname }) : sock
  return new Promise((resolve, reject) => {
    const req = mod.request(
      {
        host: url.hostname,
        port,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        agent,
        headers: {
          Host: url.host,
          'User-Agent': opts.ua || UA,
          Accept: opts.accept || 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7',
          'Accept-Encoding': 'identity',
          ...(opts.headers || {}),
        },
        timeout: Math.max(1, timeoutMs),
      },
      (res) => readBody(res, req, opts.maxBytes || MAX_BODY, resolve, reject),
    )
    req.on('timeout', () => req.destroy(timeoutError()))
    req.on('error', reject)
    req.end()
  })
}

/** 通过 SOCKS5 出口发一个 GET（最多 3 次重定向）。 */
export async function requestViaProxy(target, rawUrl, opts = {}) {
  if (!target) throw Object.assign(new Error('not-configured'), { code: 'not-configured' })
  const timeoutMs = opts.timeoutMs || 8_000
  const deadline = Date.now() + timeoutMs
  const remain = () => Math.max(1, deadline - Date.now())
  let url = new URL(rawUrl)
  for (let hop = 0; hop <= 3; hop++) {
    if (!/^https?:$/.test(url.protocol)) throw Object.assign(new Error('bad-url'), { code: 'bad-url' })
    const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80)
    const sock = await socks5Connect(target, url.hostname, port, remain())
    let res
    try {
      res = await httpOverSocket(sock, url, remain(), opts)
    } finally {
      sock.destroy()
    }
    if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.location) {
      url = new URL(res.headers.location, url)
      continue
    }
    return { ...res, url: url.toString() }
  }
  throw Object.assign(new Error('redirect-loop'), { code: 'redirect-loop' })
}

/** 直连 GET（没有出口时给体检 CLI 用）。 */
export async function requestDirect(rawUrl, opts = {}) {
  const timeoutMs = opts.timeoutMs || 8_000
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(rawUrl, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        'User-Agent': opts.ua || UA,
        Accept: opts.accept || 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7',
        'Accept-Encoding': 'identity',
        ...(opts.headers || {}),
      },
    })
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > (opts.maxBytes || MAX_BODY)) {
      throw Object.assign(new Error('too-large'), { code: 'too-large' })
    }
    return { status: res.status, headers: Object.fromEntries(res.headers), body: buf.toString('utf8'), url: res.url || rawUrl }
  } catch (e) {
    if (e?.name === 'AbortError') throw timeoutError()
    throw e
  } finally {
    clearTimeout(timer)
  }
}

async function fetchJsonViaProxy(target, host, path, timeoutMs) {
  const sock = await socks5Connect(target, host, 443, timeoutMs)
  try {
    const res = await httpOverSocket(sock, new URL(`https://${host}${path}`), timeoutMs, {
      accept: 'application/json',
      maxBytes: 64 * 1024,
    })
    if (res.status < 200 || res.status >= 300) {
      throw Object.assign(new Error(`http-${res.status}`), { code: 'http' })
    }
    try {
      return JSON.parse(res.body)
    } catch {
      throw Object.assign(new Error('bad-json'), { code: 'bad-json' })
    }
  } finally {
    sock.destroy()
  }
}

let cache = { at: 0, key: '', value: null }

export function resetExitCache() {
  cache = { at: 0, key: '', value: null }
}

/**
 * 探测当前出口。
 * - 未配置：0ms 返回 offline（configured=false）
 * - 配置了但隧道没起：≤ timeoutMs 返回 offline
 * - 隧道正常：返回 ip / 归属地 / online
 */
export async function probeExit({ timeoutMs = EXIT_TIMEOUT_MS, target = exitTarget(), useCache = true } = {}) {
  const started = Date.now()
  const checkedAt = new Date().toISOString()
  if (!target) {
    return {
      configured: false,
      online: false,
      ip: null,
      city: '',
      region: '',
      country: '',
      org: '',
      location: '',
      beijing: false,
      latencyMs: 0,
      error: 'not-configured',
      checkedAt,
    }
  }
  if (useCache && cache.key === target.label) {
    const ttl = cache.value.online ? ONLINE_TTL : OFFLINE_TTL
    if (Date.now() - cache.at < ttl) {
      return { ...cache.value, cached: true, latencyMs: Date.now() - started }
    }
  }
  const deadline = started + timeoutMs
  const remain = () => Math.max(1, deadline - Date.now())
  const attempts = [
    fetchJsonViaProxy(target, 'myip.ipip.net', '/json', remain()).then((x) => {
      const info = parseExitInfo(x)
      if (!info) throw Object.assign(new Error('bad-json'), { code: 'bad-json' })
      return info
    }),
    fetchJsonViaProxy(target, 'ipinfo.io', '/json', remain()).then((x) => {
      const info = parseExitInfo(x)
      if (!info) throw Object.assign(new Error('bad-json'), { code: 'bad-json' })
      return info
    }),
  ]
  let out
  try {
    const info = await withTimeout(Promise.any(attempts), remain())
    out = {
      configured: true,
      online: true,
      ...info,
      beijing: isBeijing(info),
      latencyMs: Date.now() - started,
      error: null,
      checkedAt,
    }
  } catch (e) {
    const raw = e?.code || (e instanceof AggregateError ? e.errors?.[0]?.code : null) || 'offline'
    const isOffline =
      ['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ENOENT', 'closed', 'socks-refused', 'socks-auth', 'socks-version', 'socks-atyp'].includes(raw) ||
      String(raw).startsWith('socks-reply-')
    const code = isOffline ? 'offline' : raw
    out = {
      configured: true,
      online: false,
      ip: null,
      city: '',
      region: '',
      country: '',
      org: '',
      location: '',
      beijing: false,
      latencyMs: Date.now() - started,
      error: code === 'timeout' ? 'timeout' : String(code),
      checkedAt,
    }
  }
  cache = { at: Date.now(), key: target.label, value: out }
  return out
}

const RISK_RULES = [
  [/Security Verification|isVerification/i, '智联 Security Verification', 'blocked'],
  [/Aliyun WAF|aliyun.*waf|errors\.aliyun\.com|____tmd____|滑块验证/i, '阿里云 WAF / 滑块', 'blocked'],
  [/code["']?\s*[:=]\s*(35|37)|code\s*(35|37)|IP地址存在异常|环境异常/i, 'BOSS code 35/37 IP 异常', 'blocked'],
  [/访问过于频繁|请求过于频繁|rate.?limit|too many requests/i, '限流', 'blocked'],
  [/Just a moment|cf-chl|Cloudflare/i, 'Cloudflare 挑战', 'blocked'],
  [/验证码|captcha|verify you are human/i, '验证码', 'blocked'],
  [/请登录|登录后查看|user-token|login required|未登录/i, '需要登录', 'need-login'],
]

const MARKERS = {
  liepin: /job-list-item|job-title-box|猎聘/i,
  linkedin: /jobPosting|base-search-card|jobs-guest/i,
  v2ex: /"(id|title)"\s*:/i,
  eleduck: /"posts"\s*:/i,
  jobui: /<rss|<item>/i,
  maimai: /__NEXT_DATA__|job-list|listing/i,
  zhaopin: /jobdetail|job-list-box|joblist-box|jobName|job-name/i,
  '51job': /jobdetail|job-list-box|joblist-box|jobName|job-name|__NEXT_DATA__/i,
  lagou: /jobdetail|job-list-box|joblist-box|position-list|__NEXT_DATA__/i,
  boss: /jobList|"code"\s*:\s*0/i,
}

const SHELL_RULES = [
  [/we-vue-bundle|interfaceacting|antidom/i, '200 JS shell（无岗位数据）'],
  [/<title>[^<]*热门职位招聘/i, '200 热门页（无岗位数据）'],
]

/** 把一次探测结果归到解锁矩阵：unlocked / blocked / need-login / unknown / error / timeout。 */
export function classifySource(source, { status = 0, body = '', error = null } = {}) {
  if (error) {
    return { verdict: error === 'timeout' ? 'timeout' : 'error', feature: error === 'timeout' ? '超时' : String(error) }
  }
  const text = String(body || '')
  for (const [re, feature, verdict] of RISK_RULES) {
    if (re.test(text)) return { verdict, feature }
  }
  if (status === 401 || status === 403) return { verdict: 'blocked', feature: `HTTP ${status}` }
  if (status === 429) return { verdict: 'blocked', feature: 'HTTP 429 限流' }
  if (status < 200 || status >= 300) return { verdict: 'error', feature: `HTTP ${status}` }
  const shell = SHELL_RULES.find(([re]) => re.test(text))
  if (shell) return { verdict: 'unknown', feature: shell[1] }
  const marker = MARKERS[source]
  if (marker && !marker.test(text)) return { verdict: 'unknown', feature: '200 但无岗位特征' }
  return { verdict: 'unlocked', feature: '正常返回岗位特征' }
}
