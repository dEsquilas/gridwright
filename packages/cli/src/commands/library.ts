/**
 * `gw library` — stages 5 and 13, the two that make a run add to the system.
 *
 * Neither can be skipped. A run that builds a component and does not register
 * it leaves the project with one more file and no more system, which is the
 * definition of a failed run here.
 */

import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve as resolvePath } from 'node:path'
import {
  activeRun, advance, loadConfig, loadState, paths, saveState,
  type IR, type RunState, type GridwrightConfig, type RunScore,
} from '@gridwright/core'
import { ensureLibrary, registerComponent, readRegistry, findByHash } from '@gridwright/library'
import { ok, fail, info, warn, dim, bold, green, yellow } from '../ui.js'

export interface LibraryArgs {
  run?: string
  component?: string
  approve?: boolean
  json?: boolean
}

function context(root: string, id?: string): { run: RunState; config: GridwrightConfig } {
  const config = loadConfig(root)
  if (!config) fail('This project is not configured.', 'Run `gw init` first.')
  const run = id ? loadState(root, id) : activeRun(root)
  if (!run) fail('No open run.', 'Start one with `gw build "<figma-url>"`.')
  return { run, config }
}

export function runEnsure(root: string, args: LibraryArgs): void {
  const { run, config } = context(root, args.run)
  const exists = existsSync(join(root, config.library.dir))

  // Creating structure in someone else's repo is invasive exactly once, so
  // that once is a gate. Afterwards it never asks again.
  if (!exists && !args.approve) {
    console.log(bold('The component library does not exist yet.'))
    console.log(dim('  gridwright would create, and nothing else:\n'))
    console.log(`    ${config.library.dir}/`)
    console.log(`    ${config.library.barrel}`)
    console.log(`    ${config.library.registry}`)
    console.log()
    warn('This is the one time it asks (Law 5).')
    console.log(dim('  Approve with: gw library ensure --approve'))
    process.exitCode = 1
    return
  }

  const result = ensureLibrary(root, config)
  if (result.created.length > 0) {
    ok(`Library ready — created ${result.created.length} ${result.created.length === 1 ? 'entry' : 'entries'}`)
    for (const c of result.created) console.log(`    ${dim('·')} ${c}`)
  } else {
    ok(`Library already in place at ${config.library.dir}`)
  }

  advance(run, 'library:ensure', { status: 'done', output: { created: result.created } })
  saveState(root, run)
  info(`Now on ${green(run.stage)}`)
}

export function runRegister(root: string, args: LibraryArgs): void {
  const { run, config } = context(root, args.run)

  // The file `author` wrote, when there is one. Demanding the flag inside a run
  // meant `library:register` — a stage that cannot be skipped, because it is
  // what makes a run add to the design system — could not run as part of the
  // pipeline at all.
  const authored = run.stages.author.output?.file
  const given = args.component ?? (typeof authored === 'string' ? authored : undefined)
  if (!given) {
    fail(
      'Which component? Pass --component.',
      'gw library register --component src/components/ui/HeroBanner/index.tsx\n\n' +
        'Inside a run it is taken from what `author` recorded.',
    )
  }
  const componentPath = isAbsolute(given) ? given : resolvePath(root, given)
  if (!existsSync(componentPath)) fail(`No such component: ${componentPath}`)

  const irPath = paths.ir(root, run.id)
  if (!existsSync(irPath)) fail(`Run ${run.id} has no IR.`, 'Re-run `gw build` for that node.')
  const ir = JSON.parse(readFileSync(irPath, 'utf8')) as IR

  const before = findByHash(readRegistry(root, config), ir.hash)
  // The score at the width the design was drawn at, not the worst viewport.
  // The worst viewport decides whether a run passes (Law 6); it is the wrong
  // number to file against a component, because it is usually a width the
  // design has no frame for. The registry said 54% about a component that is
  // 90% against its own design.
  const measured = run.stages.verify.output?.score as RunScore | undefined
  const score = measured?.viewports.find((v) => v.viewport === 'design')?.total ?? measured?.total

  // The name comes from the file that was written, not from the Figma frame.
  // A frame called "Wrapper full" is the designer's scaffolding; three of them
  // in one file would all register under the same name, and none of them is
  // what the component is called in the codebase.
  const name = componentName(componentPath) ?? run.name
  const shape = config.conventions?.shapes.find((s) => componentPath.includes(s.dir))

  const result = registerComponent(root, config, {
    name,
    componentPath,
    ...(shape ? { exportShape: shape.export } : {}),
    figma: { file: ir.source.file, node: ir.source.node, irHash: ir.hash },
    // The props the component actually takes, which `author` recorded. The IR's
    // slots are the design's names for its text — `suscribeToOut`,
    // `loremIpsumDolor` — and no component is called that: this one takes a
    // `fieldValues` its CMS supplies. Filing the slots meant the registry
    // described a component that does not exist.
    props: authoredProps(run) ?? propsOf(ir),
    tokens: resolvedTokenNames(root, run.id, ir),
    ...(score !== undefined ? { score } : {}),
  })

  if (before) {
    // Same design hash: this is the same component drawn again, not a new one.
    console.log(`${yellow('↻')} Updated ${bold(before[0])} — run ${result.entry.runs} of this design`)
  } else {
    ok(`Registered ${bold(name)}`)
  }
  if (result.barrelLine) console.log(`    ${dim(result.barrelLine)}`)

  advance(run, 'library:register', {
    status: 'done',
    output: { name: before?.[0] ?? run.name, runs: result.entry.runs },
  })
  saveState(root, run)
  info(`Now on ${green(run.stage)}`)
}

/** The prop names the component declares, from what `author` handed over. */
function authoredProps(run: RunState): string[] | null {
  const props = run.stages.author.output?.props
  if (!props || typeof props !== 'object') return null
  const names = Object.keys(props as Record<string, unknown>)
  if (names.length === 0) return null
  // A single wrapper prop says nothing: `["fieldValues"]` is the CMS's
  // envelope, and what is inside it is the component's actual surface.
  const only = names.length === 1 ? (props as Record<string, unknown>)[names[0]!] : null
  if (only && typeof only === 'object') {
    return Object.keys(only as Record<string, unknown>).map((k) => `${names[0]}.${k}`)
  }
  return names
}

/**
 * What the design's values resolved to, by name.
 *
 * A value with no single token — a gradient, a type triple — is decomposed by
 * `resolve` into parts the project already has, and the note names them. Those
 * names are what belongs here. The raw string is what the design brought, and
 * it is already in the IR; a registry full of `#e0f2f1` cannot answer "what
 * uses tertiary-50", which is the one question a component registry exists to
 * answer.
 */
function resolvedTokenNames(root: string, runId: string, ir: IR): string[] {
  const file = join(root, '.gridwright', 'runs', runId, 'resolutions.json')
  if (!existsSync(file)) return Object.values(ir.tokens)
  try {
    const resolutions = JSON.parse(readFileSync(file, 'utf8')) as Array<{
      match?: { name: string }
      note?: string
    }>
    const names = new Set<string>()
    for (const r of resolutions) {
      if (r.match) { names.add(r.match.name); continue }
      // `already expressible: stop 1 → colors.cream.200, stop 2 → colors.primary.800`
      // The trailing dot is the sentence's, not the token's: a note reads
      // "stop 2 → colors.primary.800. A composite token would duplicate them."
      for (const m of (r.note ?? '').matchAll(/\u2192\s*([A-Za-z][\w.-]*)/g)) {
        names.add(m[1]!.replace(/[.,;]+$/, ''))
      }
    }
    return names.size > 0 ? [...names].sort() : Object.values(ir.tokens)
  } catch {
    return Object.values(ir.tokens)
  }
}

/** `Card/index.tsx` is Card, `Card.tsx` is Card — the name the codebase uses. */
function componentName(path: string): string | null {
  const parts = path.replace(/\\/g, '/').split('/')
  const file = parts[parts.length - 1] ?? ''
  const base = file.replace(/\.[^.]+$/, '')
  const name = base === 'index' ? (parts[parts.length - 2] ?? '') : base
  return /^[A-Z]/.test(name) ? name : null
}

/** Slots become props; the Figma copy is their default value. */
function propsOf(ir: IR): string[] {
  const out = new Set<string>()
  const walk = (nodes: IR['children']) => {
    for (const n of nodes) {
      if (n.slot) out.add(n.slot)
      if (n.children) walk(n.children)
    }
  }
  walk(ir.children)
  for (const v of Object.keys(ir.variants ?? {})) out.add(v)
  return [...out]
}
