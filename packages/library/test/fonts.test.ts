import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { missingFonts, loadedFontFamilies, normalizeFamily } from '../src/fonts.js'

// A stock Vite + shadcn project: Geist through @fontsource-variable.
const shadcn = () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-fonts-'))
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { '@fontsource-variable/geist': '^5' } }))
  writeFileSync(join(root, 'src/index.css'), `@import "@fontsource-variable/geist";\n@theme inline {\n  --font-sans: 'Geist Variable', sans-serif;\n}\n`)
  return root
}

describe('which typefaces a project loads', () => {
  it('reads @fontsource packages and the families --font-* tokens name', () => {
    expect(loadedFontFamilies(shadcn()).has('geist')).toBe(true)
  })

  it('treats "Geist Variable", @fontsource-variable/geist and Geist as one family', () => {
    expect(normalizeFamily('Geist Variable')).toBe(normalizeFamily('geist'))
  })

  // The case that prompted this: Forebound's design is set in Graphik and
  // Suisse Int'l Mono, neither of which a fresh project has.
  it('names the design families the project does not load, as the design spells them', () => {
    expect(missingFonts(shadcn(), ['Graphik', "Suisse Int'l Mono", 'Geist', 'Graphik'])).toEqual(['Graphik', "Suisse Int'l Mono"])
  })

  it('reads @font-face, Google Fonts links and next/font', () => {
    const root = shadcn()
    writeFileSync(join(root, 'src/fonts.css'), `@font-face { font-family: "Graphik"; src: url(/g.woff2); }`)
    writeFileSync(join(root, 'index.html'), `<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&family=Roboto+Mono" rel="stylesheet">`)
    mkdirSync(join(root, 'app'))
    writeFileSync(join(root, 'app/layout.tsx'), `import { Space_Grotesk } from 'next/font/google'`)
    expect(missingFonts(root, ['Graphik', 'Inter', 'Roboto Mono', 'Space Grotesk'])).toEqual([])
  })

  it('never asks for a family every browser has', () => {
    expect(missingFonts(shadcn(), ['sans-serif', 'system-ui', 'monospace'])).toEqual([])
  })
})
