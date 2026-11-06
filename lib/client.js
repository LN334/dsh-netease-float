/**
 * dsh-netease-float — 浏览器半侧（v2 页面版）
 * ---------------------------------------------------------------------------
 * 手写 dsh.client bundle，无构建。三处注册：
 *   · sidebar.panellist  左栏一级入口「音乐」
 *   · main               主区域整页（正在播放 / 歌词 / 我的歌单 / 歌单详情 / 登录 / 搜索）
 *   · sidebar.right.pane.tab + .title   会话右侧栏歌词（替代原来的 shell.overlay 浮窗）
 *
 * 播放内核与数据是模块级单例（不挂在任何组件上）：主页面和右栏是两个独立
 * 渲染根，必须共享同一份 audio 与同一份队列。
 *
 * 边界：样式全部挂在 .nfm / .nfx 之下，不写 html/body，不改宿主变量。
 */
window.__ModuleLoader__.load({
  id: 'dsh-netease-float',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var ReactMod = require('react')
    var React =
      ReactMod && typeof ReactMod.createElement === 'function'
        ? ReactMod
        : ReactMod && ReactMod.default && typeof ReactMod.default.createElement === 'function'
          ? ReactMod.default
          : ReactMod
    var h = React.createElement
    if (typeof h !== 'function') {
      throw new Error('[dsh-netease-float] react module has no createElement: ' + Object.keys(ReactMod || {}).join(','))
    }
    var useState = React.useState
    var useEffect = React.useEffect
    var useRef = React.useRef
var useMemo = React.useMemo
    var useCallback = React.useCallback
    var useMemo = React.useMemo

    var BASE = '/netease-float'
    var PANEL_ID = 'dsh-netease-float'
    var STORE_KEY = 'dsh-netease-float:v2'
    var ACCENT = '#ff2b4e'

    /* ================================================================ 工具 */

    function getJson(path, opts) {
      return fetch(BASE + path, Object.assign({ credentials: 'omit' }, opts || {})).then(function (r) {
        return r.text().then(function (txt) {
          var data = null
          try {
            data = txt ? JSON.parse(txt) : null
          } catch (e) {
            data = null
          }
          if (!r.ok || !data) {
            var msg = (data && (data.error || data.hint || data.message)) || 'HTTP ' + r.status
            var err = new Error(String(msg))
            err.data = data
            err.status = r.status
            throw err
          }
          return data
        })
      })
    }

    function postJson(path, body) {
      return getJson(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
    }

    function fmtTime(sec) {
      var s = Math.max(0, Math.floor(Number(sec) || 0))
      var m = Math.floor(s / 60)
      var r = s % 60
      return m + ':' + (r < 10 ? '0' : '') + r
    }

    /* 网易云接口的 duration 是毫秒；列表/播放里统一按秒 */
    function durSec(d) {
      var n = Number(d) || 0
      if (n > 10000) n = n / 1000
      return Math.round(n)
    }

    function clamp(v, lo, hi) {
      return v < lo ? lo : v > hi ? hi : v
    }

    function cleanText(s) {
      return String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
    }

    /* ============================================================= 歌词解析 */

    var TIME_RE = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
    var OFFSET_RE = /^\s*\[offset:\s*([+-]?\d+)\s*\]\s*$/i

    /* LRC：一行可带多个时间标签；小数按位数换算（.5 = 500ms） */
    function parseLrc(text) {
      var out = []
      if (!text) return out
      var offset = 0
      String(text)
        .split(/\r?\n/)
        .forEach(function (raw) {
          if (!raw) return
          var om = OFFSET_RE.exec(raw)
          if (om) {
            offset = Number(om[1]) || 0
            return
          }
          var times = []
          var m
          TIME_RE.lastIndex = 0
          var rest = raw
          while ((m = TIME_RE.exec(raw))) {
            var min = Number(m[1]) || 0
            var sec = Number(m[2]) || 0
            var frac = m[3] ? Number('0.' + m[3]) : 0
            times.push(min * 60 + sec + frac)
            rest = raw.slice(TIME_RE.lastIndex)
          }
          if (!times.length) return
          var body = cleanText(rest)
          if (!body) return
          times.forEach(function (t) {
            out.push({ t: t, text: body, tr: '', words: null })
          })
        })
      if (offset) {
        out.forEach(function (l) {
          l.t = Math.max(0, l.t - offset / 1000)
        })
      }
      out.sort(function (a, b) {
        return a.t - b.t
      })
      return out
    }

    /* YRC：`[start,dur](t0,d0,0)字(t1,d1,0)字…` 逐字时间轴 */
    function parseYrc(text) {
      var out = []
      if (!text) return out
      var lineRe = /^\[(\d+),(\d+)\](.*)$/
      var wordRe = /\((\d+),(\d+),\d+\)([^()]*)/g
      String(text)
        .split(/\r?\n/)
        .forEach(function (rawLine) {
          var line = String(rawLine || '').trim()
          if (!line) return
          var lm = lineRe.exec(line)
          if (!lm) {
            /* 偶尔混进普通 LRC 行，退回按 LRC 收 */
            var sub = parseLrc(line)
            for (var i = 0; i < sub.length; i++) out.push(sub[i])
            return
          }
          var start = Number(lm[1]) / 1000
          var body = lm[3]
          var words = []
          var wm
          wordRe.lastIndex = 0
          while ((wm = wordRe.exec(body))) {
            var c = wm[3]
            if (c == null || c === '') continue
            words.push({ t: Number(wm[1]) / 1000, d: Number(wm[2]) / 1000, c: c })
          }
          var plain = words.length
            ? words
                .map(function (w) {
                  return w.c
                })
                .join('')
            : cleanText(body)
          if (!plain) return
          out.push({ t: start, text: cleanText(plain), tr: '', words: words.length ? words : null })
        })
      out.sort(function (a, b) {
        return a.t - b.t
      })
      return out
    }

    /* 翻译按时间戳对齐；对不上的（独立时间轴）单独追加，不丢 */
    function mergeTranslation(lines, tlrc) {
      if (!tlrc) return lines
      var tr = {}
      parseLrc(tlrc).forEach(function (l) {
        var k = Math.round(l.t * 100)
        if (!tr[k]) tr[k] = l.text
      })
      var used = {}
      var out = lines.map(function (l) {
        var k = Math.round(l.t * 100)
        if (tr[k]) {
          used[k] = true
          return Object.assign({}, l, { tr: tr[k] })
        }
        return l
      })
      Object.keys(tr).forEach(function (k) {
        if (used[k]) return
        out.push({ t: Number(k) / 100, text: '', tr: tr[k], words: null, solo: true })
      })
      out.sort(function (a, b) {
        return a.t - b.t
      })
      return out
    }

    /* 二进制搜索：最后一个 t <= pos 的下标 */
    function activeIndex(lines, pos) {
      if (!lines || !lines.length) return -1
      var lo = 0
      var hi = lines.length - 1
      var ans = -1
      while (lo <= hi) {
        var mid = (lo + hi) >> 1
        if (lines[mid].t <= pos + 0.02) {
          ans = mid
          lo = mid + 1
        } else {
          hi = mid - 1
        }
      }
      return ans
    }

    /* ============================================================ 状态中心 */

    var state = {
      ready: false,
      origin: '',
      token: '',
      bootError: '',
      view: 'now', /* now | lyrics | library | detail | login | search */
      searchFrom: 'now', /* 从哪页进的搜索，返回时回原处 */
      tab: 'now', /* 顶部 tab：now | library */
      /* 当前播放 */
      current: null,
      queue: [],
      index: -1,
      playing: false,
      position: 0,
      bufferedEnd: 0,
      duration: 0,
      volume: 0.8,
      loopMode: 'list',
      /* 歌词 */
      lyricLines: [],
      lyricActive: -1,
      lyricLoading: false,
      lyricId: 0,
      /* 数据 */
      library: { items: [], loading: false, error: '', nickname: '', uid: 0 },
      detail: { id: 0, name: '', cover: '', creator: '', total: 0, songs: [], loading: false, error: '' },
      search: { q: '', tab: 'song', items: [], playlists: [], loading: false, error: '' },
      account: { loggedIn: false, nickname: '', avatar: '', uid: 0 },
      login: { stage: 'idle', key: '', qrUrl: '', svg: '', message: '', busy: false },
      toast: '',
      settings: {
        showTranslation: true,
        wordByWord: true,
        cover: true,
        accent: '#ff2b4e',
        quality: 'exhigh',
        loopMode: 'list',
        rightLyrics: true,
        lyricSize: 'normal',
        showRoma: false,
        lyricWeight: 'normal',
        lyricSpacing: 'normal',
        fade: true,
        compact: false,
        hotkeys: true,
        barOn: true,
        barSize: 'normal',
        barHeight: 'normal',
        barControls: true,
        barFont: 'default',
      },
    }

    var subs = []

    function getState() {
      return state
    }

    function setState(patch) {
      state = Object.assign({}, state, patch)
      for (var i = 0; i < subs.length; i++) {
        try {
          subs[i]()
        } catch (e) {
          /* 单个订阅者出错不能拖垮别的 */
        }
      }
    }

    function useApp() {
      var pair = useState(0)
      var force = pair[1]
      useEffect(function () {
        var fn = function () {
          force(function (x) {
            return x + 1
          })
        }
        subs.push(fn)
        return function () {
          var i = subs.indexOf(fn)
          if (i >= 0) subs.splice(i, 1)
        }
      }, [])
      return state
    }

    var toastTimer = null
    function toast(msg) {
      setState({ toast: String(msg || '') })
      if (toastTimer) clearTimeout(toastTimer)
      toastTimer = setTimeout(function () {
        setState({ toast: '' })
        toastTimer = null
      }, 2800)
    }

    /* ============================================================ 播放内核 */

    var audio = null
    var rafId = 0
    var lastPos = -1

    function ensureAudio() {
      if (audio) return audio
      audio = new Audio()
      audio.preload = 'auto'
      /* 不设 crossOrigin：直连 CDN 播放，设了反而会被 CORS 拦 */
      audio.addEventListener('timeupdate', function () {
        var d = audio.duration
        if (isFinite(d) && d > 0 && Math.abs(d - state.duration) > 0.5) {
          setState({ duration: d })
        }
        var buf = 0
        try {
          if (audio.buffered && audio.buffered.length) buf = audio.buffered.end(audio.buffered.length - 1)
        } catch (e) {}
        var pos = audio.currentTime || 0
        /* 位置只在整 0.5s 变一次时才推，避免 timeupdate 打爆重渲染 */
        if (Math.abs(pos - lastPos) >= 0.5) {
          lastPos = pos
          setState({ position: pos, bufferedEnd: buf })
          syncLyric(pos)
          syncMediaPosition()
        }
      })
      audio.addEventListener('loadedmetadata', function () {
        var d = audio.duration
        if (isFinite(d) && d > 0) setState({ duration: d })
      })
      audio.addEventListener('play', function () {
        setState({ playing: true })
        setMediaPlaybackState('playing')
        syncMediaPosition(true)
      })
      audio.addEventListener('pause', function () {
        setState({ playing: false })
        setMediaPlaybackState('paused')
        syncMediaPosition(true)
      })
      audio.addEventListener('ended', function () {
        if (state.loopMode === 'one') {
          audio.currentTime = 0
          audio.play().catch(function () {})
          return
        }
        if (state.loopMode === 'off' && state.index >= state.queue.length - 1) {
          setState({ playing: false, position: 0 })
          return
        }
        next()
      })
      audio.addEventListener('error', function () {
        setState({ playing: false })
        toast('这首歌暂时放不了，换一首试试')
      })
      return audio
    }

    /* ============================================================ 系统媒体会话（任务栏/媒体浮层） */
    var msBound = false
    var msPosAt = 0

    function setupMediaSession() {
      if (msBound) return
      if (typeof navigator === 'undefined' || !navigator.mediaSession) return
      msBound = true
      var ms = navigator.mediaSession
      function bind(action, fn) {
        try {
          ms.setActionHandler(action, fn)
        } catch (e) {}
      }
      bind('play', function () {
        if (audio && audio.paused) togglePlay()
      })
      bind('pause', function () {
        if (audio && !audio.paused) togglePlay()
      })
      bind('nexttrack', next)
      bind('previoustrack', prev)
      bind('seekto', function (d) {
        var el = ensureAudio()
        if (d && typeof d.seekTime === 'number') {
          try {
            el.currentTime = d.seekTime
          } catch (e) {}
          setState({ position: d.seekTime })
          syncLyric(d.seekTime)
        }
      })
      bind('seekforward', function () {
        var el = ensureAudio()
        try {
          el.currentTime = Math.min((el.currentTime || 0) + 10, el.duration || 0)
        } catch (e) {}
      })
      bind('seekbackward', function () {
        var el = ensureAudio()
        try {
          el.currentTime = Math.max((el.currentTime || 0) - 10, 0)
        } catch (e) {}
      })
      bind('stop', function () {
        var el = ensureAudio()
        el.pause()
        try {
          el.currentTime = 0
        } catch (e) {}
        setState({ playing: false })
      })
    }

    function syncMediaSession(track) {
      setupMediaSession()
      if (typeof navigator === 'undefined' || !navigator.mediaSession) return
      if (!track) {
        try {
          navigator.mediaSession.metadata = null
        } catch (e) {}
        return
      }
      if (typeof MediaMetadata === 'undefined') return
      var artists = track.ar || track.artists || []
      var artist = artists
        .map(function (a) {
          return a && a.name
        })
        .filter(Boolean)
        .join(' / ')
      var album = (track.al && track.al.name) || ''
      var pic = (track.al && track.al.picUrl) || track.picUrl || ''
      if (pic) pic = pic.replace(/^http:/, 'https:')
      var artwork = pic ? [{ src: pic, sizes: '512x512' }] : []
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: track.name || '未知歌曲',
          artist: artist || '未知歌手',
          album: album,
          artwork: artwork,
        })
      } catch (e) {}
      syncMediaPosition(true)
    }

    function syncMediaPosition(force) {
      if (typeof navigator === 'undefined' || !navigator.mediaSession) return
      if (!navigator.mediaSession.setPositionState) return
      var el = audio
      if (!el || !isFinite(el.duration) || el.duration <= 0) return
      var now = Date.now()
      if (!force && now - msPosAt < 1000) return
      msPosAt = now
      var pos = el.currentTime || 0
      if (!isFinite(pos) || pos < 0) pos = 0
      if (pos > el.duration) pos = el.duration
      try {
        navigator.mediaSession.setPositionState({
          duration: el.duration,
          playbackRate: el.playbackRate || 1,
          position: pos,
        })
      } catch (e) {}
    }

    function setMediaPlaybackState(v) {
      if (typeof navigator === 'undefined' || !navigator.mediaSession) return
      try {
        navigator.mediaSession.playbackState = v
      } catch (e) {}
    }

    function syncLyric(pos) {
      var lines = state.lyricLines
      if (!lines.length) return
      var idx = activeIndex(lines, pos)
      if (idx !== state.lyricActive) setState({ lyricActive: idx })
    }

    function mediaUrl(path) {
      if (!state.origin) return BASE + path
      var sep = path.indexOf('?') >= 0 ? '&' : '?'
      return state.origin + BASE + path + (state.token ? sep + 'mt=' + encodeURIComponent(state.token) : '')
    }

    function coverUrl(url, size) {
      if (!url) return ''
      var q = '/api/cover?url=' + encodeURIComponent(url) + (size ? '&size=' + size : '')
      return mediaUrl(q)
    }

    function playAt(i) {
      var q = state.queue
      if (!q.length) return
      var idx = ((i % q.length) + q.length) % q.length
      var track = q[idx]
      if (!track || !track.id) return
      setState({ current: track, index: idx, position: 0, duration: durSec(track.duration), lyricLines: [], lyricActive: -1 })
      savePlayer()
      loadLyric(track.id)
      syncMediaSession(track)
      var el = ensureAudio()
      setState({ playing: true })
      getJson('/api/song-url?id=' + encodeURIComponent(track.id))
        .then(function (j) {
          if (!state.current || state.current.id !== track.id) return
          el.src = j.url
          startFade()
          return el.play().catch(function (err) {
            if (err && err.name === 'NotAllowedError') {
              /* 用户手势还没用上：静音起播再取消静音 */
              el.muted = true
              el.play()
                .then(function () {
                  el.muted = false
                })
                .catch(function () {})
              return
            }
            toast('这首歌暂时放不了，换一首试试')
          })
        })
        .catch(function (err) {
          if (!state.current || state.current.id !== track.id) return
          var d = err.data || {}
          setState({ playing: false })
          toast(d.hint || d.error || d.message || '无法播放')
        })
    }

    function togglePlay() {
      var el = ensureAudio()
      if (!state.current) {
        if (state.queue.length) playAt(0)
        return
      }
      /* 刷新后恢复出来的队列还没有 audio src，得先解析一次播放地址 */
      if (!el.src) {
        playAt(state.index)
        return
      }
      if (el.paused) {
        el.play().catch(function () {
          toast('播放失败')
        })
        setState({ playing: true })
      } else {
        el.pause()
        setState({ playing: false })
      }
    }

    function next() {
      if (!state.queue.length) return
      if (state.loopMode === 'one') {
        playAt(state.index)
        return
      }
      var i = state.index + 1
      if (i >= state.queue.length) i = 0
      playAt(i)
    }

    function prev() {
      if (!state.queue.length) return
      var i = state.index - 1
      if (i < 0) i = state.queue.length - 1
      playAt(i)
    }

    function seekTo(ratio) {
      var el = ensureAudio()
      var d = state.duration || (el && el.duration) || 0
      if (!d) return
      var t = clamp(ratio, 0, 1) * d
      try {
        el.currentTime = t
      } catch (e) {}
      setState({ position: t })
      syncLyric(t)
    }

    var fadeTimer = null
    function stopFade() {
      if (fadeTimer) {
        clearInterval(fadeTimer)
        fadeTimer = null
      }
    }

    /* 切歌淡入：0 → 当前音量，约 320ms；关掉时直接到位 */
    function startFade() {
      var el = ensureAudio()
      stopFade()
      var target = clamp(state.volume, 0, 1)
      if (!state.settings.fade || target <= 0) {
        el.volume = target
        return
      }
      var t0 = Date.now()
      el.volume = 0
      fadeTimer = setInterval(function () {
        var k = Math.min(1, (Date.now() - t0) / 320)
        el.volume = clamp(target * k, 0, 1)
        if (k >= 1) stopFade()
      }, 24)
    }

    function setVolume(v) {
      var vol = clamp(Number(v) || 0, 0, 1)
      setState({ volume: vol })
      stopFade()
      if (audio) audio.volume = vol
      saveConfig({ volume: vol })
      savePlayer()
    }

    function setLoopMode(mode) {
      setState({ loopMode: mode })
      saveConfig({ loopMode: mode })
      saveSettings({ loopMode: mode })
    }

    /* 设置页统一写入口：先更新界面状态，再落到 ~/.dsh/netease-float.json */
    function saveSettings(patch) {
      var next = Object.assign({}, state.settings, patch)
      setState({ settings: next })
      saveConfig(patch)
    }

    /* 刷新后队列不该凭空消失：把队列/索引/音量存在 localStorage */
    var PERSIST_KEY = 'dsh-netease-float:player'
    function savePlayer() {
      try {
        if (typeof localStorage === 'undefined') return
        localStorage.setItem(
          PERSIST_KEY,
          JSON.stringify({ queue: (state.queue || []).slice(0, 300), index: state.index, volume: state.volume }),
        )
      } catch (_) {}
    }
    function restorePlayer() {
      try {
        if (typeof localStorage === 'undefined') return
        var raw = localStorage.getItem(PERSIST_KEY)
        if (!raw) return
        var j = JSON.parse(raw)
        if (!j || !Array.isArray(j.queue) || !j.queue.length) return
        var idx = clamp(Number(j.index) || 0, 0, j.queue.length - 1)
        var cur = j.queue[idx]
        if (!cur || !cur.id) return
        setState({
          queue: j.queue,
          index: idx,
          current: cur,
          duration: durSec(cur.duration),
          position: 0,
          playing: false,
        })
        syncMediaSession(cur)
        setMediaPlaybackState('paused')
      } catch (_) {}
    }

    function enqueue(tracks, startIndex) {
      var list = (tracks || []).filter(function (t) {
        return t && t.id
      })
      if (!list.length) return
      setState({ queue: list, view: 'now', tab: 'now' })
      playAt(startIndex || 0)
    }

    /* 行内「⋯」：不打断当前播放，把一首歌排到下一首或追加到队尾 */
    function playNextTrack(track) {
      if (!track || !track.id) return
      var q = state.queue.slice()
      var exist = -1
      var curIdx = -1
      for (var i = 0; i < q.length; i++) {
        if (q[i] && q[i].id === track.id && exist < 0) exist = i
        if (q[i] && state.current && q[i].id === state.current.id && curIdx < 0) curIdx = i
      }
      if (exist >= 0) q.splice(exist, 1)
      if (curIdx >= 0) {
        var at = exist >= 0 && exist < curIdx ? curIdx - 1 : curIdx
        q.splice(Math.min(at + 1, q.length), 0, track)
        setState({ queue: q })
        toast('下一首播放：' + (track.name || ''))
      } else {
        q.unshift(track)
        setState({ queue: q })
        playAt(0)
      }
    }

    function appendToQueue(track) {
      if (!track || !track.id) return
      for (var i = 0; i < state.queue.length; i++) {
        if (state.queue[i] && state.queue[i].id === track.id) {
          toast('已经在队列里了')
          return
        }
      }
      setState({ queue: state.queue.concat([track]) })
      toast('已加到队列：' + (track.name || ''))
    }

    /* ============================================================ 数据加载 */

    var configPatchTimer = null
    var pendingConfig = {}
    function saveConfig(patch) {
      pendingConfig = Object.assign({}, pendingConfig, patch)
      if (configPatchTimer) clearTimeout(configPatchTimer)
      configPatchTimer = setTimeout(function () {
        var body = pendingConfig
        pendingConfig = {}
        configPatchTimer = null
        postJson('/api/config', body).catch(function () {})
      }, 400)
    }

    function boot() {
      if (state.ready) return
      restorePlayer()
      getJson('/api/http-base')
        .then(function (j) {
          setState({ origin: j.origin || '', token: j.mediaToken || '', ready: true })
          return Promise.all([
            getJson('/api/config').then(function (c) {
              var cfg = (c && c.config) || {}
              var next = Object.assign({}, state.settings)
              for (var k in next) {
                if (cfg[k] !== undefined && typeof cfg[k] === typeof next[k]) next[k] = cfg[k]
              }
              setState({
                volume: typeof cfg.volume === 'number' ? cfg.volume : 0.8,
                settings: next,
                loopMode: next.loopMode === 'one' || next.loopMode === 'off' ? next.loopMode : 'list',
              })
              if (audio) audio.volume = state.volume
            }),
            refreshAccount(),
          ])
        })
        .catch(function (err) {
          setState({ ready: true, bootError: String((err && err.message) || err) })
        })
    }

    function refreshAccount() {
      return getJson('/api/account')
        .then(function (j) {
          setState({
            account: {
              loggedIn: Boolean(j && j.loggedIn),
              guest: Boolean(j && j.guest),
              nickname: (j && j.nickname) || '',
              avatar: (j && j.avatar) || '',
              uid: (j && j.uid) || 0,
            },
          })
        })
        .catch(function () {})
    }

    function loadLibrary(force) {
      if (state.library.loading) return
      if (!state.account.loggedIn && !force) {
        setState({ library: Object.assign({}, state.library, { error: '', items: [] }) })
        return
      }
      setState({ library: Object.assign({}, state.library, { loading: true, error: '' }) })
      getJson('/api/nm/playlists')
        .then(function (j) {
          setState({
            library: {
              items: j.items || [],
              loading: false,
              error: '',
              nickname: j.nickname || '',
              uid: j.uid || 0,
            },
          })
        })
        .catch(function (err) {
          setState({ library: Object.assign({}, state.library, { loading: false, error: String(err.message || err) }) })
        })
    }

    function openPlaylist(id, name, cover) {
      setState({
        view: 'detail',
        tab: 'library',
        detail: { id: id, name: name || '', cover: cover || '', creator: '', total: 0, songs: [], loading: true, error: '' },
      })
      getJson('/api/nm/playlist?id=' + encodeURIComponent(id))
        .then(function (j) {
          if (state.detail.id !== id) return
          setState({
            detail: {
              id: id,
              name: j.name || name || '',
              cover: j.cover || cover || '',
              creator: j.creator || '',
              total: j.total || (j.songs || []).length,
              songs: j.songs || [],
              loading: false,
              error: '',
            },
          })
        })
        .catch(function (err) {
          if (state.detail.id !== id) return
          setState({ detail: Object.assign({}, state.detail, { loading: false, error: String(err.message || err) }) })
        })
    }

    function doSearch(q, tab) {
      var kw = cleanText(q)
      if (!kw) return
      var kind = tab === 'playlist' ? 'playlist' : 'song'
      setState({
        view: 'search',
        tab: 'now',
        searchFrom: state.view,
        search: { q: kw, tab: kind, items: [], playlists: [], loading: true, error: '' },
      })
      var url = '/api/search?q=' + encodeURIComponent(kw) + '&limit=30' + (kind === 'playlist' ? '&type=1000' : '')
      getJson(url)
        .then(function (j) {
          if (state.search.q !== kw || state.search.tab !== kind) return
          if (kind === 'playlist') {
            setState({ search: { q: kw, tab: kind, items: [], playlists: j.items || [], loading: false, error: '' } })
          } else {
            setState({ search: { q: kw, tab: kind, items: j.songs || [], playlists: [], loading: false, error: '' } })
          }
        })
        .catch(function (err) {
          if (state.search.q !== kw || state.search.tab !== kind) return
          setState({ search: { q: kw, tab: kind, items: [], playlists: [], loading: false, error: String(err.message || err) } })
        })
    }

    var lyricSeq = 0

    /* 接口字段可能是字符串，也可能是 {lyric: string} 包装 */
    function pickLrc(v) {
      if (!v) return ''
      if (typeof v === 'string') return v
      return v.lyric || ''
    }

    /* 把一条独立时间轴（音译等）按时间戳并到主歌词上；对不上的行原样保留 */
    function mergeExtra(lines, src, field) {
      var text = pickLrc(src)
      if (!text) return lines
      var map = {}
      parseLrc(text).forEach(function (l) {
        var k = Math.round(l.t * 100)
        if (!map[k]) map[k] = l.text
      })
      var any = false
      var out = lines.map(function (l) {
        var hit = map[Math.round(l.t * 100)]
        if (!hit) return l
        any = true
        var copy = Object.assign({}, l)
        copy[field] = hit
        return copy
      })
      return any ? out : lines
    }

    function loadLyric(id) {
      var seq = ++lyricSeq
      setState({ lyricLoading: true, lyricLines: [], lyricActive: -1, lyricId: id })
      getJson('/api/lyric?id=' + encodeURIComponent(id))
        .then(function (j) {
          if (seq !== lyricSeq) return
          var yrc = pickLrc(j.yrc) || pickLrc(j.lrc && j.lrc.yrc)
          var main = pickLrc(j.lrc)
          var lines = yrc ? parseYrc(yrc) : parseLrc(main)
          if (!lines.length) lines = parseLrc(main)
          var tr = pickLrc(j.tlyric) || pickLrc(j.lrc && j.lrc.tlyric)
          var roma = pickLrc(j.romalrc) || pickLrc(j.lrc && j.lrc.romalrc)
          lines = mergeTranslation(lines, tr)
          lines = mergeExtra(lines, roma, 'rm')
          setState({ lyricLines: lines, lyricLoading: false, lyricActive: activeIndex(lines, state.position) })
        })
        .catch(function () {
          if (seq !== lyricSeq) return
          setState({ lyricLines: [], lyricLoading: false })
        })
    }

    /* ============================================================== 登录 */

    var qrTimer = null

    function startQrLogin() {
      if (qrTimer) {
        clearInterval(qrTimer)
        qrTimer = null
      }
      setState({ login: { stage: 'loading', key: '', qrUrl: '', message: '正在获取二维码…', busy: true } })
      getJson('/api/login/qrcode/new')
        .then(function (j) {
          if (!j.ok) throw new Error(j.error || '获取二维码失败')
          setState({ login: { stage: 'waiting', key: j.key || '', qrUrl: j.url || '', svg: j.svg || '', message: '打开网易云音乐 App 扫码', busy: false } })
          pollQr(j.key)
        })
        .catch(function (err) {
          setState({ login: { stage: 'error', key: '', qrUrl: '', message: String(err.message || err), busy: false } })
        })
    }

    function pollQr(key) {
      var tick = 0
      qrTimer = setInterval(function () {
        tick += 1
        if (tick > 100) {
          clearInterval(qrTimer)
          qrTimer = null
          setState({ login: Object.assign({}, state.login, { stage: 'expired', message: '二维码已过期，点这里刷新' }) })
          return
        }
        getJson('/api/login/qrcode/check?key=' + encodeURIComponent(key))
          .then(function (j) {
            if (j.code === 803 || j.state === 'success') {
              clearInterval(qrTimer)
              qrTimer = null
              if (j.saved === false || !j.loggedIn) {
                setState({
                  login: {
                    stage: 'error',
                    key: '',
                    qrUrl: '',
                    svg: '',
                    message: (j.error || '登录回调到了，但没拿到登录态') + '；请点「粘贴 Cookie」手动导入',
                    busy: false,
                  },
                })
                toast('登录没拿到凭据')
                return
              }
              setState({ login: { stage: 'done', key: '', qrUrl: '', svg: '', message: '登录成功', busy: false } })
              refreshAccount()
              loadLibrary(true)
              toast('已登录网易云')
              return
            }
            if (j.code === 8821 || j.code === 8820 || j.code === 8822) {
              clearInterval(qrTimer)
              qrTimer = null
              setState({
                login: {
                  stage: 'error',
                  key: '',
                  qrUrl: '',
                  svg: '',
                  message: '网易云拒绝了扫码登录（' + j.code + '）。请改用「从本机客户端读取」或「粘贴 Cookie」',
                  busy: false,
                },
              })
              toast('扫码被网易云拒绝了')
              return
            }
            if (j.code === 802) {
              setState({ login: Object.assign({}, state.login, { stage: 'scanned', message: '已扫码，请在手机上确认' }) })
              return
            }
            if (j.code === 800) {
              clearInterval(qrTimer)
              qrTimer = null
              setState({ login: Object.assign({}, state.login, { stage: 'expired', message: '二维码已过期，点这里刷新' }) })
            }
          })
          .catch(function () {})
      }, 2000)
    }

    function stopQrLogin() {
      if (qrTimer) {
        clearInterval(qrTimer)
        qrTimer = null
      }
    }

    function importLocalCookie() {
      setState({ login: Object.assign({}, state.login, { busy: true, message: '正在从本机网易云读取…' }) })
      getJson('/api/login/local')
        .then(function (j) {
          setState({ login: { stage: 'done', key: '', qrUrl: '', svg: '', message: '已导入本机登录态', busy: false } })
          toast('已导入本机客户端的登录态')
          return getJson('/api/account').catch(function () {
            return { loggedIn: true, uid: 0, nickname: '本机客户端账号' }
          })
        })
        .then(function (acc) {
          var full = Boolean(acc && acc.loggedIn && acc.uid)
          setState({
            account: {
              loggedIn: true,
              guest: !full,
              nickname: (acc && acc.nickname) || '本机客户端账号',
              avatar: (acc && acc.avatar) || '',
              uid: (acc && acc.uid) || 0,
            },
          })
          loadLibrary(true)
        })
        .catch(function (err) {
          setState({ login: { stage: 'error', key: '', qrUrl: '', svg: '', message: String(err.message || err), busy: false } })
        })
    }

    function pasteCookie(text) {
      var raw = String(text || '').trim()
      if (!raw) return
      var m = /MUSIC_U=([^;]+)/.exec(raw)
      var csrf = /__csrf=([^;]+)/.exec(raw)
      if (!m) {
        toast('没找到 MUSIC_U，请粘贴完整 Cookie')
        return
      }
      var cookie = 'MUSIC_U=' + m[1] + (csrf ? '; __csrf=' + csrf[1] : '')
      setState({ login: Object.assign({}, state.login, { busy: true, message: '正在验证 Cookie…' }) })
      postJson('/api/config', { cookie: cookie })
        .then(function () {
          return refreshAccount()
        })
        .then(function () {
          if (!state.account.loggedIn) {
            setState({ login: Object.assign({}, state.login, { busy: false, message: 'Cookie 无效或已过期' }) })
            return
          }
          setState({ login: { stage: 'done', key: '', qrUrl: '', message: '已登录：' + (state.account.nickname || ''), busy: false } })
          loadLibrary(true)
        })
        .catch(function (err) {
          setState({ login: Object.assign({}, state.login, { busy: false, message: String(err.message || err) }) })
        })
    }

    function logout() {
      postJson('/api/login/out', {})
        .then(function () {
          setState({
            account: { loggedIn: false, nickname: '', avatar: '', uid: 0 },
            library: { items: [], loading: false, error: '', nickname: '', uid: 0 },
            login: { stage: 'idle', key: '', qrUrl: '', message: '', busy: false },
          })
          toast('已退出登录')
        })
        .catch(function () {})
    }

    /* ================================================================= CSS */

    var CSS = [
      ':root{--nfm-accent:' + ACCENT + ';}',
      '.nfm-wrap{height:100%;width:100%;display:flex;flex-direction:column;background:#fff;color:#17181a;',
      'font-family:var(--dsw-font-family-ui,system-ui,-apple-system,"Segoe UI",sans-serif);overflow:hidden;}',
      '.nfm-wrap *{box-sizing:border-box;}',
      '.nfm-top{flex:0 0 auto;display:flex;align-items:center;gap:12px;padding:14px 26px 0;}',
      '.nfx-sb{display:flex;align-items:center;gap:10px;height:32px;padding:0 14px;border-top:1px solid #eceef1;background:#fbfbfc;font-size:12px;color:#5d6169;}',
      '.nfx-sb-dot{width:6px;height:6px;border-radius:50%;background:var(--nfm-accent,#ff2b4e);flex:0 0 auto;}',
      '.nfx-sb-dot.off{background:#c9cdd4;}',
      '.nfx-sb-title{max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#17181a;font-weight:500;flex:0 0 auto;}',
      '.nfx-sb-artist{max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#9aa0a8;flex:0 0 auto;}',
      '.nfx-sb-lyric{flex:1 1 auto;min-width:0;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#3d4148;}',
      '.nfx-sb-btn{width:26px;height:26px;border:0;background:transparent;border-radius:50%;color:#3d4148;font-size:13px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;}',
      '.nfx-sb-btn:hover{background:#eceef1;}',
      '.nfx-sb-btn.on{color:var(--nfm-accent,#ff2b4e);}',
      '.nfx-sb-ctrl{display:inline-flex;align-items:center;gap:2px;flex:0 0 auto;}',
      '.nfm-back{width:28px;height:28px;border:0;background:transparent;border-radius:8px;color:#5d6169;font-size:16px;',
      'cursor:pointer;display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;}',
      '.nfm-back:hover{background:#f2f3f5;}',
      '.nfm-h1{font-size:16px;font-weight:600;letter-spacing:.2px;flex:1 1 auto;min-width:0;',
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.nfm-searchbox{display:flex;align-items:center;gap:7px;height:32px;padding:0 12px;border-radius:999px;',
      'background:#f5f6f8;border:1px solid #eceef1;width:190px;flex:0 0 auto;}',
      '.nfm-searchbox input{border:0;background:transparent;outline:0;font-size:12px;color:#17181a;width:100%;',
      'font-family:inherit;}',
      '.nfm-searchbox input::placeholder{color:#9aa0a8;}',
      '.nfm-tabs{flex:0 0 auto;display:flex;gap:22px;padding:10px 26px 0;border-bottom:1px solid #f0f1f3;}',
      '.nfm-tab{position:relative;border:0;background:transparent;font-size:13px;color:#7d838c;padding:0 0 11px;',
      'cursor:pointer;font-family:inherit;font-weight:500;}',
      '.nfm-tab:hover{color:#3d4148;}',
      '.nfm-tab.on{color:#17181a;font-weight:600;}',
      '.nfm-tab.on::after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:2px;background:' + 'var(--nfm-accent)' + ';border-radius:2px;}',
      '.nfm-body{flex:1 1 auto;min-height:0;overflow:auto;padding:22px 26px 26px;}',
      '.nfm-body::-webkit-scrollbar{width:8px;}',
      '.nfm-body::-webkit-scrollbar-thumb{background:#e3e5e9;border-radius:4px;}',

      /* ---- 正在播放 ---- */
      '.nfm-now{display:flex;flex-direction:column;height:100%;}',
      '.nfm-hero{display:flex;gap:22px;align-items:flex-start;}',
      '.nfm-cover{width:186px;height:186px;border-radius:12px;flex:0 0 auto;overflow:hidden;background:#f1f2f4;',
      'box-shadow:0 10px 26px rgba(23,24,26,.14);position:relative;}',
      '.nfm-cover img{width:100%;height:100%;object-fit:cover;display:block;}',
      '.nfm-cover .ph{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;',
      'font-size:34px;color:#c9cdd4;}',
      '.nfm-meta{flex:1 1 auto;min-width:0;padding-top:4px;}',
      '.nfm-title{font-size:28px;font-weight:700;letter-spacing:-.4px;line-height:1.25;margin:0 0 8px;',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.nfm-sub{font-size:13px;color:#8a9099;line-height:1.6;}',
      '.nfm-prog{margin-top:18px;display:flex;flex-direction:column;gap:6px;}',
      '.nfm-bar{position:relative;height:4px;border-radius:2px;background:#eceef1;cursor:pointer;}',
      '.nfm-bar:hover{height:5px;}',
      '.nfm-bar-buf{position:absolute;left:0;top:0;bottom:0;background:#e2e5ea;border-radius:2px;}',
      '.nfm-bar-fill{position:absolute;left:0;top:0;bottom:0;background:var(--nfm-accent);border-radius:2px;}',
      '.nfm-time{display:flex;justify-content:space-between;font-size:11px;color:#9aa0a8;font-variant-numeric:tabular-nums;}',
      '.nfm-ctrl{display:flex;align-items:center;gap:14px;margin-top:4px;}',
      '.nfm-btn{width:34px;height:34px;border:0;background:transparent;border-radius:50%;color:#3d4148;cursor:pointer;',
      'display:inline-flex;align-items:center;justify-content:center;font-size:15px;padding:0;}',
      '.nfm-btn:hover{background:#f2f3f5;color:#17181a;}',
      '.nfm-btn.on{color:' + 'var(--nfm-accent)' + ';}',
      '.nfm-play{width:46px;height:46px;background:#17181a;color:#fff;font-size:17px;}',
      '.nfm-play:hover{background:#000;color:#fff;}',
      '.nfm-vol{display:flex;align-items:center;gap:9px;margin-left:auto;}',
      '.nfm-vol input{width:84px;accent-color:' + 'var(--nfm-accent)' + ';}',

      /* ---- 歌词（页面内） ---- */
      '.nfm-lyrs{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;justify-content:center;',
      'align-items:center;gap:3px;padding:22px 0 8px;text-align:center;overflow:hidden;}',
      '.nfm-lyrow{font-size:var(--nfm-lysize,14px);line-height:calc(var(--nfm-lysize,14px) * var(--nfm-lygap,2.1));color:#b9bec6;font-weight:var(--nfm-lyweight,400);transition:color .18s ease,font-size .18s ease;',
      'max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.nfm-lyrow.on{font-size:calc(var(--nfm-lysize,14px) * 1.6);font-weight:700;line-height:calc(var(--nfm-lysize,14px) * 2.6);color:#17181a;}',
      '.nfm-lyrow .tr{display:block;font-size:12px;font-weight:400;line-height:21px;color:#a2a8b0;}',
      '.nfm-lyrow .tr.rm{font-size:11px;color:#b0b6be;}',
      '.nfm-lyrow.on .tr{font-size:13px;}',
      '.nfm-lyrow .w{color:#17181a;}',
      '.nfm-lyrow .rest{color:#b9bec6;}',
      '.nfm-lyempty{font-size:13px;color:#9aa0a8;padding:20px 0;}',

      /* ---- 大歌词页 ---- */
      '.nfm-lystage{flex:1 1 auto;min-height:0;overflow:hidden;display:flex;flex-direction:column;',
      'justify-content:center;align-items:center;gap:4px;text-align:center;padding:10px 0;}',
      '.nfm-lybig{font-size:15px;line-height:34px;color:#c2c7ce;}',
      '.nfm-lybig.on{font-size:26px;font-weight:700;line-height:42px;color:#17181a;}',
      '.nfm-lybig .tr{display:block;font-size:13px;font-weight:400;line-height:24px;color:#a2a8b0;}',

      /* ---- 歌单网格 ---- */
      '.nfm-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:22px 20px;}',
      '@media (max-width:1180px){.nfm-grid{grid-template-columns:repeat(4,1fr);}}',
      '@media (max-width:900px){.nfm-grid{grid-template-columns:repeat(3,1fr);}}',
      '.nfm-card{cursor:pointer;min-width:0;}',
      '.nfm-card:hover .nfm-cardart{transform:translateY(-2px);box-shadow:0 12px 26px rgba(23,24,26,.16);}',
      '.nfm-cardart{position:relative;aspect-ratio:1/1;border-radius:12px;overflow:hidden;background:#f1f2f4;',
      'transition:transform .18s ease,box-shadow .18s ease;box-shadow:0 6px 16px rgba(23,24,26,.10);}',
      '.nfm-cardart img{width:100%;height:100%;object-fit:cover;display:block;}',
      '.nfm-cardart .cnt{position:absolute;top:8px;right:8px;padding:2px 7px;border-radius:999px;',
      'background:rgba(0,0,0,.45);color:#fff;font-size:10px;font-weight:500;}',
      '.nfm-cardart .heart{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;',
      'font-size:40px;color:#fff;text-shadow:0 2px 10px rgba(0,0,0,.25);}',
      '.nfm-cardname{margin-top:9px;font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.nfm-cardsub{margin-top:2px;font-size:11px;color:#9aa0a8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',

      /* ---- 曲目列表 ---- */
      '.nfm-tlist{display:block;}',
      '.nfm-morewrap{display:flex;justify-content:center;padding:12px 0 4px;}',
      '.nfm-list{width:100%;border-collapse:collapse;table-layout:fixed;}',
      '.nfm-list th{font-size:11px;color:#9aa0a8;font-weight:500;text-align:left;padding:0 10px 8px;',
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.nfm-list td{padding:9px 10px;font-size:13px;border-bottom:1px solid #f4f5f7;',
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.nfm-list tr.row{cursor:pointer;}',
      '.nfm-list tr.row:hover td{background:#fafbfc;}',
      '.nfm-list tr.cur td{background:#fff2f4;}',
      '.nfm-list tr.cur .tt{color:' + 'var(--nfm-accent)' + ';font-weight:600;}',
      '.nfm-compact .nfm-list th{padding-bottom:5px;}',
      '.nfm-compact .nfm-list td{padding:4px 10px;font-size:12px;}',
      '.nfm-idx{color:#b0b5bd;font-variant-numeric:tabular-nums;width:34px;}',
      '.nfm-tt{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:340px;}',
      '.nfm-muted{color:#8a9099;}',
      '.nfm-dur{text-align:right;color:#9aa0a8;font-variant-numeric:tabular-nums;}',
      '.nfm-more{position:relative;width:36px;text-align:right;overflow:visible!important;}',
      '.nfm-rowmore{width:26px;height:26px;border:0;background:transparent;border-radius:7px;color:#9aa0a8;',
      'font-size:16px;line-height:1;cursor:pointer;opacity:0;transition:opacity .12s ease;}',
      '.nfm-list tr:hover .nfm-rowmore,.nfm-rowmore.on{opacity:1;}',
      '.nfm-rowmore:hover{background:#f2f3f5;color:#17181a;}',
      '.nfm-menu{position:absolute;right:0;top:100%;z-index:30;min-width:132px;background:#fff;',
      'border:1px solid #ebedf0;border-radius:10px;box-shadow:0 10px 26px rgba(20,24,30,.14);padding:4px;}',
      '.nfm-menuitem{display:block;width:100%;text-align:left;border:0;background:transparent;padding:7px 10px;',
      'border-radius:7px;font-size:12.5px;color:#333;cursor:pointer;}',
      '.nfm-menuitem:hover{background:#f4f5f7;}',

      /* ---- 歌单详情头 ---- */
      '.nfm-dhead{display:flex;gap:20px;align-items:flex-end;margin-bottom:22px;}',
      '.nfm-dcover{width:158px;height:158px;border-radius:12px;overflow:hidden;background:#f1f2f4;flex:0 0 auto;',
      'box-shadow:0 10px 24px rgba(23,24,26,.14);}',
      '.nfm-dcover img{width:100%;height:100%;object-fit:cover;display:block;}',
      '.nfm-dmeta{min-width:0;padding-bottom:4px;}',
      '.nfm-dname{font-size:24px;font-weight:700;margin:0 0 8px;letter-spacing:-.3px;}',
      '.nfm-dsub{font-size:12px;color:#8a9099;margin-bottom:14px;}',
      '.nfm-actions{display:flex;gap:10px;}',
      '.nfm-primary{height:34px;padding:0 18px;border-radius:999px;border:0;background:#17181a;color:#fff;',
      'font-size:12.5px;font-weight:500;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:6px;}',
      '.nfm-primary:hover{background:#000;}',
      '.nfm-ghost{height:34px;padding:0 16px;border-radius:999px;border:1px solid #e4e6ea;background:#fff;',
      'color:#3d4148;font-size:12.5px;cursor:pointer;font-family:inherit;}',
      '.nfm-ghost:hover{background:#f7f8fa;}',

      /* ---- 登录 ---- */
      '.nfm-login{flex:1 1 auto;display:flex;align-items:center;justify-content:center;',
      'background:radial-gradient(680px 420px at 24% 12%,rgba(255,77,126,.10),transparent 62%),',
      'radial-gradient(620px 400px at 82% 86%,rgba(111,91,255,.10),transparent 62%);}',
      '.nfm-lcard{width:380px;background:#fff;border:1px solid #eef0f3;border-radius:18px;padding:26px 26px 22px;',
      'box-shadow:0 20px 56px rgba(23,24,26,.12);text-align:center;}',
      '.nfm-ltitle{font-size:16px;font-weight:600;margin:0 0 6px;}',
      '.nfm-lsub{font-size:12px;color:#8a9099;margin-bottom:18px;}',
      '.nfm-qr{width:168px;height:168px;margin:0 auto 14px;border:1px solid #eef0f3;border-radius:12px;',
      'display:flex;align-items:center;justify-content:center;overflow:hidden;background:#fff;}',
      '.nfm-qr img{width:146px;height:146px;display:block;}',
      '.nfm-qr svg{width:146px;height:146px;display:block;}',
      '.nfm-qr .ph{font-size:12px;color:#b0b5bd;}',
      '.nfm-hint{font-size:12px;color:#8a9099;line-height:1.7;}',
      '.nfm-state{font-size:12px;color:' + 'var(--nfm-accent)' + ';margin-top:4px;cursor:pointer;}',
      '.nfm-alt{display:flex;gap:10px;justify-content:center;margin-top:16px;}',
      '.nfm-note{margin-top:14px;font-size:11px;color:#a9aeb6;line-height:1.7;}',
      '.nfm-pastearea{width:100%;height:64px;margin-top:10px;border:1px solid #eef0f3;border-radius:10px;',
      'padding:8px 10px;font-size:11px;color:#3d4148;resize:none;font-family:ui-monospace,monospace;outline:0;}',
      '.nfm-pastearea:focus{border-color:#d9dce1;}',

      /* ---- 空状态 / toast ---- */
      '.nfm-empty{padding:60px 0;text-align:center;color:#9aa0a8;font-size:13px;line-height:1.9;}',
      '.nfm-empty .big{font-size:30px;color:#d3d7dd;display:block;margin-bottom:8px;}',
      '.nfm-toast{position:fixed;left:50%;bottom:36px;transform:translateX(-50%);background:rgba(23,24,26,.9);',
      'color:#fff;font-size:12.5px;padding:9px 16px;border-radius:10px;z-index:9999;pointer-events:none;',
      'box-shadow:0 10px 30px rgba(0,0,0,.22);}',

      /* ---- 左栏入口图标 ---- */
      '.nfx-ico{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;',
      'font-size:14px;line-height:1;}',

      /* ---- 右侧栏歌词 ---- */
      '.nfx-bar{height:100%;display:flex;flex-direction:column;background:#fbfbfc;border-left:1px solid #f0f1f3;',
      'font-family:var(--dsw-font-family-ui,system-ui,-apple-system,"Segoe UI",sans-serif);overflow:hidden;}',
      '.nfx-head{padding:14px 14px 8px;border-bottom:1px solid #f2f3f5;flex:0 0 auto;}',
      '.nfx-live{display:flex;align-items:center;gap:6px;font-size:10.5px;color:#9aa0a8;margin-bottom:7px;}',
      '.nfx-dot{width:6px;height:6px;border-radius:50%;background:' + 'var(--nfm-accent)' + ';}',
      '.nfx-dot.off{background:#c9cdd4;}',
      '.nfx-song{font-size:13px;font-weight:600;color:#17181a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.nfx-artist{font-size:11px;color:#8a9099;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.nfx-rows{flex:1 1 auto;min-height:0;overflow:hidden;padding:8px 12px 0;display:flex;flex-direction:column;',
      'gap:3px;justify-content:flex-start;}',
      '.nfx-row{font-size:12px;line-height:28px;color:#c3c6cb;white-space:nowrap;overflow:hidden;',
      'text-overflow:ellipsis;transition:color .18s ease,font-size .18s ease;flex:0 0 auto;}',
      '.nfx-row.on{font-size:15.5px;font-weight:600;line-height:34px;color:#17181a;}',
      '.nfx-row .tr{display:block;font-size:10.5px;line-height:17px;color:#a9aeb6;font-weight:400;}',
      '.nfx-foot{flex:0 0 auto;padding:10px 14px 12px;border-top:1px solid #f2f3f5;}',
      '.nfx-bar2{height:3px;border-radius:2px;background:#eceef1;position:relative;cursor:pointer;}',
      '.nfx-fill{position:absolute;left:0;top:0;bottom:0;background:var(--nfm-accent);border-radius:2px;}',
      '.nfx-time{display:flex;justify-content:space-between;font-size:10px;color:#a9aeb6;margin-top:5px;',
      'font-variant-numeric:tabular-nums;}',
      '.nfx-ctrl{display:flex;align-items:center;justify-content:center;gap:16px;margin-top:6px;}',
      '.nfx-btn{width:28px;height:28px;border:0;background:transparent;color:#5d6169;border-radius:50%;',
      'cursor:pointer;font-size:13px;display:inline-flex;align-items:center;justify-content:center;padding:0;}',
      '.nfx-btn:hover{background:#f0f1f3;color:#17181a;}',
      '.nfx-play{width:34px;height:34px;background:#17181a;color:#fff;font-size:14px;}',
      '.nfx-play:hover{background:#000;color:#fff;}',
      '.nfx-dock{display:inline-flex;align-items:center;gap:8px;height:28px;max-width:620px;padding:0 10px;',
      'border-radius:999px;background:#f6f7f9;font-size:12px;color:#5d6169;overflow:hidden;}',
      '.nfx-dock-idle{color:#9aa0a8;cursor:default;}',
      '.nfx-dock-dot{width:6px;height:6px;border-radius:50%;background:var(--nfm-accent,#ff2b4e);flex:0 0 auto;}',
      '.nfx-dock-dot.off{background:#c9cdd4;}',
      '.nfx-dock-title{max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#17181a;font-weight:500;}',
      '.nfx-dock-lyric{max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#8a9099;}',
      '.nfx-dock-btn{width:24px;height:24px;border:0;background:transparent;border-radius:50%;color:#3d4148;',
      'cursor:pointer;font-size:12px;display:inline-flex;align-items:center;justify-content:center;padding:0;}',
      '.nfx-dock-btn:hover{background:#eceef1;}',
      '.nfx-dock-play{color:var(--nfm-accent,#ff2b4e);}',
      '.nfx-empty{padding:22px 14px;font-size:11.5px;color:#a9aeb6;text-align:center;line-height:1.8;}',

      /* ---- 设置页 ---- */
      '.nfm-set{height:100%;width:100%;overflow:auto;background:#fff;color:#17181a;',
      'font-family:var(--dsw-font-family-ui,system-ui,-apple-system,"Segoe UI",sans-serif);}',
      '.nfm-set *{box-sizing:border-box;}',
      '.nfm-set-host{background:transparent;padding:2px 0 18px;}',
      '.nfm-setbody{display:flex;flex-direction:column;gap:16px;}',
      '.nfm-setgroup{background:#fff;border:1px solid #eceef1;border-radius:14px;padding:2px 18px 6px;}',
      '.nfm-set-host .nfm-setgroup{box-shadow:0 1px 2px rgba(23,24,26,.03);}',
      '.nfm-setgtitle{font-size:12px;font-weight:600;color:#8a9099;letter-spacing:.3px;padding:12px 0 2px;}',
      '.nfm-setrow{display:flex;align-items:center;gap:16px;padding:12px 0;border-top:1px solid #f4f5f7;}',
      '.nfm-setrow:first-of-type{border-top:0;}',
      '.nfm-setlabel{font-size:13px;color:#17181a;flex:1 1 auto;min-width:0;line-height:1.5;}',
      '.nfm-sethint{display:block;font-size:11.5px;color:#9aa0a8;margin-top:3px;line-height:1.5;}',
      '.nfm-setside{margin-left:auto;flex:0 0 auto;display:flex;align-items:center;gap:8px;}',
      '.nfm-seg{display:inline-flex;background:#f4f5f7;border-radius:9px;padding:2px;gap:2px;}',
      '.nfm-segbtn{border:0;background:transparent;border-radius:7px;padding:5px 11px;font-size:12px;',
      'color:#6b7079;cursor:pointer;font-family:inherit;line-height:1.4;transition:background .15s,color .15s;}',
      '.nfm-segbtn:hover{color:#17181a;}',
      '.nfm-segbtn.on{background:#fff;color:#17181a;font-weight:600;box-shadow:0 1px 3px rgba(23,24,26,.10);}',
      '.nfm-toggle{width:38px;height:22px;border-radius:999px;border:0;background:#e3e5e9;padding:2px;',
      'cursor:pointer;position:relative;transition:background .18s;flex:0 0 auto;}',
      '.nfm-toggle.on{background:var(--nfm-accent);}',
      '.nfm-toggle-dot{display:block;width:18px;height:18px;border-radius:50%;background:#fff;',
      'box-shadow:0 1px 3px rgba(0,0,0,.16);transition:transform .18s;}',
      '.nfm-toggle.on .nfm-toggle-dot{transform:translateX(16px);}',
      '.nfm-swatches{display:flex;gap:8px;}',
      '.nfm-swatch{width:22px;height:22px;border-radius:50%;border:0;cursor:pointer;padding:0;',
      'box-shadow:0 0 0 2px #fff,0 0 0 3px transparent;transition:box-shadow .15s;}',
      '.nfm-swatch.on{box-shadow:0 0 0 2px #fff,0 0 0 4px #17181a;}',
      '.nfm-range{width:130px;accent-color:var(--nfm-accent);}',
      '.nfm-setinline{display:flex;align-items:center;gap:10px;}',
      '.nfm-val{font-size:12px;color:#8a9099;min-width:38px;text-align:right;font-variant-numeric:tabular-nums;}',
      '.nfm-setfoot{display:flex;align-items:center;gap:12px;padding:2px 4px;color:#9aa0a8;font-size:11.5px;}',
      '.nfm-setfoot .nfm-note{margin:0;flex:1 1 auto;}',
      '.nfm-acct{display:flex;align-items:center;gap:12px;padding:8px 0 10px;}',
      '.nfm-acctava{width:44px;height:44px;border-radius:50%;object-fit:cover;flex:0 0 auto;background:#f1f2f4;}',
      '.nfm-acctava-ph{display:inline-flex;align-items:center;justify-content:center;font-size:18px;color:#b0b5bd;}',
      '.nfm-acctmeta{flex:1 1 auto;min-width:0;}',
      '.nfm-acctname{font-size:14px;font-weight:600;color:#17181a;}',
      '.nfm-acctsub{font-size:11.5px;color:#9aa0a8;margin-top:3px;}',
      '.nfm-acctbtns{display:flex;gap:8px;flex:0 0 auto;}',
      '.nfm-loginbox{display:grid;grid-template-columns:164px minmax(0,1fr);gap:16px;align-items:start;',
      'padding:14px 16px;border:1px solid #eef0f3;border-radius:12px;background:#fbfcfd;}',
      '.nfm-loginbox .nfm-qr{width:144px;height:144px;margin:0;border:1px solid #e8eaee;border-radius:12px;',
      'background:#fff;display:flex;align-items:center;justify-content:center;flex:0 0 auto;}',
      '.nfm-loginbox .nfm-qr svg{width:122px;height:122px;display:block;}',
      '.nfm-qrph{font-size:12px;color:#b0b5bd;text-align:center;line-height:1.7;padding:0 8px;}',
      '.nfm-loginmain{display:flex;flex-direction:column;gap:10px;min-width:0;}',
      '.nfm-logintitle{font-size:14px;font-weight:600;color:#17181a;}',
      '.nfm-loginstatus{font-size:12px;color:#8a9099;line-height:1.5;min-height:18px;margin-top:-2px;}',
      '.nfm-loginstatus.err{color:#d64545;}',
      '.nfm-loginstatus.ok{color:#0a8f5b;}',
      '.nfm-modeseg{display:flex;gap:2px;background:#f1f2f4;border-radius:9px;padding:3px;}',
      '.nfm-modeseg button{flex:1 1 0;height:28px;border:0;background:transparent;border-radius:7px;',
      'font-size:12px;color:#6b7079;cursor:pointer;font-family:inherit;line-height:1;transition:background .15s,color .15s;}',
      '.nfm-modeseg button:hover{color:#17181a;}',
      '.nfm-modeseg button.on{background:#fff;color:#17181a;font-weight:600;box-shadow:0 1px 2px rgba(23,24,26,.10);}',
      '.nfm-loginacts{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.nfm-loginacts .nfm-primary,.nfm-loginacts .nfm-ghost{height:34px;}',
      '.nfm-smsform{display:flex;flex-direction:column;gap:8px;}',
      '.nfm-smsrow{display:flex;gap:8px;align-items:center;}',
      '.nfm-input{flex:1 1 auto;min-width:0;height:34px;padding:0 11px;border:1px solid #e6e8ec;border-radius:9px;',
      'background:#fff;font-size:12.5px;color:#17181a;font-family:inherit;outline:none;box-sizing:border-box;}',
      '.nfm-input:focus{border-color:var(--nfm-accent);}',
      '.nfm-smsbtn{flex:0 0 100px;height:34px;padding:0;}',
      '.nfm-smsactions{display:flex;align-items:center;gap:10px;}',
      '.nfm-smsactions .nfm-primary{height:34px;padding:0 22px;}',
      '.nfm-smserr{font-size:11.5px;color:#d64545;line-height:1.4;}',
      '.nfm-smsnote{font-size:11px;color:#9aa0a8;}',
      '.nfm-loginpaste{display:flex;flex-direction:column;gap:8px;}',
      '.nfm-loginpaste .nfm-pastearea{height:62px;margin:0;box-sizing:border-box;}',
      '.nfm-pastefoot{display:flex;align-items:center;gap:10px;}',
      '.nfm-pastefoot .nfm-note{margin:0;flex:1 1 auto;}',
      '.nfm-loginnote{font-size:11px;color:#9aa0a8;margin:0;}',
      '.nfm-smsnote{font-size:11px;color:#9aa0a8;}',
      '.nfm-gear{width:30px;height:30px;border:0;background:transparent;border-radius:8px;flex:0 0 auto;',
      'color:#5d6169;font-size:15px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;}',
      '.nfm-gear:hover{background:#f2f3f5;color:#17181a;}',
      '.nfm-gear.on{color:var(--nfm-accent);}',

      /* ---- 播放页 v2 ---- */
      '.nfm-hero{gap:26px;align-items:center;}',
      '.nfm-cover{width:216px;height:216px;border-radius:14px;}',
      '.nfm-meta{padding-top:0;}',
      '.nfm-eyebrow{font-size:10.5px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:#a9aeb6;margin-bottom:10px;}',
      '.nfm-title{font-size:26px;margin-bottom:9px;}',
      '.nfm-prog{margin-top:22px;gap:7px;}',
      '.nfm-bar{height:5px;background:#eef0f3;}',
      '.nfm-bar-buf{background:#e6e9ee;}',
      '.nfm-bar-dot{position:absolute;top:50%;width:11px;height:11px;margin:-5.5px 0 0 -5.5px;border-radius:50%;',
      'background:#fff;border:2px solid var(--nfm-accent);box-shadow:0 1px 4px rgba(0,0,0,.16);pointer-events:none;',
      'opacity:0;transition:opacity .14s ease;}',
      '.nfm-prog:hover .nfm-bar-dot{opacity:1;}',
      '.nfm-ctrl{margin-top:16px;gap:10px;}',
      '.nfm-play{width:48px;height:48px;font-size:16px;box-shadow:0 8px 18px rgba(23,24,26,.16);}',
      '.nfm-lyrs{padding:16px 0 8px;}',
      '.nfm-kbd{display:flex;align-items:center;gap:6px;margin-top:16px;font-size:11px;color:#a9aeb6;}',
      '.nfm-kbd b{display:inline-block;padding:1px 6px;border:1px solid #e6e8ec;border-radius:5px;background:#fafbfc;',
      'font-weight:500;color:#6b7079;font-size:10.5px;}',
      '.nfm-queue{margin-top:14px;border:1px solid #f0f1f3;border-radius:14px;padding:12px 10px 4px;',
      'max-height:34vh;overflow:auto;flex:0 0 auto;}',
      '.nfm-queue::-webkit-scrollbar{width:8px;}',
      '.nfm-queue::-webkit-scrollbar-thumb{background:#e3e5e9;border-radius:4px;}',
      '.nfm-queue-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;padding:0 8px 10px;}',
      '.nfm-queue-title{font-size:12px;font-weight:600;color:#3d4148;}',
      '.nfm-queue-sub{font-size:11px;color:#9aa0a8;}',
      '.nfm-queue .nfm-list th{position:sticky;top:0;background:#fff;z-index:1;}',
      '.nfm-queue .nfm-list tr:last-child td{border-bottom:0;}',
      '.nfm-now .nfm-lyempty{padding:10px 0;}',
    ]

    var styleEl = null
    function injectStyle() {
      if (styleEl || typeof document === 'undefined') return
      styleEl = document.createElement('style')
      styleEl.setAttribute('data-dsh-netease-float', 'v2')
      styleEl.textContent = CSS.join('\n')
      document.head.appendChild(styleEl)
    }

    /* ================================================================ 组件 */

    var LYRIC_SIZE_PX = { small: '12px', normal: '14px', large: '17px', xlarge: '20px' }
    var LYRIC_GAP = { tight: '1.9', normal: '2.4', loose: '2.9' }

    /* 主题变量只在插件自己的根节点上设，不写 html/body，不碰宿主变量 */
    function themeVars(st) {
      var s = st.settings
      return {
        '--nfm-accent': s.accent || ACCENT,
        '--nfm-lysize': LYRIC_SIZE_PX[s.lyricSize] || '14px',
        '--nfm-lyweight': s.lyricWeight === 'bold' ? '700' : '400',
        '--nfm-lygap': LYRIC_GAP[s.lyricSpacing] || '2.4',
      }
    }

    function Icon(props) {
      return h('span', { className: 'nfx-ico', 'aria-hidden': 'true' }, props.children || '♫')
    }

    function ProgressBar(props) {
      var barRef = useRef(null)
      function onPointer(e) {
        var el = barRef.current
        if (!el) return
        var rect = el.getBoundingClientRect()
        if (!rect.width) return
        props.onSeek(clamp((e.clientX - rect.left) / rect.width, 0, 1))
      }
      var d = props.duration || 0
      var p = d ? clamp(props.position / d, 0, 1) : 0
      var b = d ? clamp(props.buffered / d, 0, 1) : 0
      return h(
        'div',
        { className: 'nfm-prog' },
        h(
          'div',
          {
            className: 'nfm-bar',
            ref: barRef,
            onPointerDown: function (e) {
              e.currentTarget.setPointerCapture(e.pointerId)
              onPointer(e)
            },
            onPointerMove: function (e) {
              if (e.currentTarget.hasPointerCapture && e.currentTarget.hasPointerCapture(e.pointerId)) onPointer(e)
            },
          },
          h('div', { className: 'nfm-bar-buf', style: { width: (b * 100).toFixed(2) + '%' } }),
          h('div', { className: 'nfm-bar-fill', style: { width: (p * 100).toFixed(2) + '%' } }),
          h('div', { className: 'nfm-bar-dot', style: { left: (p * 100).toFixed(2) + '%' } }),
        ),
        h('div', { className: 'nfm-time' }, h('span', null, fmtTime(props.position)), h('span', null, fmtTime(d))),
      )
    }

    function Controls(props) {
      var st = props.state
      return h(
        'div',
        { className: 'nfm-ctrl' },
        h(
          'button',
          {
            className: 'nfm-btn' + (st.loopMode === 'one' ? ' on' : ''),
            title: st.loopMode === 'one' ? '单曲循环' : st.loopMode === 'off' ? '不循环' : '列表循环',
            onClick: function () {
              var m = st.loopMode === 'list' ? 'one' : st.loopMode === 'one' ? 'off' : 'list'
              setLoopMode(m)
            },
          },
          st.loopMode === 'one' ? '↻¹' : st.loopMode === 'off' ? '⇥' : '↻',
        ),
        h('button', { className: 'nfm-btn', title: '上一首', onClick: prev }, '⏮'),
        h(
          'button',
          { className: 'nfm-play', title: st.playing ? '暂停' : '播放', onClick: togglePlay },
          st.playing ? '⏸' : '▶',
        ),
        h('button', { className: 'nfm-btn', title: '下一首', onClick: next }, '⏭'),
        h(
          'div',
          { className: 'nfm-vol' },
          h('span', { style: { fontSize: '13px', color: '#8a9099' } }, '🔊'),
          h('input', {
            type: 'range',
            min: '0',
            max: '1',
            step: '0.01',
            value: String(st.volume),
            onChange: function (e) {
              setVolume(e.target.value)
            },
          }),
        ),
      )
    }

    function LyricLines(props) {
      var lines = props.lines
      var active = props.active
      var count = props.count || 7
      var showTr = props.showTr
      if (!lines.length) {
        return h('div', { className: 'nfm-lyempty' }, props.emptyText || '暂无歌词')
      }
      var half = Math.floor(count / 2)
      var start = Math.max(0, active < 0 ? 0 : active - half)
      var end = Math.min(lines.length, start + count)
      start = Math.max(0, end - count)
      var out = []
      for (var i = start; i < end; i++) {
        var l = lines[i]
        var isOn = i === active
        out.push(
          h(
            'div',
            { key: i, className: 'nfm-lyrow' + (isOn ? ' on' : '') },
            l.words && isOn && props.wordByWord ? renderWords(l, props.position) : l.text || ' ',
            props.showRoma && l.rm ? h('span', { className: 'tr rm' }, l.rm) : null,
            showTr && l.tr ? h('span', { className: 'tr' }, l.tr) : null,
          ),
        )
      }
      return out
    }

    /* 逐字：已唱的字用深色，没唱的浅色（yrc 独有） */
    function renderWords(line, position) {
      var words = line.words || []
      var out = []
      var sung = ''
      var rest = ''
      for (var i = 0; i < words.length; i++) {
        var w = words[i]
        if (position >= w.t + w.d * 0.35) sung += w.c
        else rest += w.c
      }
      if (sung) out.push(h('span', { key: 's', className: 'w' }, sung))
      if (rest) out.push(h('span', { key: 'r', className: 'rest' }, rest))
      return out
    }

    function TrackList(props) {
      var rows = props.items || []
      var current = props.current
      var menuPair = useState(null)
      var limitPair = useState(120)
      var limit = limitPair[0]
      var setLimit = limitPair[1]
      var menu = menuPair[0]
      var setMenu = menuPair[1]
      useEffect(
        function () {
          if (!menu) return undefined
          var close = function () {
            setMenu(null)
          }
          document.addEventListener('click', close)
          return function () {
            document.removeEventListener('click', close)
          }
        },
        [menu],
      )
      var list = rows.slice(0, limit)
      var shownLen = Math.min(limit, rows.length)
      var body = useMemo(
        function () {
          return list.map(function (t, i) {
              var isCur = current && current.id === t.id
              return h(
                'tr',
                {
                  key: (t.id || 'x') + ':' + i,
                  className: 'row' + (isCur ? ' cur' : ''),
                  onClick: function () {
                    enqueue(rows, i)
                  },
                },
                h('td', { className: 'nfm-idx' }, isCur ? '♪' : String(i + 1)),
                h('td', { className: 'nfm-tt' }, t.name || ''),
                h('td', { className: 'nfm-muted', title: t.artist || '' }, t.artist || ''),
                h('td', { className: 'nfm-muted', title: t.album || '' }, t.album || ''),
                h('td', { className: 'nfm-dur' }, fmtTime(durSec(t.duration))),
                h(
                  'td',
                  { className: 'nfm-more' },
                  h(
                    'button',
                    {
                      className: 'nfm-rowmore' + (menu === t.id + ':' + i ? ' on' : ''),
                      title: '更多',
                      onClick: function (e) {
                        e.stopPropagation()
                        setMenu(menu === t.id + ':' + i ? null : t.id + ':' + i)
                      },
                    },
                    '⋯',
                  ),
                  menu === t.id + ':' + i
                    ? h(
                        'div',
                        {
                          className: 'nfm-menu',
                          onClick: function (e) {
                            e.stopPropagation()
                          },
                        },
                        h(
                          'button',
                          {
                            className: 'nfm-menuitem',
                            onClick: function () {
                              playNextTrack(t)
                              setMenu(null)
                            },
                          },
                          '下一首播放',
                        ),
                        h(
                          'button',
                          {
                            className: 'nfm-menuitem',
                            onClick: function () {
                              appendToQueue(t)
                              setMenu(null)
                            },
                          },
                          '加到队列',
                        ),
                      )
                    : null,
                ),
              )
            })

        },
        [rows, limit, current, menu],
      )
      if (!rows.length) return h('div', { className: 'nfm-empty' }, props.empty || '这里还没有歌')
      return h(
        'div',
        { className: 'nfm-tlist' },
        h(
        'table',
        { className: 'nfm-list' },
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            h('th', { style: { width: '44px' } }, '#'),
            h('th', null, '标题'),
            h('th', { style: { width: '200px' } }, '歌手'),
            h('th', { style: { width: '200px' } }, '专辑'),
            h('th', { style: { width: '72px', textAlign: 'right' } }, '时长'),
            h('th', { style: { width: '36px' } }, ''),
          ),
        ),
        h(
          'tbody',
          null,
          body,
        ),
        ),
        rows.length > shownLen ?
          h(
            'div',
            { className: 'nfm-morewrap' },
            h(
              'button',
              { className: 'nfm-ghost', onClick: function () { setLimit(limit + 200) } },
              '显示更多（还剩 ' + (rows.length - shownLen) + ' 首）',
            ),
          )
          : null,
      )
    }

    function NowView(st) {
      var cur = st.current
      var lines = st.lyricLines
      var queue = st.queue || []
      return h(
        'div',
        { className: 'nfm-now' },
        h(
          'div',
          { className: 'nfm-hero' },
          st.settings.cover
            ? h(
                'div',
                { className: 'nfm-cover' },
                cur && cur.picUrl
                  ? h('img', { src: coverUrl(cur.picUrl, 480), alt: '' })
                  : h('span', { className: 'ph' }, '♫'),
              )
            : null,
          h(
            'div',
            { className: 'nfm-meta' },
            h('div', { className: 'nfm-eyebrow' }, cur ? '正在播放' : '音乐'),
            h('h2', { className: 'nfm-title' }, cur ? cur.name : '还没有在播的歌'),
            h(
              'div',
              { className: 'nfm-sub' },
              cur
                ? (cur.artist || '未知歌手') + (cur.album ? ' · ' + cur.album : '')
                : queue.length
                  ? '队列里已有 ' + queue.length + ' 首，点下面任意一首开始'
                  : '在右上角搜索，或去「我的歌单」挑一张',
            ),
            h(ProgressBar, {
              position: st.position,
              duration: st.duration,
              buffered: st.bufferedEnd,
              onSeek: seekTo,
            }),
            h(Controls, { state: st }),
            h(
              'div',
              { className: 'nfm-kbd' },
              h('span', null, '快捷键'),
              h('b', null, 'Ctrl+P'),
              h('span', null, '播放/暂停'),
              h('b', null, 'Ctrl+←/→'),
              h('span', null, '切歌'),
            ),
          ),
        ),
        h(
          'div',
          {
            className: 'nfm-lyrs',
            title: '点一下看全屏歌词',
            onClick: function () {
              if (state.current) setState({ view: 'lyrics', tab: 'now' })
            },
          },
          st.lyricLoading
            ? h('div', { className: 'nfm-lyempty' }, '歌词加载中…')
            : h(LyricLines, {
                lines: lines,
                active: st.lyricActive,
                count: 7,
                position: st.position,
                showTr: st.settings.showTranslation,
                showRoma: st.settings.showRoma,
                wordByWord: st.settings.wordByWord,
                emptyText: cur ? '这首歌还没有歌词' : '选一首歌，歌词会显示在这里',
              }),
        ),
        h(
          'div',
          { className: 'nfm-queue' },
          h(
            'div',
            { className: 'nfm-queue-head' },
            h('div', { className: 'nfm-queue-title' }, '接下来'),
            h('div', { className: 'nfm-queue-sub' }, queue.length ? queue.length + ' 首' : '队列是空的'),
          ),
          h(TrackList, { items: queue, current: st.current, empty: '还没有歌，去「我的歌单」挑一张' }),
        ),
      )
    }

    function LyricsView(st) {
      var cur = st.current
      return h(
        'div',
        { className: 'nfm-now' },
        h(
          'div',
          { className: 'nfm-hero', style: { alignItems: 'center', justifyContent: 'center', gap: '14px' } },
          cur && cur.picUrl
            ? h(
                'div',
                { className: 'nfm-cover', style: { width: '54px', height: '54px', borderRadius: '10px' } },
                h('img', { src: coverUrl(cur.picUrl, 120), alt: '' }),
              )
            : null,
          h(
            'div',
            { style: { minWidth: '0' } },
            h('h2', { className: 'nfm-title', style: { fontSize: '19px', margin: '0 0 3px' } }, cur ? cur.name : '还没有在播的歌'),
            h('div', { className: 'nfm-sub' }, cur ? cur.artist || '' : '在下面搜索，或去「我的歌单」挑一张'),
          ),
        ),
        h(
          'div',
          { className: 'nfm-lystage' },
          h(LyricLines, {
            lines: st.lyricLines,
            active: st.lyricActive,
            count: 9,
            position: st.position,
            showTr: st.settings.showTranslation,
            showRoma: st.settings.showRoma,
            wordByWord: st.settings.wordByWord,
            emptyText: st.lyricLoading ? '歌词加载中…' : '这首歌还没有歌词',
          }),
        ),
        h(
          'div',
          { style: { flex: '0 0 auto', width: '640px', maxWidth: '100%', margin: '10px auto 0', textAlign: 'center' } },
          h(ProgressBar, { position: st.position, duration: st.duration, buffered: st.bufferedEnd, onSeek: seekTo }),
          h('div', { style: { display: 'flex', justifyContent: 'center' } }, h(Controls, { state: st })),
        ),
      )
    }

    function LibraryView(st, goLogin) {
      var lib = st.library
      if (!st.account.loggedIn) {
        return h(
          'div',
          { className: 'nfm-empty' },
          h('span', { className: 'big' }, '♫'),
          '登录后就能看到你的歌单和「我喜欢的音乐」',
          h('div', { style: { marginTop: '14px' } }, h('button', { className: 'nfm-primary', onClick: goLogin }, '去设置里登录')),
        )
      }
      if (lib.loading && !lib.items.length) return h('div', { className: 'nfm-empty' }, '正在读取歌单…')
      if (lib.error) return h('div', { className: 'nfm-empty' }, lib.error)
      if (!lib.items.length) return h('div', { className: 'nfm-empty' }, '这个账号还没有歌单')
      var mine = lib.items.filter(function (p) {
        return p.special || (lib.nickname && p.creator === lib.nickname)
      })
      var fav = lib.items.filter(function (p) {
        return p.special
      })
      var rest = lib.items.filter(function (p) {
        return !p.special
      })
      return h(
        'div',
        null,
        st.account.guest
          ? h(
              'div',
              { style: { fontSize: '11.5px', color: '#9aa0a8', marginBottom: '12px' } },
              '本机登录态只含播放权限，歌单可能显示不全；扫码/短信登录被网易云风控拦住，过一阵再试就能拿到完整歌单。',
            )
          : null,
        h(
          'div',
          { style: { display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '16px' } },
          h('div', { style: { fontSize: '15px', fontWeight: '600' } }, '我的歌单'),
          h(
            'div',
            { style: { fontSize: '11.5px', color: '#9aa0a8' } },
            (mine.length ? mine.length + ' 个自建 · ' : '') + rest.length + ' 个收藏',
          ),
        ),
        h(
          'div',
          { className: 'nfm-grid' },
          lib.items.map(function (p) {
            return h(
              'div',
              {
                key: p.id,
                className: 'nfm-card',
                onClick: function () {
                  openPlaylist(p.id, p.name, p.cover)
                },
              },
              h(
                'div',
                { className: 'nfm-cardart' },
                p.cover ? h('img', { src: coverUrl(p.cover, 360), alt: '' }) : null,
                p.special ? h('div', { className: 'heart' }, '♥') : null,
                h('span', { className: 'cnt' }, p.trackCount + ' 首'),
              ),
              h('div', { className: 'nfm-cardname' }, p.name),
              h('div', { className: 'nfm-cardsub' }, p.creator + (p.special ? ' · 我喜欢的音乐' : ' · 歌单')),
            )
          }),
        ),
      )
    }

    function DetailView(st) {
      var d = st.detail
      if (d.loading) return h('div', { className: 'nfm-empty' }, '正在读取歌单…')
      if (d.error) return h('div', { className: 'nfm-empty' }, d.error)
      return h(
        'div',
        null,
        h(
          'div',
          { className: 'nfm-dhead' },
          h('div', { className: 'nfm-dcover' }, d.cover ? h('img', { src: coverUrl(d.cover, 360), alt: '' }) : null),
          h(
            'div',
            { className: 'nfm-dmeta' },
            h('div', { style: { fontSize: '11px', color: '#9aa0a8', marginBottom: '6px' } }, '歌单'),
            h('h2', { className: 'nfm-dname' }, d.name),
            h('div', { className: 'nfm-dsub' }, (d.creator || '') + ' · ' + (d.total || d.songs.length) + ' 首'),
            h(
              'div',
              { className: 'nfm-actions' },
              h(
                'button',
                {
                  className: 'nfm-primary',
                  onClick: function () {
                    enqueue(d.songs, 0)
                  },
                },
                '▶ 播放全部',
              ),
              h(
                'button',
                {
                  className: 'nfm-ghost',
                  onClick: function () {
                    setState({ queue: d.songs.slice(), view: 'now', tab: 'now' })
                    toast('已加入队列')
                  },
                },
                '+ 添加到队列',
              ),
            ),
          ),
        ),
        h(TrackList, { items: d.songs, current: st.current }),
      )
    }

    function SearchView(st) {
      var s = st.search
      var tabs = [
        ['song', '单曲'],
        ['playlist', '歌单'],
      ]
      var body = null
      if (s.loading) body = h('div', { className: 'nfm-empty' }, '搜索中…')
      else if (s.error) body = h('div', { className: 'nfm-empty' }, s.error)
      else if (s.tab === 'playlist') {
        body = s.playlists.length
          ? h(
              'div',
              { className: 'nfm-grid' },
              s.playlists.map(function (p) {
                return h(
                  'div',
                  {
                    key: p.id,
                    className: 'nfm-card',
                    onClick: function () {
                      openPlaylist(p.id, p.name, p.cover)
                    },
                  },
                  h(
                    'div',
                    { className: 'nfm-cardart' },
                    p.cover ? h('img', { src: coverUrl(p.cover, 360), alt: '' }) : null,
                    h('span', { className: 'cnt' }, p.trackCount + ' 首'),
                  ),
                  h('div', { className: 'nfm-cardname' }, p.name),
                  h('div', { className: 'nfm-cardsub' }, (p.creator || '') + ' · 歌单'),
                )
              }),
            )
          : h('div', { className: 'nfm-empty' }, '没有找到相关歌单')
      } else {
        body = h(TrackList, { items: s.items, current: st.current, empty: '没有找到相关歌曲' })
      }
      return h(
        'div',
        null,
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px', flexWrap: 'wrap' } },
          h('div', { style: { fontSize: '13px', color: '#8a9099', marginRight: '4px' } }, '「' + s.q + '」'),
          h(
            'div',
            { className: 'nfm-tabs', style: { margin: '0' } },
            tabs.map(function (t) {
              return h(
                'button',
                {
                  key: t[0],
                  className: 'nfm-tab' + (s.tab === t[0] ? ' on' : ''),
                  onClick: function () {
                    doSearch(s.q, t[0])
                  },
                },
                t[1],
              )
            }),
          ),
        ),
        body,
      )
    }

    /* ============================================================ 设置页 */

    /* 账号卡：登录/退出就在这里（原来的独立登录页已搬进设置） */
    function AccountCard() {
      var st = useApp()
      var account = st.account
      var lg = st.login
      var pasteRef = useRef(null)
      var modePair = useState('qr')
      var mode = modePair[0]
      var setMode = modePair[1]
      var smsPair = useState({ phone: '', captcha: '', left: 0, sending: false, busy: false, err: '' })
      var sms = smsPair[0]
      var setSms = smsPair[1]

      useEffect(
        function () {
          if (!sms.left) return undefined
          var t = setInterval(function () {
            setSms(function (prev) {
              if (!prev.left) return prev
              return Object.assign({}, prev, { left: prev.left - 1 })
            })
          }, 1000)
          return function () {
            clearInterval(t)
          }
        },
        [sms.left],
      )

      if (account.loggedIn && lg.stage !== 'waiting' && lg.stage !== 'scanned') {
        return h(
          'div',
          { className: 'nfm-acct' },
          account.avatar
            ? h('img', { className: 'nfm-acctava', src: account.avatar, alt: '' })
            : h('span', { className: 'nfm-acctava nfm-acctava-ph' }, '♫'),
          h(
            'div',
            { className: 'nfm-acctmeta' },
            h('div', { className: 'nfm-acctname' }, account.nickname || '已登录'),
            h('div', { className: 'nfm-acctsub' }, account.uid ? 'UID ' + account.uid + ' · 网易云音乐' : '网易云音乐账号'),
          ),
          h(
            'div',
            { className: 'nfm-acctbtns' },
            h('button', { className: 'nfm-ghost', onClick: logout }, '退出登录'),
          ),
        )
      }

      var stageMsg =
        lg.stage === 'error'
          ? lg.message || '登录失败'
          : lg.stage === 'done'
            ? '登录成功'
            : mode === 'sms'
              ? '手机号 + 短信验证码'
              : mode === 'paste'
                ? '粘贴 Cookie'
                : lg.stage === 'waiting' || lg.stage === 'scanned'
                  ? lg.message || '打开网易云音乐 App 扫一扫'
                  : lg.stage === 'expired'
                    ? '二维码已过期，点「刷新二维码」重试'
                    : '扫码登录，或用下面的方式导入登录态'
      var statusCls =
        'nfm-loginstatus' + (lg.stage === 'error' ? ' err' : lg.stage === 'done' ? ' ok' : '')

      function doSendCode() {
        var phone = String(sms.phone || '').trim()
        if (!/^1\d{10}$/.test(phone)) {
          setSms(function (prev) { return Object.assign({}, prev, { err: '请输入 11 位手机号' }) })
          return
        }
        setSms(function (prev) { return Object.assign({}, prev, { sending: true, err: '' }) })
        postJson('/api/login/sms/sent', { phone: phone })
          .then(function (j) {
            setSms(function (prev) { return Object.assign({}, prev, { sending: false, left: 60 }) })
            toast(j.message || '验证码已发送')
          })
          .catch(function (err) {
            setSms(function (prev) { return Object.assign({}, prev, { sending: false, err: String(err.message || err) }) })
          })
      }

      function doSmsLogin() {
        var phone = String(sms.phone || '').trim()
        var code = String(sms.captcha || '').trim()
        if (!/^1\d{10}$/.test(phone)) {
          setSms(function (prev) { return Object.assign({}, prev, { err: '请输入 11 位手机号' }) })
          return
        }
        if (!/^\d{4,8}$/.test(code)) {
          setSms(function (prev) { return Object.assign({}, prev, { err: '请输入短信验证码' }) })
          return
        }
        setSms(function (prev) { return Object.assign({}, prev, { busy: true, err: '' }) })
        postJson('/api/login/sms/verify', { phone: phone, captcha: code })
          .then(function (j) {
            setSms(function (prev) { return Object.assign({}, prev, { busy: false }) })
            setState({ login: { stage: 'done', key: '', qrUrl: '', svg: '', message: '登录成功', busy: false } })
            refreshAccount()
            loadLibrary(true)
            toast('已登录：' + (j.nickname || '网易云账号'))
          })
          .catch(function (err) {
            setSms(function (prev) { return Object.assign({}, prev, { busy: false, err: String(err.message || err) }) })
          })
      }

      var modeBtn = function (key, label) {
        return h('button', { className: mode === key ? 'on' : '', onClick: function () { setMode(key) } }, label)
      }

      var panel = null
      if (mode === 'qr') {
        panel = h(
          'div',
          { className: 'nfm-loginacts' },
          h('button', { className: 'nfm-primary', disabled: lg.busy, onClick: startQrLogin },
            lg.busy ? '获取中…' : lg.svg ? '刷新二维码' : '获取二维码'),
          h('button', { className: 'nfm-ghost', disabled: lg.busy, onClick: importLocalCookie }, '从本机客户端读取'),
        )
      } else if (mode === 'sms') {
        panel = h(
          'div',
          { className: 'nfm-smsform' },
          h('input', {
            className: 'nfm-input',
            placeholder: '手机号',
            inputMode: 'numeric',
            maxLength: 11,
            value: sms.phone,
            onChange: function (e) {
              var v = e && e.target ? String(e.target.value || '').replace(/\D/g, '') : ''
              setSms(function (prev) { return Object.assign({}, prev, { phone: v }) })
            },
          }),
          h('div', { className: 'nfm-smsrow' },
            h('input', {
              className: 'nfm-input',
              placeholder: '短信验证码',
              inputMode: 'numeric',
              maxLength: 8,
              value: sms.captcha,
              onChange: function (e) {
                var v = e && e.target ? String(e.target.value || '').replace(/\D/g, '') : ''
                setSms(function (prev) { return Object.assign({}, prev, { captcha: v }) })
              },
            }),
            h('button', {
              className: 'nfm-ghost nfm-smsbtn',
              disabled: sms.sending || sms.left > 0,
              onClick: doSendCode,
            },
              sms.left > 0 ? sms.left + 's 后重发' : sms.sending ? '发送中…' : '发送验证码'),
          ),
          h('div', { className: 'nfm-smsactions' },
            h('button', { className: 'nfm-primary', disabled: sms.busy, onClick: doSmsLogin }, sms.busy ? '登录中…' : '登录'),
            h('span', { className: 'nfm-smsnote' }, '未注册的手机号会自动创建账号'),
          ),
          sms.err ? h('div', { className: 'nfm-smserr' }, sms.err) : null,
        )
      } else {
        panel = h(
          'div',
          { className: 'nfm-loginpaste' },
          h('textarea', {
            ref: pasteRef,
            className: 'nfm-pastearea',
            placeholder: '粘贴 MUSIC_U=...; __csrf=... 后点确认',
            spellCheck: false,
          }),
          h(
            'div',
            { className: 'nfm-pastefoot' },
            h(
              'button',
              {
                className: 'nfm-ghost',
                onClick: function () {
                  var el = pasteRef.current
                  pasteCookie(el ? el.value : '')
                },
              },
              '确认粘贴',
            ),
            h('span', { className: 'nfm-note' }, '格式：MUSIC_U=...; __csrf=...'),
          ),
        )
      }

      return h(
        'div',
        { className: 'nfm-loginbox' },
        h(
          'div',
          { className: 'nfm-qr' },
          lg.svg
            ? h('span', { style: { display: 'block', width: '122px', height: '122px' }, dangerouslySetInnerHTML: { __html: lg.svg } })
            : h('span', { className: 'nfm-qrph' }, lg.stage === 'loading' ? '获取中…' : mode === 'sms' ? '手机验证码登录' : mode === 'paste' ? '粘贴 Cookie' : '点「获取二维码」生成'),
        ),
        h(
          'div',
          { className: 'nfm-loginmain' },
          h('div', { className: 'nfm-logintitle' }, '网易云账号'),
          h('div', { className: statusCls }, stageMsg),
          h('div', { className: 'nfm-modeseg' }, modeBtn('qr', '扫码'), modeBtn('sms', '手机验证码'), modeBtn('paste', '粘贴')),
          panel,
          h('div', { className: 'nfm-note nfm-loginnote' }, '凭据只存本机 ~/.dsh/netease-float.json，不上传'),
        ),
      )
    }

    function SetRow(props) {
      return h(
        'div',
        { className: 'nfm-setrow' },
        h(
          'div',
          { className: 'nfm-setlabel' },
          props.label,
          props.hint ? h('span', { className: 'nfm-sethint' }, props.hint) : null,
        ),
        h('div', { className: 'nfm-setside' }, props.children),
      )
    }

    function SetToggle(props) {
      return h(
        'button',
        {
          className: 'nfm-toggle' + (props.value ? ' on' : ''),
          onClick: function () {
            props.onChange(!props.value)
          },
          'aria-pressed': props.value ? 'true' : 'false',
          title: props.value ? '已开启' : '已关闭',
        },
        h('span', { className: 'nfm-toggle-dot' }),
      )
    }

    function SetSeg(props) {
      return h(
        'div',
        { className: 'nfm-seg' },
        props.options.map(function (opt) {
          return h(
            'button',
            {
              key: opt[0],
              className: 'nfm-segbtn' + (opt[0] === props.value ? ' on' : ''),
              onClick: function () {
                props.onChange(opt[0])
              },
            },
            opt[1],
          )
        }),
      )
    }

    var ACCENT_CHOICES = ['#ff2b4e', '#7a5cff', '#0aa06e', '#f08a00', '#2b7fff']
    var QUALITY_CHOICES = [
      ['compat', '省流'],
      ['standard', '标准'],
      ['high', '较高'],
      ['exhigh', '极高'],
      ['lossless', '无损'],
    ]
    var LYRIC_SIZE_CHOICES = [
      ['small', '小'],
      ['normal', '中'],
      ['large', '大'],
      ['xlarge', '特大'],
    ]
    var LYRIC_WEIGHT_CHOICES = [
      ['normal', '常规'],
      ['bold', '加粗'],
    ]
    var LYRIC_SPACING_CHOICES = [
      ['tight', '紧凑'],
      ['normal', '标准'],
      ['loose', '宽松'],
    ]
    var BAR_SIZE_CHOICES = [
      ['small', '小'],
      ['normal', '中'],
      ['large', '大'],
    ]
    var BAR_FONT_CHOICES = [
      ['default', '默认'],
      ['hei', '黑体'],
      ['song', '宋体'],
      ['kai', '楷体'],
    ]
    var BAR_HEIGHT_CHOICES = [
      ['compact', '紧凑'],
      ['normal', '标准'],
      ['tall', '宽松'],
    ]
    var LOOP_CHOICES = [
      ['list', '列表循环'],
      ['one', '单曲循环'],
      ['off', '顺序播放'],
    ]

    /* 设置页：一行 = 一个标签 + 一个控件。只放真正影响播放或界面的开关，凑数的开关不要。 */
    function SettingsPanel(props) {
      var st = useApp()
      var cfg = st.settings
      var inHost = Boolean(props && props.host)
      useEffect(function () {
        boot()
      }, [])
      function row(key, label, hint, control) {
        return h(SetRow, { key: key, label: label, hint: hint }, control)
      }
      function toggle(key, label, hint, field) {
        return row(
          key,
          label,
          hint,
          h(SetToggle, {
            value: Boolean(cfg[field]),
            onChange: function (v) {
              var patch = {}
              patch[field] = v
              saveSettings(patch)
            },
          }),
        )
      }
      return h(
        'div',
        { className: 'nfm-set' + (inHost ? ' nfm-set-host' : ''), style: themeVars(st) },
        h(
          'div',
          { className: 'nfm-setbody' },
          h(
            'div',
            { className: 'nfm-setgroup' },
            h('div', { className: 'nfm-setgtitle' }, '网易云账号'),
            h(AccountCard, null),
          ),
          h(
            'div',
            { className: 'nfm-setgroup' },
            h('div', { className: 'nfm-setgtitle' }, '播放'),
            row(
              'quality',
              '音质',
              '越高越吃流量；无损要账号有权限',
              h(SetSeg, {
                value: cfg.quality,
                options: QUALITY_CHOICES,
                onChange: function (v) {
                  saveSettings({ quality: v })
                },
              }),
            ),
            row(
              'volume',
              '默认音量',
              null,
              h(
                'div',
                { className: 'nfm-setinline' },
                h('input', {
                  type: 'range',
                  min: '0',
                  max: '1',
                  step: '0.01',
                  value: String(st.volume),
                  className: 'nfm-range',
                  onChange: function (e) {
                    setVolume(e.target.value)
                  },
                }),
                h('span', { className: 'nfm-val' }, Math.round(st.volume * 100) + '%'),
              ),
            ),
            row(
              'loop',
              '播放模式',
              null,
              h(SetSeg, { value: st.loopMode, options: LOOP_CHOICES, onChange: setLoopMode }),
            ),
            toggle('fade', '切歌淡入', '换歌时音量在 0.3 秒内淡入', 'fade'),
          ),
          h(
            'div',
            { className: 'nfm-setgroup' },
            h('div', { className: 'nfm-setgtitle' }, '歌词'),
            toggle('translation', '显示翻译', null, 'showTranslation'),
            toggle('roma', '显示音译', '外文歌词的罗马音，有数据才显示', 'showRoma'),
            toggle('word-by-word', '逐字高亮', '只对带逐字歌词的歌生效', 'wordByWord'),
            row(
              'lyric-size',
              '歌词字号',
              null,
              h(SetSeg, {
                value: cfg.lyricSize,
                options: LYRIC_SIZE_CHOICES,
                onChange: function (v) {
                  saveSettings({ lyricSize: v })
                },
              }),
            ),
            row(
              'lyric-weight',
              '歌词字重',
              null,
              h(SetSeg, {
                value: cfg.lyricWeight,
                options: LYRIC_WEIGHT_CHOICES,
                onChange: function (v) {
                  saveSettings({ lyricWeight: v })
                },
              }),
            ),
            row(
              'lyric-spacing',
              '歌词行距',
              null,
              h(SetSeg, {
                value: cfg.lyricSpacing,
                options: LYRIC_SPACING_CHOICES,
                onChange: function (v) {
                  saveSettings({ lyricSpacing: v })
                },
              }),
            ),
            toggle('right-lyrics', '右侧栏歌词', null, 'rightLyrics'),
          ),
          h(
            'div',
            { className: 'nfm-setgroup' },
            h('div', { className: 'nfm-setgtitle' }, '工作区歌词条'),
            toggle('bar-on', '显示歌词条', '有歌时在窗口底部显示一行歌词', 'barOn'),
            row(
              'bar-size',
              '歌词条字号',
              null,
              h(SetSeg, {
                value: cfg.barSize,
                options: BAR_SIZE_CHOICES,
                onChange: function (v) {
                  saveSettings({ barSize: v })
                },
              }),
            ),
            row(
              'bar-font',
              '歌词条字体',
              null,
              h(SetSeg, {
                value: cfg.barFont,
                options: BAR_FONT_CHOICES,
                onChange: function (v) {
                  saveSettings({ barFont: v })
                },
              }),
            ),
            row(
              'bar-height',
              '歌词条高度',
              null,
              h(SetSeg, {
                value: cfg.barHeight,
                options: BAR_HEIGHT_CHOICES,
                onChange: function (v) {
                  saveSettings({ barHeight: v })
                },
              }),
            ),
            toggle('bar-controls', '显示播放按钮', null, 'barControls'),
          ),
          h(
            'div',
            { className: 'nfm-setgroup' },
            h('div', { className: 'nfm-setgtitle' }, '外观'),
            toggle('cover', '正在播放显示封面', null, 'cover'),
            row(
              'accent',
              '强调色',
              null,
              h(
                'div',
                { className: 'nfm-swatches' },
                ACCENT_CHOICES.map(function (c) {
                  return h('button', {
                    key: c,
                    className: 'nfm-swatch' + (c === cfg.accent ? ' on' : ''),
                    style: { background: c },
                    title: c,
                    onClick: function () {
                      saveSettings({ accent: c })
                    },
                  })
                }),
              ),
            ),
            toggle('compact', '列表紧凑', '歌单和队列的行距变紧', 'compact'),
          ),
          h(
            'div',
            { className: 'nfm-setgroup' },
            h('div', { className: 'nfm-setgtitle' }, '快捷键'),
            toggle(
              'hotkeys',
              '启用应用内快捷键',
              'Ctrl+P 播放/暂停 · Ctrl+←/→ 上一首/下一首 · Ctrl+↑/↓ 音量',
              'hotkeys',
            ),
          ),
          h(
            'div',
            { className: 'nfm-setfoot' },
            h('span', { className: 'nfm-note' }, '设置自动保存到 ~/.dsh/netease-float.json'),
            inHost && props.close
              ? h(
                  'button',
                  {
                    className: 'nfm-primary',
                    onClick: function () {
                      props.close()
                    },
                  },
                  '完成',
                )
              : null,
          ),
        ),
      )
    }

    function MusicApp() {
      var st = useApp()
      useEffect(
        function () {
          boot()
          ensureAudio().volume = state.volume
        },
        [],
      )
      useEffect(
        function () {
          if (st.tab === 'library') loadLibrary(false)
        },
        [st.tab, st.account.loggedIn],
      )
      useEffect(function () {
        if (typeof window === 'undefined') return
        function onKey(e) {
          if (!state.settings.hotkeys) return
          var t = e.target
          var tag = t && t.tagName ? String(t.tagName).toLowerCase() : ''
          if (tag === 'input' || tag === 'textarea' || (t && t.isContentEditable)) return
          if (!e.ctrlKey || e.altKey || e.metaKey) return
          var k = e.key
          if (k === 'p' || k === 'P') {
            e.preventDefault()
            togglePlay()
          } else if (k === 'ArrowLeft') {
            e.preventDefault()
            prev()
          } else if (k === 'ArrowRight') {
            e.preventDefault()
            next()
          } else if (k === 'ArrowUp') {
            e.preventDefault()
            setVolume(clamp(state.volume + 0.05, 0, 1))
          } else if (k === 'ArrowDown') {
            e.preventDefault()
            setVolume(clamp(state.volume - 0.05, 0, 1))
          }
        }
        window.addEventListener('keydown', onKey)
        return function () {
          window.removeEventListener('keydown', onKey)
        }
      }, [])
      var body = null
      if (st.view === 'search') body = SearchView(st)
      else if (st.view === 'detail') body = DetailView(st)
      else if (st.view === 'lyrics') body = LyricsView(st)
      else if (st.view === 'library') body = LibraryView(st, function () {
        toast('登录入口在 DSH 设置 → 音乐 里')
      })
      else body = NowView(st)

      var title = st.view === 'search' ? '搜索' : st.view === 'detail' ? st.detail.name || '歌单' : st.view === 'lyrics' ? '歌词' : st.view === 'library' ? '我的歌单' : '音乐'

      return h(
        'div',
        { className: 'nfm-wrap' + (st.settings.compact ? ' nfm-compact' : ''), style: themeVars(st) },
        h(
          'div',
          { className: 'nfm-top' },
          st.view !== 'now' && st.view !== 'library'
            ? h(
                'button',
                {
                  className: 'nfm-back',
                  onClick: function () {
                    if (st.view === 'lyrics') setState({ view: 'now', tab: 'now' })
                    else if (st.view === 'detail') setState({ view: 'library', tab: 'library' })
                    else if (st.view === 'search') setState({ view: state.searchFrom || 'now', tab: 'now' })
                    else setState({ view: 'now', tab: 'now' })
                  },
                },
                '‹',
              )
            : null,
          h('div', { className: 'nfm-h1' }, title),
          h(
            'div',
            { className: 'nfm-searchbox' },
            h('span', { style: { fontSize: '12px', color: '#9aa0a8' } }, '🔍'),
            h('input', {
              placeholder: '搜索歌曲',
              onKeyDown: function (e) {
                if (e.key === 'Enter') doSearch(e.currentTarget.value)
              },
            }),
          ),

        ),
        st.view === 'now' || st.view === 'library'
          ? h(
              'div',
              { className: 'nfm-tabs' },
              ['now', 'library'].map(function (k) {
                var label = k === 'now' ? '正在播放' : '我的歌单'
                var on = k === 'now' ? st.view === 'now' || st.view === 'lyrics' : st.view === k
                return h(
                  'button',
                  {
                    key: k,
                    className: 'nfm-tab' + (on ? ' on' : ''),
                    onClick: function () {
                      setState({ view: k, tab: k })
                    },
                  },
                  label,
                )
              }),
            )
          : null,
        h('div', { className: 'nfm-body' }, st.bootError ? h('div', { className: 'nfm-empty' }, '插件未就绪：' + st.bootError) : body),
        st.toast ? h('div', { className: 'nfm-toast' }, st.toast) : null,
      )
    }

    /* 右侧栏歌词：只订阅行号变化，行数按容器高度算 */
    /* 工作区底部歌词条（shell.bottom）：歌名 + 当前歌词 + 三个控制键 */
    function WorkspaceBar() {
      var st = useApp()
      var cfg = st.settings || {}
      if (!st.current || cfg.barOn === false) return null
      var cur = st.lyricLines[st.lyricActive] || null
      var line = (cur && cur.text) || ''
      var fsz = cfg.barSize === 'small' ? 12 : cfg.barSize === 'large' ? 15 : 13
      var hgt = cfg.barHeight === 'compact' ? 34 : cfg.barHeight === 'tall' ? 56 : 44
      var ff = cfg.barFont === 'hei' ? '"Microsoft YaHei", "PingFang SC", sans-serif' : cfg.barFont === 'song' ? '"Songti SC", SimSun, serif' : cfg.barFont === 'kai' ? '"KaiTi", "STKaiti", serif' : ''
      var style = {
        height: hgt + 'px',
        fontSize: fsz + 'px',
        position: 'fixed',
        left: '50%',
        transform: 'translateX(-50%)',
        bottom: '108px',
        zIndex: 60,
        pointerEvents: 'auto',
      }
      if (ff) style.fontFamily = ff
      return h(
        'div',
        { className: 'nfx-sb', style: style },
        h('span', { className: 'nfx-sb-dot' + (st.playing ? '' : ' off') }),
        h('span', { className: 'nfx-sb-title', title: st.current.name }, st.current.name),
        h('span', { className: 'nfx-sb-artist' }, st.current.artist || ''),
        h('span', { className: 'nfx-sb-lyric' }, line || '…'),
        cfg.barControls === false
          ? null
          : h('span', { className: 'nfx-sb-ctrl' },
              h('button', { className: 'nfx-sb-btn', onClick: prev, title: '上一首' }, '⏮'),
              h('button', { className: 'nfx-sb-btn on', onClick: togglePlay, title: st.playing ? '暂停' : '播放' }, st.playing ? '⏸' : '▶'),
              h('button', { className: 'nfx-sb-btn', onClick: next, title: '下一首' }, '⏭'),
            ),
      )
    }

    function LyricsTab() {
      var st = useApp()
      var boxRef = useRef(null)
      var pair = useState({ rows: 12, h: 0 })
      var dims = pair[0]
      var setDims = pair[1]
      useEffect(
        function () {
          boot()
          var el = boxRef.current
          if (!el || typeof ResizeObserver === 'undefined') return
          var ro = new ResizeObserver(function (entries) {
            var box = entries[0] && entries[0].contentRect
            if (!box) return
            var rows = Math.max(4, Math.floor((box.height - 24) / 31))
            setDims(function (prev) {
              return prev.rows === rows && prev.h === Math.round(box.height) ? prev : { rows: rows, h: Math.round(box.height) }
            })
          })
          ro.observe(el)
          return function () {
            ro.disconnect()
          }
        },
        [],
      )
      var lines = st.lyricLines
      var active = st.lyricActive
      var rows = dims.rows
      var half = Math.floor(rows / 2)
      var start = Math.max(0, active < 0 ? 0 : active - half)
      var end = Math.min(lines.length, start + rows)
      start = Math.max(0, end - rows)
      var out = []
      for (var i = start; i < end; i++) {
        var l = lines[i]
        out.push(
          h(
            'div',
            { key: i, className: 'nfx-row' + (i === active ? ' on' : '') },
            l.text || ' ',
            st.settings.showRoma && l.rm && i === active ? h('span', { className: 'tr rm' }, l.rm) : null,
            st.settings.showTranslation && l.tr && i === active ? h('span', { className: 'tr' }, l.tr) : null,
          ),
        )
      }
      if (!st.settings.rightLyrics) {
        out = [h('div', { className: 'nfx-empty', key: 'off' }, '右侧歌词已在「设置 → 音乐」里关闭')]
      } else if (!lines.length) {
        out.push(
          h(
            'div',
            { className: 'nfx-empty', key: 'e' },
            st.lyricLoading ? '歌词加载中…' : st.current ? '这首歌还没有歌词' : '打开「音乐」页放首歌，这里会跟着显示歌词',
          ),
        )
      }
      var d = st.duration || 0
      var p = d ? clamp(st.position / d, 0, 1) : 0
      return h(
        'div',
        { className: 'nfx-bar', style: themeVars(st) },
        h(
          'div',
          { className: 'nfx-head' },
          h(
            'div',
            { className: 'nfx-live' },
            h('span', { className: 'nfx-dot' + (st.playing ? '' : ' off') }),
            st.playing ? '正在播放' : st.current ? '已暂停' : '未播放',
          ),
          h('div', { className: 'nfx-song' }, st.current ? st.current.name : '还没有在播的歌'),
          h('div', { className: 'nfx-artist' }, st.current ? st.current.artist || '' : ''),
        ),
        h('div', { className: 'nfx-rows', ref: boxRef }, out),
        st.current
          ? h(
              'div',
              { className: 'nfx-foot' },
              h(
                'div',
                {
                  className: 'nfx-bar2',
                  onPointerDown: function (e) {
                    var rect = e.currentTarget.getBoundingClientRect()
                    if (rect.width) seekTo(clamp((e.clientX - rect.left) / rect.width, 0, 1))
                  },
                },
                h('div', { className: 'nfx-fill', style: { width: (p * 100).toFixed(2) + '%' } }),
              ),
              h('div', { className: 'nfx-time' }, h('span', null, fmtTime(st.position)), h('span', null, fmtTime(d))),
              h(
                'div',
                { className: 'nfx-ctrl' },
                h('button', { className: 'nfx-btn', onClick: prev, title: '上一首' }, '⏮'),
                h('button', { className: 'nfx-play nfx-btn', onClick: togglePlay, title: st.playing ? '暂停' : '播放' }, st.playing ? '⏸' : '▶'),
                h('button', { className: 'nfx-btn', onClick: next, title: '下一首' }, '⏭'),
              ),
            )
          : null,
      )
    }

    function SidebarIcon(props) {
      var st = useApp()
      var size = props && props.size ? props.size : 16
      return h('span', { className: 'nfx-ico', style: { width: size, height: size, fontSize: size - 2 } }, '♫')
    }

    /* ============================================================== 注册 */

    var inject = ['slots', 'sidebarRight', 'sidebarRightTabs']
    var LYRIC_TAB_ID = 'dsh-netease-float-lyrics'
    var openLyricTabFn = null

    function apply(ctx) {
      injectStyle()
      var slots = null
      try {
        slots = ctx.get ? ctx.get('slots') : null
      } catch (e) {
        slots = null
      }
      if (!slots) slots = ctx.slots

      try {
        var srt = ctx.get ? ctx.get('sidebarRightTabs') : null
        var sr = ctx.get ? ctx.get('sidebarRight') : null
        if (srt && typeof srt.register === 'function') {
          srt.register({
            id: LYRIC_TAB_ID,
            kind: LYRIC_TAB_ID,
            patterns: ['dsh-resource://netease-float-lyrics/**'],
            priority: 'builtin',
            canOpen: function () {
              return true
            },
            title: function () {
              return '歌词'
            },
          })
        }
        if (sr && typeof sr.openTab === 'function') {
          openLyricTabFn = function () {
            sr.openTab(LYRIC_TAB_ID, {})
          }
        }
      } catch (e) {
        openLyricTabFn = null
      }

      if (!slots || typeof slots.inject !== 'function') {
        throw new Error('[dsh-netease-float] slots service unavailable')
      }

      var disposers = []

      function push(d) {
        if (typeof d === 'function') disposers.push(d)
        else if (d && typeof d.dispose === 'function') disposers.push(function () {
          d.dispose()
        })
      }

      /* 与 dsh-task-ledger 同形：先 slots.inject(槽位名) 等槽位就位，
         再在回调里用同一个 slots 服务 register，回调本身不接参数。 */
      function reg(name, options, component) {
        push(
          slots.inject(name, function () {
            return slots.register(Object.assign({ name: name }, options), component)
          }),
        )
      }

      reg('sidebar.panellist', { id: PANEL_ID, order: 30, label: function () {
        return '音乐'
      } }, SidebarIcon)

      reg('main', { key: PANEL_ID }, MusicApp)

      /* 工作区：输入框上方一条迷你歌词，不占右侧栏 */
      reg('shell.overlay', { id: 'netease-float-lyric', order: 50 }, WorkspaceBar)

      reg('sidebar.right.pane.tab', { key: LYRIC_TAB_ID, inject: function (sessionId) {
        return { sessionId: sessionId }
      } }, LyricsTab)

      /* 宿主「设置」面板里的独立分区：账号登录 + 自定义 */
      reg('settings.section.icon', { id: PANEL_ID }, function (props) {
        var size = (props && props.size) || 16
        return h(
          'span',
          { className: 'nfx-ico', style: { width: size + 'px', height: size + 'px', fontSize: Math.max(11, size - 3) + 'px' } },
          '♫',
        )
      })

      reg('settings.section', { id: PANEL_ID, order: 25, label: function () {
        return '音乐'
      } }, function (props) {
        return h(SettingsPanel, { host: true, close: props && props.close })
      })

      reg('sidebar.right.pane.tab.title', { key: LYRIC_TAB_ID, inject: function (sessionId) {
        return { sessionId: sessionId }
      } }, function () {
        return '歌词'
      })

      if (typeof ctx.effect === 'function') {
        ctx.effect(function () {
          return function () {
            for (var i = 0; i < disposers.length; i++) {
              try {
                disposers[i]()
              } catch (e) {}
            }
            if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl)
            styleEl = null
            stopQrLogin()
            if (audio) {
              try {
                audio.pause()
              } catch (e) {}
              audio = null
            }
          }
        })
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
