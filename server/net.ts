import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { EmptyResultSchema } from '@modelcontextprotocol/sdk/types.js'
import type { Server as NetServer, Socket } from 'node:net'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  registerToolsOnServer,
  registerResourcesOnServer,
  registerPromptsOnServer
} from '@/lib/factories'
import { createServer as createMcpServer } from '@/server/server'
import { sessionManager, type SessionConfig } from '@/lib/sessions'
import { workspaceManager } from '@/lib/workspaces'

export type { NetServer }

interface KeepAliveConfig {
  enabled: boolean
  initialDelay: number
  idleTimeoutMs: number
  sseHeartbeatIntervalMs: number
  pingTimeoutMs: number
  httpKeepAliveTimeoutSec: number
}

const DEFAULT_KEEP_ALIVE: KeepAliveConfig = {
  enabled: true,
  initialDelay: 30000,
  idleTimeoutMs: 10 * 60 * 1000,
  sseHeartbeatIntervalMs: 15000,
  pingTimeoutMs: 5000,
  httpKeepAliveTimeoutSec: 75
}

type SessionTransport = {
  transport: WebStandardStreamableHTTPServerTransport
  server: McpServer
}

export type SessionTransports = Map<string, SessionTransport>
export type ShutdownServer = () => Promise<void>

const MAX_HEADER_BYTES = 16 * 1024
const MAX_BODY_BYTES = 32 * 1024 * 1024
// Includes chunk framing, and bounds bytes queued behind a running request.
const MAX_BUFFER_BYTES = MAX_BODY_BYTES + 1024 * 1024

class HttpError extends Error {
  constructor (readonly status: number, message: string) {
    super(message)
  }
}

interface ParsedRequest {
  method: string
  path: string
  headers: Record<string, string>
  body: string
  end: number
  keepAlive: boolean
}

/** Parse one complete HTTP request. null means more bytes are required. */
export function parseHttpRequest (buffer: Buffer): ParsedRequest | null {
  const headerEnd = buffer.indexOf('\r\n\r\n')
  if (headerEnd < 0) {
    if (buffer.length > MAX_HEADER_BYTES) throw new HttpError(431, 'Headers too large')
    return null
  }
  if (headerEnd > MAX_HEADER_BYTES) throw new HttpError(431, 'Headers too large')
  const lines = buffer.subarray(0, headerEnd).toString('latin1').split('\r\n')
  const requestLine = /^([A-Z]+) (\/\S*) HTTP\/(1\.[01])$/.exec(lines[0])
  if (!requestLine) throw new HttpError(400, 'Invalid request line')
  const [, method, path, version] = requestLine
  const headers: Record<string, string> = Object.create(null)
  for (const line of lines.slice(1)) {
    const match = /^([!#$%&'*+.^_`|~\da-zA-Z-]+):[\t ]*([^\r\n]*)$/.exec(line)
    if (!match) throw new HttpError(400, 'Invalid header')
    const key = match[1].toLowerCase()
    const value = match[2].trim()
    if (/[\x00-\x08\x0a-\x1f\x7f]/.test(value)) throw new HttpError(400, 'Invalid header value')
    if (headers[key] !== undefined) {
      if (['content-length', 'transfer-encoding', 'host', 'mcp-session-id'].includes(key)) {
        throw new HttpError(400, 'Duplicate framing or session header')
      }
      headers[key] += `, ${value}`
    } else headers[key] = value
  }
  if (version === '1.1' && !headers.host) throw new HttpError(400, 'Host header is required')
  const bodyStart = headerEnd + 4
  let end = bodyStart
  let bytes: Buffer
  if (headers['transfer-encoding'] !== undefined) {
    if (headers['content-length'] !== undefined || headers['transfer-encoding'].toLowerCase() !== 'chunked') {
      throw new HttpError(400, 'Unsupported or ambiguous request framing')
    }
    const chunks: Buffer[] = []
    let total = 0
    while (true) {
      const lineEnd = buffer.indexOf('\r\n', end)
      if (lineEnd < 0) {
        if (buffer.length - end > MAX_HEADER_BYTES) throw new HttpError(400, 'Invalid chunk size')
        return null
      }
      const sizeLine = buffer.subarray(end, lineEnd).toString('ascii')
      if (!/^[\da-fA-F]+(?:;[^\r\n]*)?$/.test(sizeLine)) throw new HttpError(400, 'Invalid chunk size')
      const size = Number.parseInt(sizeLine.split(';')[0], 16)
      if (!Number.isSafeInteger(size) || total + size > MAX_BODY_BYTES) throw new HttpError(413, 'Body too large')
      end = lineEnd + 2
      if (size === 0) {
        // Trailer fields are consumed, never promoted into request headers.
        const trailerStart = end
        while (true) {
          const trailerEnd = buffer.indexOf('\r\n', end)
          if (trailerEnd < 0) {
            if (buffer.length - trailerStart > MAX_HEADER_BYTES) throw new HttpError(431, 'Trailers too large')
            return null
          }
          if (trailerEnd - trailerStart > MAX_HEADER_BYTES) throw new HttpError(431, 'Trailers too large')
          if (trailerEnd === end) { end += 2; break }
          if (!/^[!#$%&'*+.^_`|~\da-zA-Z-]+:/.test(buffer.subarray(end, trailerEnd).toString('latin1'))) {
            throw new HttpError(400, 'Invalid trailer')
          }
          end = trailerEnd + 2
        }
        break
      }
      if (buffer.length < end + size + 2) return null
      if (buffer.toString('ascii', end + size, end + size + 2) !== '\r\n') throw new HttpError(400, 'Invalid chunk terminator')
      chunks.push(buffer.subarray(end, end + size))
      total += size
      end += size + 2
    }
    bytes = Buffer.concat(chunks, total)
    delete headers['transfer-encoding']
    headers['content-length'] = String(total)
  } else {
    const rawLength = headers['content-length'] ?? '0'
    if (!/^\d+$/.test(rawLength)) throw new HttpError(400, 'Invalid content length')
    const length = Number(rawLength)
    if (!Number.isSafeInteger(length) || length > MAX_BODY_BYTES) throw new HttpError(413, 'Body too large')
    end += length
    if (buffer.length < end) return null
    bytes = buffer.subarray(bodyStart, end)
  }
  const connection = headers.connection?.toLowerCase().split(/\s*,\s*/) ?? []
  return {
    method, path, headers, body: bytes.toString('utf8'), end,
    keepAlive: !connection.includes('close') && (version === '1.1' || connection.includes('keep-alive'))
  }
}

function getStatusText (status: number): string {
  const texts: Record<number, string> = {
    200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content',
    400: 'Bad Request', 403: 'Forbidden', 404: 'Not Found',
    405: 'Method Not Allowed', 406: 'Not Acceptable', 409: 'Conflict',
    413: 'Content Too Large', 415: 'Unsupported Media Type',
    431: 'Request Header Fields Too Large', 500: 'Internal Server Error',
    503: 'Service Unavailable'
  }
  return texts[status] || 'Unknown'
}

function isInitializeRequestBody (method: string, body: string): boolean {
  if (method !== 'POST' || !body) return false
  try {
    const parsed: unknown = JSON.parse(body)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) &&
      (parsed as { method?: unknown }).method === 'initialize'
  } catch { return false }
}

function hasClientActivity (method: string, body: string): boolean {
  if (method !== 'POST') return false
  try {
    const message: unknown = JSON.parse(body)
    if (!message || typeof message !== 'object') return false
    const requestMethod = (message as { method?: unknown }).method
    // Responses to server pings and client keep-alive pings are liveness only.
    return typeof requestMethod === 'string' && requestMethod !== 'ping'
  } catch { return false }
}

/** The SDK's JSON-response promise may remain pending after transport.close(). */
async function awaitResponse (pending: Promise<Response>, signal: AbortSignal): Promise<Response> {
  void pending.then((response) => {
    if (signal.aborted) void response.body?.cancel().catch(() => {})
  }, () => {})
  let abort: () => void = () => {}
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new DOMException('Connection closed', 'AbortError'))
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
  try { return await Promise.race([pending, cancelled]) } finally {
    signal.removeEventListener('abort', abort)
  }
}

export default function createNetServer (
  { createServer }: { createServer: (callback: (socket: Socket) => void) => NetServer },
  { port, endpoint, keepAlive, sessionConfig }: {
    endpoint: string
    port: number
    keepAlive?: Partial<KeepAliveConfig>
    sessionConfig?: Partial<SessionConfig>
  }
): [NetServer, SessionTransports, ShutdownServer] {
  const sessionTransports: SessionTransports = new Map()
  // Includes transports still connecting or rejected before an ID is assigned.
  const allSessions = new Set<SessionTransport>()
  const closingSessions = new Map<SessionTransport, Promise<void>>()
  const sockets = new Set<Socket>()
  const keepAliveConfig = { ...DEFAULT_KEEP_ALIVE, ...keepAlive }
  let stopping = false
  let shutdownPromise: Promise<void> | undefined

  if (sessionConfig) sessionManager.configure(sessionConfig)

  function closeSession (session: SessionTransport): Promise<void> {
    const existing = closingSessions.get(session)
    if (existing) return existing
    if (!allSessions.has(session)) return Promise.resolve()
    const sessionId = session.transport.sessionId
    if (sessionId) {
      sessionTransports.delete(sessionId)
      workspaceManager.closeSession(sessionId)
    }
    // Defer until the promise is stored to make SDK onclose callbacks reentrant.
    const closing = Promise.resolve().then(async () => {
      if (sessionId) sessionManager.remove(sessionId)
      try { await session.server.close() } catch (error) {
        console.error('[MCP] Error closing session server:', error)
      }
      try { await session.transport.close() } catch (error) {
        console.error('[MCP] Error closing session transport:', error)
      }
      allSessions.delete(session)
    }).finally(() => closingSessions.delete(session))
    closingSessions.set(session, closing)
    return closing
  }

  sessionManager.setRemovalCallback((sessionId) => {
    const session = sessionTransports.get(sessionId)
    if (session) return closeSession(session)
    workspaceManager.closeSession(sessionId)
  })
  sessionManager.setPingCallback(async (sessionId) => {
    const session = sessionTransports.get(sessionId)
    if (!session || stopping) return false
    try {
      await session.server.server.request(
        { method: 'ping' }, EmptyResultSchema, { timeout: keepAliveConfig.pingTimeoutMs }
      )
      return true
    } catch { return false }
  })

  const httpServer = createServer((socket) => {
    if (stopping) { socket.destroy(); return }
    sockets.add(socket)
    let buffer = Buffer.alloc(0)
    let socketEnded = false
    let processing = false
    let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let requestAbort: AbortController | undefined
    let heartbeat: ReturnType<typeof setInterval> | undefined

    if (keepAliveConfig.enabled) socket.setKeepAlive(true, keepAliveConfig.initialDelay)
    socket.setTimeout(keepAliveConfig.idleTimeoutMs)
    socket.on('timeout', () => socket.destroy())
    socket.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ECONNRESET') console.error('[MCP] Socket error:', error.message)
      socket.destroy()
    })
    socket.on('close', () => {
      socketEnded = true
      sockets.delete(socket)
      buffer = Buffer.alloc(0)
      stopStream()
    })
    socket.on('data', (chunk: Buffer) => {
      if (socketEnded) return
      if (buffer.length + chunk.length > MAX_BUFFER_BYTES) { socket.destroy(); return }
      buffer = Buffer.concat([buffer, chunk])
      // A single consumer owns this socket until its current response finishes.
      if (!processing) void processHttpRequests()
    })

    function writable (): boolean {
      return !socketEnded && !socket.destroyed && socket.writable
    }

    function stopStream (): void {
      if (heartbeat) clearInterval(heartbeat)
      heartbeat = undefined
      requestAbort?.abort()
      if (activeReader) void activeReader.cancel().catch(() => {})
    }

    async function writeChunk (chunk: string | Uint8Array): Promise<void> {
      if (!writable()) return
      if (!socket.write(chunk)) {
        await new Promise<void>((resolve) => {
          const done = () => {
            socket.off('drain', done)
            socket.off('close', done)
            resolve()
          }
          socket.once('drain', done)
          socket.once('close', done)
        })
      }
    }

    function writeHeaders (status: number, headers: Record<string, string>): void {
      headers.date ??= new Date().toUTCString()
      let text = `HTTP/1.1 ${status} ${getStatusText(status)}\r\n`
      for (const [key, value] of Object.entries(headers)) text += `${key}: ${value}\r\n`
      socket.write(text + '\r\n')
    }

    function sendResponse (status: number, headers: Record<string, string>, body: string, request?: ParsedRequest): void {
      if (!writable()) return
      const keepAlive = request?.keepAlive === true && !stopping
      delete headers['transfer-encoding']
      headers['content-length'] = String(Buffer.byteLength(body))
      headers.connection = keepAlive ? 'keep-alive' : 'close'
      if (keepAlive && keepAliveConfig.httpKeepAliveTimeoutSec > 0) {
        headers['keep-alive'] = `timeout=${keepAliveConfig.httpKeepAliveTimeoutSec}`
      }
      writeHeaders(status, headers)
      const responseBody = request?.method === 'HEAD' ? '' : body
      if (keepAlive) socket.write(responseBody)
      else {
        socketEnded = true
        socket.end(responseBody)
      }
    }

    function sendError (status: number, message: string, request?: ParsedRequest): void {
      sendResponse(status, { 'content-type': 'application/json' }, JSON.stringify({
        jsonrpc: '2.0', error: { code: status === 404 ? -32001 : -32000, message }, id: null
      }), request)
    }

    async function sendWebResponse (response: Response, request: ParsedRequest): Promise<void> {
      if (!writable()) {
        await response.body?.cancel()
        return
      }
      const headers: Record<string, string> = {}
      response.headers.forEach((value, key) => { headers[key] = value })
      if (!headers['content-type'] && response.status !== 204) headers['content-type'] = 'application/json'
      if (!headers['content-type']?.includes('text/event-stream')) {
        sendResponse(response.status, headers, await response.text(), request)
        return
      }

      delete headers['content-length']
      delete headers['transfer-encoding']
      headers['cache-control'] = 'no-cache'
      // SSE is close-delimited. A later HTTP response must never enter its body.
      headers.connection = 'close'
      writeHeaders(response.status, headers)
      let lastChunkAt = Date.now()
      // Only insert comments at an event boundary; do not corrupt partial events.
      let tail = ''
      let atEventBoundary = true
      const heartbeatMs = keepAliveConfig.sseHeartbeatIntervalMs
      if (heartbeatMs > 0) {
        heartbeat = setInterval(() => {
          if (!writable()) { stopStream(); return }
          if (atEventBoundary && Date.now() - lastChunkAt >= heartbeatMs && !socket.writableNeedDrain) {
            socket.write(': keepalive\n\n')
            lastChunkAt = Date.now()
          }
        }, heartbeatMs)
      }
      const reader = response.body?.getReader()
      activeReader = reader
      try {
        while (reader && writable()) {
          const { done, value } = await reader.read()
          if (done) break
          tail = (tail + new TextDecoder().decode(value)).slice(-4)
          atEventBoundary = tail.endsWith('\n\n') || tail.endsWith('\r\n\r\n')
          await writeChunk(value)
          lastChunkAt = Date.now()
        }
      } finally {
        stopStream()
        reader?.releaseLock()
        activeReader = undefined
        socketEnded = true
        socket.end()
      }
    }

    async function handleRequest (request: ParsedRequest): Promise<void> {
      const { method, path, headers, body } = request
      const pathWithoutQuery = path.split('?')[0]
      if (pathWithoutQuery === '/health' || pathWithoutQuery === endpoint + '/health') {
        sendResponse(200, { 'content-type': 'application/json' }, JSON.stringify({
          status: 'ok', timestamp: new Date().toISOString(),
          sessions: { active: sessionManager.getCount(), config: sessionManager.getConfig() }
        }), request)
        return
      }
      if (pathWithoutQuery === '/ready' || pathWithoutQuery === endpoint + '/ready') {
        sendResponse(200, { 'content-type': 'application/json' }, JSON.stringify({ ready: true }), request)
        return
      }
      if (pathWithoutQuery !== endpoint) {
        sendError(404, 'Not Found', request)
        return
      }
      const sessionId = headers['mcp-session-id']
      let session = sessionId ? sessionTransports.get(sessionId) : undefined
      if (sessionId && !session) { sendError(404, 'Session not found. Please reinitialize.', request); return }
      if (!session && !isInitializeRequestBody(method, body)) {
        sendError(400, 'Bad Request: Mcp-Session-Id header is required', request)
        return
      }
      let created: SessionTransport | undefined
      const endActivity = sessionId && hasClientActivity(method, body) ? sessionManager.beginActivity(sessionId) : () => {}
      try {
        if (!session) {
          const sessionServer = createMcpServer()
          const transport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            enableJsonResponse: true,
            onsessioninitialized: (id) => {
              if (stopping) return
              sessionTransports.set(id, newSession)
              workspaceManager.openSession(id)
              sessionManager.add(id)
              sessionServer.server.oninitialized = () => {
                const info = sessionServer.server.getClientVersion()
                if (info) sessionManager.updateClientInfo(id, info.name, info.version)
              }
            },
            onsessionclosed: (id) => { sessionManager.remove(id) }
          })
          const newSession: SessionTransport = { transport, server: sessionServer }
          created = newSession
          allSessions.add(newSession)
          registerToolsOnServer(sessionServer)
          registerResourcesOnServer(sessionServer)
          registerPromptsOnServer(sessionServer)
          await sessionServer.connect(transport)
          if (stopping || !writable()) {
            // connect() can finish after shutdown already closed this object.
            await sessionServer.close()
            await transport.close()
            return
          }
          session = newSession
        }
        requestAbort = new AbortController()
        const webRequest = new Request(`http://127.0.0.1:${port}${path}`, {
          method,
          headers,
          signal: requestAbort.signal,
          ...(method !== 'GET' && method !== 'HEAD' && body ? { body } : {})
        })
        const response = await awaitResponse(session.transport.handleRequest(webRequest), requestAbort.signal)
        await sendWebResponse(response, request)
        // Invalid initialize requests allocate SDK objects but never a session ID.
        if (created && (!created.transport.sessionId || response.status >= 400)) await closeSession(created)
      } catch (error) {
        if (created) await closeSession(created)
        throw error
      } finally {
        endActivity()
        requestAbort = undefined
        if (created && (stopping || socket.destroyed || !created.transport.sessionId)) await closeSession(created)
      }
    }

    async function processHttpRequests (): Promise<void> {
      processing = true
      try {
        while (writable() && !stopping) {
          const request = parseHttpRequest(buffer)
          if (!request) return
          buffer = buffer.subarray(request.end)
          socket.setTimeout(keepAliveConfig.idleTimeoutMs)
          await handleRequest(request)
          if (writable()) socket.setTimeout(keepAliveConfig.httpKeepAliveTimeoutSec * 1000)
        }
      } catch (error) {
        if (error instanceof HttpError) sendError(error.status, error.message)
        else if (!(error instanceof Error && error.name === 'AbortError')) {
          console.error('[MCP] Request handler error:', error)
          sendError(500, 'Internal server error')
        }
      } finally {
        processing = false
      }
    }
  })

  const shutdown: ShutdownServer = () => {
    if (shutdownPromise) return shutdownPromise
    stopping = true
    const closed = new Promise<void>((resolve) => {
      httpServer.close(() => resolve())
    })
    for (const socket of sockets) socket.destroy()
    // clear() invokes removal callbacks before detaching them and returns their completion.
    const clearSessions = sessionManager.clear()
    shutdownPromise = Promise.all([
      closed, clearSessions, ...[...allSessions].map(closeSession)
    ]).then(() => {})
    return shutdownPromise
  }
  httpServer.on('error', (error: Error) => {
    console.error('[MCP] Server error:', error)
    if (typeof Blockbench !== 'undefined') Blockbench.showQuickMessage(`MCP Server error: ${error.message}`, 3000)
    void shutdown()
  })
  httpServer.listen(port, '127.0.0.1', () => {
    console.log(`[MCP] Server listening on http://127.0.0.1:${port}${endpoint}`)
  })
  return [httpServer, sessionTransports, shutdown]
}
