/**
 * dsh-netease-float — Host 半侧
 * ---------------------------------------------------------------------------
 * 职责（三条，边界清晰）：
 *   1) 同源代理网易云：搜索 / 歌词 / 音频（音频流透传 Range，前端不直连 163）
 *   2) 小窗壁纸：读用户配置的 Wallpaper Engine 目录，解析 project.json，
 *      只放行白名单扩展名的媒体，流式返回（同样支持 Range）
 *   3) 配置读写：~/.dsh/netease-float.json（仅本机）
 *
 * 刻意不做的事：
 *   - 不扫描磁盘找 Wallpaper Engine。目录由用户显式配置，避免全盘 IO。
 *   - 不支持场景壁纸（scene.pkg / scene.json）。遇到时返回明确原因，不静默失败。
 *   - 不碰 DSH 主界面：本插件没有任何 index/主题注入，壁纸只经媒体路由下发。
 *
 * 安全边界：
 *   - 所有路由先过 connection.requestRejection（浏览器信任栅栏）。
 *   - 壁纸路径：realpath 必须落在配置根目录内，且扩展名在白名单里。
 *   - 音频代理：解析出的上游地址 host 必须在网易云域名白名单内（防 SSRF）。
 */
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import { Readable } from 'node:stream'
import { spawn } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomBytes, createDecipheriv, createCipheriv, createHash } from 'node:crypto'
import { probeSceneVideoFromPkgFile, extractSceneVideoFromPkgFile } from './vendor/scene-manifest.js'
import { qrSvg } from './qr.js'

const NAME = 'dsh-netease-float'
const BASE = '/netease-float'
const CONFIG_FILE = path.join(os.homedir(), '.dsh', 'netease-float.json')
/** 场景壁纸提取出的内嵌视频缓存目录（只存本机）。 */
const SCENE_CACHE_DIR = path.join(os.homedir(), '.dsh', 'cache', 'netease-float')
/** 随包分发的 WebWallGL 场景渲染器（浏览器端脚本，客户端按需加载）。 */
const WEBWALLGL_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'vendor', 'webwallgl.global.min.js')

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

/**
 * 媒体路由的免栅栏令牌。
 *
 * 为什么需要：桌面端页面 origin 是 `dsh-app://app`，音频/壁纸由浏览器原生发
 * `http://127.0.0.1:<port>/netease-float/api/...` —— 这种请求**不带 DSH 的认证 cookie**，
 * 会被 connection.requestRejection 一律挡成 401，表现为音频加载失败
 * （NotSupportedError，免费歌同理）。媒体路由改用本进程随机令牌校验：
 * 只在本机、进程生命周期内有效，内容本身也不是敏感数据。
 */
const MEDIA_TOKEN = randomBytes(16).toString('hex')

/** 小窗背景允许的媒体类型（场景壁纸 .pkg 走不通，明确拒绝）。 */
const MEDIA_EXT = {
  '.mp4': { kind: 'video', type: 'video/mp4' },
  '.webm': { kind: 'video', type: 'video/webm' },
  '.jpg': { kind: 'image', type: 'image/jpeg' },
  '.jpeg': { kind: 'image', type: 'image/jpeg' },
  '.png': { kind: 'image', type: 'image/png' },
  '.gif': { kind: 'image', type: 'image/gif' },
}

const DEFAULTS = {
  wallpaperDir: '',
  wallpaperId: '',
  /** 只存本机，不上传、不进日志。 */
  cookie: '',
  /** 遮罩：0..1 暗化强度 */
  overlay: 0.55,
  /** 遮罩模糊强度 px */
  blur: 6,
  /** 动态壁纸 / 静态帧 */
  wallpaperMode: 'video',
  /** 小窗展开时是否显示歌词 */
  lyrics: true,
  /** 音量 0..1 */
  volume: 0.8,
  /* ---- 音乐设置页（前端「音乐」设置分区读写） ---- */
  /** 歌词是否显示翻译 */
  showTranslation: true,
  /** 歌词是否逐字高亮（yrc） */
  wordByWord: true,
  /** 正在播放页是否显示封面 */
  cover: true,
  /** 强调色（CSS 颜色） */
  accent: '#ff2b4e',
  /** 音质：compat 只用官方外链 / standard 128k / high 192k / exhigh 320k / lossless 无损优先 */
  quality: 'exhigh',
  /** 默认播放模式：list | one | off */
  loopMode: 'list',
  /** 右侧栏歌词是否显示内容 */
  rightLyrics: true,
  /** 歌词字号：small | normal | large | xlarge */
  lyricSize: 'normal',
  /** 歌词是否显示音译（romalrc） */
  showRoma: false,
  /** 歌词字重：normal | bold */
  lyricWeight: 'normal',
  /** 歌词行距：tight | normal | loose */
  lyricSpacing: 'normal',
  /** 切歌淡入（0.3s） */
  fade: true,
  /** 歌单/队列列表紧凑 */
  compact: false,
  /** 应用内快捷键（Ctrl+P / Ctrl+方向键） */
  hotkeys: true,
}

function readConfig() {
  try {
    // 同步读：配置很小，apply 与请求路径都要用，避免 async 传染。
    const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
    const out = { ...DEFAULTS }
    for (const k of Object.keys(DEFAULTS)) {
      if (raw[k] !== undefined && typeof raw[k] === typeof DEFAULTS[k]) out[k] = raw[k]
    }
    return out
  } catch {
    return { ...DEFAULTS }
  }
}

/** 把配置原子写回（先写临时文件再 rename），避免半截 JSON。 */
async function writeConfig(next) {
  const merged = { ...readConfig() }
  for (const k of Object.keys(DEFAULTS)) {
    if (next && next[k] !== undefined && typeof next[k] === typeof DEFAULTS[k]) merged[k] = next[k]
  }
  // cookie 允许显式置空
  if (next && typeof next.cookie === 'string') merged.cookie = next.cookie
  await fsp.mkdir(path.dirname(CONFIG_FILE), { recursive: true })
  const tmp = CONFIG_FILE + '.tmp'
  await fsp.writeFile(tmp, JSON.stringify(merged, null, 2), 'utf8')
  await fsp.rename(tmp, CONFIG_FILE)
  return merged
}

/** 掩码：只暴露存在性与尾四位，回给前端也不泄露完整凭据。 */
function maskCookie(cookie) {
  if (!cookie) return null
  const musicU = /MUSIC_U=([^;]+)/.exec(cookie)
  const tail = musicU ? musicU[1].slice(-4) : ''
  return { present: true, hasMusicU: Boolean(musicU), tail }
}

/* ---------------------------------------------------------------- 账号歌单 */

/** 登录账号 id 缓存（1 小时），避免每次开面板都打一次账号接口。 */
let nmUidCache = { uid: 0, at: 0, nickname: '' }

async function nmAccount() {
  const cfg = readConfig()
  if (!cfg.cookie) return { error: '需要先配置网易云 Cookie（设置 → 网易云登录态）' }
  if (nmUidCache.uid && Date.now() - nmUidCache.at < 3600 * 1000) {
    return { uid: nmUidCache.uid, nickname: nmUidCache.nickname }
  }
  const headers = { 'User-Agent': UA, Referer: 'https://music.163.com/', Cookie: cfg.cookie }
  try {
    const r = await fetch('https://music.163.com/api/nuser/account/get', { headers })
    const j = await r.json()
    const uid = j && j.account && j.account.id
    if (!uid) return { error: 'Cookie 已失效或未登录，重新配置一次' }
    const nickname = (j.profile && j.profile.nickname) || ''
    nmUidCache = { uid, at: Date.now(), nickname }
    return { uid, nickname }
  } catch (err) {
    return { error: '读取账号失败：' + ((err && err.message) || err) }
  }
}

/** 把网易云 track 压成前端要的形状（新旧两套字段都兼容）。 */
function songFromTrack(t) {
  if (!t || !t.id) return null
  const ar = (t.ar && t.ar.map((a) => a.name)) || (t.artists && t.artists.map((a) => a.name)) || []
  const al = (t.al || t.album || {})
  const pic = String(al.picUrl || t.picUrl || '')
  const cover = pic && /^https?:\/\//i.test(pic) ? pic.replace(/^http:\/\//i, 'https://') : ''
  return {
    id: t.id,
    name: String(t.name || '').slice(0, 120),
    artist: ar.join(' / ').slice(0, 120),
    album: String(al.name || '').slice(0, 120),
    duration: Number(t.dt || t.duration) || 0,
    fee: Number(t.fee) || 0,
    /** 封面原图地址；客户端统一经 /api/cover 代理（跨源 + referer 限制） */
    picUrl: cover,
  }
}

function sendJson(res, code, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': String(body.length),
  })
  res.end(body)
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        req.destroy()
        resolve('')
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(''))
  })
}

/* ---------------------------------------------------------------- 网易云 */

/** 上游音频域名白名单：只放行网易云自己的媒体机。 */
function isAllowedAudioHost(host) {
  if (!host) return false
  const h = host.toLowerCase()
  return (
    h === 'music.163.com' ||
    h.endsWith('.music.163.com') ||
    h.endsWith('.126.net') ||
    h === '163.com' ||
    h === 'music.126.net'
  )
}

/** 播放地址缓存：拖进度条会连发多次 Range 请求，每次重新解析要多打两次网易云接口。
 *  TTL 取 5 分钟（网易云外链本身带过期时间，太长会拿到失效地址）。 */
const audioUrlCache = new Map()
const AUDIO_URL_TTL = 5 * 60 * 1000
const AUDIO_URL_CACHE_MAX = 60

async function resolveAudioUrl(id) {
  const hit = audioUrlCache.get(id)
  if (hit && Date.now() - hit.at < AUDIO_URL_TTL) return hit.url
  const resolved = await resolveAudioUrlUncached(id)
  if (resolved) {
    audioUrlCache.set(id, { url: resolved, at: Date.now() })
    if (audioUrlCache.size > AUDIO_URL_CACHE_MAX) {
      const oldest = audioUrlCache.keys().next().value
      audioUrlCache.delete(oldest)
    }
  }
  return resolved
}

const QUALITY_BR = { compat: 0, standard: 128000, high: 192000, exhigh: 320000, lossless: 999000 }

async function resolveAudioUrlUncached(id) {
  const cfg = readConfig()
  const headers = { 'User-Agent': UA, Referer: 'https://music.163.com/' }
  if (cfg.cookie) headers.Cookie = cfg.cookie

  const quality = QUALITY_BR[cfg.quality] === undefined ? 'exhigh' : cfg.quality
  const br = QUALITY_BR[quality] || 0

  /* 设了音质（除 compat）就先按码率要一次，拿不到再走官方外链兜底：
     外链是 mp3 直链、码率固定；enhance 接口才吃 br。 */
  if (br > 0) {
    try {
      const r = await fetch(
        `https://music.163.com/api/song/enhance/player/url?ids=[${encodeURIComponent(id)}]&br=${br}`,
        { headers },
      )
      const j = await r.json()
      const url = j && j.data && j.data[0] && j.data[0].url
      if (typeof url === 'string' && /^https?:/i.test(url)) {
        const abs = new URL(url)
        if (isAllowedAudioHost(abs.host)) return abs.toString()
      }
    } catch {
      /* 回落外链 */
    }
  }

  // 1) 官方外链：免费曲直接 302 到 mp3；登录态下 VIP 曲也同样有效。
  try {
    const r = await fetch(`https://music.163.com/song/media/outer/url?id=${encodeURIComponent(id)}.mp3`, {
      headers,
      redirect: 'manual',
    })
    const loc = r.headers.get('location')
    if (loc) {
      const abs = new URL(loc, 'https://music.163.com/')
      if (isAllowedAudioHost(abs.host) && !/\/404(\?|$)/.test(abs.pathname)) return abs.toString()
    }
  } catch {
    /* 回落 */
  }

  // 2) 播放地址接口（保底 320k）
  try {
    const r = await fetch(
      `https://music.163.com/api/song/enhance/player/url?ids=[${encodeURIComponent(id)}]&br=320000`,
      { headers },
    )
    const j = await r.json()
    const url = j && j.data && j.data[0] && j.data[0].url
    if (typeof url === 'string' && /^https?:/i.test(url)) {
      const abs = new URL(url)
      if (isAllowedAudioHost(abs.host)) return abs.toString()
    }
  } catch {
    /* 无解 */
  }
  return null
}

/** 把上游响应（含 Range/206）原样转发给浏览器。 */
async function proxyAudio(req, res, url) {
  const cfg = readConfig()
  const headers = { 'User-Agent': UA, Referer: 'https://music.163.com/' }
  if (cfg.cookie) headers.Cookie = cfg.cookie
  const range = req.headers.range
  if (typeof range === 'string' && range) headers.Range = range

  let upstream
  try {
    upstream = await fetch(url, { headers, redirect: 'follow' })
  } catch (err) {
    sendJson(res, 502, { ok: false, error: 'upstream fetch failed: ' + (err && err.message) })
    return
  }
  const type = upstream.headers.get('content-type') || ''
  if (upstream.status >= 400 || !/^(audio|application\/octet-stream)/i.test(type)) {
    // 网易云对不可播的曲目返回 200 + text/html 的 404 页，这里必须挡掉
    sendJson(res, 404, {
      ok: false,
      error: 'no playable audio for this track (VIP/下架/版权限制)',
      upstreamStatus: upstream.status,
      upstreamType: type,
    })
    return
  }

  const out = {
    'Content-Type': type || 'audio/mpeg',
    /* 这片字节对同一首歌是稳定的，必须允许浏览器缓存：
       之前写 no-store，浏览器拿不到可复用的缓冲，seek 时就当新资源重下，
       表现是"点了跳过去、过一会儿又回到 0:00"。 */
    'Cache-Control': 'public, max-age=86400',
    'Accept-Ranges': upstream.headers.get('accept-ranges') || 'bytes',
    /* 桌面端页面 origin 是 dsh-app://app，走真实 HTTP 播音频属于跨源，放开只读媒体。 */
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Type',
  }
  for (const h of ['content-length', 'content-range']) {
    const v = upstream.headers.get(h)
    if (v) out[h === 'content-length' ? 'Content-Length' : 'Content-Range'] = v
  }
  res.writeHead(upstream.status, out)
  if (!upstream.body) {
    res.end()
    return
  }
  const stream = Readable.fromWeb(upstream.body)
  stream.on('error', () => {
    try {
      res.destroy()
    } catch {}
  })
  req.on('close', () => {
    try {
      stream.destroy()
    } catch {}
  })
  stream.pipe(res)
}

/* ---------------------------------------------------------------- 壁纸 */

/** 场景视频探测结果缓存：键含 mtime+size，壁纸被替换后自动失效。 */
const sceneProbeCache = new Map()

async function probeSceneCached(pkgPath) {
  let st
  try {
    st = await fsp.stat(pkgPath)
  } catch {
    return false
  }
  const key = pkgPath + '|' + st.size + '|' + Math.round(st.mtimeMs)
  if (sceneProbeCache.has(key)) return sceneProbeCache.get(key)
  let ok = false
  try {
    ok = await probeSceneVideoFromPkgFile(pkgPath)
  } catch {
    ok = false
  }
  sceneProbeCache.set(key, ok)
  return ok
}

/** 场景缓存上限：超过就按最旧优先删，避免切壁纸把磁盘吃满。 */
const SCENE_CACHE_MAX_BYTES = 512 * 1024 * 1024

async function pruneSceneCache() {
  const names = await fsp.readdir(SCENE_CACHE_DIR).catch(() => [])
  const files = []
  for (const n of names) {
    if (!n.endsWith('.mp4')) continue
    try {
      const st = await fsp.stat(path.join(SCENE_CACHE_DIR, n))
      files.push({ n, size: st.size, at: st.mtimeMs })
    } catch {}
  }
  let total = files.reduce((s, f) => s + f.size, 0)
  if (total <= SCENE_CACHE_MAX_BYTES) return
  files.sort((a, b) => a.at - b.at)
  for (const f of files) {
    if (total <= SCENE_CACHE_MAX_BYTES) break
    try {
      await fsp.unlink(path.join(SCENE_CACHE_DIR, f.n))
      total -= f.size
    } catch {}
  }
}

/** 校验并定位一个场景壁纸的 scene.pkg（供渲染器与 project.json 路由复用）。 */
async function resolveScenePkg(id) {
  const cfg = readConfig()
  const root = cfg.wallpaperDir
  if (!root || !existsSync(root)) return { error: '壁纸目录未配置或不存在', code: 404 }
  if (typeof id !== 'string' || !id || id.includes('/') || id.includes('\\') || id === '.' || id === '..') {
    return { error: '非法的壁纸 id', code: 400 }
  }
  const info = await inspectWallpaperDir(root, id)
  if (!info || !info.scene || !info.pkg) return { error: '该壁纸不是场景壁纸', code: 404 }
  const dir = path.join(root, id)
  const pkgPath = path.resolve(dir, info.pkg)
  const rootAbs = path.resolve(root)
  if (!(pkgPath === rootAbs || pkgPath.startsWith(rootAbs + path.sep))) return { error: '路径越界', code: 403 }
  let st
  try {
    st = await fsp.stat(pkgPath)
  } catch {
    return { error: 'scene.pkg 不可读', code: 404 }
  }
  return { file: pkgPath, size: st.size, dir }
}

/** 场景壁纸的预览图（加载占位 / 渲染失败兜底）。 */
async function resolvePreviewFile(id) {
  const cfg = readConfig()
  const root = cfg.wallpaperDir
  if (!root || !existsSync(root)) return { error: '壁纸目录未配置或不存在', code: 404 }
  if (typeof id !== 'string' || !id || id.includes('/') || id.includes('\\') || id === '.' || id === '..') {
    return { error: '非法的壁纸 id', code: 400 }
  }
  const info = await inspectWallpaperDir(root, id)
  if (!info || !info.preview) return { error: '该壁纸没有预览图', code: 404 }
  const rootAbs = path.resolve(root)
  const full = path.resolve(path.join(root, id), info.preview)
  if (!full.startsWith(rootAbs + path.sep)) return { error: '路径越界', code: 403 }
  const spec = MEDIA_EXT[path.extname(full).toLowerCase()]
  if (!spec) return { error: '预览图格式不在白名单', code: 403 }
  try {
    const st = await fsp.stat(full)
    return { file: full, type: spec.type, size: st.size }
  } catch {
    return { error: '预览图不可读', code: 404 }
  }
}

/** 取场景壁纸内嵌的 MP4：首次提取写缓存文件，之后直接复用（支持 Range）。 */
async function resolveSceneVideo(id) {
  const cfg = readConfig()
  const root = cfg.wallpaperDir
  if (!root || !existsSync(root)) return { error: '壁纸目录未配置或不存在', code: 404 }
  if (typeof id !== 'string' || !id || id.includes('/') || id.includes('\\') || id === '.' || id === '..') {
    return { error: '非法的壁纸 id', code: 400 }
  }
  const info = await inspectWallpaperDir(root, id)
  if (!info || !info.scene || !info.pkg) return { error: '该壁纸不是可提取视频的场景壁纸', code: 404 }

  const dir = path.join(root, id)
  const pkgPath = path.resolve(dir, info.pkg)
  const rootAbs = path.resolve(root)
  if (!(pkgPath === rootAbs || pkgPath.startsWith(rootAbs + path.sep))) return { error: '路径越界', code: 403 }

  let st
  try {
    st = await fsp.stat(pkgPath)
  } catch {
    return { error: 'scene.pkg 不存在或不可读', code: 404 }
  }
  const key = 'scene-' + id + '-' + st.size + '-' + Math.round(st.mtimeMs) + '.mp4'
  const cached = path.join(SCENE_CACHE_DIR, key)
  if (existsSync(cached)) return { file: cached }

  try {
    await fsp.mkdir(SCENE_CACHE_DIR, { recursive: true })
  } catch {}
  let buf
  try {
    buf = await extractSceneVideoFromPkgFile(pkgPath)
  } catch (err) {
    return { error: '提取内嵌视频失败：' + (err && err.message), code: 500 }
  }
  if (!buf || !buf.byteLength) return { error: '场景包内没有可提取的内嵌视频', code: 404 }
  const tmp = cached + '.tmp'
  try {
    await fsp.writeFile(tmp, buf)
    await fsp.rename(tmp, cached)
  } catch (err) {
    return { error: '写入缓存失败：' + (err && err.message), code: 500 }
  }
  await pruneSceneCache().catch(() => {})
  return { file: cached, extracted: true }
}

/** 读一个壁纸目录，返回 { entry } 或 { unsupported, reason }。 */
async function inspectWallpaperDir(root, dirName) {
  const dir = path.join(root, dirName)
  let st
  try {
    st = await fsp.stat(dir)
  } catch {
    return null
  }
  if (!st.isDirectory()) return null

  let meta = {}
  const pj = path.join(dir, 'project.json')
  if (existsSync(pj)) {
    try {
      meta = JSON.parse(await fsp.readFile(pj, 'utf8')) || {}
    } catch {
      meta = {}
    }
  }
  const declared = typeof meta.file === 'string' ? meta.file : ''
  const kind = typeof meta.type === 'string' ? meta.type.toLowerCase() : ''
  const preview = typeof meta.preview === 'string' ? meta.preview : ''
  const title = typeof meta.title === 'string' && meta.title ? meta.title : dirName

  let names = []
  try {
    names = await fsp.readdir(dir)
  } catch {
    names = []
  }
  names.sort()
  const isPreviewName = (n) => /^preview\.(jpg|jpeg|png|gif)$/i.test(n)
  const hasPkg = names.some((n) => /\.pkg$/i.test(n))
  const hasSceneJson = names.some((n) => n.toLowerCase() === 'scene.json')
  const isScene = kind === 'scene' || hasPkg || hasSceneJson || /^scene\.(json|pkg)$/i.test(declared)

  /* 场景壁纸：只要有 scene.pkg 就交给 WebWallGL 渲染真实场景（图层/粒子/效果）。
     hasVideo 只作为「渲染器不可用时抽内嵌 MP4 兜底」的提示，不再是唯一出路。 */
  if (isScene) {
    const pkgName = names.find((n) => /\.pkg$/i.test(n))
    if (pkgName) {
      const hasVideo = await probeSceneCached(path.join(dir, pkgName))
      return {
        id: dirName,
        title,
        kind: 'scene',
        scene: true,
        pkg: pkgName,
        hasVideo,
        file: '',
        type: 'application/octet-stream',
        size: 0,
        preview: preview && MEDIA_EXT[path.extname(preview).toLowerCase()] ? preview : '',
        degraded: false,
        reason: hasVideo ? '' : '场景由 WebWallGL 实时渲染；渲染不可用时回退预览图',
      }
    }
  }

  /* 候选顺序：project.json 声明的文件 → 目录里的正经媒体 → 最后才轮到预览图。
     预览图只做「场景壁纸的降级静态帧」，不能顶替真正的视频壁纸。 */
  const candidates = []
  if (declared && !/\.pkg$/i.test(declared) && !/scene\.json$/i.test(declared) && !isPreviewName(path.basename(declared))) {
    candidates.push(declared)
  }
  for (const n of names) if (!isPreviewName(n)) candidates.push(n)
  if (!isScene) for (const n of names) if (isPreviewName(n)) candidates.push(n)
  if (isScene) {
    if (preview && names.includes(preview)) candidates.push(preview)
    for (const n of names) if (isPreviewName(n)) candidates.push(n)
  }

  for (const c of candidates) {
    const ext = path.extname(c).toLowerCase()
    const spec = MEDIA_EXT[ext]
    if (!spec) continue
    const full = path.join(dir, c)
    try {
      const s = await fsp.stat(full)
      if (!s.isFile() || s.size <= 0) continue
      const usedPreview = isPreviewName(c)
      return {
        id: dirName,
        title,
        kind: spec.kind,
        file: c,
        type: spec.type,
        size: s.size,
        preview: preview && MEDIA_EXT[path.extname(preview).toLowerCase()] ? preview : '',
        /* 场景壁纸：只拿得到预览图，动态场景本体（.pkg）解析不了。 */
        degraded: Boolean(isScene && usedPreview),
        reason: isScene && usedPreview ? '场景壁纸（scene.pkg）暂不支持，这里只播放预览图' : '',
      }
    } catch {
      continue
    }
  }

  if (isScene) {
    return { id: dirName, title, unsupported: true, reason: '场景壁纸（scene.pkg / scene.json）暂不支持，且目录内没有可用的预览图' }
  }
  return { id: dirName, title, unsupported: true, reason: '目录内没有 .mp4/.webm/.jpg/.png/.gif 媒体文件' }
}

async function listWallpapers() {
  const cfg = readConfig()
  const root = cfg.wallpaperDir
  if (!root) return { root: '', items: [], error: '尚未配置壁纸目录' }
  if (!existsSync(root)) return { root, items: [], error: '壁纸目录不存在：' + root }
  let entries = []
  try {
    entries = await fsp.readdir(root, { withFileTypes: true })
  } catch (err) {
    return { root, items: [], error: '无法读取目录：' + (err && err.message) }
  }
  const items = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const info = await inspectWallpaperDir(root, e.name)
    if (info) items.push(info)
  }
  items.sort((a, b) => Number(Boolean(a.unsupported)) - Number(Boolean(b.unsupported)) || a.title.localeCompare(b.title))
  return { root, items }
}

/** 解析一次媒体请求：id 只能是 root 内的直接子目录，扩展名必须在白名单。 */
async function resolveMediaFile(id) {
  const cfg = readConfig()
  const root = cfg.wallpaperDir
  if (!root || !existsSync(root)) return { error: '壁纸目录未配置或不存在', code: 404 }
  if (typeof id !== 'string' || !id || id.includes('/') || id.includes('\\') || id === '.' || id === '..') {
    return { error: '非法的壁纸 id', code: 400 }
  }
  const dir = path.join(root, id)
  const info = await inspectWallpaperDir(root, id)
  if (!info || info.unsupported) return { error: info ? info.reason : '壁纸不存在', code: 404 }

  const full = path.resolve(dir, info.file)
  // 穿越防护：resolve 之后必须仍在 root 内，且中间段不能有 ..
  const rootAbs = path.resolve(root)
  if (!(full === rootAbs || full.startsWith(rootAbs + path.sep))) {
    return { error: '路径越界', code: 403 }
  }
  const ext = path.extname(full).toLowerCase()
  if (!MEDIA_EXT[ext]) return { error: '扩展名不在白名单', code: 403 }
  try {
    const real = await fsp.realpath(full)
    const realRoot = await fsp.realpath(rootAbs)
    if (!(real === realRoot || real.startsWith(realRoot + path.sep))) return { error: '符号链接越界', code: 403 }
    return { file: real, type: MEDIA_EXT[ext].type, kind: MEDIA_EXT[ext].kind, size: statSync(real).size }
  } catch (err) {
    return { error: '文件不可读：' + (err && err.message), code: 404 }
  }
}

/** 本地文件流式响应，支持 HTTP Range（视频循环/拖动必需）。 */
function sendFileRange(req, res, file, type, size) {
  const range = typeof req.headers.range === 'string' ? req.headers.range.trim() : ''
  const base = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  }
  if (!range) {
    res.writeHead(200, { ...base, 'Content-Length': String(size) })
    if (req.method === 'HEAD') return res.end()
    const s = createReadStream(file)
    s.on('error', () => {
      try {
        res.destroy()
      } catch {}
    })
    return s.pipe(res)
  }
  const m = /^bytes=(\d*)-(\d*)$/.exec(range)
  if (!m) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` })
    return res.end()
  }
  let start = m[1] === '' ? NaN : Number(m[1])
  let end = m[2] === '' ? size - 1 : Number(m[2])
  if (m[1] === '') {
    // 后缀范围：bytes=-N
    const suffix = Number(m[2])
    if (!Number.isFinite(suffix) || suffix <= 0) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` })
      return res.end()
    }
    start = Math.max(0, size - suffix)
    end = size - 1
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= size || end < start) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` })
    return res.end()
  }
  end = Math.min(end, size - 1)
  res.writeHead(206, {
    ...base,
    'Content-Range': `bytes ${start}-${end}/${size}`,
    'Content-Length': String(end - start + 1),
  })
  if (req.method === 'HEAD') return res.end()
  const s = createReadStream(file, { start, end })
  s.on('error', () => {
    try {
      res.destroy()
    } catch {}
  })
  s.pipe(res)
}

/* ------------------------------------------------- 本机网易云登录态（可选） */

const NETease_COOKIES = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'Netease',
  'CloudMusic',
  'webapp91x64',
  'Cookies',
)

/** DPAPI 解 Chromium v10 cookie（当前用户上下文，不弹 UAC）。 */
function dpapiDecrypt(b64) {
  return new Promise((resolve) => {
    const script = [
      "$ErrorActionPreference='Stop'",
      'Add-Type -AssemblyName System.Security | Out-Null',
      `$b=[Convert]::FromBase64String('${b64}')`,
      "$p=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser')",
      '[Convert]::ToBase64String($p)',
    ].join('; ')
    const child = spawn(
      process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true },
    )
    let out = ''
    let err = ''
    child.stdout.on('data', (c) => (out += c))
    child.stderr.on('data', (c) => (err += c))
    child.on('error', () => resolve(null))
    child.on('close', (code) => {
      if (code !== 0) return resolve(null)
      const s = out.trim()
      if (!s) return resolve(null)
      try {
        resolve(Buffer.from(s, 'base64'))
      } catch {
        resolve(null)
      }
    })
  })
}

/**
 * 从本机网易云客户端读 MUSIC_U。
 * 只在用户显式点「导入」时调用；结果写进本机配置，不回传完整值。
 */
/**
 * 从本机网易云客户端读 MUSIC_U。
 * 新版客户端 cookie 是 v10 = AES-256-GCM：密钥来自同目录 LocalPrefs.json 的
 * os_crypt.encrypted_key（DPAPI 保护），明文前 32 字节是 host hash 前缀。
 * 只在用户显式点「导入」时调用；结果写进本机配置，不回传完整值。
 */
async function importNeteaseCookie() {
  if (process.platform !== 'win32') return { ok: false, error: '仅支持 Windows 本机网易云客户端' }
  if (!existsSync(NETease_COOKIES)) return { ok: false, error: '未找到网易云客户端 Cookie 文件：' + NETease_COOKIES }
  const prefsFile = path.join(path.dirname(NETease_COOKIES), 'LocalPrefs.json')
  if (!existsSync(prefsFile)) return { ok: false, error: '未找到客户端密钥文件：' + prefsFile }
  let DatabaseSync
  try {
    ;({ DatabaseSync } = await import('node:sqlite'))
  } catch {
    return { ok: false, error: '当前 Node 不支持 node:sqlite，无法自动读取；请手动粘贴 Cookie' }
  }
  let key = null
  try {
    const prefs = JSON.parse(readFileSync(prefsFile, 'utf8'))
    const ek = Buffer.from(String((prefs.os_crypt && prefs.os_crypt.encrypted_key) || ''), 'base64')
    if (ek.length > 5) {
      const raw = await dpapiDecrypt(ek.subarray(5).toString('base64'))
      if (raw && raw.length === 32) key = raw
    }
  } catch {}
  const tmp = path.join(os.tmpdir(), 'dsh-nf-cookies-' + process.pid + '.db')
  try {
    await fsp.copyFile(NETease_COOKIES, tmp)
  } catch (err) {
    return { ok: false, error: '复制 Cookie 库失败：' + (err && err.message) }
  }
  try {
    const db = new DatabaseSync(tmp, { readOnly: true })
    const rows = db.prepare("SELECT name, encrypted_value FROM cookies WHERE name IN ('MUSIC_U','__csrf') ORDER BY expires_utc DESC").all()
    db.close()
    if (!rows.length) return { ok: false, error: 'Cookie 库中没有 MUSIC_U（网易云客户端未登录）' }
    const picked = {}
    for (const row of rows) {
      if (picked[row.name]) continue
      const buf = Buffer.from(row.encrypted_value)
      if (buf.length <= 3) continue
      const prefix = buf.subarray(0, 3).toString('latin1')
      let value = ''
      if (prefix === 'v10' && key) {
        try {
          const body = buf.subarray(3)
          const d = createDecipheriv('aes-256-gcm', key, body.subarray(0, 12))
          d.setAuthTag(body.subarray(body.length - 16))
          const plain = Buffer.concat([d.update(body.subarray(12, body.length - 16)), d.final()])
          value = plain.subarray(32).toString('utf8')
        } catch {}
      } else if (prefix === 'v10' || prefix === 'v11') {
        const plain = await dpapiDecrypt(buf.subarray(3).toString('base64'))
        value = plain ? plain.toString('utf8') : ''
      }
      if (value) picked[row.name] = value
    }
    if (!picked.MUSIC_U) {
      return { ok: false, error: 'MUSIC_U 存在但解密失败；请改用「扫码登录」或手动粘贴 Cookie' }
    }
    const cookie = 'MUSIC_U=' + picked.MUSIC_U + (picked.__csrf ? '; __csrf=' + picked.__csrf : '')
    await writeConfig({ cookie })
    return { ok: true, hasMusicU: true, tail: picked.MUSIC_U.slice(-4) }
  } catch (err) {
    return { ok: false, error: '读取 Cookie 库失败：' + (err && err.message) }
  } finally {
    fsp.unlink(tmp).catch(() => {})
  }
}

/* ---------------------------------------------------------------- 登录 */

const QR_HEADERS = { 'User-Agent': UA, Referer: 'https://music.163.com/', Origin: 'https://music.163.com' }

const LOGIN_LOG = path.join(os.homedir(), '.dsh', 'netease-float-login.log')
let qrJar = ''

function loginLog(msg) {
  try {
    fsp.appendFile(LOGIN_LOG, new Date().toISOString() + ' ' + msg + '\n').catch(() => {})
  } catch {}
}

/* 网易云 eapi（AES-128-ECB + md5 摘要），新版短信验证码/手机登录都走这套。 */
const EAPI_KEY = 'e82ckenh8dichen8'

function eapiBody(pathname, payload) {
  const text = JSON.stringify(payload || {})
  const message = 'nobody' + pathname + 'use' + text + 'md5forencrypt'
  const digest = createHash('md5').update(message).digest('hex')
  const data = pathname + '-36cd479b6b5-' + text + '-36cd479b6b5-' + digest
  const cipher = createCipheriv('aes-128-ecb', Buffer.from(EAPI_KEY), null)
  const params = Buffer.concat([cipher.update(Buffer.from(data, 'utf8')), cipher.final()])
    .toString('hex')
    .toUpperCase()
  return 'params=' + encodeURIComponent(params)
}

async function eapiPost(pathname, payload) {
  const url = 'https://music.163.com' + pathname.replace(/^\/api/, '/eapi')
  const headers = {
    ...QR_HEADERS,
    'Content-Type': 'application/x-www-form-urlencoded',
    Cookie: 'os=pc; appver=2.9.7',
  }
  const r = await fetch(url, { method: 'POST', headers, body: eapiBody(pathname, payload) })
  const cookies = readSetCookies(r)
  const json = await r.json().catch(() => ({}))
  return { cookies, json }
}

function readSetCookies(r) {
  try {
    if (typeof r.headers.getSetCookie === 'function') {
      const arr = r.headers.getSetCookie()
      if (arr && arr.length) return arr
    }
  } catch {}
  try {
    const raw = r.headers.get('set-cookie')
    if (raw) return [raw]
  } catch {}
  return []
}

function jarFromSetCookies(list) {
  const out = []
  for (const line of list || []) {
    const head = String(line).split(';')[0]
    const i = head.indexOf('=')
    if (i > 0) out.push(head)
  }
  return out.join('; ')
}

/** 二维码登录第一步：拿 unikey。这是网易云未加密的老接口，可直接 fetch。 */
async function qrLoginNew() {
  try {
    const r = await fetch('https://music.163.com/api/login/qrcode/unikey?type=3', { headers: QR_HEADERS })
    const setCookies = readSetCookies(r)
    const j = await r.json()
    if (!j || j.code !== 200 || !j.unikey) {
      loginLog('unikey fail code=' + ((j && j.code) || 'unknown'))
      return { ok: false, error: '无法获取二维码（code ' + ((j && j.code) || 'unknown') + '）' }
    }
    qrJar = jarFromSetCookies(setCookies)
    const url = 'https://music.163.com/login?codekey=' + j.unikey
    let svg = ''
    try {
      svg = qrSvg(url)
    } catch (e) {
      svg = ''
    }
    loginLog('unikey ok key=' + String(j.unikey).slice(0, 8) + ' jar=' + (qrJar ? 'yes' : 'no') + ' svg=' + (svg ? svg.length : 0))
    return { ok: true, key: j.unikey, url, svg }
  } catch (err) {
    loginLog('unikey error ' + ((err && err.message) || err))
    return { ok: false, error: '获取二维码失败：' + ((err && err.message) || err) }
  }
}

/** 二维码登录第二步：轮询状态；803 时把 cookie 落盘并验证账号。 */
async function qrLoginCheck(key) {
  const url = 'https://music.163.com/api/login/qrcode/client/login?key=' + encodeURIComponent(key) + '&type=3'
  try {
    const headers = { ...QR_HEADERS }
    if (qrJar) headers.Cookie = qrJar
    const r = await fetch(url, { headers })
    const cookies = readSetCookies(r)
    const j = await r.json().catch(() => ({}))
    const code = Number(j && j.code)
    loginLog('check key=' + String(key).slice(0, 8) + ' code=' + code + ' msg=' + ((j && j.message) || '') + ' cookies=' + cookies.length)
    if (code === 803) {
      const fresh = cookieFromSetCookie(cookies)
      qrJar = ''
      if (!/MUSIC_U=/.test(fresh)) {
        loginLog('803 but no MUSIC_U')
        return { ok: true, code, state: 'success', saved: false, error: '登录成功但没拿到 MUSIC_U' }
      }
      await writeConfig({ cookie: mergeCookie(readConfig().cookie, fresh) })
      nmUidCache = { uid: 0, at: 0, nickname: '' }
      const acc = await nmAccount()
      loginLog('803 saved uid=' + (acc.uid || 0))
      return {
        ok: true,
        code,
        state: 'success',
        saved: true,
        loggedIn: acc.uid || 0,
        nickname: acc.nickname || '',
        uid: acc.uid || 0,
      }
    }
    const stateMap = { 800: 'expired', 801: 'waiting', 802: 'scanned' }
    return { ok: true, code, state: stateMap[code] || 'unknown', message: j.message || '' }
  } catch (err) {
    loginLog('check error ' + ((err && err.message) || err))
    return { ok: false, error: '轮询登录状态失败：' + ((err && err.message) || err) }
  }
}

/** 发送短信验证码（新版 eapi 接口）。 */
async function smsCaptchaSent(phone) {
  const p = String(phone || '').trim()
  if (!/^1\d{10}$/.test(p)) return { ok: false, error: '请输入 11 位手机号' }
  try {
    const { json } = await eapiPost('/api/middle/captcha/sent/v1', {
      ctcode: '86',
      secrete: 'music_middleuser_pclogin',
      cellphone: p,
      scene: '0',
    })
    const code = Number(json && json.code)
    loginLog('sms sent code=' + code + ' msg=' + ((json && (json.message || json.msg)) || ''))
    if (code === 200) return { ok: true, code, message: json.message || '验证码已发送' }
    return { ok: false, code, error: (json && (json.message || json.msg)) || '发送失败（code ' + code + '）' }
  } catch (err) {
    return { ok: false, error: '发送验证码失败：' + ((err && err.message) || err) }
  }
}

/** 手机号 + 短信验证码登录（新版 eapi 接口）；成功后把 cookie 落盘。 */
async function smsLoginVerify(phone, captcha) {
  const p = String(phone || '').trim()
  const c = String(captcha || '').trim()
  if (!/^1\d{10}$/.test(p)) return { ok: false, error: '请输入 11 位手机号' }
  if (!/^\d{4,8}$/.test(c)) return { ok: false, error: '请输入短信验证码' }
  try {
    const { cookies, json } = await eapiPost('/api/w/login/cellphone', {
      type: '1',
      https: 'true',
      phone: p,
      countrycode: '86',
      captcha: c,
      remember: 'true',
      secureCaptcha: '',
    })
    const code = Number(json && json.code)
    loginLog('sms login code=' + code + ' msg=' + ((json && (json.message || json.msg)) || ''))
    if (code !== 200) return { ok: false, code, error: (json && (json.message || json.msg)) || '登录失败（code ' + code + '）' }
    const fresh = cookieFromSetCookie(cookies)
    if (!/MUSIC_U=/.test(fresh)) {
      loginLog('sms login ok but no MUSIC_U cookies=' + cookies.length)
      return { ok: false, error: '登录成功但没拿到 MUSIC_U' }
    }
    await writeConfig({ cookie: mergeCookie(readConfig().cookie, fresh) })
    nmUidCache = { uid: 0, at: 0, nickname: '' }
    const acc = await nmAccount()
    loginLog('sms login saved uid=' + (acc.uid || 0))
    return {
      ok: true,
      saved: true,
      loggedIn: acc.uid || 0,
      nickname: acc.nickname || '',
      uid: acc.uid || 0,
    }
  } catch (err) {
    return { ok: false, error: '手机登录失败：' + ((err && err.message) || err) }
  }
}

/** 当前登录账号（带头像），给页面右上角用。 */
async function accountInfo() {
  const cfg = readConfig()
  if (!cfg.cookie) return { ok: true, loggedIn: false }
  const acc = await nmAccount()
  if (acc.error) {
    // 本机客户端导入的 MUSIC_U 能取播放地址，但账号资料接口不认（account/profile 为 null）。
    // 这种情况仍算已登录：资料区显示本机账号，歌单只能读到 uid=0 的残缺数据。
    return { ok: true, loggedIn: true, guest: true, uid: 0, nickname: '本机客户端账号', avatar: '', note: acc.error }
  }
  let avatar = ''
  try {
    const r = await fetch('https://music.163.com/api/nuser/account/get', {
      headers: { 'User-Agent': UA, Referer: 'https://music.163.com/', Cookie: cfg.cookie },
    })
    const j = await r.json()
    avatar = (j && j.profile && j.profile.avatarUrl) || ''
  } catch {}
  if (!acc.uid) {
    // 从本机客户端导入的 MUSIC_U 能正常取播放地址，但账号资料接口不认（account/profile 为 null）。
    // 这种情况仍算已登录：资料区显示本机账号，歌单/搜索/播放都靠 cookie。
    return { ok: true, loggedIn: true, guest: true, uid: 0, nickname: '本机客户端账号', avatar: '' }
  }
  return {
    ok: true,
    loggedIn: true,
    uid: acc.uid,
    nickname: acc.nickname,
    avatar: avatar ? avatar.replace(/^http:\/\//i, 'https://') : '',
  }
}

/* ---------------------------------------------------------------- 封面 */

/** 封面域名白名单：网易云自己的图床 + QQ 音乐图床。 */
function isAllowedCoverHost(host) {
  if (!host) return false
  const h = host.toLowerCase()
  return (
    h.endsWith('.music.126.net') ||
    h.endsWith('.126.net') ||
    h.endsWith('.gtimg.cn') ||
    h.endsWith('.qlogo.cn') ||
    h === 'music.163.com'
  )
}

const coverCache = new Map()
const COVER_CACHE_MAX = 80

/**
 * 封面代理。
 *
 * 页面 origin 是 dsh-app://app，img 直接拉网易云图床会同时踩两个坑：
 * 跨源 + 图床校验 Referer。统一由 host 侧转发并缓存。
 */
async function proxyCover(rawUrl, size) {
  let abs
  try {
    abs = new URL(rawUrl)
  } catch {
    return { error: '无效的封面地址' }
  }
  if (!/^https?:$/.test(abs.protocol)) return { error: '封面地址协议不支持' }
  if (!isAllowedCoverHost(abs.host)) return { error: '封面域名不在白名单' }
  const pixels = Math.min(Math.max(Number(size) || 256, 64), 512)
  abs.searchParams.set('param', pixels + 'y' + pixels)
  const key = abs.toString() + '#' + pixels
  const hit = coverCache.get(key)
  if (hit && Date.now() - hit.at < 24 * 3600 * 1000) return hit
  try {
    const r = await fetch(abs.toString(), {
      headers: { 'User-Agent': UA, Referer: 'https://music.163.com/' },
    })
    if (!r.ok) return { error: '封面拉取失败（' + r.status + '）' }
    const type = r.headers.get('content-type') || ''
    if (!/^image\//i.test(type)) return { error: '上游返回的不是图片' }
    const buf = Buffer.from(await r.arrayBuffer())
    const item = { buf, type, at: Date.now() }
    coverCache.set(key, item)
    if (coverCache.size > COVER_CACHE_MAX) coverCache.delete(coverCache.keys().next().value)
    return item
  } catch (err) {
    return { error: '封面拉取失败：' + ((err && err.message) || err) }
  }
}

/* ---------------------------------------------------------------- 歌词 */

const LYRIC_KEYS = ['lrc', 'tlyric', 'yrc', 'ytlrc', 'romalrc', 'yromalrc']

function emptyLyricBody() {
  return { lrc: '', tlyric: '', yrc: '', ytlrc: '', romalrc: '', yromalrc: '' }
}

function lyricBodyFromJson(j) {
  const out = emptyLyricBody()
  if (!j || typeof j !== 'object') return out
  out.lrc = (j.lrc && j.lrc.lyric) || ''
  out.tlyric = (j.tlyric && j.tlyric.lyric) || ''
  out.yrc = (j.yrc && j.yrc.lyric) || ''
  out.ytlrc = (j.ytlrc && j.ytlrc.lyric) || ''
  out.romalrc = (j.romalrc && j.romalrc.lyric) || ''
  out.yromalrc = (j.yromalrc && j.yromalrc.lyric) || ''
  return out
}

/** 只补空不覆盖：逐字版（yrc）与旧版（lrc）各取所长。 */
function mergeLyricBodies(primary, fallback) {
  const out = { ...primary }
  for (const k of LYRIC_KEYS) if (!out[k] && fallback[k]) out[k] = fallback[k]
  return out
}

/**
 * 歌词：先 lyric/new（带 yrc 逐字 + 翻译 + 罗马音），缺字段再回退旧接口补。
 * 旧接口只有 lrc/tlyric；新接口部分歌缺 translation，所以两条都要试。
 */
async function fetchLyricMerged(id) {
  const cfg = readConfig()
  const headers = { 'User-Agent': UA, Referer: 'https://music.163.com/' }
  if (cfg.cookie) headers.Cookie = cfg.cookie
  const hasText = (b) => Boolean(b && (b.lrc || b.yrc))
  const hasTrans = (b) => Boolean(b && (b.tlyric || b.ytlrc))

  let body = emptyLyricBody()
  let from = 'none'
  try {
    const r = await fetch(
      `https://music.163.com/api/song/lyric/new?id=${encodeURIComponent(id)}&lv=-1&kv=-1&tv=-1&rv=-1&yv=-1&ytv=-1&yrv=-1`,
      { headers },
    )
    const j = await r.json()
    const b = lyricBodyFromJson(j)
    if (hasText(b) || hasTrans(b)) {
      body = b
      from = 'lyric_new'
    }
  } catch {}

  if (!hasText(body) || !hasTrans(body)) {
    try {
      const r = await fetch(
        `https://music.163.com/api/song/lyric?id=${encodeURIComponent(id)}&lv=-1&kv=-1&tv=-1&rv=-1`,
        { headers },
      )
      const j = await r.json()
      const fb = lyricBodyFromJson(j)
      if (hasText(fb) || hasTrans(fb)) {
        body = mergeLyricBodies(body, fb)
        from = from === 'none' ? 'lyric' : from + '+lyric'
      }
    } catch {}
  }

  return {
    ...body,
    source: from,
    hasText: hasText(body),
    hasTranslation: hasTrans(body),
    isWordByWord: Boolean(body.yrc),
  }
}

/* ---------------------------------------------------------------- 可播性 */

const AUDIO_PROBE_BYTES = 8192

/** 靠文件头认音频；网易云对不可播曲目会返回 200 + HTML 404 页。 */
function audioProbeMagic(buf) {
  if (!buf || buf.length < 12) return ''
  const ascii = (o, n) => buf.subarray(o, o + n).toString('latin1')
  if (ascii(0, 3) === 'ID3') return 'mp3'
  if (ascii(0, 4) === 'fLaC') return 'flac'
  if (ascii(0, 4) === 'OggS') return 'ogg'
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return 'wav'
  if (ascii(4, 4) === 'ftyp') return 'm4a'
  const n = Math.min(buf.length - 1, 2048)
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0xff && (buf[i + 1] & 0xe0) === 0xe0) return 'mp3'
  }
  return ''
}

/** 网易云 CDN 节点偶尔对某些网络直接 403；同一 path 换节点通常可用。 */
function audioHostAlternatives(url) {
  try {
    const u = new URL(url)
    const h = u.hostname.toLowerCase()
    if (!/^m\d+\.music\.126\.net$/.test(h)) return []
    const out = []
    for (const n of ['m801', 'm701', 'm501', 'm401', 'm201', 'm101', 'm802', 'm803', 'm805']) {
      const alt = new URL(url)
      alt.hostname = n + '.music.126.net'
      if (alt.toString() !== url) out.push(alt.toString())
    }
    return out
  } catch { return [] }
}

/** 用 Range 取前 8KB 判断这个地址到底是音频还是网页。 */
async function probeAudioUrl(url, headers) {
  try {
    const r = await fetch(url, {
      headers: { ...headers, Range: 'bytes=0-' + (AUDIO_PROBE_BYTES - 1) },
    })
    if (r.status !== 200 && r.status !== 206) return { ok: false, status: r.status, reason: 'http' }
    const ab = await r.arrayBuffer().catch(() => null)
    const buf = Buffer.from(ab || new ArrayBuffer(0)).subarray(0, AUDIO_PROBE_BYTES)
    const type = (r.headers.get('content-type') || '').toLowerCase()
    if (buf.length < 512) return { ok: false, status: r.status, reason: 'short', type }
    if (/text\/html|application\/(json|xml)|text\/plain/.test(type)) {
      return { ok: false, status: r.status, reason: 'html', type }
    }
    const magic = audioProbeMagic(buf)
    return magic ? { ok: true, status: r.status, type, magic } : { ok: false, status: r.status, reason: 'magic', type }
  } catch (err) {
    return { ok: false, reason: 'network', error: String((err && err.message) || err) }
  }
}

/**
 * 给前端一套「能照着做」的失败说明：category 决定说什么，action 决定给什么按钮。
 * category: login_required | vip_required | paid_required | copyright_unavailable | url_unavailable | network
 * action:   login | upgrade | purchase | switch_source | retry
 */
function classifySongUrlFailure({ itemCode = 0, fee = 0, loggedIn = false, probe = null } = {}) {
  const base = { ok: false, code: itemCode || fee || 0 }
  if (itemCode === 404 || itemCode === -200) {
    return { ...base, category: 'copyright_unavailable', action: 'switch_source', message: '这首歌已下架或没有版权' }
  }
  if (fee === 1) {
    if (!loggedIn) return { ...base, category: 'login_required', action: 'login', message: '这是会员歌曲，登录后可以试听片段' }
    return { ...base, category: 'vip_required', action: 'upgrade', message: '需要黑胶 VIP 才能播放' }
  }
  if (fee === 4) {
    if (!loggedIn) return { ...base, category: 'login_required', action: 'login', message: '这是付费专辑，请先登录' }
    return { ...base, category: 'paid_required', action: 'purchase', message: '需要购买数字专辑才能播放' }
  }
  if (fee === 8) return { ...base, category: 'copyright_unavailable', action: 'switch_source', message: '这首歌暂无版权' }
  if (probe && probe.reason === 'html') {
    return { ...base, category: 'url_unavailable', action: 'retry', message: '拿到的是网页而不是音频（可能需要登录或已下架）' }
  }
  if (probe && probe.reason === 'network') {
    return { ...base, category: 'network', action: 'retry', message: '网络不通，稍后重试' }
  }
  return { ...base, category: 'url_unavailable', action: 'retry', message: '暂时拿不到播放地址' }
}

/* ---------------------------------------------------------------- 插件 */

function resolveWebServer(ctx) {
  try {
    const viaGet = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
    if (viaGet) return viaGet
  } catch {}
  return ctx.webServer
}

function apply(ctx) {
  const disposers = []
  const webServer = resolveWebServer(ctx)

  if (!webServer || typeof webServer.register !== 'function') {
    try {
      ctx.logger?.warn?.('[' + NAME + '] 当前 profile 没有 webServer，Host 半侧跳过；小窗无法加载媒体')
    } catch {}
    return
  }

  function rejected(req, res) {
    try {
      const conn = (typeof ctx.get === 'function' ? ctx.get('connection') : undefined) || ctx.connection
      if (!conn || typeof conn.requestRejection !== 'function') return false
      const code = conn.requestRejection(req)
      if (code === undefined || code === null || code === false) return false
      res.statusCode = typeof code === 'number' ? code : 403
      res.end()
      return true
    } catch {
      return false
    }
  }

  /**
   * 注册路由。媒体类路径（音频/壁纸/渲染器脚本）由浏览器原生发起，
   * 带不上 DSH 的 cookie，因此用 MEDIA_TOKEN 校验而不是走 cookie 信任栅栏。
   */
  /* 注意：/api/nm/* 由插件界面用 fetch 调用（走 dsh-app 协议转发），不是浏览器原生媒体请求，
     不能要求 mt 媒体令牌，否则界面拿不到歌单（403 media token required）。 */
  const MEDIA_PATH_RE = /^\/(api\/audio|api\/cover|api\/wallpaper-media|api\/scene-video|api\/wallpaper-preview|api\/webwallgl\.js)$/
  function route(p, handler) {
    const media = MEDIA_PATH_RE.test(p)
    const d = webServer.register({
      kind: 'exact',
      path: BASE + p,
      handler: async (req, res) => {
        if (media) {
          let mt = ''
          try {
            mt = new URL(req.url, 'http://127.0.0.1').searchParams.get('mt') || ''
          } catch {}
          if (mt !== MEDIA_TOKEN) {
            sendJson(res, 403, { ok: false, error: 'media token required' })
            return
          }
        } else if (rejected(req, res)) return
        try {
          await handler(req, res)
        } catch (err) {
          if (!res.headersSent) sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
          else {
            try {
              res.destroy()
            } catch {}
          }
        }
      },
    })
    disposers.push(d)
  }

  /* 真实 HTTP 基址：桌面端页面跑在 dsh-app://app 下，那层协议转发会扣掉
     content-length，音频因此拿不到总长度、seekable 塌缩成"只能拖已缓冲段"。
     客户端拿到这个 origin 后改用绝对 http:// 地址播音频，绕开转发。 */
  route('/api/http-base', async (req, res) => {
    let origin = ''
    try {
      if (typeof webServer.getOrigin === 'function') origin = webServer.getOrigin()
    } catch {}
    if (!origin) {
      const host = String(req.headers.host || '')
      if (/^[A-Za-z0-9.\-:[\]]+$/.test(host)) origin = 'http://' + host
    }
    sendJson(res, 200, { ok: true, origin, mediaToken: MEDIA_TOKEN })
  })

  route('/api/config', async (req, res) => {
    const method = (req.method || 'GET').toUpperCase()
    if (method === 'GET') {
      const cfg = readConfig()
      return sendJson(res, 200, {
        ok: true,
        config: { ...cfg, cookie: '' },
        cookie: maskCookie(cfg.cookie),
        file: CONFIG_FILE,
      })
    }
    if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    const text = await readBody(req)
    let payload
    try {
      payload = text ? JSON.parse(text) : {}
    } catch {
      return sendJson(res, 400, { ok: false, error: 'invalid json' })
    }
    try {
      const saved = await writeConfig(payload && typeof payload === 'object' ? payload : {})
      return sendJson(res, 200, {
        ok: true,
        config: { ...saved, cookie: '' },
        cookie: maskCookie(saved.cookie),
      })
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
    }
  })

  /* 搜索：type=1 单曲，type=1000 歌单。返回结构按 type 区分。 */
  route('/api/search', async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    const q = (u.searchParams.get('q') || '').trim()
    const rawType = String(u.searchParams.get('type') || '1')
    const type = rawType === '1000' ? '1000' : '1'
    const limit = Math.min(Math.max(Number(u.searchParams.get('limit')) || 20, 1), 50)
    const offset = Math.max(Number(u.searchParams.get('offset')) || 0, 0)
    if (!q) return sendJson(res, 400, { ok: false, error: 'q required' })
    const cfg = readConfig()
    const headers = { 'User-Agent': UA, Referer: 'https://music.163.com/' }
    if (cfg.cookie) headers.Cookie = cfg.cookie
    const target =
      'https://music.163.com/api/cloudsearch/pc?type=' +
      type +
      '&s=' +
      encodeURIComponent(q) +
      '&limit=' +
      limit +
      '&offset=' +
      offset
    try {
      const r = await fetch(target, { headers })
      const j = await r.json()
      const result = (j && j.result) || {}
      if (type === '1000') {
        const items = (result.playlists || []).map((p) => ({
          id: p.id,
          name: String(p.name || '').slice(0, 80),
          cover: String(p.coverImgUrl || '').replace(/^http:\/\//i, 'https://'),
          creator: (p.creator && p.creator.nickname) || '',
          trackCount: Number(p.trackCount) || 0,
        }))
        return sendJson(res, 200, { ok: true, type: 'playlist', items, count: Number(result.playlistCount) || items.length })
      }
      const songs = (result.songs || []).map(songFromTrack).filter(Boolean)
      return sendJson(res, 200, { ok: true, type: 'song', songs, count: Number(result.songCount) || songs.length })
    } catch (err) {
      sendJson(res, 502, { ok: false, error: 'search failed: ' + (err && err.message) })
    }
  })

  route('/api/lyric', async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    const id = u.searchParams.get('id')
    if (!id) return sendJson(res, 400, { ok: false, error: 'id required' })
    try {
      const body = await fetchLyricMerged(id)
      sendJson(res, 200, { ok: true, id: Number(id) || id, ...body })
    } catch (err) {
      sendJson(res, 502, { ok: false, error: 'lyric failed: ' + ((err && err.message) || err) })
    }
  })

  /* 封面代理：页面跨源 + 图床验 Referer，img 不能直连。走媒体令牌通道。 */
  route('/api/cover', async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    const target = u.searchParams.get('url') || ''
    if (!target) return sendJson(res, 400, { ok: false, error: 'url required' })
    const r = await proxyCover(target, u.searchParams.get('size'))
    if (r.error) return sendJson(res, 404, { ok: false, error: r.error })
    res.writeHead(200, {
      'Content-Type': r.type,
      'Content-Length': String(r.buf.length),
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*',
    })
    res.end(r.buf)
  })

  /* ------------------------------------------------ 登录（扫码 / 本机 / 粘贴） */

  route('/api/login/qrcode/new', async (req, res) => {
    const r = await qrLoginNew()
    sendJson(res, r.ok ? 200 : 502, r)
  })

  route('/api/login/qrcode/check', async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    const key = u.searchParams.get('key') || ''
    if (!key) return sendJson(res, 400, { ok: false, error: 'key required' })
    const r = await qrLoginCheck(key)
    sendJson(res, r.ok ? 200 : 502, r)
  })

  route('/api/login/local', async (req, res) => {
    const r = await importNeteaseCookie()
    if (r.ok) {
      nmUidCache = { uid: 0, at: 0, nickname: '' }
      const acc = await nmAccount()
      return sendJson(res, 200, { ...r, nickname: acc.nickname || '', uid: acc.uid || 0 })
    }
    sendJson(res, 400, r)
  })

  route('/api/login/sms/sent', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
    let body = {}
    try { body = JSON.parse((await readBody(req)) || '{}') } catch {}
    const r = await smsCaptchaSent(body.phone)
    sendJson(res, r.ok ? 200 : 400, r)
  })

  route('/api/login/sms/verify', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
    let body = {}
    try { body = JSON.parse((await readBody(req)) || '{}') } catch {}
    const r = await smsLoginVerify(body.phone, body.captcha)
    sendJson(res, r.ok ? 200 : 400, r)
  })

  route('/api/login/out', async (req, res) => {
    await writeConfig({ cookie: '' })
    nmUidCache = { uid: 0, at: 0, nickname: '' }
    sendJson(res, 200, { ok: true })
  })

  route('/api/account', async (req, res) => {
    const r = await accountInfo()
    sendJson(res, 200, r)
  })

  /* 账号里的歌单列表（含「我喜欢的音乐」，specialType=5）。
     走媒体令牌通道：桌面端这层请求不带不上的 cookie 会被栅栏挡成空 body。 */
  route('/api/nm/playlists', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    const acc = await nmAccount()
    const uid = acc.uid || 0
    const cfg = readConfig()
    const headers = { 'User-Agent': UA, Referer: 'https://music.163.com/' }
    if (cfg.cookie) headers.Cookie = cfg.cookie
    try {
      const r = await fetch(
        'https://music.163.com/api/user/playlist?uid=' + uid + '&limit=100&offset=0',
        { headers },
      )
      const j = await r.json()
      const items = (j.playlist || [])
        .filter((p) => p && p.id)
        .map((p) => ({
          id: p.id,
          name: String(p.name || '').slice(0, 80),
          trackCount: Number(p.trackCount) || 0,
          creator: (p.creator && p.creator.nickname) || '',
          cover: String(p.coverImgUrl || '').replace(/^http:\/\//i, 'https://'),
          special: p.specialType === 5,
        }))
      return sendJson(res, 200, { ok: true, uid: uid, nickname: acc.nickname || '', guest: !acc.uid, items })
    } catch (err) {
      return sendJson(res, 502, { ok: false, error: '读取歌单失败：' + ((err && err.message) || err) })
    }
  })

  /* 某个歌单的全部歌曲。`/api/playlist/detail` 的 tracks 就是全量，不用 weapi 加密。 */
  route('/api/nm/playlist', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    const u = new URL(req.url, 'http://127.0.0.1')
    const id = String(u.searchParams.get('id') || '').trim()
    if (!/^\d{1,20}$/.test(id)) return sendJson(res, 400, { ok: false, error: '歌单 id 无效' })
    const cfg = readConfig()
    const headers = { 'User-Agent': UA, Referer: 'https://music.163.com/' }
    if (cfg.cookie) headers.Cookie = cfg.cookie
    try {
      const r = await fetch('https://music.163.com/api/playlist/detail?id=' + id, { headers })
      const j = await r.json()
      const p = (j && (j.playlist || j.result)) || null
      if (!p) return sendJson(res, 404, { ok: false, error: '歌单不存在或无权访问' })
      const songs = (p.tracks || []).map(songFromTrack).filter(Boolean)
      const cover = String(p.coverImgUrl || '')
      return sendJson(res, 200, {
        ok: true,
        id: Number(id),
        name: String(p.name || '').slice(0, 80),
        cover: cover ? cover.replace(/^http:\/\//i, 'https://') : '',
        creator: (p.creator && p.creator.nickname) || '',
        total: Number(p.trackCount) || songs.length,
        songs,
      })
    } catch (err) {
      return sendJson(res, 502, { ok: false, error: '读取歌单歌曲失败：' + ((err && err.message) || err) })
    }
  })

  /* 播放地址：直接给客户端网易云 CDN 的 https 直链。
     `<audio>` 跨域播放不需要认证/CORS，比走自家代理稳（代理会被 DSH 信任栅栏拦成 401）。
     这也是 ncm-player 的做法：拿到 url 就交给 audio 元素，不再自己转发字节。 */
  route('/api/song-url', async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    const id = u.searchParams.get('id')
    if (!id) return sendJson(res, 400, { ok: false, error: 'id required' })
    const cfg = readConfig()
    const headers = { 'User-Agent': UA, Referer: 'https://music.163.com/' }
    if (cfg.cookie) headers.Cookie = cfg.cookie

    /* 先拿 fee / privilege.code，失败时才能说清「为什么不能播」而不是一句版权受限 */
    let meta = null
    try {
      const r = await fetch('https://music.163.com/api/song/detail?ids=[' + encodeURIComponent(id) + ']', { headers })
      const j = await r.json()
      const s = (j && j.songs && j.songs[0]) || null
      if (s) {
        meta = {
          fee: Number(s.fee) || 0,
          itemCode: Number(s.privilege && s.privilege.code) || 0,
        }
      }
    } catch {}

    const url = await resolveAudioUrl(id)
    if (!url) {
      const fail = classifySongUrlFailure({
        itemCode: meta ? meta.itemCode : 0,
        fee: meta ? meta.fee : 0,
        loggedIn: Boolean(cfg.cookie),
      })
      return sendJson(res, 404, { ...fail, id: Number(id) || id })
    }

    /* 页面是 secure context，http 媒体会被当混合内容拦掉，统一升 https */
    const httpsUrl = url.replace(/^http:\/\//i, 'https://')
    /* 网易云对不可播曲目会 302 到一个 200 + HTML 的 404 页，必须验文件头 */
    let finalUrl = httpsUrl
    let probe = await probeAudioUrl(finalUrl, headers)
    if (!probe.ok) {
      for (const alt of audioHostAlternatives(finalUrl)) {
        const p = await probeAudioUrl(alt, headers)
        if (p.ok) {
          finalUrl = alt
          probe = p
          break
        }
      }
    }
    if (!probe.ok) {
      const fail = classifySongUrlFailure({
        itemCode: meta ? meta.itemCode : 0,
        fee: meta ? meta.fee : 0,
        loggedIn: Boolean(cfg.cookie),
        probe,
      })
      return sendJson(res, 404, { ...fail, id: Number(id) || id, upstream: probe })
    }
    sendJson(res, 200, { ok: true, url: finalUrl, format: probe.magic || '', upstreamStatus: probe.status })
  })

  route('/api/audio', async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    const id = u.searchParams.get('id')
    if (!id) return sendJson(res, 400, { ok: false, error: 'id required' })
    const url = await resolveAudioUrl(id)
    if (!url) {
      return sendJson(res, 404, {
        ok: false,
        error: '无法获取播放地址（可能版权受限/需要登录）。可在设置里导入网易云 Cookie 后重试。',
      })
    }
    // 同源代理：浏览器只与本机 /api/audio 打交道，不直连 163，避免 CORS 与凭据外泄
    await proxyAudio(req, res, url)
  })

  route('/api/wallpapers', async (req, res) => {
    const out = await listWallpapers()
    sendJson(res, 200, { ok: true, ...out })
  })

  route('/api/wallpaper-media', async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    const id = u.searchParams.get('id') || ''
    const m = await resolveMediaFile(id)
    if (m.error) return sendJson(res, m.code, { ok: false, error: m.error })
    sendFileRange(req, res, m.file, m.type, m.size)
  })

  /* 场景壁纸：第一次请求时从 scene.pkg 抽出内嵌 MP4 并写缓存，之后按 Range 正常出流。 */
  route('/api/scene-video', async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    const r = await resolveSceneVideo(u.searchParams.get('id') || '')
    if (r.error) return sendJson(res, r.code, { ok: false, error: r.error })
    let st
    try {
      st = statSync(r.file)
    } catch {
      return sendJson(res, 404, { ok: false, error: '缓存文件不可读' })
    }
    sendFileRange(req, res, r.file, 'video/mp4', st.size)
  })

  /* WebWallGL 场景渲染器脚本：随包分发，客户端首次用到场景壁纸时才拉。 */
  route('/api/webwallgl.js', async (req, res) => {
    let st
    try {
      st = statSync(WEBWALLGL_FILE)
    } catch {
      return sendJson(res, 404, { ok: false, error: 'webwallgl 未随包分发' })
    }
    res.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Content-Length': String(st.size),
      'Cache-Control': 'public, max-age=86400',
    })
    if (req.method === 'HEAD') return res.end()
    const s = createReadStream(WEBWALLGL_FILE)
    s.on('error', () => {
      try {
        res.destroy()
      } catch {}
    })
    s.pipe(res)
  })

  /* 场景壁纸的原始 scene.pkg：渲染器自己解析，一次拉全量。 */
  route('/api/scene-pkg', async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    const info = await resolveScenePkg(u.searchParams.get('id') || '')
    if (info.error) return sendJson(res, info.code, { ok: false, error: info.error })
    sendFileRange(req, res, info.file, 'application/octet-stream', info.size)
  })

  /* 场景壁纸的 project.json（缺失时返回 null，渲染器自行回退）。 */
  route('/api/project-json', async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    const info = await resolveScenePkg(u.searchParams.get('id') || '')
    if (info.error) return sendJson(res, info.code, { ok: false, error: info.error })
    let raw = 'null'
    try {
      raw = await fsp.readFile(path.join(info.dir, 'project.json'), 'utf8')
    } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(raw)
  })

  /* 场景壁纸预览图：渲染器加载期间的占位，渲染失败时兜底。 */
  route('/api/wallpaper-preview', async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    const m = await resolvePreviewFile(u.searchParams.get('id') || '')
    if (m.error) return sendJson(res, m.code, { ok: false, error: m.error })
    sendFileRange(req, res, m.file, m.type, m.size)
  })

  route('/api/netease-cookie', async (req, res) => {
    const method = (req.method || 'GET').toUpperCase()
    if (method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        clientCookieFile: NETease_COOKIES,
        clientCookieFound: existsSync(NETease_COOKIES),
        configured: maskCookie(readConfig().cookie),
      })
    }
    if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    const result = await importNeteaseCookie()
    sendJson(res, result.ok ? 200 : 400, result)
  })

  try {
    ctx.logger?.info?.('[' + NAME + '] routes ready: ' + BASE + '/api/{config,search,lyric,audio,wallpapers,wallpaper-media,netease-cookie}')
  } catch {}

  ctx.effect(() => () => {
    for (const d of disposers) {
      try {
        d()
      } catch {}
    }
  })
}

const inject = ['webServer', 'connection']

export { apply, inject, NAME as name }
