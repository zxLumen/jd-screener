/** 有上限的 TTL 缓存（进程内，重启即失效） */
export class TTLCache {
  constructor({ max = 200, ttl = 10 * 60 * 1000 } = {}) {
    this.max = max
    this.ttl = ttl
    this.map = new Map()
  }

  get(key) {
    const hit = this.map.get(key)
    if (!hit) return null
    if (hit.exp <= Date.now()) {
      this.map.delete(key)
      return null
    }
    // 命中后挪到队尾，近似 LRU
    this.map.delete(key)
    this.map.set(key, hit)
    return hit.value
  }

  set(key, value, ttl) {
    if (this.map.has(key)) this.map.delete(key)
    while (this.map.size >= this.max) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this.map.delete(oldest)
    }
    this.map.set(key, { value, exp: Date.now() + (ttl || this.ttl) })
  }

  get size() {
    return this.map.size
  }
}
