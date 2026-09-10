import { afterEach, describe, expect, test, spyOn } from 'bun:test'
import * as net from 'node:net'
import { once } from 'node:events'
import createNetServer, { parseHttpRequest, type ShutdownServer } from '../server/net'
import { sessionManager } from '../lib/sessions'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const shutdowns: ShutdownServer[] = []
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const initialize = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'network-test', version: '1' } }
}

async function startServer () {
  const [server, sessions, shutdown] = createNetServer(net, {
    port: 0, endpoint: '/bb-mcp',
    sessionConfig: { pingIntervalMs: 0, inactivityTimeoutMs: 60_000 },
    keepAlive: { sseHeartbeatIntervalMs: 10 }
  })
  shutdowns.push(shutdown)
  await once(server, 'listening')
  const address = server.address() as net.AddressInfo
  const url = `http://127.0.0.1:${address.port}/bb-mcp`
  return { server, sessions, shutdown, address, url }
}

async function initializeSession (url: string): Promise<string> {
  const response = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(initialize)
  })
  expect(response.status).toBe(200)
  await response.text()
  const id = response.headers.get('mcp-session-id')
  expect(id).toBeTruthy()
  return id!
}

function rawRequest (body: string, headers = '', connection = 'keep-alive'): string {
  return `POST /bb-mcp HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: ${connection}\r\n${headers}\r\n${body}`
}

async function exchange (port: number, request: string): Promise<string> {
  const socket = net.connect(port, '127.0.0.1')
  let data = ''
  socket.setEncoding('utf8')
  socket.on('data', (chunk) => { data += chunk })
  socket.on('error', () => {})
  socket.write(request)
  await once(socket, 'close')
  return data
}

afterEach(async () => {
  for (const shutdown of shutdowns.splice(0)) await shutdown()
  await sessionManager.clear()
})

describe('HTTP framing', () => {
  test('waits for fragmented UTF-8 chunked bodies and preserves the next request', () => {
    const body = Buffer.from('{"name":"角色"}')
    const header = Buffer.from('POST /bb-mcp HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n\r\n')
    const parts = [body.subarray(0, 11), body.subarray(11)]
    const chunks = parts.flatMap((part) => [Buffer.from(`${part.length.toString(16)}\r\n`), part, Buffer.from('\r\n')])
    const first = Buffer.concat([header, ...chunks, Buffer.from('0\r\nX-Trace: done\r\n\r\n')])
    expect(parseHttpRequest(first.subarray(0, first.length - 1))).toBeNull()
    const next = Buffer.from('GET /ready HTTP/1.1\r\nHost: localhost\r\n\r\n')
    const parsed = parseHttpRequest(Buffer.concat([first, next]))!
    expect(parsed.body).toBe(body.toString())
    expect(parsed.end).toBe(first.length)
    expect(parsed.headers['transfer-encoding']).toBeUndefined()
    expect(parseHttpRequest(next)?.path).toBe('/ready')
  })

  test.each([
    'Content-Length: -1',
    'Content-Length: 1x',
    'Content-Length: 0\r\nContent-Length: 0',
    'Content-Length: 0\r\nTransfer-Encoding: chunked',
    'Transfer-Encoding: gzip',
    'Mcp-Session-Id: one\r\nMcp-Session-Id: two'
  ])('rejects ambiguous or invalid headers: %s', (headers) => {
    expect(() => parseHttpRequest(Buffer.from(`POST /bb-mcp HTTP/1.1\r\nHost: localhost\r\n${headers}\r\n\r\n`))).toThrow()
  })

  test('HTTP 1.0 closes by default, and HTTP 1.1 respects a close token', () => {
    expect(parseHttpRequest(Buffer.from('GET /ready HTTP/1.0\r\n\r\n'))?.keepAlive).toBe(false)
    expect(parseHttpRequest(Buffer.from('GET /ready HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive, close\r\n\r\n'))?.keepAlive).toBe(false)
  })
})

test('binds loopback and creates distinct concurrent MCP sessions', async () => {
  const { address, url, sessions } = await startServer()
  expect(address.address).toBe('127.0.0.1')
  const ids = await Promise.all([initializeSession(url), initializeSession(url), initializeSession(url)])
  expect(new Set(ids).size).toBe(3)
  expect(sessions.size).toBe(3)
})

test('parses a chunked MCP initialize request over a real socket', async () => {
  const { address, sessions } = await startServer()
  const body = JSON.stringify(initialize)
  const response = await exchange(address.port,
    `POST /bb-mcp HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n${Buffer.byteLength(body).toString(16)}\r\n${body}\r\n0\r\n\r\n`)
  expect(response).toStartWith('HTTP/1.1 200')
  expect(sessions.size).toBe(1)
})

test('serializes requests arriving while an earlier response is pending on the same socket', async () => {
  const { address, url, sessions } = await startServer()
  const id = await initializeSession(url)
  let active = 0
  let maximum = 0
  const mock = spyOn(sessions.get(id)!.transport, 'handleRequest').mockImplementation(async (request) => {
    const body = await request.json() as { id: number }
    maximum = Math.max(maximum, ++active)
    await delay(body.id === 10 ? 40 : 1)
    --active
    return Response.json({ id: body.id })
  })
  try {
    const socket = net.connect(address.port, '127.0.0.1')
    let result = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => { result += chunk })
    const closed = once(socket, 'close')
    const headers = `Mcp-Session-Id: ${id}\r\n`
    socket.write(rawRequest('{"id":10}', headers))
    await delay(10)
    socket.write(rawRequest('{"id":11}', headers, 'close'))
    await closed
    expect(maximum).toBe(1)
    expect(result.indexOf('"id":10')).toBeLessThan(result.indexOf('"id":11'))
    expect(result.match(/HTTP\/1.1 200/g)?.length).toBe(2)
  } finally { mock.mockRestore() }
})

test('cancels a disconnected SSE reader so a fresh GET can attach to the session', async () => {
  const { address, url } = await startServer()
  const id = await initializeSession(url)
  const socket = net.connect(address.port, '127.0.0.1')
  socket.write(`GET /bb-mcp HTTP/1.1\r\nHost: localhost\r\nAccept: text/event-stream\r\nMcp-Session-Id: ${id}\r\n\r\n`)
  await once(socket, 'data')
  const closed = once(socket, 'close')
  socket.destroy()
  await closed
  await delay(20)
  const response = await fetch(url, { headers: { accept: 'text/event-stream', 'mcp-session-id': id } })
  expect(response.status).toBe(200)
  await response.body?.cancel()
})

test('shutdown closes SSE and idle sockets, clears sessions, and permits immediate rebinding', async () => {
  const { address, url, sessions, shutdown } = await startServer()
  const id = await initializeSession(url)
  const response = await fetch(url, { headers: { accept: 'text/event-stream', 'mcp-session-id': id } })
  expect(response.status).toBe(200)
  const idle = net.connect(address.port, '127.0.0.1')
  await once(idle, 'connect')
  const idleClosed = once(idle, 'close')
  const session = sessions.get(id)!
  const closed = spyOn(session.server, 'close')
  await shutdown()
  await idleClosed
  expect(closed).toHaveBeenCalled()
  expect(sessions.size).toBe(0)
  expect(sessionManager.getCount()).toBe(0)
  await response.body?.cancel().catch(() => {})
  const rebound = net.createServer()
  rebound.listen(address.port, '127.0.0.1')
  await once(rebound, 'listening')
  await new Promise<void>((resolve) => rebound.close(() => resolve()))
})

test('rejected initialize attempts do not retain sessions', async () => {
  const { url, sessions } = await startServer()
  const response = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(initialize)
  })
  expect(response.status).toBeGreaterThanOrEqual(400)
  await response.text()
  expect(sessions.size).toBe(0)
  expect(sessionManager.getCount()).toBe(0)
})

test('invalid initialize parameters do not retain a session', async () => {
  const { url, sessions } = await startServer()
  const response = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ ...initialize, params: {} })
  })
  const body = await response.json() as { error?: unknown }
  expect(body.error).toBeDefined()
  expect(sessions.size).toBe(0)
  expect(sessionManager.getCount()).toBe(0)
})

test('failed transport connection closes its newly allocated MCP server', async () => {
  const { url, sessions } = await startServer()
  const connect = spyOn(McpServer.prototype, 'connect').mockRejectedValueOnce(new Error('test connection failure'))
  const close = spyOn(McpServer.prototype, 'close')
  try {
    const response = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify(initialize)
    })
    expect(response.status).toBe(500)
    await response.text()
    expect(close).toHaveBeenCalled()
    expect(sessions.size).toBe(0)
  } finally {
    connect.mockRestore()
    close.mockRestore()
  }
})

test('transport pongs received as HTTP POST do not refresh inactivity', async () => {
  const { url } = await startServer()
  sessionManager.configure({ inactivityTimeoutMs: 50 })
  const id = await initializeSession(url)
  for (let count = 0; count < 5; ++count) {
    await delay(15)
    const response = await fetch(url, {
      method: 'POST', headers: {
        'mcp-session-id': id, 'content-type': 'application/json', accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: `keepalive-${count}`, result: {} })
    })
    await response.text()
  }
  expect(sessionManager.has(id)).toBe(false)
})

test('disconnecting releases the HTTP waiter even if the SDK response promise never settles', async () => {
  const { url, address, sessions } = await startServer()
  sessionManager.configure({ inactivityTimeoutMs: 50 })
  const id = await initializeSession(url)
  const handler = spyOn(sessions.get(id)!.transport, 'handleRequest').mockImplementation(() => new Promise(() => {}))
  const socket = net.connect(address.port, '127.0.0.1')
  try {
    socket.write(rawRequest('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{}}', `Mcp-Session-Id: ${id}\r\n`))
    await delay(15)
    const closed = once(socket, 'close')
    socket.destroy()
    await closed
    await delay(80)
    expect(sessionManager.has(id)).toBe(false)
    expect(sessions.size).toBe(0)
  } finally {
    socket.destroy()
    handler.mockRestore()
  }
})

test('DELETE closes the server and makes a terminated session return 404', async () => {
  const { url, sessions } = await startServer()
  const id = await initializeSession(url)
  const closed = spyOn(sessions.get(id)!.server, 'close')
  const response = await fetch(url, { method: 'DELETE', headers: { 'mcp-session-id': id } })
  expect(response.status).toBe(200)
  await response.text()
  expect(closed).toHaveBeenCalled()
  expect(sessions.size).toBe(0)
  const stale = await fetch(url, { headers: { 'mcp-session-id': id } })
  expect(stale.status).toBe(404)
  await stale.text()
})
