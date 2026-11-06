/**
 * 极简 QR 码生成（byte 模式 / 纠错等级 L / 版本 1–5）
 * ---------------------------------------------------------------------------
 * 只为了把网易云扫码登录的 URL 画成二维码，因此砍掉了一切用不到的分支：
 *   · 只用 byte 模式（URL 是 ASCII）
 *   · 只用纠错等级 L（容量最大，单块不需要交错）
 *   · 版本 1–5 自动选择（最多 108 字节，够 73 字符的登录 URL）
 * 输出 SVG 字符串，无第三方依赖。
 *
 * 算法按 ISO/IEC 18004 实现：数据编码 → Reed-Solomon → 交织（单块无需）
 * → 功能图形 → 8 种掩码里按罚分选最优 → 格式信息。
 */

'use strict'

/* ------------------------------------------------------------ GF(256) */

const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
;(function initGalois() {
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]
})()

function gfMul(a, b) {
  if (!a || !b) return 0
  return EXP[LOG[a] + LOG[b]]
}

/* 生成多项式 ∏(x - α^i) */
function genPoly(n) {
  let poly = [1]
  for (let i = 0; i < n; i++) {
    const next = new Array(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gfMul(poly[j], 1)
      next[j + 1] ^= gfMul(poly[j], EXP[i])
    }
    poly = next
  }
  return poly
}

/* --------------------------------------------------- 版本参数（等级 L） */

const VERSIONS = {
  1: { data: 19, ecc: 7, align: [] },
  2: { data: 34, ecc: 10, align: [6, 18] },
  3: { data: 55, ecc: 15, align: [6, 22] },
  4: { data: 80, ecc: 20, align: [6, 26] },
  5: { data: 108, ecc: 26, align: [6, 30] },
}

const MODE_BYTE = 0b0100
const MAX_BYTES = 108

function pickVersion(byteLen) {
  /* 头 4bit 模式 + 8bit 长度 = 12bit，向上取整成 2 字节 */
  const need = byteLen + 2
  for (let v = 1; v <= 5; v++) {
    if (VERSIONS[v].data >= need) return v
  }
  return 0
}

function buildCodewords(bytes, version) {
  const spec = VERSIONS[version]
  const capacity = spec.data
  const bits = []
  const push = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1)
  }
  push(MODE_BYTE, 4)
  push(bytes.length, 8)
  for (let i = 0; i < bytes.length; i++) push(bytes[i], 8)
  /* 终止符 */
  const maxBits = capacity * 8
  for (let i = 0; i < 4 && bits.length < maxBits; i++) bits.push(0)
  while (bits.length % 8 !== 0) bits.push(0)
  const data = []
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]
    data.push(b)
  }
  const pads = [0xec, 0x11]
  let p = 0
  while (data.length < capacity) data.push(pads[p++ % 2])

  /* Reed-Solomon（单块，无需交错） */
  const g = genPoly(spec.ecc)
  const res = data.concat(new Array(spec.ecc).fill(0))
  for (let i = 0; i < data.length; i++) {
    const coef = res[i]
    if (!coef) continue
    for (let j = 0; j < g.length; j++) res[i + j] ^= gfMul(g[j], coef)
  }
  return data.concat(res.slice(data.length))
}

/* ------------------------------------------------------------ 矩阵构建 */

function makeMatrix(version) {
  const size = 17 + version * 4
  const m = []
  for (let y = 0; y < size; y++) m.push(new Array(size).fill(null))
  return { size, m, reserved: m.map((row) => row.map(() => false)) }
}

function setFn(mx, x, y, val) {
  if (x < 0 || y < 0 || x >= mx.size || y >= mx.size) return
  mx.m[y][x] = val
  mx.reserved[y][x] = true
}

function finder(mx, cx, cy) {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx
      const y = cy + dy
      if (x < 0 || y < 0 || x >= mx.size || y >= mx.size) continue
      const inside = Math.abs(dx) <= 3 && Math.abs(dy) <= 3
      let dark = false
      if (inside) {
        const ring = Math.max(Math.abs(dx), Math.abs(dy))
        dark = ring !== 2
      }
      setFn(mx, x, y, dark ? 1 : 0)
    }
  }
}

function alignment(mx, cx, cy) {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const ring = Math.max(Math.abs(dx), Math.abs(dy))
      setFn(mx, cx + dx, cy + dy, ring !== 1 ? 1 : 0)
    }
  }
}

function formatBits(mask) {
  /* 等级 L = 01，5 位数据 = 01 + mask(3bit)，BCH(15,5) 后异或 0x5412 */
  let data = (0b01 << 3) | mask
  let rem = data << 10
  for (let i = 14; i >= 10; i--) {
    if ((rem >> i) & 1) rem ^= 0b10100110111 << (i - 10)
  }
  const bits = ((data << 10) | rem) ^ 0b101010000010010
  const out = []
  for (let i = 14; i >= 0; i--) out.push((bits >> i) & 1)
  return out
}

function placeFormat(mx, mask) {
  const bits = formatBits(mask)
  const size = mx.size
  const at = (i) => bits[i]
  /* 左上角两份 */
  const a = [
    [0, 8],
    [1, 8],
    [2, 8],
    [3, 8],
    [4, 8],
    [5, 8],
    [7, 8],
    [8, 8],
    [8, 7],
    [8, 5],
    [8, 4],
    [8, 3],
    [8, 2],
    [8, 1],
    [8, 0],
  ]
  for (let i = 0; i < 15; i++) {
    const [x, y] = a[i]
    setFn(mx, x, y, at(i))
  }
  /* 右上 / 左下 */
  for (let i = 0; i < 8; i++) {
    setFn(mx, size - 1 - i, 8, at(i))
  }
  for (let i = 8; i < 15; i++) {
    setFn(mx, 8, size - 15 + i, at(i))
  }
  /* 固定暗模块 */
  setFn(mx, 8, size - 8, 1)
}

function buildFunctionPatterns(version) {
  const spec = VERSIONS[version]
  const mx = makeMatrix(version)
  const size = mx.size
  finder(mx, 3, 3)
  finder(mx, size - 4, 3)
  finder(mx, 3, size - 4)
  for (let i = 8; i < size - 8; i++) {
    setFn(mx, i, 6, i % 2 === 0 ? 1 : 0)
    setFn(mx, 6, i, i % 2 === 0 ? 1 : 0)
  }
  const al = spec.align
  for (let i = 0; i < al.length; i++) {
    for (let j = 0; j < al.length; j++) {
      const cx = al[i]
      const cy = al[j]
      /* 跳过与三个定位图形重叠的位置 */
      if ((cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6)) continue
      alignment(mx, cx, cy)
    }
  }
  /* 预留格式区（先填 0，稍后覆盖） */
  placeFormat(mx, 0)
  return mx
}

function placeData(mx, codewords, mask) {
  const size = mx.size
  let bitIdx = 0
  const totalBits = codewords.length * 8
  const getBit = (i) => {
    if (i >= totalBits) return 0
    const byte = codewords[i >> 3]
    return (byte >> (7 - (i & 7))) & 1
  }
  let upward = true
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right = 5 /* 跳过竖直 timing 列 */
    for (let step = 0; step < size; step++) {
      const y = upward ? size - 1 - step : step
      for (let k = 0; k < 2; k++) {
        const x = right - k
        if (mx.reserved[y][x]) continue
        let bit = getBit(bitIdx)
        bitIdx++
        if (maskApply(mask, x, y)) bit ^= 1
        mx.m[y][x] = bit
      }
    }
    upward = !upward
  }
}

function maskApply(mask, x, y) {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0
    case 1:
      return y % 2 === 0
    case 2:
      return x % 3 === 0
    case 3:
      return (x + y) % 3 === 0
    case 4:
      return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0
    case 7:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
    default:
      return false
  }
}

function penalty(mx) {
  const size = mx.size
  let score = 0
  /* 规则 1：连续 5 个以上同色 */
  for (let y = 0; y < size; y++) {
    let run = 1
    for (let x = 1; x < size; x++) {
      if (mx.m[y][x] === mx.m[y][x - 1]) run++
      else {
        if (run >= 5) score += 3 + (run - 5)
        run = 1
      }
    }
    if (run >= 5) score += 3 + (run - 5)
  }
  for (let x = 0; x < size; x++) {
    let run = 1
    for (let y = 1; y < size; y++) {
      if (mx.m[y][x] === mx.m[y - 1][x]) run++
      else {
        if (run >= 5) score += 3 + (run - 5)
        run = 1
      }
    }
    if (run >= 5) score += 3 + (run - 5)
  }
  /* 规则 2：2×2 同色块 */
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = mx.m[y][x]
      if (c === mx.m[y][x + 1] && c === mx.m[y + 1][x] && c === mx.m[y + 1][x + 1]) score += 3
    }
  }
  /* 规则 3：类定位图形 1011101 + 四白 */
  const pat = [1, 0, 1, 1, 1, 0, 1]
  const check = (get) => {
    for (let i = 0; i <= size - 7; i++) {
      let ok = true
      for (let j = 0; j < 7; j++) {
        if (get(i + j) !== pat[j]) {
          ok = false
          break
        }
      }
      if (!ok) continue
      let before = true
      for (let j = 1; j <= 4; j++) {
        if (i - j >= 0 && get(i - j) === 1) {
          before = false
          break
        }
      }
      let after = true
      for (let j = 0; j < 4; j++) {
        if (i + 7 + j < size && get(i + 7 + j) === 1) {
          after = false
          break
        }
      }
      if (before || after) score += 40
    }
  }
  for (let y = 0; y < size; y++) check((i) => mx.m[y][i])
  for (let x = 0; x < size; x++) check((i) => mx.m[i][x])
  /* 规则 4：暗色比例偏离 50% */
  let dark = 0
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (mx.m[y][x]) dark++
  const ratio = (dark * 100) / (size * size)
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10
  return score
}

/* -------------------------------------------------------------- 对外接口 */

function qrMatrix(text) {
  const bytes = Array.from(Buffer.from(String(text), 'utf8'))
  if (bytes.length > MAX_BYTES) throw new Error('QR payload too long')
  const version = pickVersion(bytes.length)
  if (!version) throw new Error('QR payload too long')
  const codewords = buildCodewords(bytes, version)
  let best = null
  for (let mask = 0; mask < 8; mask++) {
    const mx = buildFunctionPatterns(version)
    placeData(mx, codewords, mask)
    placeFormat(mx, mask)
    const p = penalty(mx)
    if (!best || p < best.p) best = { p, mx }
  }
  return best.mx
}

function qrSvg(text, opts) {
  const mx = qrMatrix(text)
  const size = mx.size
  const quiet = (opts && opts.quiet) || 2
  const px = size + quiet * 2
  const rects = []
  for (let y = 0; y < size; y++) {
    let x = 0
    while (x < size) {
      if (!mx.m[y][x]) {
        x++
        continue
      }
      let run = 0
      while (x + run < size && mx.m[y][x + run]) run++
      rects.push(`<rect x="${x + quiet}" y="${y + quiet}" width="${run}" height="1"/>`)
      x += run
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${px} ${px}" shape-rendering="crispEdges" role="img" aria-label="登录二维码">` +
    `<rect width="${px}" height="${px}" fill="#fff"/>` +
    `<g fill="#17181a">${rects.join('')}</g>` +
    `</svg>`
  )
}

export { qrSvg, qrMatrix }
