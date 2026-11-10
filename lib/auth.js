/**
 * 招聘来源登录态（cookie / UA）。
 *
 * - BOSS 直聘必须带登录 cookie；cookie 与浏览器 UA、IP 绑定，换环境容易 code 37。
 * - 脉脉公开岗位页不需要 cookie；配置后可选带上。
 * - 只落盘到 data/sources-auth.json（0600），接口永远只返回掩码，不返回原文。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FILE = process.env.JD_AUTH_FILE || path.join(__dirname, '..', 'data', 'sources-auth.json')
const ENV_COOKIE = { boss: 'BOSS_COOKIE', maimai: 'MAIMAI_COOKIE' }
const ENV_UA = { boss: 'BOSS_UA', maimai: 'MAIMAI_UA' }

const state = {
  boss: { cookie: '', ua: '', updatedAt: null, lastOkAt: null, lastError: null, fromEnv: false },
  maimai: { cookie: '', ua: '', updatedAt: null, lastOkAt: null, lastError: null, fromEnv: false },
}

let saveTimer = null

function sanitizeCookie(raw) {
  return String(raw || '')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 8000)
}

function mask(cookie) {
  if (!cookie) return ''
  const tail = cookie.slice(-4)
  return `len=${cookie.length} · 尾4=${tail}`
}

export async function initAuth() {
  try {
    const raw = JSON.parse(await fs.readFile(FILE, 'utf8'))
    for (const id of Object.keys(state)) {
      if (raw?.[id]?.cookie) {
        state[id] = { ...state[id], ...raw[id], fromEnv: false }
      }
    }
  } catch {
    /* 首次运行没有文件 */
  }
  for (const id of Object.keys(state)) {
    const cookie = sanitizeCookie(process.env[ENV_COOKIE[id]])
    if (cookie) {
      state[id] = {
        ...state[id],
        cookie,
        ua: String(process.env[ENV_UA[id]] || state[id].ua || '').slice(0, 300),
        updatedAt: state[id].updatedAt || new Date().toISOString(),
        fromEnv: true,
      }
    }
  }
}

export function getAuth(id) {
  const s = state[id]
  if (!s) return null
  return { cookie: s.cookie, ua: s.ua }
}

/** 脉脉公开页无需登录；BOSS 必须有 cookie */
export function isConfigured(id) {
  if (id === 'maimai') return true
  return Boolean(state[id]?.cookie)
}

export function authStatus(id) {
  const s = state[id]
  if (!s) return null
  return {
    id,
    configured: isConfigured(id),
    mode: id === 'maimai' ? (s.cookie ? 'public+cookie' : 'public') : 'cookie',
    hasCookie: Boolean(s.cookie),
    cookieMasked: mask(s.cookie),
    hasUA: Boolean(s.ua),
    ua: s.ua ? s.ua.slice(0, 80) + (s.ua.length > 80 ? '…' : '') : '',
    updatedAt: s.updatedAt,
    lastOkAt: s.lastOkAt,
    lastError: s.lastError,
    fromEnv: s.fromEnv,
    file: FILE,
  }
}

export function allAuthStatus() {
  return Object.keys(state).map(authStatus)
}

async function persist() {
  try {
    await fs.mkdir(path.dirname(FILE), { recursive: true, mode: 0o700 })
    const tmp = `${FILE}.tmp`
    const payload = {}
    for (const [id, s] of Object.entries(state)) {
      payload[id] = {
        cookie: s.cookie,
        ua: s.ua,
        updatedAt: s.updatedAt,
        lastOkAt: s.lastOkAt,
        lastError: s.lastError,
      }
    }
    await fs.writeFile(tmp, JSON.stringify(payload), { mode: 0o600 })
    await fs.rename(tmp, FILE)
    await fs.chmod(FILE, 0o600).catch(() => {})
  } catch (e) {
    console.warn('[auth] 保存失败:', e?.message || e)
    throw e
  }
}

export async function saveAuth(id, { cookie, ua }) {
  if (!state[id]) throw new Error('未知来源')
  const c = sanitizeCookie(cookie)
  if (id === 'boss' && c.length < 10) throw new Error('BOSS cookie 太短，需要粘贴完整 Cookie')
  if (c.length > 8000) throw new Error('cookie 太长')
  state[id] = {
    ...state[id],
    cookie: c,
    ua: String(ua || '').replace(/[\r\n]+/g, ' ').slice(0, 300),
    updatedAt: new Date().toISOString(),
    lastError: null,
    fromEnv: false,
  }
  await persist()
  return authStatus(id)
}

export async function clearAuth(id) {
  if (!state[id]) throw new Error('未知来源')
  state[id] = { ...state[id], cookie: '', updatedAt: new Date().toISOString(), lastOkAt: null, lastError: null, fromEnv: false }
  await persist()
  return authStatus(id)
}

export function markResult(id, ok, error = null) {
  const s = state[id]
  if (!s) return
  if (ok) {
    s.lastOkAt = new Date().toISOString()
    s.lastError = null
  } else {
    s.lastError = String(error || 'unknown').slice(0, 200)
  }
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    persist().catch(() => {})
  }, 1500)
  saveTimer.unref?.()
}
