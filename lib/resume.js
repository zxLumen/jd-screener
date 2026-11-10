/**
 * 简历文件解析：PDF / DOCX / TXT / MD / HTML。
 *
 * - PDF 优先用 poppler 的 pdftotext（容器内已装），没有就退回内置抽取
 * - DOCX 用内置 zip 解压（deflate）+ word/document.xml 抽文本
 * - 全程在内存里，不落盘、不写库
 */
import { spawn } from 'node:child_process'
import zlib from 'node:zlib'
import { stripHtml, pageText, tidy } from './html.js'

export const MAX_RESUME_BYTES = 5 * 1024 * 1024

export class ResumeError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/* ---------------- PDF ---------------- */
function runPdftotext(buf, timeout = 15_000) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn('pdftotext', ['-layout', '-enc', 'UTF-8', '-', '-'], { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (e) {
      reject(Object.assign(e, { code: 'missing' }))
      return
    }
    let out = Buffer.alloc(0)
    let err = ''
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      child.kill('SIGKILL')
      reject(new ResumeError('timeout', 'PDF 解析超时'))
    }, timeout)
    child.on('error', (e) => {
      if (done) return
      done = true
      clearTimeout(timer)
      reject(Object.assign(e, { code: e.code === 'ENOENT' ? 'missing' : 'spawn' }))
    })
    child.stdout.on('data', (d) => {
      out = Buffer.concat([out, d])
      if (out.length > 8 * 1024 * 1024) {
        child.kill('SIGKILL')
      }
    })
    child.stderr.on('data', (d) => {
      err += d.toString().slice(0, 300)
    })
    child.on('close', (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (code !== 0 && !out.length) reject(new ResumeError('pdf', err.trim() || 'pdftotext 失败'))
      else resolve(out.toString('utf8'))
    })
    child.stdin.on('error', () => {})
    child.stdin.end(buf)
  })
}

function inflateMaybe(buf) {
  try {
    return zlib.inflateSync(buf)
  } catch {
    try {
      return zlib.inflateRawSync(buf)
    } catch {
      return null
    }
  }
}

function utf16be(buf) {
  let s = ''
  for (let i = 0; i + 1 < buf.length; i += 2) s += String.fromCharCode((buf[i] << 8) | buf[i + 1])
  return s
}

/** 内置 PDF 文本抽取：只处理常见的 FlateDecode + ToUnicode，够兜底 */
export function pdfTextLite(buf) {
  const raw = buf.toString('latin1')
  const streams = []
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g
  let m
  while ((m = re.exec(raw)) && streams.length < 400) {
    const body = Buffer.from(m[1], 'latin1')
    const plain = inflateMaybe(body)
    const text = plain ? plain.toString('latin1') : body.toString('latin1')
    if (/BT[\s\S]*ET/.test(text) && /(?:Tj|TJ)/.test(text)) streams.push(text)
  }
  if (!streams.length) return ''

  const cmap = new Map()
  for (const s of streams) {
    for (const block of s.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const pair of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
        const src = Number.parseInt(pair[1], 16)
        const dst = Buffer.from(pair[2], 'hex')
        cmap.set(src, utf16be(dst))
      }
    }
    for (const block of s.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      for (const r of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<([0-9a-fA-F]+)>|\[([\s\S]*?)\])/g)) {
        const from = Number.parseInt(r[1], 16)
        const to = Number.parseInt(r[2], 16)
        if (to - from > 2000) continue
        if (r[4]) {
          const base = Buffer.from(r[4], 'hex')
          for (let i = from; i <= to; i++) {
            const b = Buffer.from(base)
            b[b.length - 1] += i - from
            cmap.set(i, utf16be(b))
          }
        } else if (r[5]) {
          const list = [...r[5].matchAll(/<([0-9a-fA-F]+)>/g)]
          list.forEach((x, i) => {
            if (from + i <= to) cmap.set(from + i, utf16be(Buffer.from(x[1], 'hex')))
          })
        }
      }
    }
  }

  const decodeHex = (hex) => {
    const b = Buffer.from(hex.replace(/\s+/g, ''), 'hex')
    if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return utf16be(b.subarray(2))
    let out = ''
    for (let i = 0; i + 1 < b.length; i += 2) {
      const code = (b[i] << 8) | b[i + 1]
      out += cmap.get(code) ?? (code >= 0x20 && code < 0x3000 ? String.fromCharCode(code) : '')
    }
    return out
  }

  const decodeLiteral = (s) =>
    s
      .replace(/\\([nrtbf()\\])/g, (_, c) => ({ n: '\n', r: '\n', t: ' ', b: '', f: '', '(': '(', ')': ')', '\\': '\\' })[c] ?? '')
      .replace(/\\([0-7]{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))
      .replace(/\\\r?\n/g, '')

  const out = []
  for (const s of streams) {
    if (!/BT[\s\S]*ET/.test(s)) continue
    let text = ''
    const token = /\((?:[^()\\]|\\.)*\)\s*Tj|<([0-9a-fA-F\s]+)>\s*Tj|\[((?:[^\][]|\\.)*)\]\s*TJ|(T\*|Td|TD|ET)/g
    let t
    while ((t = token.exec(s))) {
      if (t[1]) text += decodeHex(t[1])
      else if (t[2]) {
        for (const str of t[2].matchAll(/\(((?:[^()\\]|\\.)*)\)|<([0-9a-fA-F\s]+)>/g)) {
          text += str[1] !== undefined ? decodeLiteral(str[1]) : decodeHex(str[2])
        }
      } else if (t[0].startsWith('(')) text += decodeLiteral(t[0].slice(1, -3))
      else text += '\n'
    }
    if (text.trim()) out.push(text)
  }
  return tidy(out.join('\n')).slice(0, 30000)
}

/* ---------------- DOCX ---------------- */
export function readZipEntries(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (eocd < 0) throw new ResumeError('zip', '不是有效的 docx（缺 EOCD）')
  const count = buf.readUInt16LE(eocd + 10)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  const entries = new Map()
  let off = cdOffset
  for (let i = 0; i < count && off + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break
    const method = buf.readUInt16LE(off + 10)
    const csize = buf.readUInt32LE(off + 20)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const localOff = buf.readUInt32LE(off + 42)
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen)
    if (buf.readUInt32LE(localOff) === 0x04034b50) {
      const lName = buf.readUInt16LE(localOff + 26)
      const lExtra = buf.readUInt16LE(localOff + 28)
      const start = localOff + 30 + lName + lExtra
      const data = buf.subarray(start, start + csize)
      if (method === 0) entries.set(name, data)
      else if (method === 8) {
        try {
          entries.set(name, zlib.inflateRawSync(data))
        } catch {
          /* 跳过坏的条目 */
        }
      }
    }
    off += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

function xmlToText(xml) {
  return tidy(
    String(xml || '')
      .replace(/<w:tab[^>]*\/>/g, ' ')
      .replace(/<w:br[^>]*\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<\/w:tr>/g, '\n')
      .replace(/<\/w:tc>/g, '\t')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n'),
  )
}

/* ---------------- 文本 ---------------- */
function decodeText(buf) {
  const utf8 = new TextDecoder('utf-8').decode(buf)
  const bad = (utf8.match(/\uFFFD/g) || []).length
  if (bad > 3 && bad / Math.max(1, utf8.length) > 0.005) {
    try {
      const gbk = new TextDecoder('gbk').decode(buf)
      if ((gbk.match(/\uFFFD/g) || []).length < bad) return gbk
    } catch {
      /* 没有 gbk 支持就用 utf8 */
    }
  }
  return utf8
}

export function guessTitle(text) {
  const lines = String(text || '')
    .split('\n')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 16)
  const role = /(工程师|开发|架构师|产品经理|运营|设计师|分析师|研究员|负责人|总监|经理|顾问|实习)/i
  // 简历首行常是姓名/联系方式；按 • · | / 切开逐段找岗位名
  for (const line of lines) {
    for (const seg of line.split(/[•·|｜/、,，]+/)) {
      const s = seg.trim().replace(/^[\d\s.、-]+/, '')
      if (s.length >= 3 && s.length <= 30 && role.test(s) && !/[@]|https?:|电话|手机/i.test(s)) return s
    }
  }
  // 再退一步：独立成行、不像姓名/联系方式的短行
  const hit = lines.find(
    (l) =>
      l.length >= 3 &&
      l.length <= 30 &&
      role.test(l) &&
      !/[@]|https?:|\d{7,}/.test(l) &&
      !/^(男|女|年龄|电话|邮箱|地址)/.test(l),
  )
  return hit || ''
}

export function guessSalary(text) {
  const t = String(text || '')
  const m =
    t.match(/期望(?:月薪|薪资|薪酬)?\s*[:：]?\s*(\d{2,3})\s*[-~—–至到]\s*(\d{2,3})\s*[kK千]/) ||
    t.match(/(\d{2,3})\s*[-~—–至到]\s*(\d{2,3})\s*[kK千]\s*(?:\/月|每月|月薪)/)
  if (!m) return { min: null, max: null }
  return { min: Number(m[1]), max: Number(m[2]) }
}

/**
 * 解析上传的简历文件。
 * @param {{filename?:string, base64:string}} input
 */
export async function extractResume({ filename = '', base64 = '' }) {
  if (!base64 || typeof base64 !== 'string') throw new ResumeError('empty', '文件是空的')
  let buf
  try {
    buf = Buffer.from(base64.replace(/^data:[^,]*,/, ''), 'base64')
  } catch {
    throw new ResumeError('base64', '文件编码不对')
  }
  if (!buf.length) throw new ResumeError('empty', '文件是空的')
  if (buf.length > MAX_RESUME_BYTES) throw new ResumeError('too-large', `文件最多 ${MAX_RESUME_BYTES / 1024 / 1024}MB`)

  const ext = (String(filename).toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || ''
  const magicPdf = buf.subarray(0, 5).toString('latin1') === '%PDF-'
  const magicZip = buf[0] === 0x50 && buf[1] === 0x4b
  const warnings = []
  let kind = ext || 'txt'
  let text = ''

  if (ext === 'pdf' || magicPdf) {
    kind = 'pdf'
    try {
      text = await runPdftotext(buf)
    } catch (e) {
      if (e.code !== 'missing') warnings.push(`pdftotext 不可用（${e.code}），改用内置抽取`)
      text = pdfTextLite(buf)
      if (!text) throw new ResumeError('pdf', 'PDF 解析失败：可能是扫描件或特殊字体，请上传 DOCX/TXT')
    }
    if (text.replace(/\s/g, '').length < 40) {
      const lite = pdfTextLite(buf)
      if (lite.length > text.length) text = lite
    }
  } else if (ext === 'docx' || (magicZip && ext !== 'zip')) {
    kind = 'docx'
    let entries
    try {
      entries = readZipEntries(buf)
    } catch (e) {
      throw new ResumeError('docx', e.message || 'DOCX 解压失败')
    }
    const doc = entries.get('word/document.xml')
    if (!doc) {
      if (entries.has('word/document.xml'.replace('document', 'document2'))) {
        throw new ResumeError('docx', '这个 Word 文件结构异常')
      }
      throw new ResumeError('doc', '只支持 .docx；老 .doc 请另存为 .docx 或 PDF')
    }
    text = xmlToText(doc.toString('utf8'))
    if (entries.has('word/header1.xml')) warnings.push('已忽略页眉内容')
  } else if (ext === 'doc') {
    throw new ResumeError('doc', '老 .doc 格式不支持，请另存为 .docx 或 PDF')
  } else if (ext === 'html' || ext === 'htm') {
    kind = 'html'
    text = pageText(decodeText(buf))
  } else if (magicZip) {
    throw new ResumeError('zip', '压缩包不能直接解析，请上传 PDF/DOCX/TXT')
  } else {
    kind = ext === 'md' || ext === 'markdown' ? 'md' : 'txt'
    text = decodeText(buf)
    if (/<\/?(?:html|body|div|p)\b/i.test(text)) {
      kind = 'html'
      text = pageText(text)
    }
  }

  text = tidy(text).slice(0, 30000)
  const chinese = (text.match(/[\u4e00-\u9fa5]/g) || []).length
  if (text.length < 80) throw new ResumeError('short', '没抽到足够的简历文本，换 PDF/DOCX 或直接粘贴')
  if (kind === 'pdf' && chinese < 10 && text.length < 400) {
    warnings.push('PDF 里中文很少，可能是扫描件或字体未嵌入')
  }

  return { kind, text, warnings, bytes: buf.length }
}
