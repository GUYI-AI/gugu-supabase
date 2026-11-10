import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  Fixture,
  SEED,
  Typist,
  childService,
  count,
  getFile,
  machine,
  makeGate,
  openPage,
  filesConfig,
  sleep,
  startIssuer,
  startFiles,
  stats,
  typeString,
  waitFor,
  type Issuer,
  type Running,
} from './support.ts'

/**
 * E4(原型 e4-lifecycle 的本仓版):干净关闭后卸载、kill -9、合盖期间服务端卸载(对照:只存文本)、冷压缩与换代。
 */
let fx: Fixture
let issuer: Issuer
let dbUrl: string
let chat: string
const u = { a: '', b: '' }

beforeAll(async () => {
  fx = new Fixture()
  await fx.connect()
  issuer = await startIssuer()
  dbUrl = await fx.filesLogin()
  u.a = await fx.person('E4 A')
  u.b = await fx.person('E4 B')
  chat = await fx.group(u.a, [u.b])
})
afterAll(async () => {
  await issuer?.close()
  await fx?.cleanup()
})

describe('E4a 干净关闭', () => {
  let svc: Running
  afterAll(async () => svc?.close())
  it('开着时不卸载;最后一个页面关掉 ⇒ 立刻存盘并卸载,库里有刚打的字', async () => {
    svc = await startFiles(filesConfig(dbUrl, issuer.jwksUrl))
    const doc = await fx.file(chat, u.a, 'close.md', 'text/markdown', SEED)
    const m = machine(svc.url, await issuer.mint(u.a))
    const p = openPage(m, doc, 0)
    await p.synced
    await typeString(new Typist(p, '（A 在这段后面写）'), '‹U1›', 50)
    await sleep(1500)
    expect(svc.service.hocuspocus.documents.has(`${doc}@0`)).toBe(true) // 对照:开着就不卸载
    const tClose = Date.now()
    p.close()
    const ms = await waitFor(() => !svc.service.hocuspocus.documents.has(`${doc}@0`), 5000, 5)
    expect(ms).toBeGreaterThanOrEqual(0)
    expect(Date.now() - tClose).toBeLessThan(2000)
    expect((await fx.row(doc))!.inline_text).toContain('‹U1›')
    m.socket.destroy()
  })
})

describe('E4b kill -9', () => {
  it('两个人打字时服务被 kill -9 再起来 ⇒ 每个标记在库里完整且只出现一次,库与副本相同', async () => {
    const doc = await fx.file(chat, u.a, 'crash.md', 'text/markdown', SEED)
    const child = await childService(dbUrl, issuer.jwksUrl)
    await child.start()
    try {
      const A = machine(child.url, await issuer.mint(u.a))
      const B = machine(child.url, await issuer.mint(u.b))
      const pa = openPage(A, doc, 0)
      const pb = openPage(B, doc, 0)
      await Promise.all([pa.synced, pb.synced])
      const typed: string[] = []
      const run = async (p: typeof pa, anchor: string, name: string) => {
        const ty = new Typist(p, anchor)
        for (let i = 1; i <= 30; i++) {
          const tk = `‹${name}${i}›`
          await typeString(ty, tk, 25)
          typed.push(tk)
        }
      }
      const crash = (async () => {
        await sleep(2500)
        await child.kill('SIGKILL')
        await sleep(1500)
        await child.start()
      })()
      await Promise.all([run(pa, '（A 在这段后面写）', 'A'), run(pb, '（B 在这段后面写）', 'B'), crash])
      const t = await issuer.mint(u.a)
      const settle = await waitFor(async () => {
        const live = await getFile(child.url, t, doc)
        return live.body.live === true && live.body.text === pa.text() && pa.text() === pb.text()
      }, 15_000, 100)
      expect(settle).toBeGreaterThanOrEqual(0)
      pa.close()
      pb.close()
      const unloaded = await waitFor(async () => (await stats(child.adminUrl)).documents === 0, 8000)
      // Intermittent in CI only: print what the service still holds before failing.
      if (unloaded < 0) console.error('E4b: document still loaded 8 s after both pages closed', JSON.stringify(await stats(child.adminUrl)))
      expect(unloaded).toBeGreaterThanOrEqual(0)
      const row = await fx.row(doc)
      expect(typed).toHaveLength(60)
      expect(typed.filter((tk) => count(row!.inline_text!, tk) !== 1)).toEqual([])
      expect(count(row!.inline_text!, '# 协同测试文档')).toBe(1)
      expect(row!.inline_text).toBe(pa.text())
      A.socket.destroy()
      B.socket.destroy()
    } finally {
      await child.kill('SIGTERM')
    }
  })
})

describe('E4c 合盖期间服务端卸载', () => {
  let svc: Running
  beforeAll(async () => {
    svc = await startFiles(filesConfig(dbUrl, issuer.jwksUrl, { timeoutMs: 3000 }))
  })
  afterAll(async () => svc?.close())

  /** 合盖(帧两头都扣住)、合盖前一刻打的字没发出去;服务端超时断开、存盘、卸载;开盖。 */
  async function lid(textOnlyControl: boolean) {
    const doc = await fx.file(chat, u.a, 'lid.md', 'text/markdown', SEED)
    const gate = makeGate()
    const A = machine(svc.url, await issuer.mint(u.a), { gate })
    const p = openPage(A, doc, 0)
    await p.synced
    const ty = new Typist(p, '（A 在这段后面写）')
    await typeString(ty, '‹L1›', 50)
    await sleep(1500)
    gate.pause()
    await typeString(ty, '‹OFFLINE›', 50)
    const unloaded = await waitFor(() => !svc.service.hocuspocus.documents.has(`${doc}@0`), 20_000, 100)
    expect(unloaded).toBeGreaterThanOrEqual(0)
    // 对照:一个只存正文、不存协同状态的服务 —— 下次加载按正文重建,生成另一套 item id。
    if (textOnlyControl) await fx.admin.query('UPDATE chat.workspace_items SET ystate = NULL WHERE id = $1', [doc])
    gate.resume()
    const t = await issuer.mint(u.a)
    await waitFor(async () => {
      const live = await getFile(svc.url, t, doc)
      return live.body.live === true && live.body.text === p.text()
    }, 15_000, 100)
    const live = (await getFile(svc.url, t, doc)).body.text as string
    p.close()
    A.socket.destroy()
    await waitFor(() => !svc.service.hocuspocus.documents.has(`${doc}@0`), 8000)
    return { offline: count(live, '‹OFFLINE›'), header: count(live, '# 协同测试文档'), l1: count(live, '‹L1›') }
  }

  it('存 ystate:开盖后离线打的字补上,不重复', async () => {
    expect(await lid(false)).toEqual({ offline: 1, header: 1, l1: 1 })
  })
  it('对照 —— 只存正文:开盖后整篇内容重复一遍', async () => {
    const r = await lid(true)
    expect(r.header).toBe(2)
    expect(r.l1).toBe(2)
  })
})

describe('E4d 冷压缩与换代', () => {
  let svc: Running
  beforeAll(async () => {
    // 超时要长过 A 那一段(打字 + 关页面),对照「B 还挂着就不压缩」才看得到。
    svc = await startFiles(filesConfig(dbUrl, issuer.jwksUrl, { timeoutMs: 8000 }))
  })
  afterAll(async () => svc?.close())

  it('历史远大于正文 ⇒ 卸载后按正文重建、epoch+1;还开着时不压缩;旧代号的客户端被告知 stale-epoch,重载后重放离线改动', async () => {
    const doc = await fx.file(chat, u.a, 'compact.md', 'text/markdown', SEED)
    const gateB = makeGate()
    const A = machine(svc.url, await issuer.mint(u.a))
    const B = machine(svc.url, await issuer.mint(u.b), { gate: gateB })
    const pa = openPage(A, doc, 0)
    const pb = openPage(B, doc, 0)
    await Promise.all([pa.synced, pb.synced])

    // B 记下自己没被服务端确认的本地改动,每条是一个带上下文的 edit(旧, 新) —— 和 agent 用的是同一个原语。
    const CTX = 12
    const spanEdit = (before: string, after: string) => {
      let p0 = 0
      while (p0 < before.length && p0 < after.length && before[p0] === after[p0]) p0++
      let s0 = 0
      while (s0 < before.length - p0 && s0 < after.length - p0 && before[before.length - 1 - s0] === after[after.length - 1 - s0]) s0++
      return { old: before.slice(Math.max(0, p0 - CTX), before.length - s0 + CTX), new: after.slice(Math.max(0, p0 - CTX), after.length - s0 + CTX) }
    }
    const unsynced: { old: string; new: string }[] = []
    let recording = false
    let beforeText = ''
    pb.doc.on('beforeTransaction', (tr) => {
      if (tr.local) beforeText = pb.text()
    })
    pb.doc.on('afterTransaction', (tr) => {
      if (tr.local && recording && pb.text() !== beforeText) unsynced.push(spanEdit(beforeText, pb.text()))
    })
    gateB.pause() // B 合盖,带着一处没发出去的改动
    recording = true
    await typeString(new Typist(pb, '（B 在这段后面写）'), '‹B-OFFLINE›', 50)

    // A 写很多、改很多(历史 >> 正文)。每 200 下合成一个事务发出去 —— 9000 条单独的消息会撞上每连接的限速。
    const ty = new Typist(pa, '（A 在这段后面写）')
    let seed = 3
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    for (let batch = 0; batch < 45; batch++) {
      pa.doc.transact(() => {
        for (let i = 0; i < 200; i++) {
          if (rnd() < 0.35) ty.backspace()
          else ty.type(String.fromCharCode(97 + Math.floor(rnd() * 26)))
        }
      })
      await sleep(20)
    }
    await sleep(1500)
    const aText = pa.text()
    pa.close()
    await sleep(500)
    // 对照:B 还挂着(服务端看来连接还在)⇒ 文档不卸载、不压缩,代号不变。
    expect(svc.service.stats.compactions).toBe(0)
    expect((await fx.row(doc))!.epoch).toBe(0)

    expect(await waitFor(() => svc.service.stats.compactions > 0, 20_000, 100)).toBeGreaterThanOrEqual(0)
    const row = (await fx.row(doc))!
    expect(row.epoch).toBe(1)
    expect(row.ys!).toBeLessThan(4 * Buffer.byteLength(row.inline_text!) + 4096)
    expect(svc.logs.some((l) => l.msg === 'compacted' && l.itemId === doc)).toBe(true)

    gateB.resume() // B 开盖:拿着代号 0 重连,被拒
    expect(await waitFor(() => !!pb.events.authFailed, 15_000, 50)).toBeGreaterThanOrEqual(0)
    expect(pb.events.authFailed!.reason).toBe('stale-epoch:1')

    recording = false
    pb.close()
    const fresh = openPage(B, doc, 1)
    await fresh.synced
    const t = fresh.doc.getText('content')
    let replayed = 0
    for (const e of unsynced) {
      const cur = t.toString()
      if (count(cur, e.old) !== 1) continue
      const at = cur.indexOf(e.old)
      fresh.doc.transact(() => {
        t.delete(at, e.old.length)
        t.insert(at, e.new)
      })
      replayed++
    }
    expect(unsynced.length).toBeGreaterThan(0)
    expect(replayed).toBe(unsynced.length)
    await sleep(500)
    const live = (await getFile(svc.url, await issuer.mint(u.a), doc)).body.text as string
    expect(count(live, '‹B-OFFLINE›')).toBe(1)
    expect(count(live, '# 协同测试文档')).toBe(1)
    expect(live).toContain(aText.slice(60, 120))
    fresh.close()
    A.socket.destroy()
    B.socket.destroy()
  })
})
