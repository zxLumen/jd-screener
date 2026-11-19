/**
 * 搜索结果缓存：同 q / 城市 / 来源 / 画像，5 分钟、最多 200 条。
 *
 * 键里带画像指纹，避免同 q 不同简历串分；画像正文只存 hash，不把简历原文放进键。
 */
import crypto from 'node:crypto'
import { TTLCache } from './cache.js'

function profileSignature(p = {}) {
  const resume = p.resumeText
    ? crypto.createHash('sha1').update(String(p.resumeText)).digest('hex')
    : ''
  return JSON.stringify({
    title: p.title || '',
    years: p.years ?? null,
    education: p.education || '',
    cities: Array.isArray(p.cities) ? p.cities : [],
    salaryMin: p.salaryMin ?? null,
    salaryMax: p.salaryMax ?? null,
    remoteOk: Boolean(p.remoteOk),
    skills: Array.isArray(p.skills) ? p.skills : [],
    resume,
  })
}

export class SearchCache {
  constructor({ max = 200, ttl = 5 * 60 * 1000 } = {}) {
    this.ttl = ttl
    this.cache = new TTLCache({ max, ttl })
  }

  key(input = {}) {
    const sig = JSON.stringify({
      q: String(input.query || '').trim().toLowerCase(),
      city: String(input.city || '').trim(),
      sources: [...(input.sources || [])].map(String).sort(),
      limit: Number(input.limit) || 12,
      profile: profileSignature(input.profile),
    })
    return crypto.createHash('sha1').update(sig).digest('hex')
  }

  get(input) {
    return this.cache.get(this.key(input))
  }

  set(input, value, ttl) {
    this.cache.set(this.key(input), value, ttl || this.ttl)
  }

  get size() {
    return this.cache.size
  }

  clear() {
    this.cache.map.clear()
  }
}
