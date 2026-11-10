import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const FILE = path.join(os.tmpdir(), `duiwei-auth-${process.pid}.json`)
process.env.JD_AUTH_FILE = FILE
const auth = await import('../lib/auth.js')

after(async () => {
  await fs.rm(FILE, { force: true })
})

test('登录态：保存后只回掩码，落盘 0600，可清除', async () => {
  await auth.initAuth()
  assert.equal(auth.isConfigured('boss'), false)
  assert.equal(auth.isConfigured('maimai'), true)

  const cookie = 'wt2=abc123; __zp_stoken__=verysecretvalue; bst=xyz'
  const st = await auth.saveAuth('boss', { cookie, ua: 'Mozilla/5.0 Test' })
  assert.equal(st.configured, true)
  assert.equal(st.hasCookie, true)
  assert.match(st.cookieMasked, /^len=\d+ · 尾4=/)
  assert.ok(!JSON.stringify(st).includes('verysecretvalue'))
  assert.equal(st.hasUA, true)

  const mode = (await fs.stat(FILE)).mode & 0o777
  assert.equal(mode, 0o600)
  const raw = await fs.readFile(FILE, 'utf8')
  assert.match(raw, /verysecretvalue/)

  const cleared = await auth.clearAuth('boss')
  assert.equal(cleared.configured, false)
  assert.equal(auth.isConfigured('boss'), false)
})

test('登录态：BOSS 空 cookie 拒绝', async () => {
  await assert.rejects(() => auth.saveAuth('boss', { cookie: 'x' }), /太短/)
})
