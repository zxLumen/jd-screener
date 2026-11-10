/**
 * 轻量 HTML → 文本。只为招聘页/简历页服务，不追求完整 DOM。
 * 关键点：剥脚本样式、保留段落换行、解码实体、限制输出长度。
 */

const NAMED = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  middot: '·',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  yen: '¥',
}

export function decodeEntities(s) {
  return String(s || '').replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]+);/gi, (m, body) => {
    const key = body.toLowerCase()
    if (key[0] === '#') {
      const hex = key[1] === 'x'
      const n = Number.parseInt(hex ? key.slice(2) : key.slice(1), hex ? 16 : 10)
      if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return m
      try {
        return String.fromCodePoint(n)
      } catch {
        return m
      }
    }
    return NAMED[key] ?? m
  })
}

/** 去掉不可见字符与多余空白，但保留换行 */
export function tidy(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function stripHtml(html) {
  let s = String(html || '')
  s = s.replace(/<!--[\s\S]*?-->/g, '')
  s = s.replace(/<(script|style|noscript|template|svg|canvas|iframe)\b[\s\S]*?<\/\1>/gi, '')
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<\/(p|div|section|article|li|ul|ol|dl|dt|dd|h[1-6]|tr|table|blockquote|pre)>/gi, '\n')
  s = s.replace(/<li\b[^>]*>/gi, '- ')
  s = s.replace(/<[^>]+>/g, ' ')
  return tidy(decodeEntities(s))
}

/** 整页正文：去掉导航/页脚/表单，比 stripHtml 更狠一点 */
export function pageText(html) {
  let s = String(html || '')
  s = s.replace(/<!--[\s\S]*?-->/g, '')
  s = s.replace(/<(script|style|noscript|template|svg|canvas|iframe|header|footer|nav|aside|form|button)\b[\s\S]*?<\/\1>/gi, '')
  return stripHtml(s)
}

export function pageTitle(html) {
  const s = String(html || '')
  const og = s.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i)
  if (og) return tidy(decodeEntities(og[1])).slice(0, 120)
  const t = s.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  return t ? tidy(decodeEntities(t[1])).slice(0, 120) : ''
}

/** 取带某个 class 的元素内部 HTML（按同名标签配对，允许嵌套） */
export function innerByClass(html, cls, tag = 'div') {
  const s = String(html || '')
  const re = new RegExp(`<${tag}\\b[^>]*class=["'][^"']*${cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^"']*["'][^>]*>`, 'i')
  const m = re.exec(s)
  if (!m) return ''
  const start = m.index + m[0].length
  const open = new RegExp(`<${tag}\\b`, 'gi')
  const close = new RegExp(`</${tag}\\s*>`, 'gi')
  let depth = 1
  let i = start
  while (i < s.length && depth > 0) {
    open.lastIndex = i
    close.lastIndex = i
    const no = open.exec(s)
    const nc = close.exec(s)
    if (!nc) break
    if (no && no.index < nc.index) {
      depth++
      i = no.index + no[0].length
    } else {
      depth--
      if (depth === 0) return s.slice(start, nc.index)
      i = nc.index + nc[0].length
    }
  }
  // 没配对上就退化为到第一个 </tag>
  const end = s.indexOf(`</${tag}>`, start)
  return end > 0 ? s.slice(start, end) : ''
}

/** 取属性值（宽松） */
export function attr(html, name) {
  const m = String(html || '').match(new RegExp(`${name}=["']([^"']+)["']`, 'i'))
  return m ? decodeEntities(m[1]) : ''
}
