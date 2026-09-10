import { afterEach, expect, test } from 'bun:test'
import { SessionManager } from '../lib/sessions'

const managers: SessionManager[] = []
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
function manager (timeout = 30, ping = 0): SessionManager {
  const instance = new SessionManager()
  instance.configure({ inactivityTimeoutMs: timeout, pingIntervalMs: ping })
  managers.push(instance)
  return instance
}
afterEach(async () => { for (const instance of managers.splice(0)) await instance.clear() })

test('clear removes sessions through their async cleanup callbacks and waits for completion', async () => {
  const sessions = manager()
  const closed: string[] = []
  sessions.setRemovalCallback(async (id) => {
    await delay(5)
    sessions.remove(id)
    closed.push(id)
  })
  sessions.add('one')
  sessions.add('two')
  const completion = sessions.clear()
  expect(sessions.getCount()).toBe(0)
  expect(closed).toEqual([])
  await completion
  expect(closed.sort()).toEqual(['one', 'two'])
})

test('active and queued requests defer expiration until all requests finish', async () => {
  const sessions = manager()
  sessions.add('one')
  const endFirst = sessions.beginActivity('one')
  sessions.beginActivity('one')
  await delay(50)
  expect(sessions.has('one')).toBe(true)
  endFirst()
  endFirst()
  await delay(50)
  expect(sessions.has('one')).toBe(true)
  sessions.endActivity('one')
  await delay(50)
  expect(sessions.has('one')).toBe(false)
})

test('successful transport pings do not keep an unused session alive forever', async () => {
  const sessions = manager(40, 5)
  sessions.setPingCallback(async () => true)
  sessions.add('idle')
  await delay(65)
  expect(sessions.has('idle')).toBe(false)
})

test('ping callbacks cannot overlap and completion after removal cannot resurrect a session', async () => {
  const sessions = manager(500, 5)
  let active = 0
  let maximum = 0
  sessions.setPingCallback(async () => {
    maximum = Math.max(maximum, ++active)
    await delay(25)
    --active
    return true
  })
  sessions.add('one')
  await delay(65)
  sessions.remove('one')
  await delay(35)
  expect(maximum).toBe(1)
  expect(sessions.has('one')).toBe(false)
})
