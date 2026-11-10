import test from 'node:test'
import assert from 'node:assert/strict'
import { parseJD, parseProfile, parseSalary, parseYears, parseEducation, splitJDs, findRedFlags } from '../lib/parse.js'
import { scoreOne } from '../lib/score.js'

const SAMPLE_AI = `AI 应用工程师
某 AI 创业公司 · 北京 · 25-40K·14薪

岗位职责
1. 负责大模型应用（RAG、Agent、知识库）的设计与落地；
2. 用 Python / FastAPI 搭建推理服务与业务 API；
3. 与产品一起做效果评估、badcase 分析与迭代；
4. 参与向量检索、Prompt 工程与模型选型。

任职要求
1. 本科及以上学历，3-5 年后端或 AI 应用开发经验；
2. 精通 Python，熟悉 FastAPI、Redis、MySQL；
3. 熟悉 RAG、LangChain、向量数据库（Milvus / pgvector）；
4. 熟悉 Docker / Kubernetes，有线上服务经验；
5. 有 LLM 应用落地经验优先。`

const SAMPLE_OUTSOURCE = `AI 训练师（外包驻场）
某数据服务公司 · 北京 · 10-15K

岗位职责
1. 负责大模型语料标注、质量抽检；
2. 按项目排期完成标注任务；
3. 一人多岗，兼顾部分运营支持工作。

任职要求
1. 大专及以上学历，1-3 年相关经验；
2. 熟悉 Excel，打字速度快；
3. 能接受大小周，抗压能力强；
4. 有数据标注经验优先。`

test('parseYears: 常见写法', () => {
  assert.deepEqual(
    { min: parseYears('3-5年后端开发经验').min, max: parseYears('3-5年后端开发经验').max },
    { min: 3, max: 5 },
  )
  assert.equal(parseYears('5年以上工作经验').min, 5)
  assert.equal(parseYears('5年以上工作经验').max, null)
  assert.deepEqual(
    { min: parseYears('1年以内').min, max: parseYears('1年以内').max },
    { min: 0, max: 1 },
  )
  assert.equal(parseYears('经验不限').unlimited, true)
  assert.equal(parseYears('公司成立于 2018 年'), null)
})

test('parseSalary: 月薪 / 年薪 / 日薪 / 面议', () => {
  const a = parseSalary('20-40K·15薪')
  assert.equal(a.min, 20)
  assert.equal(a.max, 40)
  assert.equal(a.months, 15)
  const b = parseSalary('15k-25k')
  assert.equal(b.min, 15)
  assert.equal(b.max, 25)
  const c = parseSalary('年薪30-60万')
  assert.equal(c.min, 25)
  assert.equal(c.max, 50)
  const d = parseSalary('200-300元/天')
  assert.equal(Math.round(d.min), 4)
  assert.equal(parseSalary('薪资面议').negotiable, true)
})

test('parseEducation: 取最低硬门槛', () => {
  assert.equal(parseEducation('本科及以上学历，硕士优先').level, '本科')
  assert.equal(parseEducation('硕士及以上学历').level, '硕士')
  assert.equal(parseEducation('学历不限').level, '不限')
  assert.equal(parseEducation('大专以上').level, '大专')
})

test('parseJD: 标题 / 公司 / 城市 / 薪资 / 技能 / 风险', () => {
  const jd = parseJD(SAMPLE_AI)
  assert.equal(jd.title, 'AI 应用工程师')
  assert.equal(jd.company, '某 AI 创业公司')
  assert.equal(jd.city, '北京')
  assert.equal(jd.salary.min, 25)
  assert.equal(jd.salary.max, 40)
  assert.equal(jd.salary.months, 14)
  assert.equal(jd.years.min, 3)
  assert.equal(jd.years.max, 5)
  assert.equal(jd.education.level, '本科')
  const ids = jd.skills.map((s) => s.id)
  for (const id of ['python', 'fastapi', 'redis', 'mysql', 'rag', 'langchain', 'vectordb', 'docker', 'kubernetes', 'llm']) {
    assert.ok(ids.includes(id), `缺少技能 ${id}`)
  }
  assert.equal(jd.redFlags.length, 0)
})

test('findRedFlags: 外包 / 大小周 / 一人多岗 / 抗压', () => {
  const labels = findRedFlags(SAMPLE_OUTSOURCE).map((f) => f.label)
  assert.ok(labels.includes('外包/驻场'))
  assert.ok(labels.includes('加班文化'))
  assert.ok(labels.includes('职责过杂'))
  assert.ok(labels.includes('高压文化'))
})

test('splitJDs: --- 分隔', () => {
  const parts = splitJDs(`${SAMPLE_AI}\n---\n${SAMPLE_OUTSOURCE}`)
  assert.equal(parts.length, 2)
  assert.match(parts[0], /AI 应用工程师/)
  assert.match(parts[1], /外包驻场/)
})

test('parseProfile: 从简历抽技能 / 年限 / 学历 / 城市', () => {
  const p = parseProfile({
    title: 'AI 应用工程师',
    resumeText: '5 年后端经验，本科，北京。Python FastAPI Ray Kubernetes Docker Redis MySQL RAG LangChain Milvus',
  })
  assert.equal(p.years, 5)
  assert.equal(p.education, '本科')
  assert.deepEqual(p.cities, ['北京'])
  assert.ok(p.skills.includes('python'))
  assert.ok(p.skills.includes('kubernetes'))
})

test('scoreOne: 高匹配 JD 应该强投或可投', () => {
  const profile = parseProfile({
    title: 'AI 应用工程师',
    years: '5',
    education: '本科',
    city: '北京',
    salaryMin: '25',
    salaryMax: '40',
    resumeText: 'Python FastAPI Ray Kubernetes Docker Redis MySQL RAG LangChain Milvus LLM Prompt Agent',
  })
  const jd = parseJD(SAMPLE_AI)
  const r = scoreOne(profile, jd)
  assert.ok(r.score >= 65, `分数 ${r.score} 偏低`)
  assert.ok(['strong', 'ok'].includes(r.verdict))
  assert.equal(r.hardFail, false)
  assert.equal(r.gates.find((g) => g.key === 'years').status, 'pass')
  assert.equal(r.gates.find((g) => g.key === 'edu').status, 'pass')
})

test('scoreOne: 年限不够硬门槛封顶 50', () => {
  const profile = parseProfile({
    title: '后端工程师',
    years: '1',
    education: '本科',
    city: '北京',
    salaryMin: '20',
    salaryMax: '30',
    resumeText: 'Python FastAPI Redis MySQL',
  })
  const r = scoreOne(profile, parseJD(SAMPLE_AI))
  assert.equal(r.hardFail, true)
  assert.ok(r.score <= 50, `分数 ${r.score} 应封顶`)
  assert.ok(['maybe', 'no'].includes(r.verdict))
})

test('scoreOne: 薪资明显低于期望会扣分', () => {
  const profile = parseProfile({
    title: 'AI 训练师',
    years: '3',
    education: '本科',
    city: '北京',
    salaryMin: '50',
    salaryMax: '60',
    resumeText: 'Excel 数据标注 运营',
  })
  const r = scoreOne(profile, parseJD(SAMPLE_OUTSOURCE))
  assert.equal(r.gates.find((g) => g.key === 'salary').status, 'fail')
  assert.ok(r.redFlags.length >= 3)
  assert.ok(r.score < 50)
})

test('scoreOne: AI 分只占 45%', () => {
  const profile = parseProfile({
    title: 'AI 应用工程师',
    years: '5',
    education: '本科',
    city: '北京',
    salaryMin: '25',
    salaryMax: '40',
    resumeText: 'Python FastAPI Kubernetes Docker Redis MySQL RAG LangChain Milvus',
  })
  const jd = parseJD(SAMPLE_AI)
  const rule = scoreOne(profile, jd)
  const withAI = scoreOne(profile, jd, { score: 100, verdict: 'strong', reasons: [], resume_keywords: [], questions: [], must_have: [], missing: [], risks: [] })
  assert.equal(withAI.aiScore, 100)
  assert.ok(withAI.score > rule.score)
  assert.equal(withAI.ruleScore, rule.ruleScore)
  assert.ok(withAI.score <= Math.round(rule.ruleScore * 0.55 + 100 * 0.45) + 1)
})
