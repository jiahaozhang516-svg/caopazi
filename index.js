/**
 * aihub-checkin —— 南林 ACM「AI Hub」每日自动签到（DSHM 端侧插件）
 * 站点：https://acm.njfu.edu.cn/aihub/
 *
 * ── 它解决什么 ────────────────────────────────────────────────────────────
 * 该站点每天可签到一次，按连续天数发额度。签到接口只认**网页登录态 Cookie**：
 *   POST /aihub/api/checkin   body `{}`   →  {reward, streak}
 *   GET  /aihub/api/me                    →  {checkin:{doneToday,streak,nextReward,…}}
 * 未登录一律 401 "请先登录"；带 Origin 的非本站请求一律 403 "cross-site request forbidden"。
 * 登录只有企业微信 OAuth 一条路，回调被白名单钉死在 acm.njfu.edu.cn 上。
 *
 * ── 登录怎么拿到 Cookie（已在真机网络上实测通过）──────────────────────────
 * 企业微信的扫码页把登录拆成了三步公开接口，整条链路可以在 Host 里跑完：
 *   1) GET  https://acm.njfu.edu.cn/aihub/api/auth/login
 *        → 302 到 login.work.weixin.qq.com/…&state=<随机>，并下发 cookie `login_flow=<state>`
 *   2) POST https://login.work.weixin.qq.com/wwlogin/monoApi/sso/login/getWebQrCodeKey
 *        （form：agentid/appid/lang/login_type/redirect_uri/state/refresh_key=true）
 *        → {"data":{"web_key":"…"}}，二维码图片 = /wwlogin/sso/qrcode?key=<web_key>
 *   3) POST …/wwlogin/monoApi/sso/login/getWebQrCodeStatus（form：webKey/lastStatus/openDataSid）
 *        长轮询；扫码确认后 → {"data":{"status":"QRCODE_SCAN_SUCC","auth_code":"…"}}
 *   4) GET  https://acm.njfu.edu.cn/aihub/api/auth/callback?code=…&state=…
 *        （带上第 1 步的 login_flow cookie）→ 服务端下发会话 Cookie，登录完成。
 *
 * 状态枚举：QRCODE_SCAN_NEVER=0 / ING=1 / SUCC=2 / FAIL=3 / PC_BIND=4 / ERR=100。
 *
 * ── 边界（如实登记）──────────────────────────────────────────────────────
 * · 定时器只在 DSHM 进程活着时走。应用被杀/被系统冻结时不执行；下次启动后
 *   只要"今天还没签到"会立刻补签一次（补签逻辑见 tick()）。
 * · Cookie 会过期（服务端说了算，通常是数周到一个月）。届时 /api/me 返回 401，
 *   插件把状态记成"登录已失效"，重新走一次扫码登录即可。
 * · 不改站点、不代理流量、不写任何站点侧的持久化；只在本地存 Cookie 与签到结果。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createSeatClient, pickSeat, dateInCN, compactDate, DEFAULT_UA } from './libseat.js'

export const name = 'caopazi'
export const inject = ['tools']

const API = 'https://acm.njfu.edu.cn/aihub'
const WECOM = 'https://login.work.weixin.qq.com/wwlogin/monoApi/sso/login'
const WECOM_QR = 'https://login.work.weixin.qq.com/wwlogin/sso/qrcode'
const APPID = 'wwea1c6a035e0d9ec7'
const AGENTID = '1000276'
const REDIRECT_URI = 'https://acm.njfu.edu.cn/aihub/api/auth/callback'
const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Mobile Safari/537.36 HuaweiBrowser/15.0'
const TZ = 'Asia/Shanghai'
const TICK_MS = 60 * 1000
const RETRY_GAP_MS = 30 * 60 * 1000

const HOME = process.env.DSH_HOME || path.join(process.env.HOME || '.', 'dsh', 'home')
const DIR = path.join(HOME, 'aihub-checkin')
const STORE_FILE = path.join(DIR, 'store.json')
const QR_FILE = path.join(DIR, 'login-qr.png')

/** 插件版本：直接读自己旁边的 package.json，设置页角落显示用。 */
const VERSION = (() => {
  try {
    const file = fileURLToPath(new URL('./package.json', import.meta.url))
    return String(JSON.parse(fs.readFileSync(file, 'utf8')).version || '')
  } catch (_e) {
    return ''
  }
})()

/** 侧栏角标读取的状态接口。 */
const STATUS_ROUTE = '/aihub-checkin/status'
/** 用户层「关掉角标」的开关：在 Download 里建这个空文件，下次启动会摘掉前端声明。 */
const DISABLE_FLAG = '/storage/Users/currentUser/Download/com.dshm.dshclient/aihub-badge-off'
/** webServer 就绪后记下的本机 origin，仅用于 aihub_status 自检。 */
let statusOrigin = null

const DEFAULT_STORE = {
  settings: {
    enabled: true,
    time: '08:00',
    cookie: '',
    seat: {
      enabled: false,
      user: '',
      pass: '',
      openTime: '07:00',
      daysAhead: 1,
      roomId: 100455352,
      roomName: '三层B区',
      preferred: [],
      parity: 'even',
      maxDistance: 3,
      fallbackAny: false,
      startTime: '07:30',
      endTime: '22:00',
      /** 特殊时段：`4=10:00-22:00`，多条用分号隔开；键是星期（0=周日 … 6=周六）。 */
      overrides: '',
    },
  },
  lastSuccessDate: '',
  lastAttemptAt: 0,
  lastResult: null,
  history: [],
  pendingLogin: null,
  seatSession: null,
  seatLast: null,
  seatHistory: [],
}

/** 取第一个「不是 undefined/null」的值（不用 ?? ，保持语法面尽量窄）。 */
function pick(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

// ── 本地存储 ────────────────────────────────────────────────────────────────
function ensureDir() {
  try {
    fs.mkdirSync(DIR, { recursive: true })
  } catch (_ignored) {}
}

function readStore() {
  ensureDir()
  try {
    const raw = fs.readFileSync(STORE_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    const settings = { ...DEFAULT_STORE.settings, ...((parsed && parsed.settings) || {}) }
    settings.seat = { ...DEFAULT_STORE.settings.seat, ...((parsed && parsed.settings && parsed.settings.seat) || {}) }
    if (!Array.isArray(settings.seat.preferred)) settings.seat.preferred = []
    return {
      ...DEFAULT_STORE,
      ...parsed,
      settings,
      history: Array.isArray(parsed && parsed.history) ? parsed.history : [],
      seatHistory: Array.isArray(parsed && parsed.seatHistory) ? parsed.seatHistory : [],
    }
  } catch (_ignored) {
    return JSON.parse(JSON.stringify(DEFAULT_STORE))
  }
}

function writeStore(store) {
  ensureDir()
  const tmp = STORE_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n')
  fs.renameSync(tmp, STORE_FILE)
}

function pushHistory(store, entry) {
  store.history = [entry, ...(store.history || [])].slice(0, 40)
  store.lastResult = entry
}

// ── 时间（固定 Asia/Shanghai，与站点/用户所在时区一致）───────────────────────
function nowCN() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  const parts = {}
  for (const p of fmt.formatToParts(new Date())) parts[p.type] = p.value
  const hh = Number(parts.hour)
  const mm = Number(parts.minute)
  return {
    date: parts.year + '-' + parts.month + '-' + parts.day,
    clock: String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0'),
    minutes: hh * 60 + mm,
  }
}

function parseClock(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text || '').trim())
  if (!m) return null
  const hh = Number(m[1])
  const mm = Number(m[2])
  if (!(hh >= 0 && hh < 24 && mm >= 0 && mm < 60)) return null
  return hh * 60 + mm
}

// ── HTTP 小工具 ─────────────────────────────────────────────────────────────
function cookieHeader(jar) {
  return [...jar.entries()]
    .filter(([, v]) => String(v || '') !== '')
    .map(([k, v]) => k + '=' + v)
    .join('; ')
}

function absorbCookies(jar, res) {
  let list = []
  try {
    list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
  } catch (_ignored) {}
  if (!list.length) {
    const raw = res.headers.get('set-cookie')
    if (raw) list = [raw]
  }
  for (const line of list) {
    const first = String(line).split(';')[0]
    const eq = first.indexOf('=')
    if (eq <= 0) continue
    const key = first.slice(0, eq).trim()
    const value = first.slice(eq + 1).trim()
    if (key) jar.set(key, value)
  }
}

async function httpJson(url, options) {
  const res = await fetch(url, options)
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch (_ignored) {}
  return { status: res.status, json, text, headers: res.headers }
}

// ── 站点 API ────────────────────────────────────────────────────────────────
async function getMe(cookie) {
  const r = await httpJson(API + '/api/me', {
    method: 'GET',
    headers: { 'user-agent': UA, accept: 'application/json', cookie: cookie || '' },
    signal: AbortSignal.timeout(15000),
  })
  return r
}

async function postCheckin(cookie) {
  const r = await httpJson(API + '/api/checkin', {
    method: 'POST',
    headers: {
      'user-agent': UA,
      accept: 'application/json',
      'content-type': 'application/json',
      cookie: cookie || '',
    },
    body: '{}',
    signal: AbortSignal.timeout(15000),
  })
  return r
}

function describeMe(me) {
  const c = (me && me.checkin) || {}
  const lines = []
  if (c.doneToday) lines.push('今日已签到（连续 ' + pick(c.streak, '?') + ' 天）')
  else lines.push('今日未签到（连续 ' + pick(c.streak, '?') + ' 天，下次 +' + pick(c.nextReward, '?') + '）')
  const credits = me && (pick(me.credits, me.balance, me.quota, me.remaining))
  if (credits !== undefined && credits !== null) lines.push('当前额度：' + credits)
  return lines.join('；')
}

// ── 企业微信扫码登录 ────────────────────────────────────────────────────────
async function wecomKey(state) {
  const body = new URLSearchParams({
    agentid: AGENTID,
    appid: APPID,
    lang: 'zh',
    login_type: 'CorpApp',
    redirect_uri: REDIRECT_URI,
    state: state,
    refresh_key: 'true',
  })
  const r = await httpJson(WECOM + '/getWebQrCodeKey', {
    method: 'POST',
    headers: {
      'user-agent': UA,
      'content-type': 'application/x-www-form-urlencoded',
      referer: 'https://login.work.weixin.qq.com/wwlogin/sso/login',
      origin: 'https://login.work.weixin.qq.com',
    },
    body: body.toString(),
    signal: AbortSignal.timeout(20000),
  })
  const data = (r.json && r.json.data) || {}
  const settings = data.settings || data
  return { webKey: settings.web_key || '', raw: r }
}

async function wecomPoll(webKey, lastStatus) {
  const body = new URLSearchParams({
    webKey: webKey,
    lastStatus: String(pick(lastStatus, '0')),
    openDataSid: '',
  })
  const r = await httpJson(WECOM + '/getWebQrCodeStatus', {
    method: 'POST',
    headers: {
      'user-agent': UA,
      'content-type': 'application/x-www-form-urlencoded',
      referer: 'https://login.work.weixin.qq.com/wwlogin/sso/login',
      origin: 'https://login.work.weixin.qq.com',
    },
    body: body.toString(),
    signal: AbortSignal.timeout(20000),
  })
  return (r.json && r.json.data) || {}
}

async function loginStart(store) {
  const res = await fetch(API + '/api/auth/login', {
    method: 'GET',
    redirect: 'manual',
    headers: { 'user-agent': UA },
    signal: AbortSignal.timeout(15000),
  })
  const jar = new Map()
  absorbCookies(jar, res)
  const location = res.headers.get('location') || ''
  if (!location) throw new Error('登录入口没有返回跳转地址（HTTP ' + res.status + '）')
  const target = new URL(location, 'https://login.work.weixin.qq.com')
  const state = target.searchParams.get('state') || ''

  const key = await wecomKey(state)
  if (!key.webKey) {
    const hint = (key.raw && (key.raw.text || '')).slice(0, 200)
    throw new Error('企业微信没有下发二维码 key：' + hint)
  }

  const png = await fetch(WECOM_QR + '?key=' + encodeURIComponent(key.webKey), {
    headers: { 'user-agent': UA },
    signal: AbortSignal.timeout(20000),
  })
  if (!png.ok) throw new Error('二维码图片获取失败：HTTP ' + png.status)
  const bytes = Buffer.from(await png.arrayBuffer())
  ensureDir()
  fs.writeFileSync(QR_FILE, bytes)

  store.pendingLogin = {
    webKey: key.webKey,
    state: state,
    cookies: Object.fromEntries(jar),
    createdAt: Date.now(),
  }
  writeStore(store)

  return { webKey: key.webKey, state: state, qrFile: QR_FILE, bytes: bytes.length }
}

async function loginComplete(store, pending, authCode) {
  const jar = new Map(Object.entries(pending.cookies || {}))
  const url =
    REDIRECT_URI + '?code=' + encodeURIComponent(authCode) + '&state=' + encodeURIComponent(pending.state || '')
  let res = await fetch(url, {
    method: 'GET',
    redirect: 'manual',
    headers: { 'user-agent': UA, cookie: cookieHeader(jar) },
    signal: AbortSignal.timeout(20000),
  })
  absorbCookies(jar, res)
  let hops = 0
  while (res.status >= 300 && res.status < 400 && hops < 5) {
    const loc = res.headers.get('location')
    if (!loc) break
    const next = new URL(loc, 'https://acm.njfu.edu.cn').toString()
    if (!next.startsWith('https://acm.njfu.edu.cn/')) break
    res = await fetch(next, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'user-agent': UA, cookie: cookieHeader(jar) },
      signal: AbortSignal.timeout(20000),
    })
    absorbCookies(jar, res)
    hops += 1
  }

  const cookie = cookieHeader(jar)
  if (!cookie) throw new Error('回调没有下发任何 Cookie，登录未生效')
  const me = await getMe(cookie)
  if (me.status !== 200) {
    throw new Error('登录后 /api/me 仍返回 ' + me.status + '：' + (me.text || '').slice(0, 120))
  }
  store.settings.cookie = cookie
  store.pendingLogin = null
  writeStore(store)
  return { cookie, me: me.json }
}

// ── 签到主流程 ──────────────────────────────────────────────────────────────
let running = false

async function runCheckin(store, opts) {
  if (running) return { ok: false, summary: '已有一次签到正在进行中，请稍后再试', detail: '' }
  running = true
  const at = new Date().toISOString()
  try {
    const cookie = (store.settings.cookie || '').trim()
    if (!cookie) {
      const entry = { at, ok: false, kind: 'no-cookie', message: '还没有登录，先执行 aihub_login_start 扫码登录' }
      pushHistory(store, entry)
      writeStore(store)
      return { ok: false, summary: entry.message, detail: '登录一次之后，之后每天由插件自动签到。' }
    }

    const me = await getMe(cookie)
    if (me.status === 401) {
      const entry = { at, ok: false, kind: 'unauthorized', message: '登录态已失效（/api/me 401），需要重新扫码登录' }
      pushHistory(store, entry)
      writeStore(store)
      return { ok: false, summary: entry.message, detail: 'Cookie 过期或站点已重置会话。执行 aihub_login_start 重新扫码即可。' }
    }
    if (me.status !== 200 || !me.json) {
      const entry = { at, ok: false, kind: 'me-failed', message: '读取账号信息失败：HTTP ' + me.status }
      pushHistory(store, entry)
      writeStore(store)
      return { ok: false, summary: entry.message, detail: (me.text || '').slice(0, 300) }
    }

    const doneToday = !!(me.json.checkin && me.json.checkin.doneToday)
    if (doneToday && !opts.force) {
      const today = nowCN().date
      store.lastSuccessDate = today
      const entry = { at, ok: true, kind: 'already', message: '今日已签到，无需重复', account: describeMe(me.json) }
      pushHistory(store, entry)
      writeStore(store)
      return { ok: true, summary: '今日已签到（跳过）', detail: entry.account }
    }

    const r = await postCheckin(cookie)
    if (r.status === 200 && r.json) {
      const reward = r.json.reward
      const streak = r.json.streak
      const today = nowCN().date
      store.lastSuccessDate = today
      const entry = {
        at,
        ok: true,
        kind: 'checked',
        message: '签到成功 +' + pick(reward, '?') + ' 额度（连续 ' + pick(streak, '?') + ' 天）',
        reward: pick(reward, null),
        streak: pick(streak, null),
      }
      pushHistory(store, entry)
      writeStore(store)
      return { ok: true, summary: entry.message, detail: '签到时间：' + at }
    }
    if (r.status === 401) {
      const entry = { at, ok: false, kind: 'unauthorized', message: '签到被拒（401），登录态失效，需要重新登录' }
      pushHistory(store, entry)
      writeStore(store)
      return { ok: false, summary: entry.message, detail: '执行 aihub_login_start 重新扫码。' }
    }
    const msg = (r.json && r.json.message) || ('HTTP ' + r.status)
    const entry = { at, ok: false, kind: 'checkin-failed', message: '签到失败：' + msg }
    pushHistory(store, entry)
    writeStore(store)
    return { ok: false, summary: entry.message, detail: (r.text || '').slice(0, 300) }
  } catch (error) {
    const entry = { at, ok: false, kind: 'error', message: '签到出错：' + String((error && error.message) || error) }
    pushHistory(store, entry)
    writeStore(store)
    return { ok: false, summary: entry.message, detail: '' }
  } finally {
    store.lastAttemptAt = Date.now()
    try {
      writeStore(store)
    } catch (_ignored) {}
    running = false
  }
}

// ── 图书馆抢座任务 ──────────────────────────────────────────────────────────
/** 跨 tick 复用同一个客户端，避免每次都重新登录。 */
let seatClient = null
let seatRunning = false
/** 抢座互斥：定时任务和手动工具不能同时下单，否则可能重复预约。 */
let seatBusy = false
/** 已预热过会话的目标日期（每天只预热一次）。 */
let seatWarmDay = ''

function seatSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function getSeatClient(store) {
  if (!seatClient) seatClient = createSeatClient({ userAgent: DEFAULT_UA })
  if (!seatClient.hasSession() && store.seatSession) {
    try {
      seatClient.restore(store.seatSession)
    } catch (_ignored) {}
  }
  return seatClient
}

/** 要抢的日期（默认提前 1 天 = 次日）。 */
function seatTargetDate(store) {
  const ahead = Number(store.settings.seat.daysAhead)
  return dateInCN(Number.isFinite(ahead) ? ahead : 1)
}

async function ensureSeatLogin(store, force) {
  const s = store.settings.seat
  const client = getSeatClient(store)
  if (!force && client.hasSession()) return client
  if (!s.user || !s.pass) throw new Error('还没配置图书馆学号/密码')
  await client.login(s.user, s.pass)
  store.seatSession = client.snapshot()
  // 只回写会话字段，避免覆盖并发改的配置
  try {
    const fresh = readStore()
    fresh.seatSession = client.snapshot()
    writeStore(fresh)
  } catch (_ignored) {}
  return client
}

/**
 * 带鉴权重试地跑一次需要 token 的操作：
 * 遇到「未登录 / 300」时丢掉内存里的旧客户端、强制重登，再试一次。
 * 注意：这个客户端有两条失败路径——抛异常（seats/book）和返回 {ok:false,message}（cancel），
 * 两条都要认，否则会话过期后取消会一直失败。
 */
async function withSeatAuth(store, fn) {
  const isAuth = (v) => {
    const text = String((v && (v.message || v)) || '')
    return text.indexOf('登录') >= 0 || text.indexOf('300') >= 0
  }
  const relogin = async () => {
    seatClient = null
    store.seatSession = null
    return ensureSeatLogin(store, true)
  }
  let client = await ensureSeatLogin(store, false)
  try {
    const res = await fn(client)
    if (res && res.ok === false && isAuth(res.message)) return fn(await relogin())
    return res
  } catch (error) {
    if (!isAuth(error)) throw error
    return fn(await relogin())
  }
}

/** 座位表缓存：抢座窗口内每 20 秒一发，不能每次都重新拉整张表。 */
let seatPoolCache = { date: '', at: 0, seats: null }

/**
 * 把设定窗口裁到当天实际开放时段（座位对象自带 openStart/openEnd）。
 * @returns {object|null} {start,end,clamped,openStart,openEnd}；完全不重叠返回 null
 */
function clampTo(openStart, openEnd, start, end) {
  const os = parseClock(openStart)
  const oe = parseClock(openEnd)
  const sMin = parseClock(start)
  const eMin = parseClock(end)
  if (os === null || oe === null || sMin === null || eMin === null) return { start, end, clamped: false }
  const ns = Math.max(sMin, os)
  const ne = Math.min(eMin, oe)
  if (ns >= ne) return null
  const fmt = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0')
  return { start: fmt(ns), end: fmt(ne), clamped: ns !== sMin || ne !== eMin, openStart, openEnd }
}

/** 窗口被裁剪时的说明尾巴。 */
function winNote(w) {
  return w && w.clamped ? '；当天开放 ' + w.openStart + '-' + w.openEnd + '，已自动裁到 ' + w.start + '-' + w.end : ''
}

/**
 * 把失败归到一个已知类别，便于「能自动处理的自动处理，不能的留证」。
 * @returns {'auth'|'blocked'|'window'|'taken'|'protocol'|'unknown'}
 */
function classifySeatError(text) {
  const s = String(text || '')
  if (s.indexOf('登录') >= 0 || s.indexOf('300') >= 0) return 'auth'
  if (s.indexOf('403') >= 0 || s.indexOf('非 JSON') >= 0 || s.indexOf('反爬') >= 0) return 'blocked'
  if (s.indexOf('时段') >= 0 || s.indexOf('开放') >= 0 || s.indexOf('时间') >= 0) return 'window'
  if (s.indexOf('当前时段') >= 0 || s.indexOf('已预约') >= 0) return 'taken'
  if (s.indexOf('参数') >= 0 || s.indexOf('参数错误') >= 0 || s.indexOf('非法') >= 0) return 'protocol'
  if (s.indexOf('没有可用座位') >= 0 || s.indexOf('座位表为空') >= 0) return 'taken'
  return 'unknown'
}

/** 目标日期是周几（0=周日 … 6=周六，按日历日算，不受时区影响）。 */
function weekdayOf(iso) {
  const parts = String(iso).split('-').map(Number)
  return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2])).getUTCDay()
}

/**
 * 解析「特殊时段」：`4=10:00-22:00;6=09:00-18:00`
 * @returns {Object<number,{start:string,end:string}>}
 */
function parseOverrides(text) {
  const out = {}
  const raw = String(text || '').trim()
  if (!raw) return out
  for (const piece of raw.split(/[;；\n]+/)) {
    const m = /^\s*([0-6])\s*[=:：]\s*(\d{1,2}:\d{2})\s*[-–—~至]\s*(\d{1,2}:\d{2})\s*$/.exec(piece)
    if (!m) continue
    const wd = Number(m[1])
    const start = parseClock(m[2])
    const end = parseClock(m[3])
    if (start === null || end === null || start >= end) continue
    out[wd] = { start: m[2], end: m[3] }
  }
  return out
}

/**
 * 执行一次抢座（dryRun 时只挑座、不下单）。
 * @param {object} store 已读取的存储
 * @param {object} opts { dryRun?: boolean, reason?: string }
 */
async function runSeatBooking(store, opts) {
  if (seatBusy) throw new Error('上一次抢座还在执行中，请稍后再试')
  seatBusy = true
  const s = store.settings.seat
  const at = new Date().toISOString()
  const date = seatTargetDate(store)
  const entry = { at, ok: false, date, message: '', seat: '', reason: '', resvId: null, uuid: null }

  // 先看这天有没有「特殊时段」（例如周四 10:00-22:00），没有就用默认窗口
  const wd = weekdayOf(date)
  const override = parseOverrides(s.overrides)[wd] || null
  const wantStart = override ? override.start : s.startTime
  const wantEnd = override ? override.end : s.endTime
  const overrideNote = override ? '（周' + '日一二三四五六'.charAt(wd) + '特殊时段 ' + wantStart + '-' + wantEnd + '）' : ''

  try {
    if (!Array.isArray(s.preferred) || s.preferred.length === 0) throw new Error('还没配置目标座位（seat_config 的 preferred）')
    let client = await ensureSeatLogin(store, false)
    const dryRun = Boolean(opts && opts.dryRun)
    let seats
    const cached =
      !dryRun && seatPoolCache.date === date && Array.isArray(seatPoolCache.seats) && Date.now() - seatPoolCache.at < 45000
    if (cached) {
      seats = seatPoolCache.seats
    } else {
      try {
        seats = await client.seats(s.roomId, compactDate(date))
      } catch (error) {
        // 会话过期：旧 token 在内存里，hasSession() 会一直为真 —— 必须强制重登一次
        if (String((error && error.message) || '').indexOf('登录') >= 0) {
          seatClient = null
          store.seatSession = null
          client = await ensureSeatLogin(store, true)
          seats = await client.seats(s.roomId, compactDate(date))
        } else {
          throw error
        }
      }
      seatPoolCache = { date: date, at: Date.now(), seats: seats }
    }
    if (!seats.length) throw new Error('座位表为空（' + date + ' 可能还没开放预约）')

    if (opts && opts.dryRun) {
      const preview = pickSeat(seats, s)
      const w = preview.seat ? clampTo(preview.seat.openStart, preview.seat.openEnd, wantStart, wantEnd) : null
      entry.ok = Boolean(preview.seat) && Boolean(w)
      entry.seat = preview.seat ? String(preview.seat.devName) : ''
      entry.reason = preview.reason
      if (!preview.seat) entry.message = '演练：没有可用座位'
      else if (!w) entry.message = '演练：' + preview.seat.devName + ' 当天开放时段与设定窗口不重叠'
      else entry.message = '演练：将预约 ' + preview.seat.devName + ' ' + w.start + '-' + w.end + '（' + preview.detail + winNote(w) + overrideNote + '）'
      return entry
    }

    let pool = seats
    let firstError = ''
    const attempts = []
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const picked = pickSeat(pool, s)
      if (!picked.seat) {
        attempts.push({ seat: '', ok: false, message: picked.detail })
        break
      }
      // 用座位自带的 openStart/openEnd 裁剪（不同日期可能不同，如某天 20:00 闭馆）
      const w = clampTo(picked.seat.openStart, picked.seat.openEnd, wantStart, wantEnd)
      if (!w) {
        attempts.push({ seat: String(picked.seat.devName), ok: false, message: '当天开放时段与设定不重叠' })
        if (!firstError) firstError = '当天开放时段与设定不重叠'
        pool = pool.filter((seat) => seat.devId !== picked.seat.devId)
        continue
      }
      const booked = await withSeatAuth(store, (c) =>
        c.book({
          devId: picked.seat.devId,
          date: date,
          start: w.start,
          end: w.end,
        }),
      )
      attempts.push({ seat: String(picked.seat.devName), ok: booked.ok, message: String(booked.message || '') })
      if (booked.ok) {
        entry.ok = true
        entry.seat = String(picked.seat.devName)
        entry.reason = picked.reason
        entry.resvId = booked.resvId
        entry.uuid = booked.uuid
        entry.message =
          '预约成功：' + picked.seat.devName + ' ' + date + ' ' + w.start + '-' + w.end + '（' + picked.detail + winNote(w) + overrideNote + '）'
        // 下单成功后座位表变了，作废缓存
        seatPoolCache = { date: '', at: 0, seats: null }
        break
      }
      if (!firstError) firstError = String(booked.message || '')
      // 留证：把服务端原始返回存下来（截断），遇到未知错误才能直接定位，而不是猜
      if (booked.raw) {
        try {
          entry.raw = JSON.stringify(booked.raw).slice(0, 600)
        } catch (_e) {}
      }
      // 业务层拒绝（时段冲突 / 参数错误）换座位也没用，直接停
      if (firstError.indexOf('当前时段') >= 0 || firstError.indexOf('参数') >= 0) break
      pool = pool.filter((seat) => seat.devId !== picked.seat.devId)
      await seatSleep(600)
    }
    entry.attempts = attempts
    if (!entry.ok) {
      const tail = attempts
        .filter((a) => a.message)
        .map((a) => (a.seat ? a.seat + '：' : '') + a.message)
        .join(' / ')
      entry.message = '预约失败：' + (firstError || tail || '没有可用座位')
      entry.kind = classifySeatError(firstError || tail)
    }
  } catch (error) {
    entry.message = '抢座出错：' + String((error && error.message) || error)
    const text = String((error && error.message) || '')
    if (text.indexOf('登录') >= 0 || text.indexOf('300') >= 0) {
      // 关键：只清 store 不够，内存里的客户端还留着旧 token，下次仍不会重登
      seatClient = null
      store.seatSession = null
    }
  } finally {
    // 演练不落盘：否则「今日已完成」会被误标，真正到点时反被跳过
    if (!(opts && opts.dryRun)) {
      // 只回写自己的字段：整份 store 覆盖会冲掉并发改的配置（例如正在保存的设置）
      try {
        const fresh = readStore()
        fresh.seatSession = store.seatSession
        fresh.seatLast = entry
        fresh.seatHistory = [entry, ...(fresh.seatHistory || [])].slice(0, 40)
        writeStore(fresh)
      } catch (_ignored) {}
    }
    seatBusy = false
  }
  return entry
}

// ── 定时器：每天到点签一次 + 启动补签 ───────────────────────────────────────
let ticking = false

async function tick(reason) {
  if (ticking) return
  ticking = true
  try {
    const store = readStore()
    const s = store.settings
    const now = nowCN()

    // 有待完成的扫码登录：顺带长轮询一次，扫完就自动落地
    const pending = store.pendingLogin
    if (pending && pending.webKey) {
      const age = Date.now() - (pending.createdAt || 0)
      if (age < 10 * 60 * 1000) {
        try {
          const status = await wecomPoll(pending.webKey, '0')
          if (status && status.status === 'QRCODE_SCAN_SUCC' && status.auth_code) {
            await loginComplete(store, pending, status.auth_code)
          }
        } catch (_ignored) {}
      } else {
        store.pendingLogin = null
        writeStore(store)
      }
    }

    if (!s.enabled) return
    if (!String(s.cookie || '').trim()) return
    if (store.lastSuccessDate === now.date) return

    const target = parseClock(s.time)
    if (target === null) return
    if (now.minutes < target) return

    // 失败后 30 分钟内不重试，避免每分钟一次的无谓请求
    if (store.lastAttemptAt && Date.now() - store.lastAttemptAt < RETRY_GAP_MS) {
      const last = store.lastResult
      if (last && last.ok) return
      return
    }

    await runCheckin(store, { force: false, reason: reason || 'schedule' })
  } catch (_ignored) {
  } finally {
    ticking = false
  }
}

/**
 * 抢座独立的 20 秒节拍：到点才动，一天只成功一次；失败后 5 分钟再试。
 * 与签到拆开，互不影响。
 */
async function seatTick() {
  if (seatRunning) return
  try {
    const store = readStore()
    const s = store.settings.seat
    if (!s || !s.enabled || !s.user || !s.pass) return
    const now = nowCN()
    const open = parseClock(s.openTime)
    if (open === null) return
    const date = seatTargetDate(store)
    const last = store.seatLast
    if (last && last.ok && last.date === date) return
    // 开抢前 2 分钟预热会话：token 大约 2 小时就过期，07:00 第一发必然先撞「未登录」，
    // 重登要跑「公钥 + 登录」两个请求，白白多花 2-3 秒——抢座就差这几秒。
    if (now.minutes < open) {
      if (now.minutes === open - 2 && seatWarmDay !== date) {
        seatWarmDay = date
        try {
          await ensureSeatLogin(store, true)
        } catch (_ignored) {}
      }
      return
    }
    // 业务性拒绝（时段冲突 / 参数错误）：换座位也没用，当天不再重试，省得触发反爬
    if (
      last &&
      last.date === date &&
      last.message &&
      (last.message.indexOf('当前时段') >= 0 || last.message.indexOf('请求参数') >= 0)
    ) {
      return
    }
    // 抢座窗口节奏：开抢后 3 分钟内每 20 秒一发（最关键的时段），之后退回 60 秒
    const sinceOpen = now.minutes - open
    let gapMs = sinceOpen <= 3 ? 20 * 1000 : 60 * 1000
    // 被反爬/断网挡住（403、非 JSON）时退避 5 分钟，别再火上浇油
    if (last && last.message && (last.message.indexOf('403') >= 0 || last.message.indexOf('非 JSON') >= 0)) {
      gapMs = 5 * 60 * 1000
    }
    const attempts = (store.seatHistory || []).filter((h) => h.date === date).length
    if (attempts >= 20) return
    // 鉴权类失败连碰 3 次就停手：密码改过 / 账号被限制时，继续重试只会白白触发风控
    const authFails = (store.seatHistory || [])
      .filter((h) => h.date === date)
      .slice(0, 3)
      .filter((h) => h.message && (h.message.indexOf('登录') >= 0 || h.message.indexOf('300') >= 0)).length
    if (authFails >= 3 && last && last.message && last.message.indexOf('登录') >= 0) return
    if (last && last.at && Date.now() - new Date(last.at).getTime() < gapMs) return
    seatRunning = true
    try {
      await runSeatBooking(store, { reason: 'schedule' })
    } finally {
      seatRunning = false
    }
  } catch (_ignored) {
    seatRunning = false
  }
}

// ── 工具 ────────────────────────────────────────────────────────────────────
const OUTPUT = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', required: true },
    summary: { type: 'string', required: true },
    detail: { type: 'string' },
  },
  additionalProperties: false,
}

function render(args, value) {
  const text = value && value.detail ? value.summary + '\n\n' + value.detail : (value && value.summary) || ''
  return [{ type: 'text', text: text }]
}

function maskCookie(cookie) {
  const c = String(cookie || '')
  if (!c) return '（未登录）'
  const parts = c.split(';').map((p) => p.trim()).filter(Boolean)
  const names = parts.map((p) => (p.indexOf('=') > 0 ? p.slice(0, p.indexOf('=')) : p))
  return '已登录（' + parts.length + ' 项 cookie：' + names.join('、') + '，' + c.length + ' 字符）'
}

// ── 侧栏角标：状态接口 ─────────────────────────────────────────────────────
/**
 * 用户在 Download 里放了开关文件时，摘掉本包的前端声明。
 * 目的：万一前端出问题而界面已经打不开，用户能靠「建一个空文件 + 重启」把角标关掉，
 * 不需要重装应用。只在文件存在时动作，平时什么都不做。
 */
function stripClientDeclarationIfDisabled() {
  try {
    if (!fs.existsSync(DISABLE_FLAG)) return
    const pkgPath = fileURLToPath(new URL('./package.json', import.meta.url))
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
    if (!pkg || typeof pkg !== 'object' || !pkg.dsh || !pkg.dsh.client) return
    delete pkg.dsh.client
    fs.writeFileSync(pkgPath + '.tmp', JSON.stringify(pkg, null, 2) + '\n')
    fs.renameSync(pkgPath + '.tmp', pkgPath)
  } catch (_ignored) {}
}

/** 角标要的一句话状态：优先问站点（真实），失败才退回本地缓存。 */
async function buildStatus() {
  const store = readStore()
  const now = nowCN()
  const cached = store.lastResult || null
  const cookie = String(store.settings.cookie || '').trim()

  let doneToday = store.lastSuccessDate === now.date
  let loginState = cookie ? 'unknown' : 'anonymous'
  let streak = cached && typeof cached.streak === 'number' ? cached.streak : null
  let reward = cached && typeof cached.reward === 'number' ? cached.reward : null
  let live = false

  if (cookie) {
    try {
      const me = await getMe(cookie)
      if (me.status === 200 && me.json) {
        live = true
        loginState = 'ok'
        const checkin = me.json.checkin || {}
        doneToday = checkin.doneToday === true
        if (typeof checkin.streak === 'number') streak = checkin.streak
        if (typeof checkin.nextReward === 'number') reward = checkin.nextReward
      } else if (me.status === 401) {
        loginState = 'expired'
      }
    } catch (_ignored) {}
  }

  let title
  if (!store.settings.enabled) title = 'AI Hub 签到：已暂停'
  else if (loginState === 'expired') title = 'AI Hub 登录已过期，需要重新扫码'
  else if (loginState === 'anonymous') title = 'AI Hub 还没登录（点这里让我出二维码）'
  else if (doneToday) title = 'AI Hub 今日已签到' + (streak === null ? '' : '（连续 ' + streak + ' 天）')
  else title = 'AI Hub 今日未签到，' + store.settings.time + ' 自动签到'

  // 图书馆抢座：只看本地记录（不额外打接口，避免反爬）
  const seatCfg = store.settings.seat || {}
  const seatDate = seatTargetDate(store)
  const seatLast = store.seatLast || null
  const seatDone = Boolean(seatLast && seatLast.ok && seatLast.date === seatDate)
  const seatInfo = {
    enabled: seatCfg.enabled === true,
    done: seatDone,
    date: seatDate,
    seat: seatDone ? String(seatLast.seat || '') : '',
    message: seatLast ? String(seatLast.message || '') : '',
    openTime: String(seatCfg.openTime || '07:00'),
  }

  // 角标是「所有已启用任务的汇总」：完成度 = 已完成任务数 / 已启用任务数
  const checkinEnabled = store.settings.enabled !== false
  const taskList = []
  if (checkinEnabled) taskList.push({ id: 'aihub', done: doneToday === true })
  if (seatInfo.enabled) taskList.push({ id: 'seat', done: seatDone })
  const taskTotal = taskList.length
  const taskDone = taskList.filter((t) => t.done).length
  const overallDone = taskTotal > 0 && taskDone === taskTotal
  if (seatInfo.enabled) {
    title = overallDone
      ? 'AI Hub 已签到' + (checkinEnabled && streak !== null ? '（连续 ' + streak + ' 天）' : '') + '；图书馆已约 ' + (seatInfo.seat || seatInfo.date)
      : title + '；图书馆抢座' + (seatDone ? '已成功' : '未完成')
  }
  if (taskTotal > 1) title = '已完成 ' + taskDone + '/' + taskTotal + '：' + title

  return {
    doneToday: overallDone,
    checkinDone: doneToday === true,
    loginState: loginState,
    live: live,
    date: now.date,
    time: store.settings.time,
    enabled: checkinEnabled,
    seat: seatInfo,
    tasks: { total: taskTotal, done: taskDone, list: taskList },
    streak: streak,
    reward: reward,
    lastMessage: cached ? String(cached.message || '') : '',
    lastAt: cached ? String(cached.at || '') : '',
    title: title,
    updatedAt: new Date().toISOString(),
  }
}

/** 自检：从 Host 内部打一次状态接口（异步 fetch，不会卡住事件循环）。 */
async function probeStatusRoute() {
  if (!statusOrigin) return '未注册（webServer 未就绪）'
  try {
    const res = await fetch(statusOrigin + STATUS_ROUTE, {
      headers: { accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(4000),
    })
    const text = await res.text()
    let done = '无法解析'
    try {
      done = String(JSON.parse(text).doneToday)
    } catch (_ignored) {}
    return 'HTTP ' + res.status + '，doneToday=' + done
  } catch (error) {
    return '请求失败：' + String((error && error.message) || error)
  }
}

/** 注册 /aihub-checkin/status（只在本机回环上，供侧栏角标轮询）。 */
function registerStatusRoute(ctx) {
  try {
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: 'exact',
          path: STATUS_ROUTE,
          handler: (req, res) => {
            let finished = false
            const send = (code, body) => {
              if (finished) return
              finished = true
              try {
                res.writeHead(code, {
                  'content-type': 'application/json; charset=utf-8',
                  'cache-control': 'no-store',
                })
                res.end(req.method === 'HEAD' ? undefined : body)
              } catch (_ignored) {}
            }
            try {
              if (req.method !== 'GET' && req.method !== 'HEAD') {
                send(405, '{"error":"method-not-allowed"}')
                return
              }
              buildStatus()
                .then((payload) => send(200, JSON.stringify(payload)))
                .catch(() => send(200, '{"doneToday":false,"loginState":"unknown","title":"AI Hub 状态暂时不可用"}'))
            } catch (_ignored) {
              send(200, '{"doneToday":false,"loginState":"unknown","title":"AI Hub 状态暂时不可用"}')
            }
          },
        }),
      'aihub-checkin: status route',
    )
  } catch (_ignored) {}
}

/** 设置页用的脱敏视图。 */
function publicSettings(store) {
  const s = store.settings
  const seat = { ...s.seat }
  const passSet = Boolean(seat.pass)
  delete seat.pass
  seat.passSet = passSet
  return { enabled: s.enabled !== false, time: s.time, seat }
}

/** 读取请求体（带上限，防止恶意大包）。 */
function readBody(req, limit) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size <= limit) chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(''))
  })
}

/** 把设置页提交的补丁写进 store；只认白名单字段。 */
function applyWebConfig(store, patch) {
  const s = store.settings
  const seat = s.seat
  const changed = []
  if (patch && typeof patch.enabled === 'boolean') {
    s.enabled = patch.enabled
    changed.push('签到开关')
  }
  if (patch && typeof patch.time === 'string' && parseClock(patch.time) !== null) {
    s.time = patch.time
    changed.push('签到时间')
  }
  const p = (patch && patch.seat) || {}
  if (typeof p.enabled === 'boolean') {
    seat.enabled = p.enabled
    changed.push('抢座开关')
  }
  for (const key of ['openTime', 'startTime', 'endTime']) {
    if (typeof p[key] === 'string' && parseClock(p[key]) !== null) {
      seat[key] = p[key]
      changed.push(key)
    }
  }
  if (Array.isArray(p.preferred)) {
    seat.preferred = p.preferred.map((x) => String(x).trim()).filter(Boolean)
    changed.push('优先座位')
  }
  if (typeof p.parity === 'string') seat.parity = p.parity
  if (typeof p.fallbackAny === 'boolean') seat.fallbackAny = p.fallbackAny
  if (typeof p.overrides === 'string') seat.overrides = p.overrides.trim()
  if (p.maxDistance !== undefined && Number.isFinite(Number(p.maxDistance))) seat.maxDistance = Number(p.maxDistance)
  if (p.daysAhead !== undefined && Number.isFinite(Number(p.daysAhead))) seat.daysAhead = Number(p.daysAhead)
  if (typeof p.user === 'string' && p.user.trim()) seat.user = p.user.trim()
  if (typeof p.pass === 'string' && p.pass.length > 0) seat.pass = p.pass
  writeStore(store)
  return changed
}

/** 注册设置页读写接口 /aihub-checkin/config。 */
function registerConfigRoute(ctx) {
  try {
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: 'exact',
          path: '/aihub-checkin/config',
          handler: async (req, res) => {
            const send = (code, body) => {
              try {
                res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
                res.end(JSON.stringify(body))
              } catch (_ignored) {}
            }
            try {
              if (req.method === 'GET') {
                const store = readStore()
                send(200, { ok: true, settings: publicSettings(store), seatLast: store.seatLast || null, version: VERSION })
                return
              }
              if (req.method === 'POST') {
                const text = await readBody(req, 64 * 1024)
                let patch = null
                try {
                  patch = JSON.parse(text)
                } catch (_ignored) {}
                if (!patch || typeof patch !== 'object') {
                  send(400, { ok: false, message: '请求体不是合法 JSON' })
                  return
                }
                const store = readStore()
                const changed = applyWebConfig(store, patch)
                send(200, { ok: true, changed: changed, settings: publicSettings(readStore()), version: VERSION })
                return
              }
              send(405, { ok: false, message: 'method not allowed' })
            } catch (error) {
              send(500, { ok: false, message: String((error && error.message) || error) })
            }
          },
        }),
      'aihub-checkin: config route',
    )
  } catch (_ignored) {}
}

export function apply(ctx, config) {
  try {
    ensureDir()
    stripClientDeclarationIfDisabled()
    // webServer 走子作用域注入：拿不到它只会没有角标接口，签到本身照常工作
    try {
      ctx.inject(['webServer'], (webCtx) => {
        try {
          statusOrigin = webCtx.webServer.getOrigin()
        } catch (_ignored) {}
        registerStatusRoute(webCtx)
        registerConfigRoute(webCtx)
      })
    } catch (_ignored) {}

    ctx.tools.register(
      defineTool({
        name: 'aihub_checkin',
        description:
          '立即在 https://acm.njfu.edu.cn/aihub/ 执行一次每日签到（南林 ACM AI Hub）。会先读 /api/me 判断今天是否已签到，未签到时 POST /api/checkin 领取额度。',
        parameters: {
          force: {
            type: 'boolean',
            description: '即使今天已经签到过也再请求一次（默认 false，已签到会直接跳过）',
          },
        },
        output: { schema: OUTPUT, render },
        async execute(args) {
          const store = readStore()
          return await runCheckin(store, { force: args.force === true, reason: 'manual' })
        },
      }),
    )

    ctx.tools.register(
      defineTool({
        name: 'aihub_status',
        description:
          '查看 aihub 定时签到的配置与最近结果：开关、每日时间、登录Cookie是否已配置（脱敏）、今日是否已签到、最近若干条签到记录。',
        parameters: {},
        output: { schema: OUTPUT, render },
        async execute() {
          const store = readStore()
          const s = store.settings
          const now = nowCN()
          const lines = [
            '开关：' + (s.enabled ? '开启' : '关闭'),
            '每日时间：' + s.time + '（Asia/Shanghai）',
            '登录凭据：' + maskCookie(s.cookie),
            '今日（' + now.date + '）：' + (store.lastSuccessDate === now.date ? '已签到' : '未签到'),
            '最近一次：' + (store.lastResult ? store.lastResult.message + '（' + store.lastResult.at + '）' : '无'),
            '角标接口：' + (await probeStatusRoute()),
          ]
          if (store.pendingLogin) lines.push('有待完成的扫码登录（web_key=' + store.pendingLogin.webKey + '）')
          if (store.history.length) {
            lines.push('')
            lines.push('最近记录：')
            for (const h of store.history.slice(0, 5)) {
              lines.push('- ' + h.at + ' ' + (h.ok ? '成功' : '失败') + '：' + h.message)
            }
          }
          return {
            ok: true,
            summary: lines.slice(0, 5).join('\n'),
            detail: lines.length > 5 ? lines.slice(5).join('\n') : undefined,
          }
        },
      }),
    )

    ctx.tools.register(
      defineTool({
        name: 'aihub_config',
        description:
          '修改 aihub 定时签到的配置：每日签到时间（HH:MM，Asia/Shanghai）、启用开关、登录 Cookie。只传要改的字段。',
        parameters: {
          time: { type: 'string', description: '每日签到时间，24 小时制 HH:MM，例如 08:00' },
          enabled: { type: 'boolean', description: '是否启用每日自动签到' },
          cookie: { type: 'string', description: '站点登录 Cookie（一般不用手填，扫码登录会自动写入）' },
        },
        output: { schema: OUTPUT, render },
        async execute(args) {
          const store = readStore()
          const changed = []
          if (typeof args.time === 'string' && args.time.trim()) {
            const minutes = parseClock(args.time)
            if (minutes === null) {
              return { ok: false, summary: '时间格式不对：' + args.time + '，应为 HH:MM（如 08:00）' }
            }
            store.settings.time = String(args.time).trim()
            changed.push('时间 → ' + store.settings.time)
          }
          if (typeof args.enabled === 'boolean') {
            store.settings.enabled = args.enabled
            changed.push('开关 → ' + (args.enabled ? '开启' : '关闭'))
          }
          if (typeof args.cookie === 'string') {
            store.settings.cookie = args.cookie.trim()
            changed.push('Cookie → ' + maskCookie(store.settings.cookie))
          }
          writeStore(store)
          return {
            ok: true,
            summary: changed.length ? '已更新：' + changed.join('；') : '没有需要修改的字段',
            detail: '当前每日时间：' + store.settings.time + '（Asia/Shanghai）',
          }
        },
      }),
    )

    ctx.tools.register(
      defineTool({
        name: 'aihub_login_start',
        description:
          '开始一次企业微信扫码登录：生成 8 分钟有效的登录二维码 PNG（路径在结果里），用户用企业微信「扫一扫 → 相册」扫这张图并确认后，再调用 aihub_login_finish 完成登录。',
        parameters: {},
        output: { schema: OUTPUT, render },
        async execute() {
          const store = readStore()
          try {
            const r = await loginStart(store)
            return {
              ok: true,
              summary: '登录二维码已生成：' + r.qrFile + '（' + r.bytes + ' 字节）',
              detail:
                '扫码步骤：企业微信 → 扫一扫 → 右上角「相册」→ 选这张二维码 → 在手机上确认登录。\n' +
                '确认之后调用 aihub_login_finish 收尾（插件后台也会每 60 秒自动收尾一次）。\n' +
                '二维码有效期约 8 分钟，过期请重新调用本工具。',
            }
          } catch (error) {
            return { ok: false, summary: '生成二维码失败：' + String((error && error.message) || error) }
          }
        },
      }),
    )

    ctx.tools.register(
      defineTool({
        name: 'aihub_login_finish',
        description:
          '等待并完成企业微信扫码登录：长轮询扫码状态，扫码确认后自动换取站点会话 Cookie 并校验 /api/me。',
        parameters: {
          waitSeconds: {
            type: 'integer',
            description: '最长等待秒数，默认 30，最大 120',
          },
        },
        output: { schema: OUTPUT, render },
        async execute(args) {
          const store = readStore()
          const pending = store.pendingLogin
          if (!pending || !pending.webKey) {
            return { ok: false, summary: '没有待完成的扫码登录，请先调用 aihub_login_start' }
          }
          const waitMs = Math.min(Math.max(Number(args.waitSeconds) || 30, 5), 120) * 1000
          const deadline = Date.now() + waitMs
          let status = ''
          try {
            while (Date.now() < deadline) {
              const r = await wecomPoll(pending.webKey, '0')
              status = (r && r.status) || ''
              if (status === 'QRCODE_SCAN_SUCC' && r.auth_code) {
                const done = await loginComplete(store, pending, r.auth_code)
                const account = describeMe(done.me)
                await runCheckin(readStore(), { force: false, reason: 'after-login' })
                return {
                  ok: true,
                  summary: '登录成功，会话已保存',
                  detail: account + '\n后续每天会在设定时间自动签到，不需要再登录。',
                }
              }
              if (status === 'QRCODE_SCAN_FAIL') {
                return { ok: false, summary: '企业微信返回登录失败（QRCODE_SCAN_FAIL），请重新生成二维码' }
              }
              if (status === 'QRCODE_SCAN_ERR') {
                return { ok: false, summary: '企业微信返回错误（QRCODE_SCAN_ERR），请重新生成二维码' }
              }
              // NEVER / ING / PC_BIND：继续等
              await new Promise((resolve) => setTimeout(resolve, 1500))
            }
            return {
              ok: false,
              summary: '还没收到扫码确认（当前状态：' + (status || '未知') + '）',
              detail: '二维码仍在有效期内的话，扫完再调用一次 aihub_login_finish；过期了就重新 aihub_login_start。',
            }
          } catch (error) {
            return { ok: false, summary: '完成登录失败：' + String((error && error.message) || error) }
          }
        },
      }),
    )

    // ── 图书馆抢座：工具 ──────────────────────────────────────────────────
    ctx.tools.register(
      defineTool({
        name: 'seat_status',
        description:
          '查看图书馆抢座任务的配置与最近一次结果：开关、开抢时间、目标日期、目标座位与备选、时段、座位表最近一次结果。',
        parameters: {},
        output: { schema: OUTPUT, render },
        async execute() {
          const store = readStore()
          const s = store.settings.seat
          const last = store.seatLast
          const lines = [
            '开关：' + (s.enabled ? '开启' : '关闭'),
            '开抢：每天 ' + s.openTime + '（Asia/Shanghai），抢 ' + (Number(s.daysAhead) || 1) + ' 天后的座位',
            '目标：' + (s.roomName || s.roomId) + ' · 时段 ' + s.startTime + '-' + s.endTime,
            '特殊时段：' + (s.overrides ? s.overrides.replace(/;/g, '；') : '无'),
            '优先座位：' + (s.preferred.length ? s.preferred.join(' → ') : '（未配置）'),
            '兜底规则：尾数 ' + (s.parity || '不限') + '、就近 ' + s.maxDistance + '、随便一个=' + (s.fallbackAny ? '是' : '否'),
            '账号：' + (s.user ? s.user : '（未配置）') + '；密码：' + (s.pass ? '已填' : '（未填）'),
            '最近一次：' + (last ? last.date + ' ' + (last.ok ? '成功' : '失败[' + (last.kind || 'unknown') + ']') + '：' + last.message : '无'),
            ...(last && last.raw ? ['服务端原始返回：' + last.raw] : []),
          ]
          if (store.seatHistory.length > 1) {
            lines.push('')
            lines.push('最近记录：')
            for (const h of store.seatHistory.slice(0, 5)) lines.push('- ' + h.at + ' ' + (h.ok ? '成功' : '失败') + '：' + h.message)
          }
          return { ok: true, summary: lines.slice(0, 5).join('\n'), detail: lines.slice(5).join('\n') }
        },
      }),
    )

    ctx.tools.register(
      defineTool({
        name: 'seat_config',
        description:
          '修改图书馆抢座配置：开关、开抢时间、学号密码、目标区域、优先座位列表、兜底规则（尾数/就近/随便）、预约时段、提前天数。只传要改的字段。',
        parameters: {
          enabled: { type: 'boolean', description: '是否启用每日抢座' },
          openTime: { type: 'string', description: '每天开抢时间 HH:MM（默认 07:00）' },
          user: { type: 'string', description: '图书馆学工号' },
          pass: { type: 'string', description: '图书馆密码' },
          roomId: { type: 'integer', description: '区域 id（三层B区=100455352）' },
          preferred: { type: 'array', items: { type: 'string' }, description: '优先座位号，按顺序，如 ["3F-B004","3F-B010"]' },
          parity: { type: 'string', description: '兜底尾数规则：even / odd / 空（不限）' },
          maxDistance: { type: 'number', description: '就近兜底的最大网格距离（默认 3）' },
          fallbackAny: { type: 'boolean', description: '没有符合规则的座位时，是否随便选一个' },
          startTime: { type: 'string', description: '预约开始时间 HH:MM（默认 07:30）' },
          endTime: { type: 'string', description: '预约结束时间 HH:MM（默认 22:00）' },
          overrides: {
            type: 'string',
            description: '特殊时段，如 4=10:00-22:00（周四只订 10:00 起）；多条用分号，0=周日 … 6=周六',
          },
          daysAhead: { type: 'integer', description: '提前几天抢（默认 1 = 次日）' },
        },
        output: { schema: OUTPUT, render },
        async execute(args) {
          const store = readStore()
          const s = store.settings.seat
          const changed = []
          const clockFields = ['openTime', 'startTime', 'endTime']
          for (const key of ['enabled', 'user', 'pass', 'parity', 'startTime', 'endTime', 'openTime', 'fallbackAny']) {
            if (args[key] === undefined) continue
            if (clockFields.indexOf(key) >= 0 && parseClock(args[key]) === null) {
              return { ok: false, summary: key + ' 时间格式不对：' + args[key] }
            }
            s[key] = args[key]
            changed.push(key + ' → ' + String(args[key]))
          }
          if (typeof args.overrides === 'string') {
            const text = args.overrides.trim()
            if (text && Object.keys(parseOverrides(text)).length === 0) {
              return { ok: false, summary: '特殊时段格式不对：' + text + '（应为 4=10:00-22:00，多条用分号）' }
            }
            s.overrides = text
            changed.push('特殊时段 → ' + (text || '无'))
          }
          if (args.roomId !== undefined) {
            s.roomId = Number(args.roomId)
            changed.push('roomId → ' + s.roomId)
          }
          if (args.maxDistance !== undefined) {
            s.maxDistance = Number(args.maxDistance)
            changed.push('maxDistance → ' + s.maxDistance)
          }
          if (args.daysAhead !== undefined) {
            s.daysAhead = Number(args.daysAhead)
            changed.push('daysAhead → ' + s.daysAhead)
          }
          if (Array.isArray(args.preferred)) {
            s.preferred = args.preferred.map((x) => String(x).trim()).filter(Boolean)
            changed.push('preferred → ' + s.preferred.join(' → '))
          }
          writeStore(store)
          return {
            ok: true,
            summary: changed.length ? '已更新：' + changed.join('；') : '没有要改的字段',
            detail: '当前目标：' + (s.preferred.join(' → ') || '未配置') + '，' + s.startTime + '-' + s.endTime,
          }
        },
      }),
    )

    ctx.tools.register(
      defineTool({
        name: 'seat_preview',
        description:
          '演练模式：按当前配置算出「到时候会预约哪个座位、用哪个时段、为什么」，不下单。传 date 可只推算某一天的窗口（不需要该日已放号，纯本地计算）。',
        parameters: {
          date: { type: 'string', description: '可选，YYYY-MM-DD；只推算这一天的时段窗口，不联网' },
        },
        output: { schema: OUTPUT, render },
        async execute(args) {
          const store = readStore()
          const s = store.settings.seat
          const wanted =
            typeof args.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.date.trim()) ? args.date.trim() : ''
          const targetDate = seatTargetDate(store)

          // 纯本地算窗口：周几 + 特殊时段 + 默认窗口（不联网）
          const describeWindow = (date) => {
            const wd = weekdayOf(date)
            const ov = parseOverrides(s.overrides)[wd] || null
            const start = ov ? ov.start : s.startTime
            const end = ov ? ov.end : s.endTime
            return {
              wd: wd,
              start: start,
              end: end,
              override: ov,
              text:
                date +
                '（周' +
                '日一二三四五六'.charAt(wd) +
                '）→ 使用 ' +
                start +
                '-' +
                end +
                (ov ? '（特殊时段）' : '（默认时段）'),
            }
          }

          // 指定了别的日期：只做本地推算（那天可能还没放号）
          if (wanted && wanted !== targetDate) {
            const w = describeWindow(wanted)
            return {
              ok: true,
              summary: w.text,
              detail: '如果要抢这一天，到时候会用这个窗口（纯本地推算，不联网，未放号也能算）。',
            }
          }

          const w = describeWindow(wanted || targetDate)
          const entry = await runSeatBooking(store, { dryRun: true })
          return {
            ok: entry.ok,
            summary: entry.message,
            detail: '目标日期：' + entry.date + '；' + w.text + (entry.reason ? '；命中规则：' + entry.reason : ''),
          }
        },
      }),
    )

    ctx.tools.register(
      defineTool({
        name: 'seat_book',
        description: '立刻按当前配置抢一次座位（不等 07:00）。成功会返回座位号与预约 id。',
        parameters: {},
        output: { schema: OUTPUT, render },
        async execute() {
          const store = readStore()
          const entry = await runSeatBooking(store, { reason: 'manual' })
          return { ok: entry.ok, summary: entry.message, detail: '目标日期：' + entry.date }
        },
      }),
    )

    ctx.tools.register(
      defineTool({
        name: 'seat_cancel',
        description: '取消图书馆座位预约：传 resvId 与 uuid；不传则取消「最近一次成功预约」记录里的那单。',
        parameters: {
          resvId: { type: 'integer', description: '预约 id（不传则用最近一次记录）' },
          uuid: { type: 'string', description: '预约 uuid（不传则用最近一次记录）' },
        },
        output: { schema: OUTPUT, render },
        async execute(args) {
          const store = readStore()
          let resvId = args.resvId
          let uuid = args.uuid
          if (!resvId || !uuid) {
            const last = store.seatLast
            if (!last || !last.ok || !last.resvId || !last.uuid) {
              return { ok: false, summary: '没有可取消的记录，请显式传 resvId 与 uuid' }
            }
            resvId = last.resvId
            uuid = last.uuid
          }
          try {
            const res = await withSeatAuth(store, (client) => client.cancel(uuid, resvId))
            // 取消成功后座位表变了，作废缓存，避免下一次挑座还按旧数据判断
            if (res.ok) seatPoolCache = { date: '', at: 0, seats: null }
            return {
              ok: res.ok,
              summary: res.ok ? '已取消预约 ' + resvId : '取消失败：' + res.message,
              detail: res.ok ? '座位会释放回公共池' : '',
            }
          } catch (error) {
            return { ok: false, summary: '取消出错：' + String((error && error.message) || error) }
          }
        },
      }),
    )

    // 定时器：每 60 秒看一次；失败不抛给宿主
    const timer = setInterval(() => {
      void tick('timer')
    }, TICK_MS)
    // 抢座独立 20 秒节拍（只有到点才会真的发请求）
    const seatTimer = setInterval(() => {
      void seatTick()
    }, 20 * 1000)
    const startup = setTimeout(() => {
      void tick('startup')
    }, 8000)

    try {
      ctx.effect(() => () => {
        clearInterval(timer)
        clearInterval(seatTimer)
        clearTimeout(startup)
      }, 'aihub-checkin timers')
    } catch (_ignored) {}
  } catch (error) {
    // 绝不把失败抛给宿主：一行日志，插件静默降级
    try {
      console.error('[aihub-checkin] apply failed:', error)
    } catch (_ignored) {}
  }
}
