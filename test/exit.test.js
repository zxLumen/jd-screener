import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import http from 'node:http'
import {
  classifySource,
  exitTarget,
  isBeijing,
  parseExitInfo,
  probeExit,
  resetExitCache,
  socks5Connect,
  requestViaProxy,
} from '../lib/exit.js'

test('exitTarget：未配置 / unix / socks5 / 非法值', () => {
  assert.equal(exitTarget({}), null)
  assert.equal(exitTarget({ JD_EXIT_PROXY: '  ' }), null)
  const unix = exitTarget({ JD_EXIT_PROXY: 'unix:/run/jd-exit/bridge.sock' })
  assert.equal(unix.type, 'unix')
  assert.equal(unix.path, '/run/jd-exit/bridge.sock')
  const tcp = exitTarget({ JD_EXIT_PROXY: 'socks5h://127.0.0.1:1080' })
  assert.equal(tcp.type, 'tcp')
  assert.equal(tcp.host, '127.0.0.1')
  assert.equal(tcp.port, 1080)
  assert.equal(exitTarget({ JD_EXIT_PROXY: 'http://127.0.0.1:8080' }), null)
  assert.equal(exitTarget({ JD_EXIT_PROXY: 'not a url' }), null)
})

test('parseExitInfo：ipip / ipinfo 都能认出北京', () => {
  const a = parseExitInfo({
    ret: 'ok',
    data: { ip: '1.2.3.4', location: ['中国', '北京', '北京', '', '中国联通'] },
  })
  assert.equal(a.ip, '1.2.3.4')
  assert.equal(a.city, '北京')
  assert.equal(a.region, '北京')
  assert.equal(a.org, '中国联通')
  assert.equal(isBeijing(a), true)

  const b = parseExitInfo({ ip: '5.6.7.8', city: 'Beijing', region: 'Beijing', country: 'CN', org: 'AS1' })
  assert.equal(b.city, 'Beijing')
  assert.equal(isBeijing(b), true)
  assert.equal(isBeijing(parseExitInfo({ ip: '9.9.9.9', city: 'Hong Kong', country: 'HK' })), false)
  assert.equal(parseExitInfo(null), null)
  assert.equal(parseExitInfo({ ret: 'ok', data: { location: ['中国'] } }), null)
})

test('classifySource：风控/登录/正常都能分出来', () => {
  assert.equal(classifySource('liepin', { status: 200, body: '<div class="job-list-item">' }).verdict, 'unlocked')
  assert.equal(classifySource('zhaopin', { status: 200, body: 'Security Verification' }).verdict, 'blocked')
  assert.equal(classifySource('51job', { status: 200, body: 'Aliyun WAF' }).verdict, 'blocked')
  assert.equal(classifySource('lagou', { status: 200, body: '请完成滑块验证' }).verdict, 'blocked')
  assert.equal(classifySource('boss', { status: 200, body: '{"code":37,"message":"环境异常"}' }).verdict, 'blocked')
  assert.equal(classifySource('boss', { status: 200, body: '{"code":35,"message":"您的IP地址存在异常行为."}' }).verdict, 'blocked')
  assert.equal(classifySource('boss', { status: 200, body: '{"code":0,"zpData":{"jobList":[1]}}' }).verdict, 'unlocked')
  assert.equal(classifySource('maimai', { status: 200, body: '请登录后查看' }).verdict, 'need-login')
  assert.equal(classifySource('v2ex', { status: 403, body: '' }).verdict, 'blocked')
  assert.equal(classifySource('v2ex', { status: 200, body: 'not-json' }).verdict, 'unknown')
  assert.equal(
    classifySource('zhaopin', { status: 200, body: '<title>北京热门职位招聘</title>' }).verdict,
    'unknown',
  )
  assert.equal(classifySource('51job', { status: 200, body: '<script src="we-vue-bundle.js">' }).verdict, 'unknown')
  assert.equal(classifySource('v2ex', { error: 'timeout' }).verdict, 'timeout')
})

test('probeExit：未配置出口毫秒级返回 offline', async () => {
  resetExitCache()
  const t0 = Date.now()
  const r = await probeExit({ target: null, useCache: false })
  assert.equal(r.configured, false)
  assert.equal(r.online, false)
  assert.equal(r.error, 'not-configured')
  assert.ok(Date.now() - t0 < 50)
})

test('probeExit：出口连不上时 2s 内返回 offline', async () => {
  resetExitCache()
  const t0 = Date.now()
  const r = await probeExit({
    target: { type: 'tcp', host: '127.0.0.1', port: 9, label: 'dead' },
    timeoutMs: 400,
    useCache: false,
  })
  const elapsed = Date.now() - t0
  assert.equal(r.configured, true)
  assert.equal(r.online, false)
  assert.ok(elapsed < 900, `should fail fast, got ${elapsed}ms`)
})

test('probeExit：SOCKS 要求认证时按 offline 处理', async () => {
  resetExitCache()
  const server = net.createServer((client) => {
    client.once('data', () => client.end(Buffer.from([5, 0xff])))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  try {
    const r = await probeExit({
      target: { type: 'tcp', host: '127.0.0.1', port: server.address().port, label: 'auth' },
      timeoutMs: 500,
      useCache: false,
    })
    assert.equal(r.configured, true)
    assert.equal(r.online, false)
    assert.equal(r.error, 'offline')
  } finally {
    server.close()
  }
})

/** 本地假 SOCKS5：只接受 CONNECT，统一转到 127.0.0.1:targetPort。 */
function startFakeSocks(targetPort) {
  return new Promise((resolve) => {
    const server = net.createServer((client) => {
      let buf = Buffer.alloc(0)
      let phase = 0
      const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk])
        if (phase === 0 && buf.length >= 2) {
          const n = buf[1]
          if (buf.length < 2 + n) return
          buf = buf.subarray(2 + n)
          client.write(Buffer.from([5, 0]))
          phase = 1
        }
        if (phase === 1 && buf.length >= 4) {
          const atyp = buf[3]
          let len = 0
          if (atyp === 1) len = 4
          else if (atyp === 4) len = 16
          else if (atyp === 3) len = 1 + buf[4]
          if (buf.length < 4 + len + 2) return
          buf = buf.subarray(4 + len + 2)
          const upstream = net.connect(targetPort, '127.0.0.1', () => {
            client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]))
            if (buf.length) upstream.write(buf)
            client.pipe(upstream).pipe(client)
            client.off('data', onData)
          })
          upstream.on('error', () => client.destroy())
          phase = 2
        }
      }
      client.on('data', onData)
      client.on('error', () => {})
    })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

test('socks5Connect + requestViaProxy：本地假出口能通', async () => {
  const web = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, path: req.url }))
  })
  await new Promise((r) => web.listen(0, '127.0.0.1', r))
  const targetPort = web.address().port
  const socks = await startFakeSocks(targetPort)
  try {
    const target = { type: 'tcp', host: '127.0.0.1', port: socks.address().port, label: 'fake' }
    const sock = await socks5Connect(target, 'example.com', 80, 1_000)
    assert.ok(sock)
    sock.destroy()
    const res = await requestViaProxy(target, `http://example.com/hello`, { timeoutMs: 2_000 })
    assert.equal(res.status, 200)
    assert.equal(JSON.parse(res.body).path, '/hello')
  } finally {
    socks.close()
    web.close()
  }
})
