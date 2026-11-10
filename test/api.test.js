import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const PORT = 18879
const BASE = `http://127.0.0.1:${PORT}`

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
    env: { ...process.env, PORT: String(PORT), ZX_AI_APP_TOKEN: '', ZX_AI_GATEWAY_URL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => (logs += d))
  child.stderr.on('data', (d) => (logs += d))
  await waitHealth()
})

after(() => {
  child?.kill('SIGTERM')
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
  assert.ok(d.unavailable.some((s) => s.id === 'boss' && /未接/.test(s.note)))
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
