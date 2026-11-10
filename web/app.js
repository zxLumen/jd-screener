/* 对位 · 前端（原生 ES module，零构建） */
const $ = (s, r = document) => r.querySelector(s)
const $$ = (s, r = document) => [...r.querySelectorAll(s)]

const LS = {
  profile: 'duiwei.profile.v1',
  jds: 'duiwei.jds.v1',
  last: 'duiwei.last.v1',
  ai: 'duiwei.useai.v1',
}
const MAX_JDS = 8
const VERDICTS = [
  ['all', '全部'],
  ['strong', '强投'],
  ['ok', '可投'],
  ['maybe', '观望'],
  ['no', '不建议'],
]
const FALLBACK_SOURCES = [
  { id: 'liepin', name: '猎聘', region: '中国', enabled: true, note: '公开列表 + 详情页' },
  { id: 'linkedin', name: 'LinkedIn', region: '中国/全球', enabled: true, note: 'guest 公开职位接口' },
  { id: 'v2ex', name: 'V2EX 酷工作', region: '中国', enabled: true, note: '公开 API' },
  { id: 'eleduck', name: '电鸭社区', region: '远程', enabled: true, note: '公开 API' },
  { id: 'remoteok', name: 'Remote OK', region: '全球远程', enabled: false, note: '英文远程岗' },
]
const FALLBACK_UNAVAILABLE = [
  { id: 'boss', name: 'BOSS直聘', note: '未接：接口返回 code 37（环境异常）' },
  { id: 'mimai', name: '脉脉', note: '未接：搜索需登录' },
]

const state = {
  profile: load(LS.profile, null),
  jds: load(LS.jds, []),
  results: [],
  filter: 'all',
  onlyPass: false,
  running: false,
  abort: null,
  elapsedMs: 0,
  ai: false,
  startedAt: null,
  searching: false,
  searchAbort: null,
  searchMeta: null,
  uploading: false,
  aiBusy: new Set(),
  sources: [],
  unavailable: [],
  lastTitle: '',
}

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* 隐私模式或超额，忽略 */
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

function firstLine(text) {
  const line = String(text || '')
    .split('\n')
    .map((s) => s.trim())
    .find(Boolean)
  return (line || '未命名 JD').slice(0, 60)
}

function fmtTime(ts) {
  try {
    return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

function fmtDate(v) {
  if (!v) return ''
  try {
    return new Date(v).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
  } catch {
    return ''
  }
}

let toastTimer = null
function toast(msg, ms = 2800) {
  const el = $('#toast')
  el.textContent = msg
  el.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    el.hidden = true
  }, ms)
}

async function postJson(url, body, signal) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  let data = null
  try {
    data = await r.json()
  } catch {
    /* ignore */
  }
  if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`)
  return data
}

/* ---------------- 画像 ---------------- */
function profileFromForm() {
  return {
    title: $('#p-title').value.trim(),
    years: $('#p-years').value,
    education: $('#p-edu').value,
    city: $('#p-city').value.trim(),
    salaryMin: $('#p-smin').value,
    salaryMax: $('#p-smax').value,
    remoteOk: $('#p-remote').checked,
    resumeText: $('#p-resume').value,
  }
}

function fillForm(p) {
  if (!p) {
    for (const id of ['#p-title', '#p-years', '#p-city', '#p-smin', '#p-smax', '#p-resume']) $(id).value = ''
    $('#p-edu').value = '本科'
    $('#p-remote').checked = false
    return
  }
  $('#p-title').value = p.title || ''
  $('#p-years').value = p.years ?? ''
  $('#p-edu').value = p.education || '本科'
  $('#p-city').value = p.city || ''
  $('#p-smin').value = p.salaryMin ?? ''
  $('#p-smax').value = p.salaryMax ?? ''
  $('#p-remote').checked = Boolean(p.remoteOk)
  $('#p-resume').value = p.resumeText || ''
}

let previewTimer = null
async function refreshProfilePreview() {
  clearTimeout(previewTimer)
  previewTimer = setTimeout(async () => {
    const p = profileFromForm()
    if (!p.resumeText.trim() && !p.title.trim()) {
      $('#skill-preview').innerHTML = ''
      return
    }
    try {
      const r = await postJson('/api/parse-profile', { profile: p })
      const skills = r.profile?.skills || []
      if (!skills.length) {
        $('#skill-preview').innerHTML = '<span class="tag">还没识别到技能，写具体点</span>'
        return
      }
      const head = `<span class="tag more">识别到 ${skills.length} 项</span>`
      const tags = skills.slice(0, 14).map((s) => `<span class="tag">${esc(s)}</span>`).join('')
      const more = skills.length > 14 ? `<span class="tag more">+${skills.length - 14}</span>` : ''
      $('#skill-preview').innerHTML = head + tags + more
    } catch {
      /* 限流或网络错误时静默 */
    }
  }, 500)
}

function onProfileChange() {
  const p = profileFromForm()
  state.profile = p
  save(LS.profile, p)
  refreshProfilePreview()

  const q = $('#q')
  if (q && p.title && (!q.value.trim() || q.dataset.auto === '1')) {
    q.value = p.title
    q.dataset.auto = '1'
  }
  const qc = $('#q-city')
  if (qc && p.city && (!qc.value.trim() || qc.dataset.auto === '1')) {
    qc.value = p.city.split(/[,，、/|\s]+/)[0] || ''
    qc.dataset.auto = '1'
  }
  state.lastTitle = p.title
}

function fillSampleProfile() {
  const p = {
    title: 'AI 应用工程师',
    years: '5',
    education: '本科',
    city: '北京',
    salaryMin: '25',
    salaryMax: '40',
    remoteOk: true,
    resumeText:
      '后端 / AI 工程化，5 年经验。Python、FastAPI、Ray、Ray Serve、Docker、Kubernetes、Redis、MySQL、Kafka、Linux、CI/CD。' +
      '做过多模态大模型应用、RAG、LangChain、向量数据库、语音识别与语音合成；熟悉 Prometheus / Grafana、Caddy、GitHub Actions。',
  }
  fillForm(p)
  onProfileChange()
  toast('已填入示例画像，可直接搜岗位')
}

/* ---------------- 简历上传 ---------------- */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(String(fr.result || ''))
    fr.onerror = () => reject(new Error('读取文件失败'))
    fr.readAsDataURL(file)
  })
}

async function handleResumeFile(file) {
  if (!file || state.uploading) return
  if (file.size > 5 * 1024 * 1024) return toast('文件最大 5MB')
  state.uploading = true
  const note = $('#resume-note')
  note.textContent = `正在解析 ${file.name}…`
  try {
    const data = await fileToBase64(file)
    const r = await postJson('/api/resume', { filename: file.name, data })
    const p = r.profile || {}
    if (p.title) $('#p-title').value = p.title
    if (p.years != null) $('#p-years').value = p.years
    if (p.education) $('#p-edu').value = p.education
    if (p.cities?.length) $('#p-city').value = p.cities.join(' / ')
    if (p.salaryMin != null) $('#p-smin').value = p.salaryMin
    if (p.salaryMax != null) $('#p-smax').value = p.salaryMax
    $('#p-resume').value = String(r.text || '').slice(0, 12000)
    onProfileChange()
    const skills = p.skills?.length || 0
    const warn = r.meta?.warnings?.length ? ` · ${r.meta.warnings.join('；')}` : ''
    note.textContent = `已解析 ${String(r.meta?.kind || '').toUpperCase()} · ${r.meta?.chars || 0} 字 · 识别 ${skills} 项技能 · ${r.meta?.elapsedMs || 0}ms${warn}`
    toast(`简历已解析：${skills} 项技能，画像已填好`)
  } catch (e) {
    note.textContent = `解析失败：${e.message}`
    toast(`解析失败：${e.message}`, 3600)
  } finally {
    state.uploading = false
    $('#resume-file').value = ''
  }
}

/* ---------------- JD 列表 ---------------- */
function saveJds() {
  save(
    LS.jds,
    state.jds.map((j) => ({ id: j.id, text: j.text })),
  )
}

function renderJdList() {
  const box = $('#jd-list')
  const count = state.jds.length
  $('#jd-count').textContent = `${count} / ${MAX_JDS} 条`
  if (!count) {
    box.innerHTML = '<div class="empty">还没有 JD。粘一段进来，点「添加 JD」。</div>'
  } else {
    box.innerHTML = state.jds
      .map((j) => {
        const meta = j.meta
        const title = meta?.title || firstLine(j.text)
        const bits = []
        if (meta?.company) bits.push(meta.company)
        if (meta?.city) bits.push(meta.city)
        if (meta?.salary?.raw) bits.push(meta.salary.raw)
        if (meta?.years?.raw) bits.push(meta.years.raw)
        if (meta?.redFlags?.length) bits.push(`风险 ${meta.redFlags.length}`)
        const metaLine = bits.length ? bits.join(' · ') : `${j.text.length} 字`
        return `<div class="jd-item">
          <div class="jd-item-main">
            <span class="jd-item-title" title="${esc(title)}">${esc(title)}</span>
            <span class="jd-item-meta">${esc(metaLine)}</span>
          </div>
          <button type="button" data-remove="${esc(j.id)}" aria-label="移除这条 JD">移除</button>
        </div>`
      })
      .join('')
  }
  updateRunUI()
}

async function parseJdPreview(item) {
  try {
    const r = await postJson('/api/parse-jd', { text: item.text })
    item.meta = r.jd
    renderJdList()
  } catch {
    /* 预览失败不影响筛选 */
  }
}

function addJds() {
  const raw = $('#jd-input').value
  if (!raw.trim()) return toast('先把 JD 粘进来')
  const parts = raw
    .split(/\n\s*(?:-{3,}|={3,})\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 20)
  if (!parts.length) return toast('没识别到有效 JD（至少 20 字）')
  const room = MAX_JDS - state.jds.length
  if (room <= 0) return toast(`一次最多 ${MAX_JDS} 条，先移除几条`)
  const take = parts.slice(0, room)
  const now = Date.now()
  for (let i = 0; i < take.length; i++) {
    const item = { id: `jd_${now}_${i}`, text: take[i], meta: null }
    state.jds.push(item)
    parseJdPreview(item)
  }
  if (parts.length > room) toast(`只加了前 ${room} 条，一次最多 ${MAX_JDS} 条`)
  else toast(`已添加 ${take.length} 条 JD`)
  $('#jd-input').value = ''
  saveJds()
  renderJdList()
}

async function importJd() {
  const url = $('#jd-url').value.trim()
  if (!url) return toast('先贴一条公开 JD 链接')
  if (state.jds.length >= MAX_JDS) return toast(`一次最多 ${MAX_JDS} 条，先移除几条`)
  const btn = $('#btn-import')
  btn.disabled = true
  btn.textContent = '导入中…'
  try {
    const r = await postJson('/api/import-jd', { url })
    const item = { id: `jd_${Date.now()}_url`, text: r.text, meta: r.jd, sourceUrl: r.url }
    state.jds.push(item)
    saveJds()
    renderJdList()
    parseJdPreview(item)
    $('#jd-url').value = ''
    const src = { liepin: '猎聘', linkedin: 'LinkedIn', url: '网页' }[r.source] || r.source
    toast(`已从${src}导入：${r.jd?.title || firstLine(r.text)}`)
  } catch (e) {
    toast(`导入失败：${e.message}`, 4200)
  } finally {
    btn.disabled = false
    btn.textContent = '从链接导入'
  }
}

async function loadSamples() {
  try {
    const r = await fetch('/samples.json')
    if (!r.ok) throw new Error('samples')
    const arr = await r.json()
    const room = MAX_JDS - state.jds.length
    if (room <= 0) return toast(`一次最多 ${MAX_JDS} 条，先移除几条`)
    const take = arr.slice(0, room)
    const now = Date.now()
    take.forEach((text, i) => {
      const item = { id: `jd_${now}_s${i}`, text, meta: null }
      state.jds.push(item)
      parseJdPreview(item)
    })
    saveJds()
    renderJdList()
    toast(`已载入 ${take.length} 条示例 JD`)
  } catch {
    toast('示例加载失败')
  }
}

function clearJds() {
  if (!state.jds.length) return
  if (!window.confirm(`清空 ${state.jds.length} 条 JD？`)) return
  state.jds = []
  state.results = []
  state.searchMeta = null
  saveJds()
  renderJdList()
  $('#results').hidden = true
  updateRunUI()
}

/* ---------------- 搜索 ---------------- */
function renderSources() {
  const list = state.sources.length ? state.sources : FALLBACK_SOURCES
  const off = state.unavailable.length ? state.unavailable : FALLBACK_UNAVAILABLE
  $('#source-picker').innerHTML = [
    ...list.map(
      (s) => `<label class="src-opt">
        <input type="checkbox" data-source="${esc(s.id)}" ${s.enabled ? 'checked' : ''} />
        <span class="src-opt-main"><b>${esc(s.name)}</b><small>${esc(s.region)} · ${esc(s.note || '')}</small></span>
      </label>`,
    ),
    ...off.map(
      (s) => `<label class="src-opt off" title="${esc(s.note || '未接')}">
        <input type="checkbox" disabled />
        <span class="src-opt-main"><b>${esc(s.name)}</b><small>未接</small></span>
      </label>`,
    ),
  ].join('')
  $('#source-status').textContent = `已接 ${list.length} · 默认 ${list.filter((s) => s.enabled).length}`
  updateSourceStatus()
}

function selectedSources() {
  return $$('#source-picker input[data-source]')
    .filter((el) => el.checked && !el.disabled)
    .map((el) => el.dataset.source)
}

function updateSourceStatus() {
  const n = selectedSources().length
  $('#btn-search').disabled = state.searching || n === 0
  if (!state.searching) $('#btn-search').textContent = n ? `搜 JD 并匹配（${n} 源）` : '先选来源'
}

function setSearchProgress(text, pct) {
  $('#search-progress').hidden = false
  $('#search-progress-text').textContent = text
  $('#search-progress-bar').style.width = `${pct}%`
}

async function runSearch() {
  if (state.searching) {
    state.searchAbort?.abort()
    return
  }
  const profile = profileFromForm()
  state.profile = profile
  save(LS.profile, profile)
  const sources = selectedSources()
  if (!sources.length) return toast('至少选一个来源')
  const query = $('#q').value.trim() || profile.title
  if (!query) return toast('先填关键词或目标岗位')

  state.searching = true
  state.results = []
  state.searchMeta = null
  state.searchAbort = new AbortController()
  const ctrl = state.searchAbort
  const btn = $('#btn-search')
  btn.dataset.running = 'true'
  btn.textContent = '停止'
  $('#results').hidden = true
  $('#search-note').textContent = ''
  const t0 = Date.now()
  setSearchProgress(`0s · 抓 ${sources.length} 个来源：${sources.join(' / ')}`, 8)
  const tick = setInterval(() => {
    const secs = ((Date.now() - t0) / 1000).toFixed(1)
    setSearchProgress(`${secs}s · 抓取列表 + 补详情中…`, Math.min(92, 8 + Number(secs) * 6))
  }, 500)
  const hardTimeout = setTimeout(() => ctrl.abort(), 90_000)

  try {
    const r = await postJson(
      '/api/search',
      {
        profile,
        query,
        city: $('#q-city').value.trim(),
        sources,
        limit: Number($('#q-limit').value) || 12,
      },
      ctrl.signal,
    )
    state.results = r.results || []
    state.searchMeta = r.meta || null
    state.elapsedMs = r.meta?.elapsedMs || Date.now() - t0
    setSearchProgress(`完成 · ${state.results.length} 条`, 100)
    const diag = (r.meta?.sources || [])
      .map((s) => `${s.name} ${s.count}${s.error ? `（${s.error}）` : ''}`)
      .join(' · ')
    $('#search-note').textContent = `候选 ${r.meta?.candidates || 0} 条，补详情 ${r.meta?.detailed || 0} 条，返回 ${state.results.length} 条 · ${diag}`
    if (!state.results.length) {
      toast('这次没搜到可匹配的岗位，换关键词/城市或加来源', 4200)
      return
    }
    renderResults()
    if ($('#search-ai').checked && state.ai) await aiReviewTop(3)
  } catch (e) {
    if (e.name === 'AbortError') {
      $('#search-note').textContent = '已停止搜索。'
    } else {
      $('#search-note').textContent = `搜索失败：${e.message}`
      toast(`搜索失败：${e.message}`, 4200)
    }
  } finally {
    clearInterval(tick)
    clearTimeout(hardTimeout)
    state.searching = false
    state.searchAbort = null
    btn.dataset.running = 'false'
    $('#search-progress').hidden = true
    updateSourceStatus()
  }
}

/* ---------------- 运行（粘贴模式） ---------------- */
function updateRunUI() {
  const btn = $('#btn-run')
  const count = state.jds.length
  btn.dataset.running = state.running ? 'true' : 'false'
  btn.textContent = state.running ? '停止' : count ? `开始筛选（${count}）` : '开始筛选'
  btn.disabled = !state.running && count === 0
  $('#use-ai').disabled = state.running || !state.ai
  if (!state.running && !state.results.length) $('#progress-wrap').hidden = true
}

function setProgress(done, total) {
  $('#progress-wrap').hidden = false
  const p = total ? Math.round((done / total) * 100) : 0
  $('#progress-bar').style.width = `${p}%`
  $('#progress-text').textContent = `${done} / ${total}`
}

async function run() {
  if (state.running) {
    state.abort?.abort()
    return
  }
  if (!state.jds.length) return toast('先加几条 JD')

  const profile = profileFromForm()
  state.profile = profile
  save(LS.profile, profile)
  const useAI = $('#use-ai').checked && state.ai
  const ctrl = new AbortController()
  state.abort = ctrl
  state.running = true
  state.results = []
  state.searchMeta = null
  state.startedAt = Date.now()
  updateRunUI()
  $('#results').hidden = true
  $('#run-note').textContent = useAI ? '规则层先算，AI 深评中…' : '规则模式，秒出结果…'
  setProgress(0, state.jds.length)

  const results = new Array(state.jds.length)
  let cursor = 0
  let done = 0
  const worker = async () => {
    for (;;) {
      const idx = cursor++
      if (idx >= state.jds.length) return
      const jd = state.jds[idx]
      try {
        const r = await postJson('/api/screen-one', { profile, jd: jd.text, useAI, id: jd.id }, ctrl.signal)
        results[idx] = r.result
      } catch (e) {
        if (e.name === 'AbortError') return
        results[idx] = {
          id: jd.id,
          title: jd.meta?.title || firstLine(jd.text),
          error: e.message || '请求失败',
        }
      } finally {
        if (!ctrl.signal.aborted) {
          done++
          setProgress(done, state.jds.length)
        }
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.min(3, state.jds.length) }, worker))
  } finally {
    state.running = false
    state.abort = null
    state.elapsedMs = Date.now() - state.startedAt
    state.results = results.filter(Boolean).sort((a, b) => (b.score || 0) - (a.score || 0))
    updateRunUI()
    if (ctrl.signal.aborted) {
      $('#run-note').textContent = `已停止，保留 ${state.results.length} 条已完成结果。`
    } else {
      $('#run-note').textContent = ''
    }
    if (state.results.length) {
      renderResults()
      save(LS.last, { at: Date.now(), results: state.results.map(({ text, ...rest }) => rest) })
    } else {
      toast('没有拿到结果，检查一下服务是否正常')
    }
  }
}

/* ---------------- AI 精评 ---------------- */
async function aiReview(r, quiet = false) {
  if (!r || !r.text || state.aiBusy.has(r.id)) return
  state.aiBusy.add(r.id)
  const btn = $(`[data-ai="${CSS.escape(r.id)}"]`)
  if (btn) {
    btn.disabled = true
    btn.textContent = 'AI 评…'
  }
  try {
    const res = await postJson('/api/screen-one', {
      profile: profileFromForm(),
      jd: r.text,
      useAI: true,
      id: r.id,
    })
    Object.assign(r, res.result)
    if (!quiet) renderResults()
    if (!quiet) toast(`AI 精评完成：${r.score} 分`)
  } catch (e) {
    if (!quiet) toast(`AI 精评失败：${e.message}`, 3800)
  } finally {
    state.aiBusy.delete(r.id)
    const b = $(`[data-ai="${CSS.escape(r.id)}"]`)
    if (b) {
      b.disabled = false
      b.textContent = r.ai ? 'AI 已评' : 'AI 精评'
    }
  }
}

async function aiReviewTop(n) {
  const top = state.results.filter((r) => r.text && !r.ai).slice(0, n)
  if (!top.length) return
  $('#search-note').textContent = `AI 精评前 ${top.length} 条…`
  for (const r of top) {
    await aiReview(r, true)
  }
  renderResults()
  $('#search-note').textContent = `AI 精评完成 ${top.length} 条（规则分仍在结果里）`
}

/* ---------------- 结果 ---------------- */
function counts() {
  const c = { all: 0, strong: 0, ok: 0, maybe: 0, no: 0 }
  for (const r of state.results) {
    c.all++
    if (r.verdict && c[r.verdict] != null) c[r.verdict]++
  }
  return c
}

function renderFilters() {
  const c = counts()
  const chips = VERDICTS.map(
    ([k, label]) =>
      `<button type="button" class="chip" data-filter="${k}" aria-pressed="${state.filter === k}">${label} ${c[k] || 0}</button>`,
  ).join('')
  const pass = `<button type="button" class="chip" data-pass="1" aria-pressed="${state.onlyPass}">只看硬门槛通过</button>`
  $('#filters').innerHTML = chips + pass
}

function aiMetaNote(r) {
  if (r.ai) {
    const parts = [`AI ${r.aiScore} 分`, `规则 ${r.ruleScore} 分`]
    if (r.aiMeta?.cached) parts.push('缓存命中')
    return parts.join(' · ')
  }
  const m = r.aiMeta || {}
  if (m.failed) return `AI 调用失败（${m.reason || 'unknown'}），已按规则分`
  if (m.skipped === 'not-configured') return 'AI 未配置，按规则分'
  if (m.skipped === 'rate-limit') return 'AI 触发限流，按规则分'
  if (m.skipped === 'daily-cap') return 'AI 今日额度已用完，按规则分'
  if (m.skipped === 'off') return '未开 AI，按规则分'
  return '规则分（AI 未评）'
}

function confidenceLabel(c) {
  return { high: '高', medium: '中', low: '低' }[c] || '低'
}

function renderResult(r) {
  if (r.error) {
    return `<article class="result" data-verdict="no">
      <div class="score" style="--p:0"><strong>—</strong><small>失败</small></div>
      <div class="r-main">
        <h3 class="r-title">${esc(r.title || '未命名 JD')}</h3>
        <p class="ai-note">${esc(r.error)}</p>
      </div>
    </article>`
  }

  const gates = (r.gates || [])
    .map(
      (g) =>
        `<span class="gate ${esc(g.status)}" title="${esc(g.detail)}"><b>${esc(g.label)}</b> ${esc(g.detail)}</span>`,
    )
    .join('')

  const hit = r.skill?.hit || []
  const missing = r.skill?.missing || []
  const mustMissing = new Set(r.skill?.mustMissing || [])
  const skillUnknown = Boolean(r.skill?.unknown)
  const hitChips = skillUnknown
    ? '<span class="muted">未填技能，未做匹配</span>'
    : hit.length
      ? hit.map((s) => `<span class="kw hit">${esc(s)}</span>`).join('')
      : '<span class="muted">无</span>'
  const missChips = skillUnknown
    ? '<span class="muted">—</span>'
    : missing.length
      ? missing
          .map((s) => `<span class="kw miss ${mustMissing.has(s) ? 'must' : ''}">${esc(s)}</span>`)
          .join('')
      : '<span class="muted">无</span>'

  const risks = (r.redFlags || [])
    .map((f) => `<span class="risk" title="${esc(f.evidence)}">${esc(f.label)}</span>`)
    .join('')

  const reasons = (r.reasons || []).map((s) => `<li>${esc(s)}</li>`).join('')
  const salary = r.salary?.raw || '薪资未写'
  const years = r.years?.raw || '年限未写'
  const edu = r.education?.raw || '学历未写'
  const sourceLink = r.sourceUrl
    ? `<a class="src-tag" href="${esc(r.sourceUrl)}" target="_blank" rel="noopener noreferrer">${esc(r.sourceName || '原帖')} ↗</a>`
    : r.sourceName
      ? `<span class="src-tag">${esc(r.sourceName)}</span>`
      : ''
  const posted = r.postedAt ? fmtDate(r.postedAt) : ''
  const aiBtn =
    r.text && !r.ai
      ? `<button class="ghost sm ai-btn" type="button" data-ai="${esc(r.id)}">AI 精评</button>`
      : ''

  let aiBlock = ''
  if (r.ai) {
    const a = r.ai
    const aiReasons = (a.reasons || []).map((s) => `<li>${esc(s)}</li>`).join('') || '<li class="muted">无</li>'
    const kws = (a.resume_keywords || []).map((s) => `<span class="kw hit">${esc(s)}</span>`).join('') || '<span class="muted">无</span>'
    const qs = (a.questions || []).map((s) => `<li>${esc(s)}</li>`).join('') || '<li class="muted">无</li>'
    const aiRisks =
      (a.risks || [])
        .map((x) => `<li>${esc(x.signal)}${x.why ? `：${esc(x.why)}` : ''}</li>`)
        .join('') || '<li class="muted">无</li>'
    const must = (a.must_have || []).map((s) => `<span class="kw miss">${esc(s)}</span>`).join('')
    aiBlock = `<div class="ai-grid">
      <div>
        <h4>AI 判断</h4>
        <ul>${aiReasons}</ul>
        ${must ? `<h4>AI 认为的硬要求</h4><div class="skill-row">${must}</div>` : ''}
        <h4>建议补进简历</h4>
        <div class="skill-row">${kws}</div>
        <h4>AI 看到的额外风险</h4>
        <ul>${aiRisks}</ul>
      </div>
      <div>
        <h4>面试追问</h4>
        <ol>${qs}</ol>
      </div>
    </div>`
  } else {
    aiBlock = `<p class="ai-note">${esc(aiMetaNote(r))}。点卡片右上角「AI 精评」可得到简历关键词与面试追问。</p>`
  }

  return `<article class="result" data-verdict="${esc(r.verdict)}">
    <div class="score" style="--p:${Number(r.score) || 0}"><strong>${Number(r.score) || 0}</strong><small>匹配</small></div>
    <div class="r-main">
      <div class="r-head">
        <h3 class="r-title">${esc(r.title)}${r.company ? ` <span class="r-company">${esc(r.company)}</span>` : ''}</h3>
        <span class="r-head-actions">${aiBtn}<span class="badge ${esc(r.verdict)}">${esc(r.verdictLabel)}</span></span>
      </div>
      <div class="r-meta">
        <span>${esc(r.city || '城市未写')}</span>
        <span>${esc(salary)}</span>
        <span>${esc(years)}</span>
        <span>${esc(edu)}</span>
        <span>JD ${r.jdStats?.chars || 0} 字</span>
        <span>置信度 ${confidenceLabel(r.confidence)}</span>
        <span>${esc(aiMetaNote(r))}</span>
        ${r.sourceDetail === 'fallback' ? '<span class="warn-note">详情未取到，按摘要算</span>' : ''}
        ${sourceLink ? `<span class="src-line">${sourceLink}${posted ? ` · ${posted}` : ''}</span>` : ''}
      </div>
      <div class="gates">${gates}</div>
      <div class="skill-block">
        <div class="skill-row"><span>命中</span>${hitChips}</div>
        <div class="skill-row"><span>缺失</span>${missChips}</div>
      </div>
      ${risks ? `<div class="risks">${risks}</div>` : ''}
      <ul class="r-reasons">${reasons}</ul>
      <details class="more"${r.ai && (r.verdict === 'strong' || r.verdict === 'ok') ? ' open' : ''}>
        <summary>AI 深评 · 简历关键词 · 面试追问</summary>
        ${aiBlock}
      </details>
    </div>
  </article>`
}

function renderResults() {
  const c = counts()
  const aiUsed = state.results.filter((r) => r.aiMeta?.used).length
  const aiCached = state.results.filter((r) => r.aiMeta?.cached).length
  const secs = (state.elapsedMs / 1000).toFixed(1)
  const srcs = (state.searchMeta?.sources || [])
    .filter((s) => s.count > 0)
    .map((s) => `${s.name} ${s.count}`)
    .join(' / ')
  $('#summary').innerHTML = `共 <b>${c.all}</b> 条 · 强投 <b>${c.strong}</b> / 可投 <b>${c.ok}</b> / 观望 <b>${c.maybe}</b> / 不建议 <b>${c.no}</b> · ${secs}s${
    srcs ? ` · 抓到 ${srcs}` : ''
  }${aiUsed ? ` · AI 评 ${aiUsed} 条${aiCached ? `（缓存 ${aiCached}）` : ''}` : ''}`

  renderFilters()
  const list = state.results.filter((r) => {
    if (state.filter !== 'all' && r.verdict !== state.filter) return false
    if (state.onlyPass && r.hardFail) return false
    return true
  })
  $('#result-list').innerHTML = list.length
    ? list.map(renderResult).join('')
    : '<div class="empty">这个筛选条件下没有结果。</div>'
  $('#results').hidden = false
}

/* ---------------- 导出 ---------------- */
function mdCell(s) {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

function buildMarkdown() {
  const p = state.profile || {}
  const lines = []
  lines.push('# 对位 · JD 筛选结果')
  lines.push('')
  lines.push(
    `画像：${p.title || '未填'} · ${p.years || '?'} 年 · ${p.education || '?'} · ${p.city || '?'} · 期望 ${p.salaryMin || '?'}-${p.salaryMax || '?'}K`,
  )
  lines.push(`生成：${new Date().toLocaleString('zh-CN')}`)
  lines.push('')
  lines.push('| 分数 | 结论 | 岗位 | 公司 | 城市 | 薪资 | 来源 | 缺失技能 |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const r of state.results) {
    if (r.error) {
      lines.push(`| — | 失败 | ${mdCell(r.title)} |  |  |  |  | ${mdCell(r.error)} |`)
      continue
    }
    lines.push(
      `| ${r.score} | ${r.verdictLabel} | ${mdCell(r.title)} | ${mdCell(r.company)} | ${mdCell(r.city)} | ${mdCell(r.salary?.raw)} | ${mdCell(r.sourceName)} | ${mdCell((r.skill?.missing || []).join('、'))} |`,
    )
  }
  lines.push('')
  for (const r of state.results) {
    if (r.error) continue
    lines.push(`## ${r.title}${r.company ? ` · ${r.company}` : ''} — ${r.score} 分 / ${r.verdictLabel}`)
    lines.push('')
    if (r.sourceUrl) lines.push(`- 来源：${r.sourceName} ${r.sourceUrl}`)
    lines.push(`- 硬门槛：${(r.gates || []).map((g) => `${g.label}=${g.detail}`).join('；')}`)
    if (r.skill?.hit?.length) lines.push(`- 命中：${r.skill.hit.join('、')}`)
    if (r.skill?.missing?.length) lines.push(`- 缺失：${r.skill.missing.join('、')}`)
    if (r.redFlags?.length) lines.push(`- 风险：${r.redFlags.map((f) => f.label).join('、')}`)
    if (r.ai?.resume_keywords?.length) lines.push(`- 建议补进简历：${r.ai.resume_keywords.join('、')}`)
    if (r.ai?.questions?.length) {
      lines.push('- 面试追问：')
      for (const q of r.ai.questions) lines.push(`  - ${q}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

async function copyMarkdown() {
  if (!state.results.length) return toast('还没有结果')
  const text = buildMarkdown()
  try {
    await navigator.clipboard.writeText(text)
    toast('Markdown 已复制')
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
    toast('Markdown 已复制')
  }
}

function csvCell(s) {
  return `"${String(s ?? '').replace(/"/g, '""')}"`
}

function downloadCsv() {
  if (!state.results.length) return toast('还没有结果')
  const head = ['分数', '结论', '岗位', '公司', '城市', '薪资', '年限要求', '学历要求', '来源', '链接', '命中技能', '缺失技能', '风险', 'AI建议关键词']
  const rows = state.results.map((r) =>
    r.error
      ? ['', '失败', r.title, '', '', '', '', '', '', '', '', '', r.error, '']
      : [
          r.score,
          r.verdictLabel,
          r.title,
          r.company,
          r.city,
          r.salary?.raw || '',
          r.years?.raw || '',
          r.education?.raw || '',
          r.sourceName || '',
          r.sourceUrl || '',
          (r.skill?.hit || []).join('、'),
          (r.skill?.missing || []).join('、'),
          (r.redFlags || []).map((f) => f.label).join('、'),
          (r.ai?.resume_keywords || []).join('、'),
        ],
  )
  const csv = '\uFEFF' + [head, ...rows].map((row) => row.map(csvCell).join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `duiwei-jd-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  toast('CSV 已下载')
}

/* ---------------- 初始化 ---------------- */
function bind() {
  $('#profile-form').addEventListener('input', onProfileChange)
  $('#profile-form').addEventListener('change', onProfileChange)
  $('#btn-sample-profile').addEventListener('click', fillSampleProfile)

  $('#btn-upload').addEventListener('click', () => $('#resume-file').click())
  $('#resume-file').addEventListener('change', (e) => handleResumeFile(e.target.files?.[0]))
  const drop = $('#drop')
  drop.addEventListener('click', (e) => {
    if (e.target.closest('button') || e.target.closest('input')) return
    $('#resume-file').click()
  })
  drop.addEventListener('dragover', (e) => {
    e.preventDefault()
    drop.classList.add('dragging')
  })
  drop.addEventListener('dragleave', () => drop.classList.remove('dragging'))
  drop.addEventListener('drop', (e) => {
    e.preventDefault()
    drop.classList.remove('dragging')
    handleResumeFile(e.dataTransfer?.files?.[0])
  })

  $('#btn-search').addEventListener('click', runSearch)
  $('#q').addEventListener('input', () => ($('#q').dataset.auto = '0'))
  $('#q-city').addEventListener('input', () => ($('#q-city').dataset.auto = '0'))
  $('#source-picker').addEventListener('change', updateSourceStatus)

  $('#btn-add').addEventListener('click', addJds)
  $('#btn-import').addEventListener('click', importJd)
  $('#jd-url').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      importJd()
    }
  })
  $('#btn-sample').addEventListener('click', loadSamples)
  $('#btn-clear').addEventListener('click', clearJds)
  $('#btn-run').addEventListener('click', run)
  $('#btn-copy').addEventListener('click', copyMarkdown)
  $('#btn-csv').addEventListener('click', downloadCsv)

  $('#jd-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove]')
    if (!btn) return
    const id = btn.dataset.remove
    state.jds = state.jds.filter((j) => j.id !== id)
    saveJds()
    renderJdList()
  })

  $('#result-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-ai]')
    if (!btn) return
    const r = state.results.find((x) => x.id === btn.dataset.ai)
    if (r) aiReview(r)
  })

  $('#filters').addEventListener('click', (e) => {
    const f = e.target.closest('[data-filter]')
    if (f) {
      state.filter = f.dataset.filter
      renderResults()
      return
    }
    const p = e.target.closest('[data-pass]')
    if (p) {
      state.onlyPass = !state.onlyPass
      renderResults()
    }
  })

  $('#use-ai').addEventListener('change', () => save(LS.ai, $('#use-ai').checked))

  $('#btn-help').addEventListener('click', () => $('#help').showModal())
  $('#btn-help-close').addEventListener('click', () => $('#help').close())
  $('#help').addEventListener('click', (e) => {
    if (e.target === $('#help')) $('#help').close()
  })

  $('#btn-clear-local').addEventListener('click', () => {
    if (!window.confirm('清除本机保存的画像、简历、JD 和结果？服务端没有你的数据。')) return
    for (const k of Object.values(LS)) localStorage.removeItem(k)
    state.profile = null
    state.jds = []
    state.results = []
    state.searchMeta = null
    fillForm(null)
    $('#profile-form').reset()
    $('#skill-preview').innerHTML = ''
    $('#resume-note').textContent = ''
    $('#q').value = ''
    $('#q-city').value = ''
    saveJds()
    renderJdList()
    $('#results').hidden = true
    toast('本地数据已清除')
  })

  $('#run-note').addEventListener('click', (e) => {
    const b = e.target.closest('#btn-restore')
    if (!b) return
    const last = load(LS.last, null)
    if (!last?.results?.length) return
    state.results = last.results
    state.searchMeta = null
    state.elapsedMs = 0
    renderResults()
    toast(`已恢复 ${fmtTime(last.at)} 的结果`)
  })
}

async function init() {
  if (window.self !== window.top) document.body.classList.add('embedded')

  const saved = state.profile || load(LS.profile, null)
  if (saved) fillForm(saved)
  else fillForm({ education: '本科' })

  state.jds = (Array.isArray(state.jds) ? state.jds : []).filter((j) => j && j.text).slice(0, MAX_JDS)
  renderJdList()
  bind()

  const useAI = load(LS.ai, true)
  $('#use-ai').checked = useAI !== false

  if (saved?.title) {
    $('#q').value = saved.title
    $('#q').dataset.auto = '1'
  }
  if (saved?.city) {
    $('#q-city').value = String(saved.city).split(/[,，、/|\s]+/)[0] || ''
    $('#q-city').dataset.auto = '1'
  }

  try {
    const r = await fetch('/api/config')
    const cfg = await r.json()
    state.ai = Boolean(cfg.ai)
    state.sources = Array.isArray(cfg.sources) ? cfg.sources : []
    state.unavailable = Array.isArray(cfg.unavailableSources) ? cfg.unavailableSources : []
    renderSources()
    const el = $('#ai-status')
    el.dataset.on = String(state.ai)
    el.textContent = state.ai ? 'AI 已接' : '规则模式'
    el.title = state.ai
      ? `AI 经主站网关，单次 900 tokens；限流 ${cfg.limits?.aiPerHour || 20} 次/小时`
      : '服务端未配置 AI 令牌，只用规则分'
    if (!state.ai) {
      $('#use-ai').checked = false
      $('#search-ai').checked = false
      $('#search-ai').disabled = true
      $('#run-note').textContent = '当前是规则模式：不调模型，秒出结果。'
    }
    updateRunUI()
  } catch {
    renderSources()
    $('#ai-status').dataset.on = 'false'
    $('#ai-status').textContent = '离线'
    $('#search-note').textContent = '配置加载失败，搜索可能不可用。'
  }

  const last = load(LS.last, null)
  if (last?.results?.length) {
    const prefix = state.ai ? '' : '当前是规则模式。'
    $('#run-note').innerHTML = `${prefix}上次筛选：${fmtTime(last.at)} · ${last.results.length} 条 <button id="btn-restore" class="link" type="button">恢复</button>`
  }

  refreshProfilePreview()
}

init()
