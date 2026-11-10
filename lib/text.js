/** 文本归一化与匹配小工具（零依赖） */

/** NFKC + 统一换行 + 小写；只用于匹配，展示仍用原文 */
export function norm(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .toLowerCase()
}

export function clamp(n, min, max) {
  const x = Number(n)
  if (!Number.isFinite(x)) return min
  return Math.min(max, Math.max(min, x))
}

export function uniq(arr) {
  return [...new Set((arr || []).filter(Boolean))]
}

export function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const reCache = new Map()

/**
 * 关键词命中：英文/数字走词边界（避免 go 命中 google、sql 命中 mysql），
 * 中文直接 includes。返回 boolean。
 */
export function hasAlias(text, alias) {
  const a = String(alias || '').toLowerCase()
  if (!a) return false
  if (/^[a-z0-9+#./ _-]+$/.test(a)) {
    let re = reCache.get(a)
    if (!re) {
      re = new RegExp(`(^|[^a-z0-9])${escapeRe(a)}(?=[^a-z0-9]|$)`, 'i')
      reCache.set(a, re)
    }
    return re.test(text)
  }
  return text.includes(a)
}

/** 截断，保留原意 */
export function clip(s, n) {
  const t = String(s ?? '')
  return t.length > n ? t.slice(0, n) + '…' : t
}

/** 取匹配词附近的一小段作为证据 */
export function evidence(text, index, len = 24) {
  const i = Math.max(0, index)
  const start = Math.max(0, i - len)
  const end = Math.min(text.length, i + len)
  return text.slice(start, end).replace(/\s+/g, ' ').trim()
}

/** 稳定字符串签名（用于 AI 结果缓存） */
export function signature(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj)
  if (Array.isArray(obj)) return `[${obj.map(signature).join(',')}]`
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${signature(obj[k])}`).join(',')}}`
}
