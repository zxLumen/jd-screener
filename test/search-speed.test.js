import test from 'node:test'
import assert from 'node:assert/strict'
import { collect, hydrate } from '../lib/sources.js'
import { SearchCache } from '../lib/search-cache.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function item(id, source = 'liepin') {
  return {
    id: String(id),
    source,
    title: `岗位 ${id}`,
    company: '某公司',
    city: '北京',
    url: `https://example.com/${id}`,
    text: `岗位 ${id} 的详细描述，Python 后端，北京，20-30K，三年以上经验。`,
    light: `岗位 ${id}`,
  }
}

test('并发：6 源同时抓，总耗时接近最慢单源', async () => {
  const ids = ['liepin', 'linkedin', 'v2ex', 'eleduck', 'jobui', 'maimai']
  const adapters = Object.fromEntries(
    ids.map((id) => [
      id,
      {
        search: async () => {
          await sleep(150)
          return [item(id, id)]
        },
        detail: null,
      },
    ]),
  )
  const t0 = Date.now()
  const r = await collect({
    query: '并发测试-6源',
    city: '北京',
    sources: ids,
    adapters,
    sourceTimeoutMs: 1_000,
    deadline: Date.now() + 2_000,
  })
  const elapsed = Date.now() - t0
  assert.ok(elapsed < 700, `6 源应并发，实际 ${elapsed}ms`)
  assert.equal(r.items.length, 6)
  assert.equal(r.partial, false)
  assert.ok(r.diagnostics.every((d) => d.error === null))
})

test('超时：单源超时 partial:true，其余源结果保留', async () => {
  const adapters = {
    liepin: { search: () => new Promise(() => {}), detail: null },
    linkedin: { search: async () => [item('fast', 'linkedin')], detail: null },
  }
  const t0 = Date.now()
  const r = await collect({
    query: '超时测试-单源',
    city: '北京',
    sources: ['liepin', 'linkedin'],
    adapters,
    sourceTimeoutMs: 80,
    deadline: Date.now() + 500,
  })
  const elapsed = Date.now() - t0
  assert.ok(elapsed < 500, `单源超时不应拖整体，实际 ${elapsed}ms`)
  assert.equal(r.partial, true)
  assert.ok(r.items.some((i) => i.id === 'fast'))
  assert.ok(!r.items.some((i) => i.id.startsWith('slow')))
  const slow = r.diagnostics.find((d) => d.id === 'liepin')
  assert.equal(slow.error, 'timeout')
  assert.equal(slow.partial, true)
})

test('超时：总预算用完时 hydrate 返回 fallback，不继续等详情', async () => {
  const adapters = {
    liepin: { detail: () => new Promise(() => {}) },
  }
  const t0 = Date.now()
  const r = await hydrate([item('1', 'liepin')], {
    adapters,
    deadline: Date.now() + 80,
    detailTimeoutMs: 1_000,
  })
  const elapsed = Date.now() - t0
  assert.ok(elapsed < 500, `预算用完应立即返回，实际 ${elapsed}ms`)
  assert.equal(r.partial, true)
  assert.equal(r.items[0].detail, 'fallback')
  assert.equal(r.items[0].detailError, 'budget')
})

test('缓存：同 q 命中、不同画像不串、200 上限 LRU + TTL', async () => {
  const base = {
    query: 'python',
    city: '北京',
    sources: ['liepin', 'v2ex'],
    limit: 12,
    profile: { title: 'python', years: 3, education: '本科', cities: ['北京'], skills: ['Python'], resumeText: '简历 A' },
  }
  const c = new SearchCache({ max: 200, ttl: 60_000 })
  assert.equal(c.get(base), null)
  c.set(base, { results: ['a'] })
  assert.deepEqual(c.get(base), { results: ['a'] })
  assert.equal(c.get({ ...base, profile: { ...base.profile, resumeText: '简历 B' } }), null)
  assert.equal(c.get({ ...base, query: 'golang' }), null)

  const small = new SearchCache({ max: 2, ttl: 60_000 })
  small.set({ ...base, query: 'a' }, 1)
  small.set({ ...base, query: 'b' }, 2)
  small.set({ ...base, query: 'c' }, 3)
  assert.equal(small.size, 2)
  assert.equal(small.get({ ...base, query: 'a' }), null)
  assert.equal(small.get({ ...base, query: 'c' }), 3)

  const ttl = new SearchCache({ max: 2, ttl: 20 })
  ttl.set(base, 1)
  await sleep(30)
  assert.equal(ttl.get(base), null)
})
