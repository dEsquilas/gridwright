/**
 * Writing new tokens into the project's own system.
 *
 * Through an AST, never a regular expression. This edits a file the whole team
 * shares and the build depends on; a regex that works on the config in front of
 * you and not on the one with a trailing comment breaks everyone's build, and
 * the diff will not say why.
 *
 * Nothing here decides *whether* to write. That is the human gate in Law 5 —
 * these functions are handed an already-approved list.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { Project, QuoteKind, SyntaxKind, type ObjectLiteralExpression } from 'ts-morph'
import type { TokenSystem } from './read.js'

/**
 * Raised rather than clobbering a computed token.
 *
 * The decision belongs to the person at the gate: the value may need to go to
 * the CSS file the indirection points at, or the name may simply be taken.
 * Neither is something to guess at while holding a write to a shared config.
 */
export class ComputedTokenCollision extends Error {
  constructor(
    readonly token: string,
    readonly current: string,
  ) {
    super(
      `\`${token}\` already exists and is computed: ${current}\n` +
        `Overwriting it with a literal would remove whatever the expression provides — ` +
        `opacity support, a theme override, a CSS variable that is the real source of truth.\n` +
        `Either give the new token a different name, or add the value where that expression reads from.`,
    )
    this.name = 'ComputedTokenCollision'
  }
}

export interface TokenWrite {
  /** Dotted path, e.g. "colors.brand.500" or "--sf-brand-500". */
  name: string
  value: string
  /** The Tailwind section it belongs in: colors, spacing, borderRadius… */
  section: string
}

export interface WriteResult {
  file: string
  written: TokenWrite[]
  /** Unified diff of what changed, for the gate and the dashboard. */
  diff: string
}

export function writeTokens(
  projectRoot: string,
  system: TokenSystem,
  writes: TokenWrite[],
): WriteResult {
  if (writes.length === 0) return { file: system.file ?? '', written: [], diff: '' }
  if (!system.file) throw new Error('There is nowhere to write: no token file was detected.')

  const abs = `${projectRoot}/${system.file}`
  const before = readFileSync(abs, 'utf8')

  const after = system.target === 'tailwind-config'
    ? writeIntoTailwindConfig(abs, writes)
    : writeIntoCss(before, writes, system.target)

  writeFileSync(abs, after)
  return { file: system.file, written: writes, diff: unifiedDiff(system.file, before, after) }
}

/** Same edit, without touching the file — this is what the gate shows. */
export function previewTokens(
  projectRoot: string,
  system: TokenSystem,
  writes: TokenWrite[],
): string {
  if (writes.length === 0 || !system.file) return ''
  const abs = `${projectRoot}/${system.file}`
  const before = readFileSync(abs, 'utf8')
  const after = system.target === 'tailwind-config'
    ? writeIntoTailwindConfig(abs, writes, { dryRun: true })
    : writeIntoCss(before, writes, system.target)
  return unifiedDiff(system.file, before, after)
}

function writeIntoTailwindConfig(
  absPath: string,
  writes: TokenWrite[],
  opts: { dryRun?: boolean } = {},
): string {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    // Match the file being edited rather than imposing a style. The diff at the
    // gate is what a person reads, and mixed quoting there reads as damage.
    manipulationSettings: { quoteKind: detectQuoteKind(absPath) },
  })
  const source = project.addSourceFileAtPath(absPath)

  const theme = findOrCreateTheme(source)
  // New tokens go under `extend`, never over the base scale. Writing to
  // `theme.colors` directly replaces Tailwind's palette wholesale, and a
  // component three files away loses `gray-500` without any hint why.
  const extend = getOrCreateObject(theme, 'extend')

  for (const w of writes) {
    const path = w.name.split('.')
    let target = getOrCreateObject(extend, w.section)
    // Everything but the last segment is nesting: colors.brand.500.
    for (const segment of path.slice(0, -1)) {
      target = getOrCreateObject(target, segment)
    }
    const leaf = path[path.length - 1]!
    const existing = target.getProperty(leaf)

    // Never overwrite something the project computes.
    //
    // A project declaring `brand.DEFAULT` as
    // `rgb(var(--sf-brand) / <alpha-value>)` had it replaced with `#007a8d`.
    // That silently removes opacity support — `bg-brand/50` stops working —
    // and severs a single source of truth that lived in a CSS file this writer
    // never looked at. `read.ts` already marks these `comparable: false` and
    // documents why; the writer simply was not asking.
    if (existing?.isKind(SyntaxKind.PropertyAssignment)) {
      const current = existing.getInitializer()
      const isLiteral = current?.isKind(SyntaxKind.StringLiteral)
        || current?.isKind(SyntaxKind.NoSubstitutionTemplateLiteral)
      if (current && !isLiteral) {
        throw new ComputedTokenCollision(w.name, current.getText().trim())
      }
    }

    if (existing) existing.remove()
    target.addPropertyAssignment({ name: quoteIfNeeded(leaf), initializer: quote(w.value, absPath) })
  }

  source.formatText({ indentSize: 2 })
  const text = source.getFullText()
  if (!opts.dryRun) source.saveSync()
  return text
}

function findOrCreateTheme(source: ReturnType<Project['addSourceFileAtPath']>): ObjectLiteralExpression {
  for (const obj of source.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression)) {
    const prop = obj.getProperty('theme')
    if (prop?.isKind(SyntaxKind.PropertyAssignment)) {
      const init = prop.getInitializer()
      if (init?.isKind(SyntaxKind.ObjectLiteralExpression)) return init
    }
  }

  // No theme at all: attach one to whatever object is exported.
  const exported = source.getExportAssignment(() => true)?.getExpression()
  if (exported?.isKind(SyntaxKind.ObjectLiteralExpression)) {
    return getOrCreateObject(exported, 'theme')
  }
  const first = source.getFirstDescendantByKind(SyntaxKind.ObjectLiteralExpression)
  if (first) return getOrCreateObject(first, 'theme')

  throw new Error(
    'Could not find an object to add `theme` to in the config. ' +
      'Add a `theme: {}` block by hand and run this again — guessing at the shape of a ' +
      'config file is how builds break.',
  )
}

function getOrCreateObject(parent: ObjectLiteralExpression, name: string): ObjectLiteralExpression {
  const existing = parent.getProperty(name) ?? parent.getProperty(`'${name}'`) ?? parent.getProperty(`"${name}"`)
  if (existing?.isKind(SyntaxKind.PropertyAssignment)) {
    const init = existing.getInitializer()
    if (init?.isKind(SyntaxKind.ObjectLiteralExpression)) return init
  }
  const added = parent.addPropertyAssignment({ name: quoteIfNeeded(name), initializer: '{}' })
  return added.getInitializerIfKindOrThrow(SyntaxKind.ObjectLiteralExpression)
}

/**
 * CSS custom properties, appended inside the block that already holds them.
 *
 * Kept as a text edit rather than a full CSS parse: the goal is to add lines to
 * an existing block, and reprinting someone's stylesheet through a parser would
 * reformat far more than it changed.
 *
 * In Tailwind v4 a token is a utility only inside `@theme`, and only under its
 * namespace: `--color-brand` there gives `bg-brand`; the same line in `:root`
 * gives a variable and no class at all. The first cut looked for `@theme {` or
 * `:root {`, and shadcn's `@theme inline {` matched neither form it knew — so a
 * shadcn stylesheet had its new colours written into `:root`, where no utility
 * could reach them.
 */
function writeIntoCss(source: string, writes: TokenWrite[], target?: string): string {
  const theme = target === 'tailwind-theme'
  const lines = writes.map((w) => `  ${cssName(w, theme)}: ${w.value};`)
  const wrap = theme ? '@theme' : ':root'

  // A plain `@theme` first: `inline` changes how values are emitted, and a
  // project that has both keeps its own tokens in the plain one.
  const blockStart = theme
    ? firstMatch(source, [/@theme\s*\{/, /@theme\s+inline\s*\{/])
    : firstMatch(source, [/@theme\s*\{|:root\s*\{/])
  if (blockStart === -1) {
    return `${source.trimEnd()}\n\n${wrap} {\n${lines.join('\n')}\n}\n`
  }

  const open = source.indexOf('{', blockStart)
  const close = matchingBrace(source, open)
  if (close === -1) return `${source.trimEnd()}\n\n${wrap} {\n${lines.join('\n')}\n}\n`

  const body = source.slice(open + 1, close).trimEnd()
  return `${source.slice(0, open + 1)}${body}\n${lines.join('\n')}\n${source.slice(close)}`
}

function firstMatch(source: string, patterns: RegExp[]): number {
  for (const p of patterns) {
    const i = source.search(p)
    if (i !== -1) return i
  }
  return -1
}

/** Tailwind v4 namespaces, by the section a token was resolved into. */
const V4_NAMESPACE: Record<string, string> = {
  colors: 'color', color: 'color', spacing: 'spacing', borderRadius: 'radius', radius: 'radius',
  boxShadow: 'shadow', shadow: 'shadow', fontSize: 'text', typography: 'text',
}

/**
 * The property name a token is written under.
 *
 * For v4, under the namespace that makes it a utility. `brand.600` in the
 * colours section is `--color-brand-600`; a name that already carries a
 * namespace is left alone.
 */
function cssName(w: TokenWrite, theme: boolean): string {
  const bare = w.name.replace(/^--/, '')
  if (!theme) return `--${bare}`
  if (/^(color|spacing|radius|shadow|text|font)-/.test(bare)) return `--${bare}`
  const ns = V4_NAMESPACE[w.section]
  const flat = bare.replace(/\./g, '-')
  return ns ? `--${ns}-${flat}` : `--${flat}`
}

function matchingBrace(src: string, open: number): number {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** Whichever quote the file already leans on. */
function detectQuoteKind(absPath: string): QuoteKind {
  const src = readFileSync(absPath, 'utf8')
  const singles = (src.match(/'/g) ?? []).length
  const doubles = (src.match(/"/g) ?? []).length
  return doubles > singles ? QuoteKind.Double : QuoteKind.Single
}

function quote(value: string, absPath: string): string {
  const q = detectQuoteKind(absPath) === QuoteKind.Double ? '"' : "'"
  return `${q}${value.replace(new RegExp(q, 'g'), `\\${q}`)}${q}`
}

function quoteIfNeeded(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : `'${name}'`
}

/** Enough of a diff to read at a gate. The point is seeing what changes before
 *  approving it, not producing something `patch` could apply. */
export function unifiedDiff(file: string, before: string, after: string): string {
  const a = before.split('\n')
  const b = after.split('\n')
  const out: string[] = [`--- ${file}`, `+++ ${file}`]

  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue }

    const resync = b.indexOf(a[i] ?? ' ', j)
    if (resync !== -1 && resync - j < 40) {
      for (; j < resync; j++) out.push(`+ ${b[j]}`)
      continue
    }
    if (i < a.length) out.push(`- ${a[i++]}`)
    else if (j < b.length) out.push(`+ ${b[j++]}`)
  }
  return out.length > 2 ? out.join('\n') : ''
}
