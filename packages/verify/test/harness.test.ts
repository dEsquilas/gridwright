import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  findProjectCss, projectDependsOn, resolveProjectModule, tailwindSourceStylesheet, viteConfig,
} from '../src/harness.js'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'gw-harness-')) })
afterEach(() => rmSync(root, { recursive: true, force: true }))

const file = (rel: string, body: string) => {
  const p = join(root, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body)
}

const packageJson = (deps: Record<string, string>, devDeps: Record<string, string> = {}) =>
  file('package.json', JSON.stringify({ name: 'app', dependencies: deps, devDependencies: devDeps }))

/**
 * A Vite 8 + Tailwind v4 project — the shape `npm create vite` and `shadcn init`
 * produce today — could not be rendered at all. The harness served the
 * project's `@vitejs/plugin-react` 6 with gridwright's own Vite 6 and failed on
 * "Missing field `moduleType`"; had it got past that, it would have found no
 * stylesheet in `src/index.css`, and with no postcss config it would not have
 * compiled Tailwind anyway. Three separate ways to report a correct component
 * as rendering nothing.
 */
describe('rendering a Vite 8 + Tailwind v4 project', () => {
  it('reads the dependency from either list', () => {
    packageJson({ react: '^19' }, { '@tailwindcss/vite': '^4' })
    expect(projectDependsOn(root, '@tailwindcss/vite')).toBe(true)
    expect(projectDependsOn(root, 'vue')).toBe(false)
  })

  it('has no dependencies when there is no package.json', () => {
    expect(projectDependsOn(root, 'vite')).toBe(false)
  })

  it('resolves the project\'s own Vite, through its exports', () => {
    packageJson({}, { vite: '^8' })
    file('node_modules/vite/package.json', JSON.stringify({
      name: 'vite', type: 'module',
      exports: { '.': './dist/node/index.js', './package.json': './package.json' },
    }))
    expect(resolveProjectModule(root, 'vite')).toBe(join(root, 'node_modules/vite/dist/node/index.js'))
  })

  it('takes the import condition when exports are conditional', () => {
    packageJson({ lib: '^1' })
    file('node_modules/lib/package.json', JSON.stringify({
      name: 'lib',
      exports: { '.': { types: './index.d.ts', import: './esm.js', require: './cjs.cjs' } },
    }))
    expect(resolveProjectModule(root, 'lib')).toBe(join(root, 'node_modules/lib/esm.js'))
  })

  it('reports a package the project does not have as missing', () => {
    packageJson({})
    expect(resolveProjectModule(root, 'vite')).toBeNull()
  })

  it('loads the Tailwind Vite plugin when the project compiles Tailwind with it', () => {
    packageJson({}, { '@tailwindcss/vite': '^4', '@vitejs/plugin-react': '^6' })
    const config = viteConfig({ projectRoot: root, framework: 'react19' })
    expect(config).toContain("import tailwindcss from '@tailwindcss/vite'")
    expect(config).toContain('plugins: [plugin(), tailwindcss()]')
  })

  it('leaves the plugin out when the project does not use it', () => {
    packageJson({}, { '@vitejs/plugin-react': '^6' })
    const config = viteConfig({ projectRoot: root, framework: 'react19' })
    expect(config).not.toContain('tailwindcss')
    expect(config).toContain('plugins: [plugin()]')
  })

  it('finds src/index.css and prefers it as source when the Vite plugin compiles it', () => {
    packageJson({}, { '@tailwindcss/vite': '^4' })
    file('src/index.css', '@import "tailwindcss";\n')
    file('dist/output.css', '.p-4{padding:1rem}\n')
    expect(findProjectCss(root)).toEqual([join(root, 'src/index.css')])
  })

  it('still prefers a build output when nothing can compile the source', () => {
    packageJson({})
    file('src/index.css', '@import "tailwindcss";\n')
    file('dist/output.css', '.p-4{padding:1rem}\n')
    // Candidate order puts src/index.css first; without a compiler it is the
    // first found that wins, as before.
    expect(findProjectCss(root)).toEqual([join(root, 'src/index.css')])
    rmSync(join(root, 'src/index.css'))
    expect(findProjectCss(root)).toEqual([join(root, 'dist/output.css')])
  })

  it('points Tailwind v4 at the project, since the harness root is not where the component lives', () => {
    file('src/index.css', '@import "tailwindcss";\n@theme inline {}\n')
    const dir = join(root, '.gridwright/harness')
    const css = tailwindSourceStylesheet(dir, root, [join(root, 'src/index.css')])
    expect(css).toBe('@import "../../src/index.css";\n@source "../..";\n')
  })

  it('leaves a Tailwind v3 or compiled stylesheet alone', () => {
    file('src/app.css', '@tailwind base;\n@tailwind utilities;\n')
    file('dist/output.css', '.p-4{padding:1rem}\n')
    const dir = join(root, '.gridwright/harness')
    expect(tailwindSourceStylesheet(dir, root, [join(root, 'src/app.css')])).toBeNull()
    expect(tailwindSourceStylesheet(dir, root, [join(root, 'dist/output.css')])).toBeNull()
    expect(tailwindSourceStylesheet(dir, root, [])).toBeNull()
  })
})
