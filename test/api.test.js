import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const PORT = 18879
const BASE = `http://127.0.0.1:${PORT}`
const AUTH_FILE = path.join(os.tmpdir(), `duiwei-api-auth-${process.pid}.json`)

let child
let logs = ''

const PROFILE = {
  title: 'AI 应用工程师',
  years: '5',
  education: '本科',
  city: '北京',
  salaryMin: '25',
  salaryMax: '40',
  resumeText: 'Python FastAPI Ray Kubernetes Docker Redis MySQL RAG LangChain Milvus LLM',
}

const JD = `AI 应用工程师
某 AI 创业公司 · 北京 · 25-40K·14薪

岗位职责
1. 负责大模型应用（RAG、Agent）的设计与落地；
2. 用 Python / FastAPI 搭建推理服务。

任职要求
1. 本科及以上学历，3-5 年后端或 AI 应用开发经验；
2. 精通 Python，熟悉 FastAPI、Redis、MySQL；
3. 熟悉 RAG、LangChain、向量数据库（Milvus）；
4. 熟悉 Docker / Kubernetes。`

async function waitHealth(timeout = 8000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    try {
      const r = await fetch(`${BASE}/api/health`)
      if (r.ok) return
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 120))
  }
  throw new Error(`server 未启动\n${logs}`)
}

before(async () => {
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      ZX_AI_APP_TOKEN: '',
      ZX_AI_GATEWAY_URL: '',
      JD_ADMIN_TOKEN: 'test-token',
      JD_AUTH_FILE: AUTH_FILE,
      JD_EXIT_PROXY: '',
      JD_EXIT_TIMEOUT_MS: '300',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => (logs += d))
  child.stderr.on('data', (d) => (logs += d))
  await waitHealth()
})

after(async () => {
  child?.kill('SIGTERM')
  await fs.rm(AUTH_FILE, { force: true })
})

test('GET / 返回页面', async () => {
  const r = await fetch(`${BASE}/`)
  assert.equal(r.status, 200)
  const html = await r.text()
  assert.match(html, /对位/)
  assert.match(html, /AI 智能筛选 JD/)
})

test('GET /api/health 与 /api/config', async () => {
  const h = await (await fetch(`${BASE}/api/health`)).json()
  assert.equal(h.ok, true)
  assert.equal(h.ai, false)
  const c = await (await fetch(`${BASE}/api/config`)).json()
  assert.equal(c.ok, true)
  assert.equal(c.ai, false)
  assert.equal(c.maxJDs, 8)
  assert.match(c.privacy, /localStorage/)
})

test('POST /api/parse-jd 不调模型也能解析', async () => {
  const r = await fetch(`${BASE}/api/parse-jd`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: JD }),
  })
  assert.equal(r.status, 200)
  const d = await r.json()
  assert.equal(d.jd.title, 'AI 应用工程师')
  assert.equal(d.jd.city, '北京')
  assert.equal(d.jd.salary.min, 25)
  assert.ok(d.jd.skills.includes('Python'))
})

test('POST /api/screen-one 规则模式可用', async () => {
  const r = await fetch(`${BASE}/api/screen-one`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile: PROFILE, jd: JD, useAI: false }),
  })
  assert.equal(r.status, 200)
  const d = await r.json()
  assert.equal(d.ok, true)
  assert.equal(d.result.title, 'AI 应用工程师')
  assert.equal(typeof d.result.score, 'number')
  assert.equal(d.result.aiMeta.skipped, 'off')
  assert.ok(d.result.score >= 60)
})

test('POST /api/screen 批量 2 条', async () => {
  const r = await fetch(`${BASE}/api/screen`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile: PROFILE, jds: [JD, JD], useAI: false }),
  })
  assert.equal(r.status, 200)
  const d = await r.json()
  assert.equal(d.results.length, 2)
  assert.equal(d.meta.ai.configured, false)
  assert.ok(d.meta.elapsedMs >= 0)
})

test('参数校验：短 JD / 空列表', async () => {
  const short = await fetch(`${BASE}/api/screen-one`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile: PROFILE, jd: '太短', useAI: false }),
  })
  assert.equal(short.status, 400)

  const empty = await fetch(`${BASE}/api/screen`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile: PROFILE, jds: [], useAI: false }),
  })
  assert.equal(empty.status, 400)
})

test('未知 API 404 / 目录穿越 404', async () => {
  const a = await fetch(`${BASE}/api/nope`)
  assert.equal(a.status, 404)
  const b = await fetch(`${BASE}/..%2f..%2fpackage.json`)
  assert.equal(b.status, 404)
})

test('GET /api/sources 列出可用与未接来源', async () => {
  const d = await (await fetch(`${BASE}/api/sources`)).json()
  assert.equal(d.ok, true)
  const ids = d.sources.map((s) => s.id)
  assert.ok(ids.includes('liepin'))
  assert.ok(ids.includes('linkedin'))
  assert.ok(!ids.includes('boss'))
  assert.ok(d.unavailable.some((s) => s.id === 'boss' && /cookie|来源登录/.test(s.note)))
})

test('POST /api/resume 解析 TXT 简历', async () => {
  const text = `王五
AI 应用工程师
5 年经验，Python、FastAPI、Ray、Kubernetes、Redis、MySQL、Docker、RAG、LangChain。
做过大模型应用与 MLOps 平台，期望月薪 30-45K。`
  const r = await fetch(`${BASE}/api/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: 'resume.txt', data: Buffer.from(text).toString('base64') }),
  })
  assert.equal(r.status, 200)
  const d = await r.json()
  assert.equal(d.meta.kind, 'txt')
  assert.equal(d.profile.title, 'AI 应用工程师')
  assert.ok(d.profile.skills.includes('Python'))
  assert.equal(d.profile.salaryMin, 30)
  assert.match(d.text, /LangChain/)
})

test('POST /api/resume 空文件返回 422', async () => {
  const r = await fetch(`${BASE}/api/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: 'a.txt', data: '' }),
  })
  assert.equal(r.status, 422)
})

test('POST /api/search 参数校验：无可用来源 / 无关键词', async () => {
  const noSource = await fetch(`${BASE}/api/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile: PROFILE, query: 'python', sources: ['boss'] }),
  })
  assert.equal(noSource.status, 400)

  const noQuery = await fetch(`${BASE}/api/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile: { ...PROFILE, title: '' }, query: '', sources: ['v2ex'] }),
  })
  assert.equal(noQuery.status, 400)
})

test('POST /api/import-jd 拒绝非 http 链接', async () => {
  const r = await fetch(`${BASE}/api/import-jd`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'ftp://example.com/jd' }),
  })
  assert.equal(r.status, 422)
})

test('管理接口：401 / 保存 cookie 只回掩码 / 清除', async () => {
  const no = await fetch(`${BASE}/api/admin/sources`)
  assert.equal(no.status, 401)

  const headers = { 'Content-Type': 'application/json', 'X-Admin-Token': 'test-token' }
  const before = await (await fetch(`${BASE}/api/admin/sources`, { headers })).json()
  assert.equal(before.auth.find((a) => a.id === 'boss').configured, false)
  assert.equal(before.auth.find((a) => a.id === 'maimai').configured, true)

  const cookie = '__zp_stoken__=supersecret123456; bst=abc'
  const save = await fetch(`${BASE}/api/admin/sources`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ source: 'boss', cookie, ua: 'Mozilla/5.0 Test' }),
  })
  assert.equal(save.status, 200)
  const saved = await save.json()
  assert.equal(saved.auth.configured, true)
  assert.ok(!JSON.stringify(saved).includes('supersecret123456'))
  const list = await (await fetch(`${BASE}/api/sources`)).json()
  assert.ok(list.sources.some((s) => s.id === 'boss'))

  const clear = await fetch(`${BASE}/api/admin/sources`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ source: 'boss', clear: true }),
  })
  assert.equal(clear.status, 200)
  const after = await clear.json()
  assert.equal(after.auth.configured, false)
})

test('GET /api/search 查询串兼容：空关键词 / 无可用来源 400', async () => {
  const empty = await fetch(`${BASE}/api/search?q=&city=北京`)
  assert.equal(empty.status, 400)
  const noSource = await fetch(`${BASE}/api/search?q=Python&city=北京&sources=boss`)
  assert.equal(noSource.status, 400)
})

test('GET /api/admin/exit：401 / 未配置 2s 内返回 offline', async () => {
  const no = await fetch(`${BASE}/api/admin/exit`)
  assert.equal(no.status, 401)

  const headers = { 'X-Admin-Token': 'test-token' }
  const t0 = Date.now()
  const r = await fetch(`${BASE}/api/admin/exit`, { headers })
  const elapsed = Date.now() - t0
  assert.equal(r.status, 200)
  const d = await r.json()
  assert.equal(d.ok, true)
  assert.equal(d.configured, false)
  assert.equal(d.online, false)
  assert.equal(d.error, 'not-configured')
  assert.match(d.checkedAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.ok(elapsed < 2_000, `exit endpoint should be fast, got ${elapsed}ms`)
})
