import test from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import { extractResume, guessTitle, guessSalary, readZipEntries, pdfTextLite, ResumeError } from '../lib/resume.js'

/** 测试用：生成一个 store 模式（无压缩）的最小 zip */
function makeZip(files) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name)
    const data = Buffer.from(content)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(0, 10)
    local.writeUInt32LE(0, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, nameBuf, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt32LE(0, 12)
    central.writeUInt32LE(0, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBuf)
    offset += local.length + nameBuf.length + data.length
  }
  const localBuf = Buffer.concat(locals)
  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(Object.keys(files).length, 8)
  eocd.writeUInt16LE(Object.keys(files).length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(localBuf.length, 16)
  return Buffer.concat([localBuf, centralBuf, eocd])
}

const DOCX_XML = `<w:document><w:body>
<w:p><w:r><w:t>张三</w:t></w:r></w:p>
<w:p><w:r><w:t>后端研发工程师 · 北京</w:t></w:r></w:p>
<w:p><w:r><w:t>6 年经验，熟悉 Python、FastAPI、Ray、Kubernetes、Redis、MySQL、Docker。</w:t></w:r></w:p>
<w:p><w:r><w:t>做过 RAG、LangChain、大模型应用与 MLOps 平台，期望 30-45K。</w:t></w:r></w:p>
</w:body></w:document>`

test('DOCX：zip 解压 + 抽正文', async () => {
  const buf = makeZip({ 'word/document.xml': DOCX_XML })
  const entries = readZipEntries(buf)
  assert.ok(entries.has('word/document.xml'))
  const r = await extractResume({ filename: 'resume.docx', base64: buf.toString('base64') })
  assert.equal(r.kind, 'docx')
  assert.match(r.text, /Python/)
  assert.match(r.text, /RAG/)
  assert.equal(r.warnings.length, 0)
})

test('TXT：UTF-8 直接读，识别标题', async () => {
  const text = `李四
高级后端工程师
8 年工作经验，Python / Go / Kubernetes / Kafka / Redis / MySQL。
负责过订单系统、支付网关与推荐服务，期望月薪 40-60K。`
  const r = await extractResume({ filename: 'resume.txt', base64: Buffer.from(text).toString('base64') })
  assert.equal(r.kind, 'txt')
  assert.match(r.text, /Python/)
  assert.equal(guessTitle(r.text), '高级后端工程师')
  assert.deepEqual(guessSalary(r.text), { min: 40, max: 60 })
})

test('PDF：内置抽取兜底', async () => {
  const stream = 'BT /F1 12 Tf 72 720 Td (Senior Python Backend Engineer with FastAPI Ray Kubernetes Docker Redis MySQL and LLM RAG experience for hire) Tj ET'
  const pdf = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R >> endobj
4 0 obj << /Length ${stream.length} >>
stream
${stream}
endstream
endobj
trailer << /Root 1 0 R >>
%%EOF`
  const buf = Buffer.from(pdf)
  const lite = pdfTextLite(buf)
  assert.match(lite, /Senior Python Backend Engineer/)
  const r = await extractResume({ filename: 'resume.pdf', base64: buf.toString('base64') })
  assert.equal(r.kind, 'pdf')
  assert.match(r.text, /Python/)
})

test('空文件 / 老 doc 明确报错', async () => {
  await assert.rejects(() => extractResume({ filename: 'a.txt', base64: '' }), (e) => e instanceof ResumeError && e.code === 'empty')
  await assert.rejects(() => extractResume({ filename: 'a.doc', base64: Buffer.from('x').toString('base64') }), (e) => e instanceof ResumeError && e.code === 'doc')
})

test('短文本不当简历', async () => {
  await assert.rejects(
    () => extractResume({ filename: 'a.txt', base64: Buffer.from('太短了').toString('base64') }),
    (e) => e instanceof ResumeError && e.code === 'short',
  )
})
