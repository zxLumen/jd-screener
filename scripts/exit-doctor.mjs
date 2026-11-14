#!/usr/bin/env node
/**
 * 出口体检 CLI：经当前出口探 10 个招聘源，产出解锁矩阵。
 *
 * 用法：
 *   npm run exit:doctor                         # 用 JD_EXIT_PROXY；没配就直连
 *   npm run exit:doctor -- --direct             # 强制直连（对照组）
 *   npm run exit:doctor -- --proxy socks5h://127.0.0.1:1080
 *   npm run exit:doctor -- --out reports/2026-11-14-exit-matrix
 *
 * 只记录 status / 耗时 / 大小 / 风控特征，不落盘页面正文。
 */
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  classifySource,
  exitTarget,
  probeExit,
  requestDirect,
  requestViaProxy,
  resetExitCache,
  EXIT_TIMEOUT_MS,
} from '../lib/exit.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

const SOURCES = [
  {
    id: 'liepin',
    name: '猎聘',
    url: 'https://www.liepin.com/city-bj/zhaopin/?key=Python',
  },
  {
    id: 'linkedin',
    name: 'LinkedIn',
    url: 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=Python&location=Beijing%2C%20China&start=0',
  },
  {
    id: 'v2ex',
    name: 'V2EX 酷工作',
    url: 'https://www.v2ex.com/api/topics/show.json?node_name=jobs',
  },
  {
    id: 'eleduck',
    name: '电鸭社区',
    url: 'https://svc.eleduck.com/api/v1/posts?category=5&page=1&page_size=5',
    accept: 'application/json',
  },
  {
    id: 'jobui',
    name: '职友集',
    url: 'https://www.jobui.com/rss/job/?rss=jobKw%40Python%7CcityKw%40%E5%8C%97%E4%BA%AC',
  },
  {
    id: 'maimai',
    name: '脉脉',
    url: 'https://maimai.cn/n/platform/job-list?page=1&direction=development&city=%E5%8C%97%E4%BA%AC',
  },
  {
    id: 'zhaopin',
    name: '智联招聘',
    url: 'https://www.zhaopin.com/sou/jl530/kwPython',
  },
  {
    id: '51job',
    name: '前程无忧',
    url: 'https://we.51job.com/pc/search?keyword=Python&jobArea=010000',
  },
  {
    id: 'lagou',
    name: '拉勾',
    url: 'https://www.lagou.com/wn/jobs?kd=Python&city=%E5%8C%97%E4%BA%AC',
  },
  {
    id: 'boss',
    name: 'BOSS直聘',
    url: 'https://www.zhipin.com/wapi/zpgeek/search/joblist.json?scene=1&query=Python&city=101010100&page=1&pageSize=5',
    accept: 'application/json, text/plain, */*',
  },
]

const VERDICT_LABEL = {
  unlocked: '✅ 解锁',
  blocked: '⛔ 风控',
  'need-login': '🔑 需登录',
  unknown: '❔ 未识别',
  error: '⚠️ 错误',
  timeout: '⏱ 超时',
}

function usage() {
  return `用法: node scripts/exit-doctor.mjs [--direct] [--proxy <url>] [--out <base>] [--timeout <ms>] [--label <text>]

  --direct         不经过出口，直连（对照组）
  --proxy <url>    临时指定出口，如 socks5h://127.0.0.1:1080 或 unix:/run/jd-exit/bridge.sock
  --out <base>     输出文件前缀，默认 reports/exit-matrix-<日期>
  --timeout <ms>   单源超时，默认 8000
  --label <text>   矩阵标题里的出口标签
`
}

function parseArgs(argv) {
  const out = { direct: false, proxy: '', out: '', timeout: 8_000, label: '', json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--direct') out.direct = true
    else if (a === '--json') out.json = true
    else if (a === '--help' || a === '-h') out.help = true
    else if (a === '--proxy') out.proxy = String(argv[++i] || '')
    else if (a === '--out') out.out = String(argv[++i] || '')
    else if (a === '--timeout') out.timeout = Math.max(1_000, Number(argv[++i]) || 8_000)
    else if (a === '--label') out.label = String(argv[++i] || '')
    else if (!a.startsWith('-')) out.out = a
  }
  return out
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = cursor++
      if (i >= items.length) return
      out[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return out
}

function bjDate() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

function mdCell(s) {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ')
}

function summarize(rows) {
  const count = {}
  for (const r of rows) count[r.verdict] = (count[r.verdict] || 0) + 1
  return count
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(usage())
    return
  }
  if (args.proxy) {
    process.env.JD_EXIT_PROXY = args.proxy
    resetExitCache()
  }
  const direct = args.direct || !exitTarget()
  const target = direct ? null : exitTarget()
  const label = args.label || (direct ? '直连（未配置出口）' : target?.label || '出口')
  const outBase = path.resolve(ROOT, args.out || path.join('reports', `exit-matrix-${bjDate()}`))

  let exit = {
    configured: false,
    online: false,
    ip: null,
    location: '',
    beijing: false,
    latencyMs: null,
    error: direct ? 'direct' : 'not-configured',
    checkedAt: new Date().toISOString(),
  }
  if (!direct) {
    exit = await probeExit({ timeoutMs: EXIT_TIMEOUT_MS, target, useCache: false })
  }

  process.stdout.write(`出口: ${label}\n`)
  if (exit.configured) {
    process.stdout.write(
      `状态: ${exit.online ? 'online' : 'offline'} · ${exit.ip || '-'} · ${exit.location || '-'} · ${exit.latencyMs}ms${exit.error ? ` · ${exit.error}` : ''}\n`,
    )
  } else {
    process.stdout.write('状态: 未配置出口，直连探测\n')
  }

  const startedAt = new Date().toISOString()
  const rows = await mapLimit(SOURCES, 3, async (src, i) => {
    const t0 = Date.now()
    try {
      const res = target
        ? await requestViaProxy(target, src.url, { timeoutMs: args.timeout, ua: UA, accept: src.accept })
        : await requestDirect(src.url, { timeoutMs: args.timeout, ua: UA, accept: src.accept })
      const cls = classifySource(src.id, { status: res.status, body: res.body })
      const row = {
        i: i + 1,
        id: src.id,
        name: src.name,
        url: src.url,
        finalUrl: res.url,
        status: res.status,
        ms: Date.now() - t0,
        bytes: Buffer.byteLength(res.body || ''),
        verdict: cls.verdict,
        feature: cls.feature,
      }
      process.stdout.write(
        `${String(row.i).padStart(2)} ${src.name.padEnd(8)} ${String(row.status).padStart(3)} ${String(row.ms).padStart(5)}ms ${VERDICT_LABEL[row.verdict] || row.verdict} · ${row.feature}\n`,
      )
      return row
    } catch (e) {
      const cls = classifySource(src.id, { error: e?.code || e?.message || 'error' })
      const row = {
        i: i + 1,
        id: src.id,
        name: src.name,
        url: src.url,
        finalUrl: '',
        status: 0,
        ms: Date.now() - t0,
        bytes: 0,
        verdict: cls.verdict,
        feature: cls.feature,
      }
      process.stdout.write(
        `${String(row.i).padStart(2)} ${src.name.padEnd(8)} ${String(row.status).padStart(3)} ${String(row.ms).padStart(5)}ms ${VERDICT_LABEL[row.verdict] || row.verdict} · ${row.feature}\n`,
      )
      return row
    }
  })

  const count = summarize(rows)
  const conclusion = Object.entries(count)
    .map(([k, v]) => `${VERDICT_LABEL[k] || k} ${v}`)
    .join(' / ')
  const finishedAt = new Date().toISOString()

  const payload = {
    ok: true,
    label,
    direct,
    exit,
    startedAt,
    finishedAt,
    timeoutMs: args.timeout,
    sources: rows,
    summary: count,
    conclusion,
  }

  await fs.mkdir(path.dirname(outBase), { recursive: true })
  await fs.writeFile(`${outBase}.json`, JSON.stringify(payload, null, 2))
  const md = [
    `# 出口解锁矩阵 · ${bjDate()}`,
    '',
    `- 出口：**${label}**`,
    `- 状态：${exit.configured ? (exit.online ? 'online' : 'offline') : '未配置（直连）'}${exit.ip ? ` · \`${exit.ip}\`` : ''}${exit.location ? ` · ${exit.location}` : ''}${exit.latencyMs != null ? ` · 探测 ${exit.latencyMs}ms` : ''}${exit.error ? ` · ${exit.error}` : ''}`,
    `- 时间：${startedAt} → ${finishedAt}`,
    `- 单源超时：${args.timeout}ms；只记录状态/耗时/特征，不落盘正文`,
    '',
    '| # | 源 | status | 耗时 | 大小 | 判定 | 风控/特征 |',
    '| --- | --- | ---: | ---: | ---: | --- | --- |',
    ...rows.map(
      (r) =>
        `| ${r.i} | ${mdCell(r.name)} | ${r.status || '-'} | ${r.ms}ms | ${r.bytes}B | ${VERDICT_LABEL[r.verdict] || r.verdict} | ${mdCell(r.feature)} |`,
    ),
    '',
    `**结论**：${conclusion}`,
    '',
  ].join('\n')
  await fs.writeFile(`${outBase}.md`, md)

  if (args.json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n')
  } else {
    process.stdout.write(`\n结论: ${conclusion}\n`)
    process.stdout.write(`已写入: ${path.relative(ROOT, outBase)}.md / .json\n`)
  }
}

main().catch((e) => {
  process.stderr.write(`exit-doctor 失败: ${e?.stack || e}\n`)
  process.exit(1)
})
