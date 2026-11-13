/**
 * 抓取工具：超时、大小上限、重定向逐跳校验（防 SSRF）。
 * 只抓公开页面；需要登录/验证码的源不硬闯。
 */
import dns from 'node:dns/promises'
import net from 'node:net'
import { execFile } from 'node:child_process'

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const MAX_BYTES = 5 * 1024 * 1024
const REDIRECTS = [301, 302, 303, 307, 308]

export class FetchError extends Error {
  constructor(code, message) {
    super(message || code)
    this.code = code
  }
}

function privateIPv4(ip) {
  const p = ip.split('.').map(Number)
  if (p.length !== 4) return true
  if (p[0] === 10 || p[0] === 127 || p[0] === 0) return true
  if (p[0] === 169 && p[1] === 254) return true
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true
  if (p[0] === 192 && p[1] === 168) return true
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true
  if (p[0] >= 224) return true
  return false
}

function privateIPv6(ip) {
  const s = ip.toLowerCase()
  return s === '::1' || s === '::' || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb')
}

async function assertPublicHost(url) {
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    throw new FetchError('blocked-host', '不允许访问内网地址')
  }
  if (net.isIP(host)) {
    if (privateIPv4(host) || privateIPv6(host)) throw new FetchError('blocked-host', '不允许访问内网地址')
    return
  }
  let addrs = []
  try {
    addrs = await dns.lookup(host, { all: true, verbatim: true })
  } catch {
    throw new FetchError('dns', `域名解析失败：${host}`)
  }
  if (addrs.some((a) => (a.family === 4 ? privateIPv4(a.address) : privateIPv6(a.address)))) {
    throw new FetchError('blocked-host', '域名解析到内网地址')
  }
}

function decodeBody(buf, contentType) {
  const m = /charset=([^;\s]+)/i.exec(contentType || '')
  const enc = (m?.[1] || 'utf-8').replace(/["']/g, '').toLowerCase()
  try {
    return new TextDecoder(enc === 'gb2312' ? 'gbk' : enc).decode(buf)
  } catch {
    return new TextDecoder('utf-8').decode(buf)
  }
}

/**
 * GET 一个公开网页。
 * @returns {Promise<{status:number,url:string,headers:Headers,text:string}>}
 */
export async function fetchPage(rawUrl, opts = {}) {
  const timeout = opts.timeout || 10_000
  const maxBytes = opts.maxBytes || MAX_BYTES
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    throw new FetchError('bad-url', '链接格式不对')
  }
  if (!/^https?:$/.test(url.protocol)) throw new FetchError('bad-url', '只支持 http/https')

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  try {
    for (let hop = 0; hop <= 3; hop++) {
      await assertPublicHost(url)
      const res = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: ctrl.signal,
        headers: {
          'User-Agent': opts.ua || UA,
          Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          'Accept-Language': opts.lang || 'zh-CN,zh;q=0.9,en;q=0.7',
          ...(opts.headers || {}),
        },
      })
      if (REDIRECTS.includes(res.status)) {
        const loc = res.headers.get('location')
        await res.body?.cancel().catch(() => {})
        if (!loc) throw new FetchError('http-' + res.status, '重定向缺少 Location')
        url = new URL(loc, url)
        if (!/^https?:$/.test(url.protocol)) throw new FetchError('bad-url', '重定向到非 http 协议')
        continue
      }
      if (res.status < 200 || res.status >= 300) {
        await res.body?.cancel().catch(() => {})
        throw new FetchError('http-' + res.status, `HTTP ${res.status}`)
      }
      const len = Number(res.headers.get('content-length')) || 0
      if (len > maxBytes) {
        await res.body?.cancel().catch(() => {})
        throw new FetchError('too-large', `页面超过 ${Math.round(maxBytes / 1024)}KB`)
      }
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length > maxBytes) throw new FetchError('too-large', `页面超过 ${Math.round(maxBytes / 1024)}KB`)
      return { status: res.status, url: url.toString(), headers: res.headers, text: decodeBody(buf, res.headers.get('content-type')) }
    }
    throw new FetchError('redirect-loop', '重定向次数过多')
  } catch (e) {
    if (e instanceof FetchError) throw e
    if (e?.name === 'AbortError') throw new FetchError('timeout', `抓取超时（${Math.round(timeout / 1000)}s）`)
    throw new FetchError('network', e?.message || '网络错误')
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchJson(url, opts = {}) {
  const r = opts.curl ? await fetchCurl(url, opts) : await fetchPage(url, {
    ...opts,
    headers: { Accept: 'application/json', ...(opts.headers || {}) },
  })
  try {
    return JSON.parse(r.text)
  } catch {
    throw new FetchError('json', '返回不是 JSON')
  }
}

/**
 * curl 兜底：个别国内站点对 Node 的 TLS/头部指纹返回 JS 挑战页，
 * 对 curl 正常。只用于固定域名的适配器，不用于用户输入的任意链接。
 */
export async function fetchCurl(rawUrl, opts = {}) {
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    throw new FetchError('bad-url', '链接格式不对')
  }
  if (!/^https?:$/.test(url.protocol)) throw new FetchError('bad-url', '只支持 http/https')
  await assertPublicHost(url)
  const proxy = String(opts.proxy || '').trim()
  if (proxy && !/^(https?|socks5|socks5h):\/\/[^\s]+$/i.test(proxy)) throw new FetchError('bad-proxy', '代理地址只支持 http(s):// 或 socks5://')
  const timeout = Math.round((opts.timeout || 12_000) / 1000)
  const maxFilesize = Math.round((opts.maxBytes || MAX_BYTES) / 1024)
  const args = [
    '-sS',
    '-L',
    '--compressed',
    '--max-redirs', '3',
    '--max-time', String(timeout),
    '--max-filesize', String(maxFilesize * 1024),
    '-A', opts.ua || UA,
    '-H', `Accept: ${opts.headers?.Accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'}`,
    '-H', `Accept-Language: ${opts.lang || 'zh-CN,zh;q=0.9,en;q=0.7'}`,
    '-w', '\n__DUWEI_STATUS__%{http_code}',
  ]
  for (const [k, v] of Object.entries(opts.headers || {})) {
    if (/^(accept|accept-language)$/i.test(k)) continue
    args.push('-H', `${k}: ${v}`)
  }
  if (proxy) args.push('-x', proxy)
  args.push(url.toString())
  const out = await new Promise((resolve, reject) => {
    execFile('curl', args, { maxBuffer: (opts.maxBytes || MAX_BYTES) + 4096, timeout: timeout * 1000 + 500 }, (err, stdout, stderr) => {
      if (err) {
        if (err.code === 'ENOENT') reject(new FetchError('no-curl', '服务器未安装 curl'))
        else if (err.killed || err.signal) reject(new FetchError('timeout', '抓取超时'))
        else reject(new FetchError('network', String(stderr || err.message).slice(0, 160)))
        return
      }
      resolve(stdout)
    })
  })
  const marker = out.lastIndexOf('__DUWEI_STATUS__')
  const body = marker >= 0 ? out.slice(0, marker).replace(/\n$/, '') : out
  const status = marker >= 0 ? Number(out.slice(marker + '__DUWEI_STATUS__'.length).trim()) : 0
  if (status < 200 || status >= 300) throw new FetchError('http-' + status, `HTTP ${status}`)
  return { status, url: url.toString(), headers: new Headers(), text: body }
}

/** 并发上限映射，保持输入顺序 */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = cursor++
      if (i >= items.length) return
      out[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return out
}

export function withTimeout(promise, ms, fallback) {
  let timer
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}
