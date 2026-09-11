import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG, type GridwrightConfig } from '@gridwright/core'
import { registerComponent, readRegistry, findByIdentity, recordView, readViews } from '../src/index.js'

let root: string
let config: GridwrightConfig
const figma = (irHash: string, identity?: string) => ({ file: 'F', node: '1:3', irHash, ...(identity ? { identity } : {}) })

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gw-views-'))
  config = { ...DEFAULT_CONFIG, library: { dir: 'src/components', barrel: 'src/components/index.ts', registry: 'src/components/registry.json' } }
})

describe('identity — specs/004', () => {
  // An instance's overrides change its IR hash. Two uses of one component with
  // different copy hashed differently and registered twice.
  it('the same main component is one entry, whatever the IR hash', () => {
    registerComponent(root, config, { name: 'OverlayForm', componentPath: join(root, 'src/components/OverlayForm.tsx'),
      figma: figma('aaa', 'set-form'), props: [], tokens: [] })
    const second = registerComponent(root, config, { name: 'OverlayFormDark', componentPath: join(root, 'src/components/OverlayForm.tsx'),
      figma: figma('bbb', 'set-form'), props: [], tokens: [] })
    expect(Object.keys(readRegistry(root, config))).toEqual(['OverlayForm'])
    expect(second.entry.runs).toBe(2)
  })

  it('a registered section is found by its identity, so the next view reuses it', () => {
    registerComponent(root, config, { name: 'NavFooter', componentPath: join(root, 'src/components/NavFooter.tsx'),
      figma: figma('ccc', 'c-footer'), props: [], tokens: [] })
    expect(findByIdentity(readRegistry(root, config), 'c-footer')?.[0]).toBe('NavFooter')
    expect(findByIdentity(readRegistry(root, config), 'c-other')).toBeNull()
  })
})

describe('views live outside the library — specs/004', () => {
  it('a view is recorded in its own manifest, not in the registry', () => {
    recordView(root, 'Home', { path: 'src/views/Home.tsx', figma: figma('ddd'), sections: ['Hero', 'NavFooter'] })
    expect(readViews(root).Home?.sections).toEqual(['Hero', 'NavFooter'])
    expect(readRegistry(root, config).Home).toBeUndefined()
    expect(existsSync(join(root, config.library.barrel))).toBe(false)
  })

  it('recording it again counts a run rather than duplicating it', () => {
    recordView(root, 'Home', { path: 'src/views/Home.tsx', figma: figma('ddd'), sections: [] })
    recordView(root, 'Home', { path: 'src/views/Home.tsx', figma: figma('eee'), sections: [] })
    expect(readViews(root).Home?.runs).toBe(2)
    expect(JSON.parse(readFileSync(join(root, '.gridwright/views.json'), 'utf8'))).toHaveProperty('Home')
  })
})
