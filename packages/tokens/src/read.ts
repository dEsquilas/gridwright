/**
 * Reading the design tokens a project already has.
 *
 * Parsed from source rather than imported and executed. A real Tailwind config
 * imports plugins, and importing it from gridwright would resolve those against
 * the wrong node_modules — santillanafrancais brings in `@tailwindcss/typography`
 * and a `plugin()` helper, and evaluating that file out of context fails before
 * a single token is read.
 *
 * The cost is that computed values are opaque: a colour built as
 * `rgb(var(--sf-primary-500, 0 134 155) / <alpha-value>)` is recorded as
 * existing, but cannot be compared by ΔE. That is the honest outcome — it is
 * recorded as unmatchable rather than quietly ignored.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Project, SyntaxKind, type ObjectLiteralExpression } from 'ts-morph'
import { withDefaults, FRAMEWORK_SOURCE } from './defaults.js'
import { parseCssColor } from './color.js'

export type TokenKind = 'color' | 'spacing' | 'typography' | 'radius' | 'shadow' | 'border' | 'other'

export interface ExistingToken {
  /** Dotted path as the project names it, e.g. "colors.primary.500". */
  name: string
  kind: TokenKind
  value: string
  /** A literal we can compare against, or a computed expression we cannot. */
  comparable: boolean
  source: string
  /**
   * The rest of a `fontSize` entry, when the project writes it as
   * `['1.25rem', { lineHeight: '1.5rem', fontWeight: '400' }]`.
   *
   * Discarded before, and the size alone is not enough to tell two tokens
   * apart: this project has `h6` at 20/24/700 and `paragraph-lg` at 20/24/400.
   * Matching on size picked whichever came first, so body copy measured off
   * the design at weight 400 resolved to the bold one — and an agent reading
   * that note writes `text-h6` and gets a bold paragraph.
   */
  lineHeight?: string
  fontWeight?: string
}

export interface TokenSystem {
  target: 'tailwind-config' | 'tailwind-theme' | 'css-vars' | 'none'
  file?: string
  tokens: ExistingToken[]
  /** Section paths found in the config, so new tokens land where their kind
   *  already lives rather than in a section invented for them. */
  sections: string[]
}

const SECTION_KINDS: Record<string, TokenKind> = {
  colors: 'color', backgroundColor: 'color', textColor: 'color', borderColor: 'color',
  spacing: 'spacing', gap: 'spacing', padding: 'spacing', margin: 'spacing',
  fontSize: 'typography', fontFamily: 'typography', fontWeight: 'typography', lineHeight: 'typography',
  borderRadius: 'radius', boxShadow: 'shadow', borderWidth: 'border',
}

/**
 * The project's tokens, plus the scale its framework already provides.
 *
 * Reading the config alone makes a project that follows Tailwind's default
 * scale look like it has no scale at all, and every value in the design then
 * arrives as new.
 */
export function readTokenSystem(projectRoot: string, target?: string, file?: string): TokenSystem {
  const system = readDeclared(projectRoot, target, file)
  // Tailwind v4's own scale is a stylesheet in the project's node_modules, in
  // the version it actually has installed. Read from there rather than kept as
  // a copy here that drifts with every release.
  const installed = system.target === 'tailwind-theme' ? readInstalledTailwindTheme(projectRoot) : null
  return { ...system, tokens: withDefaults(system.tokens, system.target, installed) }
}

/** Tailwind v4's default theme, as the project has it installed. */
export function readInstalledTailwindTheme(projectRoot: string): ExistingToken[] | null {
  const file = join(projectRoot, 'node_modules', 'tailwindcss', 'theme.css')
  if (!existsSync(file)) return null
  const src = readFileSync(file, 'utf8')
  return [...parseCss(src, FRAMEWORK_SOURCE, 'tailwind-theme').tokens, ...spacingScale(src)]
}

/**
 * Tailwind v4's spacing: every multiple of `--spacing`, not a list.
 *
 * v3 had a fixed scale, and that is what was here — so 120px and 52px were
 * proposed as new tokens in a v4 project where `p-30` and `p-13` already exist.
 * The steps go to 96 in halves, the range a layout plausibly uses; past that a
 * value is almost certainly not spacing.
 */
function spacingScale(themeCss: string): ExistingToken[] {
  const base = themeCss.match(/--spacing\s*:\s*([^;]+);/)
  const px = base ? pxOf(base[1]!.trim()) : null
  if (!px) return []
  const out: ExistingToken[] = []
  for (let n = 0; n <= 96; n += 0.5) {
    out.push({ name: `spacing.${n}`, kind: 'spacing', value: `${n * px}px`, comparable: true, source: FRAMEWORK_SOURCE })
  }
  return out
}

function readDeclared(projectRoot: string, target?: string, file?: string): TokenSystem {
  if (file) {
    const abs = join(projectRoot, file)
    if (existsSync(abs)) {
      if (target === 'tailwind-config') return readTailwindConfig(abs, file)
      if (target === 'tailwind-theme' || target === 'css-vars') return readCss(abs, file, target)
    }
  }

  for (const name of ['tailwind.config.js', 'tailwind.config.ts', 'tailwind.config.cjs', 'tailwind.config.mjs']) {
    const abs = join(projectRoot, name)
    if (existsSync(abs)) return readTailwindConfig(abs, name)
  }
  return { target: 'none', tokens: [], sections: [] }
}

/**
 * Walks `theme` (and `theme.extend`) collecting every string leaf.
 *
 * Nested objects become dotted names, which is how Tailwind addresses them
 * anyway: `colors.primary.500` is the `primary-500` utility.
 */
export function readTailwindConfig(absPath: string, label: string): TokenSystem {
  const project = new Project({ useInMemoryFileSystem: false, skipAddingFilesFromTsConfig: true })
  const source = project.addSourceFileAtPath(absPath)
  const tokens: ExistingToken[] = []
  const sections = new Set<string>()

  const theme = findTheme(source)
  if (!theme) return { target: 'tailwind-config', file: label, tokens: [], sections: [] }

  const literals = collectLiteralMaps(source)

  for (const root of theme) {
    for (const prop of root.getProperties()) {
      if (!prop.isKind(SyntaxKind.PropertyAssignment)) continue
      const section = unquote(prop.getName())
      if (section === 'extend') continue

      const init = prop.getInitializer()
      if (!init) continue
      sections.add(section)
      collect(init, section, SECTION_KINDS[section] ?? 'other', tokens, label, literals)
    }
  }
  return { target: 'tailwind-config', file: label, tokens, sections: [...sections] }
}

/**
 * Module-level maps of plain string values, keyed by their own key.
 *
 * Configs of any size stop writing values inline. santillanafrancais keeps a
 * `HEX` map and emits every colour as `color('neutral-700')`, so a reader that
 * stops at the function call sees a config with no comparable colours at all —
 * and then proposes `#4b5561` as new when `neutral-700` has been exactly that
 * since the palette was dumped from Figma.
 *
 * Following one level of indirection is the difference between resolving
 * against a project's palette and inventing a second one beside it.
 */
function collectLiteralMaps(source: ReturnType<Project['addSourceFileAtPath']>): Map<string, string> {
  const out = new Map<string, string>()
  for (const decl of source.getVariableDeclarations()) {
    const init = decl.getInitializer()
    if (!init?.isKind(SyntaxKind.ObjectLiteralExpression)) continue
    for (const prop of init.getProperties()) {
      if (!prop.isKind(SyntaxKind.PropertyAssignment)) continue
      const value = prop.getInitializer()
      if (!value?.isKind(SyntaxKind.StringLiteral)) continue
      const key = unquote(prop.getName())
      // First declaration wins: a later map keyed the same way is a different
      // scale, and guessing between them is worse than using neither.
      if (!out.has(key)) out.set(key, value.getLiteralValue())
    }
  }
  return out
}

function findTheme(source: ReturnType<Project['addSourceFileAtPath']>): ObjectLiteralExpression[] {
  const out: ObjectLiteralExpression[] = []
  for (const obj of source.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression)) {
    for (const prop of obj.getProperties()) {
      if (!prop.isKind(SyntaxKind.PropertyAssignment)) continue
      if (unquote(prop.getName()) !== 'theme') continue
      const init = prop.getInitializer()
      if (!init?.isKind(SyntaxKind.ObjectLiteralExpression)) continue
      out.push(init)
      // `extend` is where projects actually put their own tokens.
      const ext = init.getProperty('extend')
      if (ext?.isKind(SyntaxKind.PropertyAssignment)) {
        const extInit = ext.getInitializer()
        if (extInit?.isKind(SyntaxKind.ObjectLiteralExpression)) out.push(extInit)
      }
    }
  }
  return out
}

function collect(
  node: ReturnType<ObjectLiteralExpression['getProperties']>[number] | any,
  path: string,
  kind: TokenKind,
  out: ExistingToken[],
  source: string,
  literals: Map<string, string> = new Map(),
): void {
  if (node.isKind?.(SyntaxKind.ObjectLiteralExpression)) {
    for (const prop of (node as ObjectLiteralExpression).getProperties()) {
      if (!prop.isKind(SyntaxKind.PropertyAssignment)) continue
      const init = prop.getInitializer()
      if (init) collect(init, `${path}.${unquote(prop.getName())}`, kind, out, source, literals)
    }
    return
  }

  // `color('neutral-700')` — a helper over a map of values. One level of
  // indirection, and only when the argument is a literal we can look up.
  if (node.isKind?.(SyntaxKind.CallExpression)) {
    const args = node.getArguments?.() ?? []
    const first = args[0]
    if (args.length === 1 && first?.isKind?.(SyntaxKind.StringLiteral)) {
      const resolved = literals.get(first.getLiteralValue())
      if (resolved) {
        out.push({ name: path, kind, value: resolved, comparable: isComparable(resolved, kind), source })
        return
      }
    }
  }

  if (node.isKind?.(SyntaxKind.StringLiteral) || node.isKind?.(SyntaxKind.NoSubstitutionTemplateLiteral)) {
    const value = node.getLiteralValue?.() ?? unquote(node.getText())
    out.push({ name: path, kind, value, comparable: isComparable(value, kind), source })
    return
  }

  if (node.isKind?.(SyntaxKind.ArrayLiteralExpression)) {
    // fontSize entries are ['1rem', { lineHeight: '1.5rem', fontWeight: '400' }].
    // The size is the value; the rest is what tells two same-size tokens apart.
    const [first, second] = node.getElements?.() ?? []
    if (!first) return
    const before = out.length
    collect(first, path, kind, out, source, literals)
    const added = out[before]
    if (added && second?.isKind?.(SyntaxKind.ObjectLiteralExpression)) {
      const read = (name: string): string | undefined => {
        const prop = (second as ObjectLiteralExpression).getProperty?.(name)
        const text = prop?.getLastChildByKind?.(SyntaxKind.StringLiteral)?.getLiteralText?.()
        return text || undefined
      }
      const lineHeight = read('lineHeight')
      const fontWeight = read('fontWeight')
      if (lineHeight) added.lineHeight = lineHeight
      if (fontWeight) added.fontWeight = fontWeight
    }
    return
  }

  // Anything else — a call, a template with substitutions, a variable — exists
  // but cannot be compared. Recorded so it is never proposed as "new".
  out.push({ name: path, kind, value: node.getText?.() ?? '', comparable: false, source })
}

/**
 * Whether a value can be held against a design value — which depends on what
 * kind of value it is.
 *
 * Checking only for a hex or a bare length marked every shadow, gradient and
 * font stack as unreadable, so they never matched anything and every one
 * arrived as a token to create. `boxShadow.button` was sitting right there
 * while gridwright proposed to add it again.
 *
 * What genuinely cannot be compared is an expression we did not evaluate: a
 * function call left unresolved, or a template with substitutions in it.
 */
function isComparable(value: string, kind: TokenKind = 'other'): boolean {
  const v = value.trim()
  if (v === '') return false
  // An expression we could not resolve. Everything else is a literal.
  if (/\$\{|\(\s*\)|=>/.test(v)) return false

  switch (kind) {
    case 'color':
      return /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v) || /^rgba?\(/i.test(v)
    case 'spacing':
    case 'radius':
    case 'border':
      return /^-?\d+(\.\d+)?(px|rem|em|%)?$/.test(v)
    case 'shadow':
      // Comparable when it reads as layers; `sameShadow` does the rest.
      return v !== 'none' && /\d/.test(v)
    case 'typography':
      return true
    default:
      return /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)
        || /^-?\d+(\.\d+)?(px|rem|em|%)$/.test(v)
  }
}

/** Tailwind v4's `@theme` block, and plain custom properties. */
export function readCss(absPath: string, label: string, target?: string): TokenSystem {
  return parseCss(readFileSync(absPath, 'utf8'), label, target)
}

/**
 * Custom properties, resolved the way the browser would resolve them.
 *
 * The first reader took each `--x: value;` at face value, and a stock shadcn
 * stylesheet defeated it completely. Its colours are declared twice over —
 * `--color-primary: var(--primary)` inside `@theme inline`, and `--primary:
 * oklch(0.205 0 0)` in `:root` — so the value read was a `var()`, and even
 * followed it would have been an `oklch()` nothing could compare. Not one of
 * the project's colours was comparable, and every colour a design brought was
 * proposed as new.
 *
 * So `var()` is followed, the first declaration of a variable wins — the light
 * theme on `:root` comes before the dark one, and a design is drawn in the
 * light one — colours become hex, and `calc()` over lengths is evaluated,
 * because that is how shadcn builds every radius.
 *
 * For Tailwind v4 only the namespaces that become utilities are tokens:
 * `--color-*`, `--text-*`, `--radius-*`, `--shadow-*`, `--spacing-*`. A bare
 * `--primary` is a variable, not a class, and offering it as a match would
 * name something `bg-primary` could not reach.
 */
export function parseCss(src: string, label: string, target?: string): TokenSystem {
  const vars = new Map<string, string>()
  for (const m of src.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    if (!vars.has(m[1]!)) vars.set(m[1]!, m[2]!.trim())
  }

  const resolve = (value: string, depth = 0): string => {
    if (depth > 8) return value
    return value.replace(/var\(\s*--([a-z0-9-]+)\s*(?:,\s*([^()]*))?\)/gi, (_, name: string, fallback?: string) => {
      const hit = vars.get(name)
      if (hit !== undefined) return resolve(hit, depth + 1)
      return fallback !== undefined ? resolve(fallback.trim(), depth + 1) : `var(--${name})`
    })
  }

  const resolvedTarget = (target as TokenSystem['target']) ?? (/@theme\b/.test(src) ? 'tailwind-theme' : 'css-vars')
  const themeOnly = resolvedTarget === 'tailwind-theme'
  const tokens: ExistingToken[] = []
  const sections = new Set<string>()

  for (const [name, declared] of vars) {
    if (themeOnly && !isThemeToken(name)) continue
    const kind = kindFromName(name)
    const value = evaluateCalc(resolve(declared))
    sections.add(name.split('-')[0]!)

    if (kind === 'color') {
      const hex = parseCssColor(value)
      tokens.push({ name: `--${name}`, kind, value: hex ?? value, comparable: hex !== null, source: label })
      continue
    }

    const token: ExistingToken = { name: `--${name}`, kind, value, comparable: isComparable(value, kind), source: label }
    // v4 declares a size's line height as a sibling, `--text-xl--line-height`,
    // usually as a ratio. It belongs on the size, where type resolution reads it.
    if (kind === 'typography' && name.startsWith('text-')) {
      const lh = vars.get(`${name}--line-height`)
      const px = lh !== undefined ? lineHeightPx(resolve(lh), value) : null
      if (px !== null) token.lineHeight = `${px}px`
    }
    tokens.push(token)
  }

  return { target: resolvedTarget, file: label, tokens, sections: [...sections] }
}

/** A Tailwind v4 namespace that becomes a utility, and not a sub-property of one. */
function isThemeToken(name: string): boolean {
  return /^(color|text|radius|shadow|spacing)-/.test(name) && !name.includes('--')
}

/** A length in px: `12px`, `0.75rem`. */
function pxOf(value: string): number | null {
  const m = value.trim().match(/^(-?\d*\.?\d+)(px|rem|em)?$/)
  if (!m) return null
  const n = parseFloat(m[1]!)
  return m[2] === 'rem' || m[2] === 'em' ? n * 16 : n
}

/**
 * `calc()` over lengths and numbers, when it is simple enough to be sure of.
 *
 * shadcn builds every radius from one: `calc(var(--radius) - 4px)`,
 * `calc(var(--radius) * 1.4)`. Unevaluated, not one of them compared with the
 * 6px or 14px a design brings. Anything this cannot be certain about is left as
 * written, and stays incomparable.
 */
function evaluateCalc(value: string): string {
  const m = value.trim().match(/^calc\((.+)\)$/)
  if (!m) return value
  const terms = m[1]!.trim().split(/\s+([-+*/])\s+/)
  if (terms.length !== 3) return value
  const [a, op, b] = terms as [string, string, string]
  const x = pxOf(a)
  if (x === null) return value
  // A number is not a length. `calc(1.75 / 1.25)` is Tailwind's line-height
  // ratio, and reading it as px made every v4 size's line height 1.4px.
  const aIsLength = /(px|rem|em)$/.test(a.trim())
  const lengthB = pxOf(b)
  const plain = /^-?\d*\.?\d+$/.test(b.trim()) ? parseFloat(b) : null
  let out: number | null = null
  if ((op === '+' || op === '-') && aIsLength && lengthB !== null && plain === null) out = op === '+' ? x + lengthB : x - lengthB
  if ((op === '*' || op === '/') && plain !== null) out = op === '*' ? x * plain : x / plain
  if (out === null) return value
  const n = Math.round(out * 1000) / 1000
  return aIsLength ? `${n}px` : `${n}`
}

/** A line height against its size: a ratio (`calc(1.75 / 1.25)`, `1.5`), or a length. */
function lineHeightPx(lh: string, size: string): number | null {
  const sizePx = pxOf(size)
  const ratio = lh.trim().match(/^calc\(\s*(\d*\.?\d+)\s*\/\s*(\d*\.?\d+)\s*\)$/)
  if (ratio && sizePx !== null) return Math.round((parseFloat(ratio[1]!) / parseFloat(ratio[2]!)) * sizePx * 100) / 100
  if (/^\d*\.?\d+$/.test(lh.trim()) && sizePx !== null) return Math.round(parseFloat(lh) * sizePx * 100) / 100
  return pxOf(lh)
}

function kindFromName(name: string): TokenKind {
  if (/^color|^bg|colou?r/.test(name)) return 'color'
  if (/^spacing|^space|^gap/.test(name)) return 'spacing'
  if (/^font|^text|^leading|^tracking/.test(name)) return 'typography'
  if (/^radius|^rounded/.test(name)) return 'radius'
  if (/^shadow/.test(name)) return 'shadow'
  if (/^border/.test(name)) return 'border'
  return 'other'
}

function unquote(s: string): string {
  return s.replace(/^['"`]|['"`]$/g, '')
}
