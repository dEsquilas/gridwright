import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectPlacements } from '../src/placement.js'

const fresh = () => mkdtempSync(join(tmpdir(), 'gw-place-'))

describe('where things go when the project has nowhere for them yet', () => {
  // An empty Vite project: everything it compiles is under src/.
  it('proposes directories under src/ when the project keeps its source there', () => {
    const root = fresh()
    mkdirSync(join(root, 'src'))
    const byKind = Object.fromEntries(detectPlacements(root).map((p) => [p.kind, p]))
    expect(byKind.module).toMatchObject({ dir: 'src/components/modules', from: 'absent' })
    expect(byKind.view!.dir).toBe('src/views')
  })

  it('proposes them at the root when there is no src/', () => {
    const root = fresh()
    expect(detectPlacements(root).find((p) => p.kind === 'module')!.dir).toBe('components/modules')
  })
})
