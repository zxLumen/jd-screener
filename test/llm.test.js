import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { parseJD, parseProfile } from '../lib/parse.js'
import * as llm from '../lib/llm.js'

const PORT = 18880
let server
let calls = 0

const PROFILE = parseProfile({
  title: 'AI 应用工程师',
  years: '5',
  education: '本科',
  city: '北京',
  salaryMin: '25',
  salaryMax: '40',
  resumeText: 'Python FastAPI Kubernetes Docker Redis MySQL RAG LangChain Milvus',
})

function jdText(tag) {
  return `AI 应用工程师 ${tag}
某公司 · 北京 · 25-40K

岗位职责
1. 负责大模型应用落地。

任职要求
1. 本科及以上学历，3-5 年后端经验；
2. 熟悉 Python、FastAPI、RAG、LangChain、Docker。`
}

before(async () => {
  server = http.createServer((req, res) => {
    calls++
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        model: 'mock-model',
        choices: [
          {
            message: {
              content: JSON.stringify({
                score: 88,
                verdict: 'strong',
                must_have: ['Python', 'RAG'],
                missing: ['Kubernetes 生产经验'],
                risks: [{ signal: '创业公司', why: '稳定性未知' }],
                reasons: ['技能命中 5/5', '年限符合 3-5 年', '有 LLM 落地经验'],
                resume_keywords: ['RAG 召回率', 'Agent 编排'],
                questions: ['线上 QPS 多少？', '效果怎么评估？', '团队几人？'],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 1200, completion_tokens: 300 },
      }),
    )
  })
  await new Promise((resolve) => server.listen(PORT, resolve))
  process.env.ZX_AI_GATEWAY_URL = `http://127.0.0.1:${PORT}/api/ai/v1`
  process.env.ZX_AI_APP_TOKEN = 'test-token'
  delete process.env.JD_MODEL
})

after(() => {
  server?.close()
  delete process.env.ZX_AI_GATEWAY_URL
  delete process.env.ZX_AI_APP_TOKEN
})

test('sanitizeAI: 分数与数组被收敛', () => {
  const a = llm.sanitizeAI({
    score: 120,
    verdict: 'strong',
    must_have: ['A', 'A', 'B'],
    missing: 'not-array',
    risks: ['字符串风险'],
    reasons: ['r1'],
    resume_keywords: ['k1', 'k2'],
    questions: ['q1'],
  })
  assert.equal(a.score, 100)
  assert.deepEqual(a.must_have, ['A', 'B'])
  assert.deepEqual(a.missing, [])
  assert.equal(a.risks[0].signal, '字符串风险')
  assert.equal(llm.sanitizeAI({ verdict: 'strong' }), null)
})

test('screen: 走网关、解析 JSON、写入缓存', async () => {
  const jd = parseJD(jdText('缓存测试'))
  const r1 = await llm.screen(PROFILE, jd)
  assert.equal(r1.ai.score, 88)
  assert.equal(r1.ai.verdict, 'strong')
  assert.equal(r1.usage.promptTokens, 1200)
  assert.equal(r1.model, 'mock-model')
  const r2 = await llm.screen(PROFILE, jd)
  assert.equal(r2.cached, true)
  assert.equal(r2.ai.score, 88)
  assert.equal(calls, 1, '第二次应命中缓存，不再请求网关')
})

test('screen: beforeCall=false 时不发请求', async () => {
  const jd = parseJD(jdText('限流测试'))
  const before = calls
  const r = await llm.screen(PROFILE, jd, { beforeCall: () => false })
  assert.equal(r.skipped, 'rate-limit')
  assert.equal(calls, before)
})
