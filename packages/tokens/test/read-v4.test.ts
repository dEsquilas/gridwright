import { describe, it, expect } from 'vitest'
import { parseCss } from '../src/read.js'
import { withDefaults } from '../src/defaults.js'
import { resolveTokens } from '../src/resolve.js'
import type { RawToken } from '@gridwright/core'

// Trimmed from what `shadcn init` writes into a Vite project's src/index.css.
const SHADCN = `
@import "tailwindcss";
@theme inline {
  --color-primary: var(--primary);
  --color-muted-foreground: var(--muted-foreground);
  --radius-sm: calc(var(--radius) - 4px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) * 1.4);
}
:root {
  --radius: 0.625rem;
  --primary: oklch(0.205 0 0);
  --muted-foreground: oklch(0.556 0 0);
}
.dark {
  --primary: oklch(0.985 0 0);
}
`

// Trimmed from node_modules/tailwindcss/theme.css, v4.3.
const THEME = `
@theme default {
  --color-neutral-900: oklch(20.5% 0 none);
  --color-violet-500: oklch(60.6% 0.25 292.717);
  --text-xl: 1.25rem;
  --text-xl--line-height: calc(1.75 / 1.25);
  --radius-md: 0.375rem;
  --spacing: 0.25rem;
}
`

const byName = (tokens: ReturnType<typeof parseCss>['tokens']) => new Map(tokens.map((t) => [t.name, t]))
const raw = (kind: RawToken['kind'], value: string): RawToken => ({ kind, value, usedIn: ['x'] })

describe('a Tailwind v4 stylesheet, read the way Tailwind reads it', () => {
  const project = byName(parseCss(SHADCN, 'src/index.css', 'tailwind-theme').tokens)

  // The case that made every colour in a shadcn project incomparable.
  it('follows var() to the value, and turns oklch into a hex', () => {
    expect(project.get('--color-primary')).toMatchObject({ value: '#171717', comparable: true })
  })

  it('takes the light theme, which is declared first and is the one a design is drawn in', () => {
    expect(project.get('--color-primary')!.value).toBe('#171717')
  })

  it('evaluates the calc() every shadcn radius is built from', () => {
    expect(project.get('--radius-sm')).toMatchObject({ value: '6px', comparable: true })
    expect(project.get('--radius-xl')).toMatchObject({ value: '14px', comparable: true })
    expect(project.get('--radius-lg')).toMatchObject({ value: '0.625rem', comparable: true })
  })

  // `--primary` is a variable; only `--color-primary` is a class.
  it('offers only what becomes a utility', () => {
    expect(project.has('--primary')).toBe(false)
    expect(project.has('--radius')).toBe(false)
  })
})

describe('the installed Tailwind v4 theme as the framework scale', () => {
  const installed = parseCss(THEME, 'tailwind (framework default)', 'tailwind-theme').tokens
  const theme = byName(installed)

  it('reads the palette', () => {
    expect(theme.get('--color-neutral-900')!.value).toBe('#171717')
  })

  // v4 declares a size's line height as a sibling, as a ratio.
  it("puts each size's line height on the size", () => {
    expect(theme.get('--text-xl')).toMatchObject({ value: '1.25rem', lineHeight: '28px' })
    expect(theme.has('--text-xl--line-height')).toBe(false)
  })

  it('does not take the base spacing unit for a step of the scale', () => {
    expect(theme.has('--spacing')).toBe(false)
  })

  // End to end: what a design brings, against a shadcn project plus the
  // installed theme. Before, every one of these came back "new".
  it("resolves a design's colours, type and radii against both", () => {
    const tokens = withDefaults(parseCss(SHADCN, 'src/index.css', 'tailwind-theme').tokens, 'tailwind-theme', installed)
    const [ink, violet, type, radius] = resolveTokens([
      raw('color', '#171717'),
      raw('color', '#8e51ff'),
      raw('typography', 'Inter/400/20px/28px'),
      raw('radius', '6px'),
    ], tokens, { colorToleranceDeltaE: 1, spacingTolerancePx: 2 })
    expect(ink!.bucket).toBe('exact')
    expect(violet!.match?.name).toBe('--color-violet-500')
    expect(type!.match?.name).toBe('--text-xl')
    expect(radius!.match?.name).toMatch(/--radius-(sm|md)/)
  })
})

describe('Tailwind v4 spacing is a multiple, not a list', () => {
  it('offers every half-step of --spacing, so 120px and 52px already exist', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { readInstalledTailwindTheme } = await import('../src/read.js')
    const root = mkdtempSync(join(tmpdir(), 'gw-v4sp-'))
    mkdirSync(join(root, 'node_modules/tailwindcss'), { recursive: true })
    writeFileSync(join(root, 'node_modules/tailwindcss/theme.css'), THEME)
    const installed = readInstalledTailwindTheme(root)!
    const tokens = withDefaults([], 'tailwind-theme', installed)
    const [wide, odd] = resolveTokens([raw('spacing', '120px'), raw('spacing', '53.5px')], tokens,
      { colorToleranceDeltaE: 1, spacingTolerancePx: 2 })
    expect(wide!.match?.name).toBe('spacing.30')
    expect(odd!.bucket).toBe('near')
  })
})
