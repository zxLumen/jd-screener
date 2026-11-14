#!/usr/bin/env node
/**
 * Docker 出口桥：unix socket -> 宿主机 127.0.0.1:1080。
 *
 * 服务器上的 SSH 反向隧道只监听 127.0.0.1:1080；Docker 容器在 bridge 网络里
 * 看不到宿主机 loopback。这里用 unix socket 把两者接起来，既不新增公网端口，
 * 也不需要把容器改成 host 网络。
 *
 * 由 jd-exit-bridge.service 以 jd-exit 用户托管；socket 只在本机 /run 下。
 */
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'

const SOCK = process.env.JD_EXIT_SOCK || '/run/jd-exit/bridge.sock'
const UPSTREAM_HOST = process.env.JD_EXIT_UPSTREAM_HOST || '127.0.0.1'
const UPSTREAM_PORT = Number(process.env.JD_EXIT_UPSTREAM_PORT || 1080)

fs.mkdirSync(path.dirname(SOCK), { recursive: true })
try {
  fs.unlinkSync(SOCK)
} catch {
  /* 首次启动没有旧 socket */
}

const server = net.createServer((client) => {
  const upstream = net.connect(UPSTREAM_PORT, UPSTREAM_HOST)
  const kill = () => {
    client.destroy()
    upstream.destroy()
  }
  client.on('error', kill)
  upstream.on('error', kill)
  client.pipe(upstream).pipe(client)
})

server.on('error', (e) => {
  console.error(`[jd-exit-bridge] ${e?.message || e}`)
  process.exit(1)
})

server.listen(SOCK, () => {
  try {
    fs.chmodSync(SOCK, 0o666)
  } catch (e) {
    console.error(`[jd-exit-bridge] chmod ${SOCK}: ${e?.message || e}`)
  }
  console.log(`[jd-exit-bridge] ${SOCK} -> ${UPSTREAM_HOST}:${UPSTREAM_PORT}`)
})

function shutdown() {
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 2_000).unref?.()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
