// #6264 咕咕 server 的「链接 + 短码」登录(behavior/gugu-server.md 第 2 条)。交互照 RFC 8628(设备码)。
//
//   server                          这个函数                             人(手机 / 电脑浏览器)
//   POST /server-login/start  ──►  存一条请求,回 device_code + user_code
//   终端打印链接 + 短码                                                   打开 GET /server-login?code=…
//                                  确认页:这是哪台机器(主机名/系统/用户/公网地址)
//                                  POST send-code ◄──────────────────── 填邮箱
//                                  POST approve   ◄──────────────────── 填邮箱验证码,点「允许」
//   POST /server-login/poll  ──►   批准过 ⇒ 回一次性的 magiclink token_hash(只回一次)
//   用 token_hash 向 GoTrue 换**自己的**会话(与网页那一条互不相干)
//
// #6264 机器上限:「允许」与 poll 领取时各判一次(迁移 *_machine_limits_6264);超了回 error = machine_limit。
//
// 桌面经 SSH 装时另有一条 POST /server-login/grant(带桌面的登录令牌):直接建一条已批准的请求,
// 把 device_code 经 SSH 递过去,server 照旧 poll —— 见下面 handleGrant。
//
// 手机上装着、登着咕咕 App 时,点这条链接直接进 App(安卓 App Links / App 内点链接),
// App 以自己的登录令牌走 POST /server-login/view 与 /server-login/decide —— 与确认页同一个批准(approveAs),
// 只是「是你本人」由令牌证明,不再要邮箱验证码。
//
// verify_jwt = false:确认页是浏览器直接打开的,poll/start 是还没登录的 server 调的。
// 鉴权落在:确认页那一步要当场用邮箱验证码登录;poll 要出示 device_code(库里只存哈希)。
//
// 防钓鱼:别人把他机器的短码发给你骗你点「允许」—— 确认页必须把机器信息摆在「允许」按钮正上方,
// 并写明「只在你自己刚刚在服务器上执行了 gugu-server login 时才点」。
import { createClient } from 'npm:@supabase/supabase-js@2.110.9'
import { createSafeLogger } from '../_shared/safe-log.ts'
import {
  codeEntryStep,
  emailStep,
  finalPage,
  normalizeUserCode,
  otpStep,
  requestState,
  type LoginView,
  type MachineInfo,
  type MachineLimitRefusal,
} from './page.ts'

const POLL_INTERVAL_SECONDS = 5
const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // 去掉 0/O/1/I,念得出、抄得对

const supabaseUrl = () => Deno.env.get('SUPABASE_URL')!
const serviceKey = () => Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const anonKey = () => Deno.env.get('SUPABASE_ANON_KEY')!
const admin = () => createClient(supabaseUrl(), serviceKey(), { auth: { persistSession: false } })

function randomUserCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  const chars = [...bytes].map((b) => USER_CODE_ALPHABET[b % USER_CODE_ALPHABET.length])
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`
}

function randomDeviceCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function clientIp(req: Request): string | null {
  const forwarded = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  return forwarded || req.headers.get('x-real-ip') || null
}

// 咕咕 App 的页面跑在 WebView 自己的源上,调 view / decide 是跨源的(带 Authorization ⇒ 先发预检)。
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS },
  })
}

const log = createSafeLogger('server-login', {
  start: 'info', start_error: 'error', poll_error: 'error', machine_limit: 'warn',
  poll_user_error: 'error', poll_link_error: 'error', approved: 'info', grant_error: 'error',
  granted: 'info', approve_error: 'error', approved_by_user: 'info', denied: 'info',
  otp_send_error: 'error', unhandled: 'error',
})

// ── server 调的两个接口 ────────────────────────────────────────────────────────

function sanitizeMachine(input: unknown): MachineInfo {
  const m = (input ?? {}) as Record<string, unknown>
  const field = (key: string) => (typeof m[key] === 'string' ? (m[key] as string).slice(0, 120) : undefined)
  return {
    hostname: field('hostname'),
    platform: field('platform'),
    arch: field('arch'),
    user: field('user'),
    version: field('version'),
    // #6264 机器上限按机器算:server 报上自己的 machine_id(与设备行同一个),确认页「允许」时据此先判。
    machine_id: machineIdOf(m.machine_id) ?? undefined,
  }
}

/** machine_id 的形状:与设备行上的一致(十六进制 / uuid / 主机指纹这类),长度有上限。 */
function machineIdOf(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9:._-]{1,200}$/.test(value) ? value : null
}

async function handleStart(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}))
  const machine = sanitizeMachine((body as { machine?: unknown }).machine)
  const deviceCode = randomDeviceCode()
  // user_code 撞了就重抽:空间 32^8,撞上几乎不会发生,但唯一约束会把它变成响亮的错误而不是静默覆盖。
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const userCode = randomUserCode()
    const { data, error } = await admin().rpc('server_login_start', {
      p_device_code_hash: await sha256Hex(deviceCode),
      p_user_code: userCode,
      p_machine: machine,
      p_requester_ip: clientIp(req),
    })
    if (!error) {
      const expiresIn = Math.max(0, Math.round((new Date(data as string).getTime() - Date.now()) / 1000))
      log('start')
      return json({ device_code: deviceCode, user_code: userCode, expires_in: expiresIn, interval: POLL_INTERVAL_SECONDS })
    }
    if (!/duplicate key/.test(error.message)) {
      log('start_error')
      return json({ error: 'server_error', error_description: error.message }, 500)
    }
  }
  return json({ error: 'server_error', error_description: 'could not allocate a user code' }, 500)
}

async function handlePoll(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { device_code?: unknown; machine_id?: unknown }
  if (typeof body.device_code !== 'string' || body.device_code.length < 16) {
    return json({ error: 'invalid_request' }, 400)
  }
  const client = admin()
  const { data, error } = await client.rpc('server_login_poll', {
    p_device_code_hash: await sha256Hex(body.device_code),
    p_min_interval_seconds: POLL_INTERVAL_SECONDS,
    p_machine_id: machineIdOf(body.machine_id),
  })
  if (error) {
    log('poll_error')
    return json({ error: 'server_error', error_description: error.message }, 500)
  }
  const row = (Array.isArray(data) ? data[0] : data) as
    | { result: string; user_id: string | null; detail: MachineLimitRefusal | null }
    | undefined
  switch (row?.result) {
    // #6264 这个账号的机器数到上限了:不发登录凭证。server 把 limit / used / max 说成人话。
    case 'machine_limit':
      log('machine_limit')
      return json({ error: 'machine_limit', ...(row.detail ?? {}) }, 400)
    case 'pending':
      return json({ error: 'authorization_pending' }, 400)
    case 'slow_down':
      return json({ error: 'slow_down' }, 400)
    case 'denied':
      return json({ error: 'access_denied' }, 400)
    case 'approved': {
      // 给这个人签一条**一次性**的 magiclink;server 拿它去 GoTrue 换自己的会话链。
      const { data: user, error: userError } = await client.auth.admin.getUserById(row.user_id!)
      if (userError || !user.user?.email) {
        log('poll_user_error')
        return json({ error: 'server_error', error_description: 'approved user has no email' }, 500)
      }
      const { data: link, error: linkError } = await client.auth.admin.generateLink({
        type: 'magiclink',
        email: user.user.email,
      })
      if (linkError || !link.properties?.hashed_token) {
        log('poll_link_error')
        return json({ error: 'server_error', error_description: 'could not mint a login link' }, 500)
      }
      log('approved')
      return json({ token_hash: link.properties.hashed_token, type: 'magiclink', user_id: row.user_id })
    }
    default:
      return json({ error: 'expired_token' }, 400)
  }
}

// ── 桌面经 SSH 一步装好时直接发的「已批准」请求 ───────────────────────────────
//
// behavior/gugu-server.md「从桌面用 SSH 一步装好」:桌面上已经登着的人,❌ 不再走短码 + 邮箱验证码。
// 做法是**复用同一张请求表、同一个 poll**:这里以调用者本人的身份建一条请求并当场批准,只把 device_code
// (取件凭证)交回桌面;桌面经 SSH 的标准输入递给那台机器上的 `gugu-server login --grant-stdin`,
// 由它照旧 poll 一次、换**它自己的**会话链。
//
// 为什么安全、为什么不开新口子:
//  - 批准者就是这次调用的持有人:Authorization 里的令牌必须经 GoTrue `/user` 验过(签名 + 会话仍在),
//    所以只有「此刻登着这个账号的客户端」能发;网页、钓鱼页拿不到桌面的令牌,也就走不了这条路。
//    短码 + 邮箱验证码那条路要防的是「别人发来的码被你批准」——这里没有码给人看、给人批,那个风险不存在。
//  - 交出去的只有 device_code:32 字节随机数,库里只存哈希,poll 一次即作废(同一个 server_login_poll);
//    桌面只经 SSH 通道的 stdin 递出,❌ 不进命令行参数、环境变量、日志。
//  - 请求一步建成已批准(server_login_grant),并记下 via = ssh —— 机器上限据此不把它算进远程隧道(#6264)。
/** 带着登录令牌来的客户端(桌面、咕咕 App)是谁:令牌经 GoTrue `/user` 验过(签名 + 会话仍在)才算。 */
async function bearerUserId(req: Request): Promise<string | null> {
  const bearer = req.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]
  if (!bearer) return null
  const who = await fetch(`${supabaseUrl()}/auth/v1/user`, {
    headers: { apikey: anonKey(), authorization: `Bearer ${bearer}` },
  })
  const user = (await who.json().catch(() => ({}))) as { id?: string }
  return who.ok && user.id ? user.id : null
}

async function handleGrant(req: Request): Promise<Response> {
  const userId = await bearerUserId(req)
  if (!userId) return json({ error: 'unauthorized' }, 401)

  const body = await req.json().catch(() => ({}))
  const machine = sanitizeMachine((body as { machine?: unknown }).machine)
  const deviceCode = randomDeviceCode()
  const client = admin()
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const userCode = randomUserCode()
    // 一步建成「已批准、经 SSH」的请求(via = ssh:这台不占远程隧道的名额,见迁移 *_machine_limits_6264)。
    const { data: expiresAt, error } = await client.rpc('server_login_grant', {
      p_device_code_hash: await sha256Hex(deviceCode),
      p_user_code: userCode,
      p_machine: machine,
      p_requester_ip: clientIp(req),
      p_user_id: userId,
    })
    if (error) {
      if (/duplicate key/.test(error.message)) continue
      log('grant_error')
      return json({ error: 'server_error', error_description: error.message }, 500)
    }
    log('granted')
    const expiresIn = Math.max(0, Math.round((new Date(expiresAt as string).getTime() - Date.now()) / 1000))
    return json({ device_code: deviceCode, expires_in: expiresIn })
  }
  return json({ error: 'server_error', error_description: 'could not allocate a user code' }, 500)
}

// ── 咕咕 App 里的批准页(App 以自己的登录令牌来)──────────────────────────────
//
// 手机上已经登着咕咕的人点了这条链接:App 先 view 看是哪台机器、这条请求还能不能批,再 decide。
// 两个接口都要令牌 —— 机器信息只给登着咕咕的人看;批准落在令牌的主人身上,与确认页同一个 approveAs。

async function handleAppView(req: Request): Promise<Response> {
  if (!(await bearerUserId(req))) return json({ error: 'unauthorized' }, 401)
  const body = (await req.json().catch(() => ({}))) as { code?: unknown }
  const userCode = normalizeUserCode(typeof body.code === 'string' ? body.code : '')
  const view = await loadView(userCode)
  if (!view) return json({ error: 'not_found' }, 404)
  const m = view.machine ?? {}
  return json({
    code: userCode,
    state: requestState(view),
    machine: { hostname: m.hostname ?? null, platform: m.platform ?? null, arch: m.arch ?? null, user: m.user ?? null },
    requester_ip: view.requester_ip,
    created_at: view.created_at,
    expires_at: view.expires_at,
  })
}

async function handleAppDecide(req: Request): Promise<Response> {
  const userId = await bearerUserId(req)
  if (!userId) return json({ error: 'unauthorized' }, 401)
  const body = (await req.json().catch(() => ({}))) as { code?: unknown; approve?: unknown }
  if (typeof body.approve !== 'boolean') return json({ error: 'invalid_request' }, 400)
  const userCode = normalizeUserCode(typeof body.code === 'string' ? body.code : '')
  const view = await loadView(userCode)
  if (!view) return json({ error: 'not_found' }, 404)
  const state = requestState(view)
  if (state !== 'pending') return json({ state })
  if (!body.approve) {
    await deny(userCode)
    return json({ state: 'denied' })
  }
  const approval = await approveAs(userCode, userId)
  if (approval.status === 'failed') return json({ error: 'failed' }, 409)
  return json(approval.status === 'refused' ? { state: 'refused', refusal: approval.refusal ?? null } : { state: 'approved' })
}

// ── 确认页(渲染在 page.ts)────────────────────────────────────────────────────

function html(body: string): Response {
  // 页面永远 200:这是给人看的,非 200 会被浏览器 / 网关换成它们自己的错误页。
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
}

async function loadView(userCode: string): Promise<LoginView | null> {
  if (!userCode) return null
  const { data, error } = await admin().rpc('server_login_view', { p_user_code: userCode })
  if (error) throw new Error(error.message)
  const row = (Array.isArray(data) ? data[0] : data) as LoginView | undefined
  return row ?? null
}

/** 这条请求已经走完 / 过期 / 被拒:直接给结局页,❌ 再让人填邮箱。 */
function unusableRequest(view: LoginView): Response | null {
  switch (requestState(view)) {
    case 'approved':
      return html(finalPage('alreadyApproved'))
    case 'denied':
      return html(finalPage('denied'))
    case 'refused':
      return html(finalPage('machineLimit', view.machine?.hostname))
    case 'expired':
      return html(finalPage('expired'))
    case 'pending':
      return null
  }
}

type Approval = { status: 'approved' } | { status: 'refused'; refusal?: MachineLimitRefusal } | { status: 'failed' }

/**
 * 以 userId 本人批准一条请求:先判机器上限(#6264),超了就不批准。确认页(邮箱验证码证明是本人)与
 * 咕咕 App(登录令牌证明是本人)都走这一个。
 */
async function approveAs(userCode: string, userId: string): Promise<Approval> {
  const { data: decision, error } = await admin().rpc('server_login_approve', {
    p_user_code: userCode,
    p_user_id: userId,
  })
  const outcome = decision as { status?: string; refusal?: MachineLimitRefusal } | null
  if (!error && outcome?.status === 'refused') {
    log('machine_limit')
    return { status: 'refused', refusal: outcome.refusal }
  }
  if (error || outcome?.status !== 'approved') {
    log('approve_error')
    return { status: 'failed' }
  }
  log('approved_by_user')
  return { status: 'approved' }
}

async function deny(userCode: string): Promise<void> {
  const { error } = await admin().rpc('server_login_decide', { p_user_code: userCode, p_user_id: null, p_approve: false })
  if (error) throw new Error(error.message)
  log('denied')
}

async function gotrue(path: string, body: unknown, accessToken?: string): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const response = await fetch(`${supabaseUrl()}/auth/v1${path}`, {
    method: 'POST',
    headers: {
      apikey: anonKey(),
      'content-type': 'application/json',
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify(body),
  })
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>
  return { ok: response.ok, status: response.status, data }
}

async function handlePage(req: Request): Promise<Response> {
  const url = new URL(req.url)
  if (req.method === 'GET') {
    const typed = url.searchParams.get('code')
    // 没带短码(有人把链接截短了、或自己敲地址)⇒ 让他把终端里的短码输进来,❌ 直接报「不存在」。
    if (typed === null || !typed.trim()) return html(codeEntryStep())
    const userCode = normalizeUserCode(typed)
    const view = await loadView(userCode)
    if (!view) return html(codeEntryStep(typed, '没有找到这个短码。核对一下服务器终端里打出来的那一串（形如 ABCD-EFGH）。'))
    return unusableRequest(view) ?? html(emailStep(view, userCode))
  }
  const form = await req.formData()
  const action = String(form.get('action') ?? '')
  const userCode = normalizeUserCode(String(form.get('code') ?? ''))
  const view = await loadView(userCode)
  if (!view) return html(codeEntryStep('', '这个短码已经失效。回到服务器终端，用最新打出来的链接再打开一次。'))
  const unusable = unusableRequest(view)
  if (unusable) return unusable

  if (action === 'deny') {
    await deny(userCode)
    return html(finalPage('denied'))
  }

  const email = String(form.get('email') ?? '').trim().toLowerCase()
  if (action === 'send-code') {
    if (!email) return html(emailStep(view, userCode, '请填写邮箱。'))
    // 只给已有的咕咕账号发码:server 登录不是注册入口。
    const sent = await gotrue('/otp', { email, create_user: false })
    if (!sent.ok) {
      log('otp_send_error', { status: sent.status })
      const message = sent.status === 429 ? '发送太频繁，请稍等一分钟再试。' : '验证码没发出去：这个邮箱可能还没有咕咕账号。'
      return html(form.get('resend') ? otpStep(view, userCode, email, { error: message }) : emailStep(view, userCode, message))
    }
    return html(otpStep(view, userCode, email, { resent: Boolean(form.get('resend')) }))
  }

  if (action === 'approve') {
    const otp = String(form.get('otp') ?? '').replace(/\s+/g, '')
    const verified = await gotrue('/verify', { type: 'email', email, token: otp })
    const accessToken = verified.data.access_token as string | undefined
    const userId = (verified.data.user as { id?: string } | undefined)?.id
    if (!verified.ok || !accessToken || !userId) {
      return html(otpStep(view, userCode, email, { error: '验证码不对或已过期。检查最新那封邮件，或点「没收到？重新发送」。' }))
    }
    // 这条网页会话只用来确认「是你本人」,确认完立刻作废,❌ 不在用户账号上留一条闲置会话。
    await gotrue('/logout?scope=local', {}, accessToken).catch(() => undefined)
    // 超了机器上限就当场把哪条上限、用了几台说清楚。
    const approval = await approveAs(userCode, userId)
    if (approval.status === 'refused') return html(finalPage('machineLimit', view.machine?.hostname, approval.refusal))
    if (approval.status === 'failed') return html(finalPage('failed'))
    return html(finalPage('approved', view.machine?.hostname))
  }
  return html(emailStep(view, userCode))
}

Deno.serve(async (req) => {
  const path = new URL(req.url).pathname.replace(/\/+$/, '')
  const appRoute = path.endsWith('/server-login/view') || path.endsWith('/server-login/decide')
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    if (req.method === 'POST' && path.endsWith('/server-login/start')) return await handleStart(req)
    if (req.method === 'POST' && path.endsWith('/server-login/poll')) return await handlePoll(req)
    if (req.method === 'POST' && path.endsWith('/server-login/grant')) return await handleGrant(req)
    if (req.method === 'POST' && path.endsWith('/server-login/view')) return await handleAppView(req)
    if (req.method === 'POST' && path.endsWith('/server-login/decide')) return await handleAppDecide(req)
    return await handlePage(req)
  } catch (error) {
    log('unhandled')
    return appRoute ? json({ error: 'server_error' }, 500) : html(finalPage('error'))
  }
})
