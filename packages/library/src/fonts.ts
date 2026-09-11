/**
 * Which typefaces a project actually loads.
 *
 * A design names its families — Graphik, Suisse Int'l Mono, Inter — and a
 * project either ships them or it does not. When it does not, the text renders
 * in a fallback, every text box comes out a different size, and the structural
 * score moves for a reason no component can fix. Nor should one try: a
 * commercial typeface is licensed, a lookalike is a different design, and the
 * right place for either decision is the project, before anything is built.
 * So gridwright says which ones are missing, once, and does nothing else about
 * it.
 *
 * It cannot tell a private typeface from a free one. It can tell whether this
 * project loads it, which is the question that matters.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Families every browser has, which no project needs to load. */
const GENERIC = new Set([
  'serif', 'sansserif', 'monospace', 'cursive', 'fantasy', 'systemui', 'uisansserif',
  'uiserif', 'uimonospace', 'uirounded', 'emoji', 'math', 'fangsong', 'applesystem',
  'blinkmacsystemfont', 'segoeui', 'roboto', 'helveticaneue', 'arial', 'helvetica',
])

/**
 * One spelling for a family: lowercase, no spaces or punctuation, and without
 * the "Variable" a variable-font package adds. `'Geist Variable'`,
 * `@fontsource-variable/geist` and `Geist` are one family.
 */
export function normalizeFamily(name: string): string {
  return name.toLowerCase().replace(/variable/g, '').replace(/[^a-z0-9]/g, '')
}

/** Every family the project loads, normalised. */
export function loadedFontFamilies(root: string): Set<string> {
  const out = new Set<string>()
  const add = (name: string) => { const n = normalizeFamily(name); if (n) out.add(n) }

  // Packages: @fontsource/inter, @fontsource-variable/geist.
  const pkg = readJson(join(root, 'package.json'))
  for (const dep of Object.keys({ ...pkg?.dependencies, ...pkg?.devDependencies })) {
    const m = dep.match(/^@fontsource(?:-variable)?\/(.+)$/)
    if (m) add(m[1]!)
  }

  // Stylesheets: @font-face, and the families a --font-* token names.
  for (const file of files(root, ['src', 'app', 'styles', 'resources/css', 'assets'], /\.css$/)) {
    const css = safeRead(file)
    for (const m of css.matchAll(/@font-face\s*\{[^}]*font-family\s*:\s*([^;]+);/gi)) addFamilies(m[1]!, add)
    for (const m of css.matchAll(/--font-[a-z0-9-]*\s*:\s*([^;]+);/gi)) addFamilies(m[1]!, add)
  }

  // Google Fonts linked from the page.
  for (const html of [join(root, 'index.html'), join(root, 'public/index.html')]) {
    for (const m of safeRead(html).matchAll(/fonts\.googleapis\.com\/css2?\?([^"'\s>]+)/g)) {
      for (const f of m[1]!.matchAll(/family=([^:&]+)/g)) add(decodeURIComponent(f[1]!.replace(/\+/g, ' ')))
    }
  }

  // next/font: `import { Inter } from 'next/font/google'`.
  for (const file of files(root, ['app', 'src/app', 'pages', 'src/pages'], /\.(tsx|jsx|ts|js)$/)) {
    for (const m of safeRead(file).matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]next\/font\/google['"]/g)) {
      for (const name of m[1]!.split(',')) add(name.trim().replace(/_/g, ' '))
    }
  }
  return out
}

/** The design's families this project does not load, as the design spells them. */
export function missingFonts(root: string, families: string[]): string[] {
  const loaded = loadedFontFamilies(root)
  const seen = new Set<string>()
  const out: string[] = []
  for (const family of families) {
    const n = normalizeFamily(family)
    if (!n || GENERIC.has(n) || loaded.has(n) || seen.has(n)) continue
    seen.add(n)
    out.push(family)
  }
  return out
}

/** `'Geist Variable', "Inter", sans-serif` → each name. */
function addFamilies(list: string, add: (name: string) => void): void {
  for (const part of list.split(',')) {
    const name = part.trim().replace(/^['"]|['"]$/g, '')
    if (name && !name.startsWith('var(')) add(name)
  }
}

function files(root: string, dirs: string[], pattern: RegExp, depth = 4): string[] {
  const out: string[] = []
  const walk = (dir: string, d: number) => {
    if (d > depth) return
    let entries: string[]
    try { entries = readdirSync(dir) } catch { return }
    for (const e of entries) {
      if (e.startsWith('.') || e === 'node_modules' || e === 'dist') continue
      const abs = join(dir, e)
      let st
      try { st = statSync(abs) } catch { continue }
      if (st.isDirectory()) walk(abs, d + 1)
      else if (pattern.test(e)) out.push(abs)
    }
  }
  for (const d of dirs) if (existsSync(join(root, d))) walk(join(root, d), 0)
  return out
}

function readJson(file: string): Record<string, Record<string, string>> | null {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

function safeRead(file: string): string {
  try { return readFileSync(file, 'utf8') } catch { return '' }
}
