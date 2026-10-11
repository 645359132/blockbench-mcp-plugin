import { afterAll, beforeAll, expect, test } from 'bun:test'
import * as net from 'node:net'
import { once } from 'node:events'
import { z } from 'zod'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createResource, createTool, getAllToolDefinitions } from '../lib/factories'
import { registerProjectTools } from '../server/tools/project'
import createNetServer, { type ShutdownServer } from '../server/net'

interface TestCube { name: string; from: number[]; to: number[] }
interface TestProject {
  uuid: string
  name: string
  cubes: TestCube[]
  select(): boolean
  unselect(): void
}
let active: TestProject | undefined
const projects: TestProject[] = []
const originals = new Map<string, PropertyDescriptor | undefined>()
const connections: Array<{ client: Client; transport: StreamableHTTPClientTransport }> = []
let shutdown: ShutdownServer | undefined
let url: URL

function install (name: string, descriptor: PropertyDescriptor): void {
  originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  Object.defineProperty(globalThis, name, { configurable: true, ...descriptor })
}

async function connect (name: string) {
  const client = new Client({ name, version: '1' })
  const transport = new StreamableHTTPClientTransport(url)
  const connection = { client, transport }
  connections.push(connection)
  await client.connect(transport)
  return connection
}

beforeAll(async () => {
  install('Project', { get: () => active })
  install('ModelProject', { value: { all: projects } })
  install('Formats', { value: { bedrock_block: { id: 'bedrock_block' } } })
  install('newProject', { value: () => {
    const project: TestProject = {
      uuid: crypto.randomUUID(), name: '', cubes: [],
      select () { active = this; return true },
      unselect () { active = undefined }
    }
    projects.push(project)
    active = project
    return true
  } })
  // Bun shares the module registry across test files; project tools may be registered already.
  if (!getAllToolDefinitions().create_project) registerProjectTools()
  createTool('wire_add_cube', {
    description: 'Add validated cube geometry through the real HTTP workspace boundary.',
    parameters: z.object({
      name: z.string(), from: z.array(z.number()).length(3), to: z.array(z.number()).length(3),
      delay: z.number().default(0)
    }),
    async execute ({ name, from, to, delay }) {
      const project = active!
      await Bun.sleep(delay)
      if (active !== project) throw new Error('The active project changed during an asynchronous edit')
      project.cubes.push({ name, from, to })
      return JSON.stringify({ uuid: project.uuid, cubes: project.cubes })
    }
  })
  createResource('wire_model', {
    uriTemplate: 'wire-model://{id}', description: 'Read the model bound to the requesting workspace.',
    async listCallback () {
      return { resources: active ? [{ uri: 'wire-model://active', name: active.name }] : [] }
    },
    async readCallback (uri) {
      return { contents: [{ uri: uri.href, text: JSON.stringify({ uuid: active?.uuid, cubes: active?.cubes ?? [] }) }] }
    }
  })
  const [server, , stop] = createNetServer(net, {
    port: 0, endpoint: '/bb-mcp',
    sessionConfig: { pingIntervalMs: 0, inactivityTimeoutMs: 60_000 },
    keepAlive: { sseHeartbeatIntervalMs: 0 }
  })
  shutdown = stop
  await once(server, 'listening')
  url = new URL(`http://127.0.0.1:${(server.address() as net.AddressInfo).port}/bb-mcp`)
})

afterAll(async () => {
  for (const { client, transport } of connections) {
    await transport.terminateSession().catch(() => {})
    await client.close()
  }
  await shutdown?.()
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else Reflect.deleteProperty(globalThis, name)
  }
})

test('two SDK clients edit separate models concurrently and read only their own project resources', async () => {
  const [one, two] = await Promise.all([connect('agent-one'), connect('agent-two')])
  expect(one.transport.sessionId).not.toBe(two.transport.sessionId)
  const created = await Promise.all([
    one.client.callTool({ name: 'create_project', arguments: { name: 'wire-first' } }),
    two.client.callTool({ name: 'create_project', arguments: { name: 'wire-second' } })
  ])
  expect(created.every(result => !result.isError)).toBe(true)
  const edited = await Promise.all([
    one.client.callTool({ name: 'wire_add_cube', arguments: { name: 'head', from: [0, 8, 0], to: [8, 16, 8], delay: 40 } }),
    two.client.callTool({ name: 'wire_add_cube', arguments: { name: 'body', from: [0, 0, 0], to: [8, 8, 4] } }),
    one.client.callTool({ name: 'wire_add_cube', arguments: { name: 'hat', from: [-1, 15, -1], to: [9, 17, 9] } })
  ])
  expect(edited.every(result => !result.isError)).toBe(true)
  const first = projects.find(project => project.name === 'wire-first')!
  const second = projects.find(project => project.name === 'wire-second')!
  expect(first.cubes.map(cube => cube.name)).toEqual(['head', 'hat'])
  expect(second.cubes).toEqual([{ name: 'body', from: [0, 0, 0], to: [8, 8, 4] }])
  expect(active).toBeUndefined()

  const [firstRead, secondRead] = await Promise.all([
    one.client.readResource({ uri: 'wire-model://active' }),
    two.client.readResource({ uri: 'wire-model://active' })
  ])
  const firstContent = firstRead.contents[0]
  const secondContent = secondRead.contents[0]
  if (!('text' in firstContent) || !('text' in secondContent)) throw new Error('Expected text model resources')
  expect(JSON.parse(firstContent.text)).toEqual({ uuid: first.uuid, cubes: first.cubes })
  expect(JSON.parse(secondContent.text)).toEqual({ uuid: second.uuid, cubes: second.cubes })
  const [firstList, secondList] = await Promise.all([one.client.listResources(), two.client.listResources()])
  expect(firstList.resources.filter(item => item.uri.startsWith('wire-model:')).map(item => item.name)).toEqual(['wire-first'])
  expect(secondList.resources.filter(item => item.uri.startsWith('wire-model:')).map(item => item.name)).toEqual(['wire-second'])

  const stolen = await two.client.callTool({ name: 'select_project', arguments: { project_id: first.uuid } })
  expect(stolen.isError).toBe(true)
  expect(JSON.stringify(stolen.content)).toContain('another modeling workspace')
})

test('workspace_id and resource metadata isolate two agents sharing one SDK connection', async () => {
  const { client } = await connect('shared-agent-host')
  for (const workspace of ['alpha', 'beta']) {
    const created = await client.callTool({
      name: 'create_project', arguments: { name: `wire-${workspace}`, workspace_id: workspace }
    })
    expect(created.isError).not.toBe(true)
  }
  const edits = await Promise.all(['alpha', 'beta'].map((workspace, index) => client.callTool({
    name: 'wire_add_cube',
    arguments: { workspace_id: workspace, name: `${workspace}-cube`, from: [index, 0, 0], to: [index + 1, 1, 1], delay: 15 }
  })))
  expect(edits.every(result => !result.isError)).toBe(true)
  const reads = await Promise.all(['alpha', 'beta'].map(workspace => client.readResource({
    uri: 'wire-model://active', _meta: { 'blockbench/workspace_id': workspace }
  })))
  for (const [index, workspace] of ['alpha', 'beta'].entries()) {
    const content = reads[index].contents[0]
    if (!('text' in content)) throw new Error('Expected text model resource')
    const read = JSON.parse(content.text)
    expect(read.cubes.map((cube: TestCube) => cube.name)).toEqual([`${workspace}-cube`])
    expect(read.uuid).toBe(projects.find(project => project.name === `wire-${workspace}`)?.uuid)
  }
  const missingScope = await client.callTool({ name: 'wire_add_cube', arguments: { name: 'unbound', from: [0, 0, 0], to: [1, 1, 1] } })
  expect(missingScope.isError).toBe(true)
  expect(JSON.stringify(missingScope.content)).toContain('workspace_id')
})

test('a second create_project in a bound workspace is refused unless rebinding is explicit', async () => {
  const { client } = await connect('rebind')
  const first = await client.callTool({ name: 'create_project', arguments: { name: 'rebind-first' } })
  expect(first.isError).not.toBe(true)
  const second = await client.callTool({ name: 'create_project', arguments: { name: 'rebind-second' } })
  expect(second.isError).toBe(true)
  expect(JSON.stringify(second.content)).toContain('already bound')
  expect(projects.some(project => project.name === 'rebind-second')).toBe(false)
  const rebound = await client.callTool({ name: 'create_project', arguments: { name: 'rebind-second', rebind: true } })
  expect(rebound.isError).not.toBe(true)
  const edit = await client.callTool({ name: 'wire_add_cube', arguments: { name: 'cube', from: [0, 0, 0], to: [1, 1, 1] } })
  expect(JSON.parse((edit.content as Array<{ text: string }>)[0].text).uuid)
    .toBe(projects.find(project => project.name === 'rebind-second')?.uuid)
})
