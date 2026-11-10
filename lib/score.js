/**
 * 确定性打分：先过硬门槛，再算加权匹配，最后才和 AI 分混合。
 * 规则层永远可用；AI 只是加分项，不接管结论。
 */
import { clamp } from './text.js'

export const VERDICTS = {
  strong: { label: '强投', color: 'green' },
  ok: { label: '可投', color: 'blue' },
  maybe: { label: '观望', color: 'amber' },
  no: { label: '不建议', color: 'red' },
}

const STATUS_SCORE = {
  years: { pass: 100, warn: 75, fail: 0, unknown: 60 },
  edu: { pass: 100, warn: 85, fail: 0, unknown: 60 },
  city: { pass: 100, warn: 45, unknown: 60 },
  salary: { pass: 100, warn: 65, fail: 25, unknown: 60 },
}

function gate(key, label, status, detail) {
  return { key, label, status, detail }
}

function pct(n) {
  return `${Math.round(n * 100)}%`
}

function scoreYears(profile, jd) {
  if (!jd.years) return gate('years', '年限', 'unknown', 'JD 未写年限')
  if (jd.years.unlimited) return gate('years', '年限', 'pass', '经验不限')
  if (profile.years == null) return gate('years', '年限', 'unknown', '你还没填工作年限')
  const { min, max, raw } = jd.years
  if (profile.years < min) {
    return gate('years', '年限', 'fail', `你 ${profile.years} 年，要求 ${raw}`)
  }
  if (max != null && profile.years > max + 3) {
    return gate('years', '年限', 'warn', `你 ${profile.years} 年，高于 ${raw}，可能 overqualified`)
  }
  return gate('years', '年限', 'pass', `你 ${profile.years} 年，符合 ${raw}`)
}

function scoreEdu(profile, jd) {
  if (!jd.education || jd.education.level === '不限') {
    return gate('edu', '学历', 'pass', jd.education?.raw || '学历不限')
  }
  if (profile.eduRank == null) return gate('edu', '学历', 'unknown', '你还没填学历')
  if (profile.eduRank < jd.education.rank) {
    return gate('edu', '学历', 'fail', `你 ${profile.education}，要求 ${jd.education.raw}`)
  }
  if (profile.eduRank > jd.education.rank + 1) {
    return gate('edu', '学历', 'warn', `你 ${profile.education}，高于 ${jd.education.raw}`)
  }
  return gate('edu', '学历', 'pass', `你 ${profile.education}，符合 ${jd.education.raw}`)
}

function scoreCity(profile, jd) {
  if (!jd.city) return gate('city', '城市', 'unknown', 'JD 未写城市')
  if (jd.city === '远程') {
    return profile.remoteOk
      ? gate('city', '城市', 'pass', '远程岗位')
      : gate('city', '城市', 'warn', '远程岗位，但你没勾选「接受远程」')
  }
  if (!profile.cities?.length) return gate('city', '城市', 'unknown', '你还没填城市')
  if (profile.remoteOk && /远程|remote/i.test(jd.raw)) return gate('city', '城市', 'pass', '支持远程')
  const hit = profile.cities.some((c) => c === jd.city || jd.city.includes(c) || c.includes(jd.city))
  if (hit) return gate('city', '城市', 'pass', `同在 ${jd.city}`)
  return gate('city', '城市', 'warn', `JD 在 ${jd.city}，你在 ${profile.cities.join('/')}`)
}

function scoreSalary(profile, jd) {
  if (!jd.salary) return gate('salary', '薪资', 'unknown', 'JD 未写薪资')
  if (jd.salary.negotiable) return gate('salary', '薪资', 'warn', '薪资面议')
  const pMin = profile.salaryMin
  const pMax = profile.salaryMax
  if (pMin == null && pMax == null) return gate('salary', '薪资', 'unknown', '你还没填期望薪资')
  const lo = pMin ?? pMax
  const hi = pMax ?? pMin
  if (jd.salary.max >= lo && jd.salary.min <= hi) {
    return gate('salary', '薪资', 'pass', `${jd.salary.raw}，与期望 ${lo}-${hi}K 有交集`)
  }
  if (jd.salary.min > hi) {
    return gate('salary', '薪资', 'pass', `${jd.salary.raw}，高于期望 ${lo}-${hi}K`)
  }
  const gap = (lo - jd.salary.max) / lo
  if (gap > 0.15) {
    return gate('salary', '薪资', 'fail', `${jd.salary.raw}，低于期望 ${lo}-${hi}K 约 ${pct(gap)}`)
  }
  return gate('salary', '薪资', 'warn', `${jd.salary.raw}，略低于期望 ${lo}-${hi}K`)
}

function skillStats(profile, jd) {
  const list = jd.skills || []
  const profileSkills = profile.skills || []
  const set = new Set(profileSkills)
  const hit = list.filter((s) => set.has(s.id))
  const missing = list.filter((s) => !set.has(s.id))
  const totalWeight = list.reduce((n, s) => n + (s.weight || 1), 0)
  const hitWeight = hit.reduce((n, s) => n + (s.weight || 1), 0)
  const unknown = profileSkills.length === 0 && list.length > 0
  return {
    hit: unknown ? [] : hit,
    missing: unknown ? [] : missing,
    mustMissing: unknown ? [] : missing.filter((s) => (s.weight || 1) >= 2),
    coverage: totalWeight && !unknown ? hitWeight / totalWeight : null,
    hitWeight,
    totalWeight,
    unknown,
  }
}

function confidenceOf(profile, jd, skill) {
  let known = 0
  if (profile.years != null) known++
  if (profile.eduRank != null) known++
  if (profile.cities?.length) known++
  if (profile.salaryMin != null || profile.salaryMax != null) known++
  if (profile.skills?.length) known++
  if (jd.years) known++
  if (jd.education) known++
  if (jd.salary) known++
  if (jd.city) known++
  if (skill.coverage != null) known++
  if (jd.stats?.chars >= 300) known++
  if (known >= 9) return 'high'
  if (known >= 6) return 'medium'
  return 'low'
}

export function scoreOne(profile, jd, ai = null) {
  const skill = skillStats(profile, jd)
  const gates = [scoreYears(profile, jd), scoreEdu(profile, jd), scoreCity(profile, jd), scoreSalary(profile, jd)]

  const skillScore = skill.coverage == null ? 55 : skill.coverage * 100
  const byKey = Object.fromEntries(gates.map((g) => [g.key, g]))
  const yearsScore = STATUS_SCORE.years[byKey.years.status]
  const eduScore = STATUS_SCORE.edu[byKey.edu.status]
  const cityScore = STATUS_SCORE.city[byKey.city.status]
  const salaryScore = STATUS_SCORE.salary[byKey.salary.status]

  const base =
    0.45 * skillScore +
    0.2 * yearsScore +
    0.1 * eduScore +
    0.1 * cityScore +
    0.15 * salaryScore

  const penalty = Math.min(30, (jd.redFlags || []).reduce((n, f) => n + f.weight, 0))
  let ruleScore = clamp(Math.round(base - penalty), 0, 100)

  const hardFail = byKey.years.status === 'fail' || byKey.edu.status === 'fail'
  if (hardFail) ruleScore = Math.min(ruleScore, 45)

  const aiScore = ai && Number.isFinite(Number(ai.score)) ? clamp(Math.round(Number(ai.score)), 0, 100) : null
  let finalScore = aiScore == null ? ruleScore : clamp(Math.round(ruleScore * 0.55 + aiScore * 0.45), 0, 100)
  if (hardFail) finalScore = Math.min(finalScore, 50)

  let verdict = finalScore >= 80 ? 'strong' : finalScore >= 65 ? 'ok' : finalScore >= 50 ? 'maybe' : 'no'
  if (hardFail && verdict === 'strong') verdict = 'ok'
  // 没填技能时不给「强投」——技能覆盖是空的，别把结论说满
  if (skill.unknown && verdict === 'strong') verdict = 'ok'

  const reasons = []
  if (skill.unknown) {
    reasons.push('你还没填技能，技能分按中性处理')
  } else if (skill.coverage != null) {
    reasons.push(`技能命中 ${skill.hit.length}/${jd.skills.length}（加权 ${pct(skill.coverage)}）`)
  } else {
    reasons.push('JD 里没识别到技能关键词，技能分按中性处理')
  }
  reasons.push(`${byKey.years.detail}`)
  reasons.push(`${byKey.edu.detail}`)
  reasons.push(`${byKey.city.detail}`)
  reasons.push(`${byKey.salary.detail}`)
  if (jd.redFlags?.length) {
    reasons.push(`风险 ${jd.redFlags.length} 项：${jd.redFlags.map((f) => f.label).join('、')}`)
  }

  return {
    score: finalScore,
    ruleScore,
    aiScore,
    verdict,
    verdictLabel: VERDICTS[verdict].label,
    hardFail,
    gates,
    skill: {
      hit: skill.hit.map((s) => s.name),
      missing: skill.missing.map((s) => s.name),
      mustMissing: skill.mustMissing.map((s) => s.name),
      coverage: skill.coverage,
      hitWeight: skill.hitWeight,
      totalWeight: skill.totalWeight,
      unknown: skill.unknown,
    },
    redFlags: jd.redFlags || [],
    reasons,
    confidence: confidenceOf(profile, jd, skill),
    ai: ai || null,
  }
}
