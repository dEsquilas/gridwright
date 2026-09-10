/**
 * `gw golden` — stage 12, where both kinds of verification are kept (Law 7).
 *
 * Two images are saved, and calling both of them "the baseline" is the mistake
 * this file exists to avoid.
 *
 * Each thing gets a folder — `baselines/<Name>/` — because five loose files
 * per component is two hundred images in one directory by the fortieth, and
 * nothing about the flat names said which belonged together.
 *
 * `figma.png` is Figma's own export: what the component was built against. It
 * answered "did I build it right?" once, and it is kept because otherwise
 * there is no record of what was being aimed at — it lived in `runs/`, which
 * is gitignored, and vanished with the run.
 *
 * `<viewport>.png` is a screenshot of the component itself. That is the
 * regression baseline, and it is what runs in CI: "this is how it looked when
 * you accepted it, tell me when it changes."
 *
 * They cannot be the same file. A real component carries the CMS's copy rather
 * than the mockup's lorem, so it will never match Figma pixel for pixel — and a
 * designer nudging a frame would fail a build nobody touched.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import {
  activeRun, advance, loadConfig, loadState, paths, saveState,
  type Framework, type GridwrightConfig, type RunScore, type RunState,
} from '@gridwright/core'
import { ok, fail, info, warn, dim, bold, green, yellow } from '../ui.js'

export interface GoldenArgs {
  run?: string
  component?: string
  approve?: boolean
}

export function runGolden(root: string, args: GoldenArgs): void {
  const config = loadConfig(root)
  if (!config) fail('This project is not configured.', 'Run `gw init` first.')
  const run = args.run ? loadState(root, args.run) : activeRun(root)
  if (!run) fail('No open run.', 'Start one with `gw build "<figma-url>"`.')

  const score = run.stages.verify.output?.score as RunScore | undefined
  if (!score) {
    fail(
      `Run ${run.id} has not been verified.`,
      'Freezing a baseline from an unmeasured component pins whatever it happens to look\n' +
        'like right now, mistakes included. Run `gw verify` first.',
    )
  }

  // Every viewport the score has, not the configured ones. `verify` adds the
  // design's own width on top of them, and that is the one viewport where the
  // comparison means anything — freezing all the others and not that one left
  // the dashboard with no render to put beside the design.
  const shots = score.viewports
    .map((v) => ({ viewport: v.viewport, file: shotFor(root, run.id, v.viewport) }))
    .filter((s) => existsSync(s.file))

  if (shots.length === 0) {
    fail('No screenshots to freeze.', 'Run `gw verify` — the baselines come from its renders.')
  }

  // Named after the component, not the Figma frame. Three frames called
  // "Wrapper full" in one file would otherwise overwrite each other's
  // baselines, and none of those names is what the component is called.
  const name = componentName(run) ?? run.name

  // Its own folder. Flat names put five files per component in one directory,
  // and put the design's export in the same namespace as the render frozen for
  // the viewport called `design`, where they collided.
  const dir = paths.baseline(root, name)
  mkdirSync(dir, { recursive: true })
  const frozen: string[] = []

  // Figma's export, kept alongside the renders. It lived in `runs/` until now,
  // which is gitignored, so there was no record of what the component was
  // built against once the run was cleaned up.
  //
  // Called `figma.png`, not `design.png`. `verify` renders a viewport called
  // `design` — the width the frame was drawn at — so under flat names the
  // design's export and the render at that width claimed the same file. The
  // design won, and the dashboard put it in both panes: side by side showed a
  // perfect match because it was one image twice.
  const reference = paths.reference(root, run.id)
  if (existsSync(reference)) {
    const dest = join(dir, 'figma.png')
    copyFileSync(reference, dest)
    frozen.push(relative(root, dest))
  }

  for (const s of shots) {
    const dest = join(dir, `${s.viewport}.png`)
    copyFileSync(s.file, dest)
    frozen.push(relative(root, dest))
  }

  const test = writeRegressionTest(root, config, run, name)

  ok(`Saved ${frozen.length} image${frozen.length === 1 ? '' : 's'}`)
  for (const f of frozen) {
    const what = f.endsWith('figma.png') ? dim('  ← the design, for reference')
      : f.endsWith('design.png') ? dim("  ← the render at the design's own width") : ''
    console.log(`    ${dim('·')} ${f}${what}`)
  }
  if (test) console.log(`    ${dim('·')} ${test} ${dim('(new)')}`)
  else if (!hasPlaywright(root)) {
    console.log(dim(`\n  No regression spec written: this project does not have @playwright/test.`))
    console.log(dim(`  The baselines above are what the test compares against. To turn them into one:`))
    console.log(dim(`    pnpm add -D @playwright/test  &&  gw golden`))
  }
  console.log(dim('\n  These are committed, unlike runs/ and verify/ — they are test code.'))
  if (score && !score.passed) {
    // Said plainly rather than blocking on it: the number is evidence for
    // whoever reviews the run, not a verdict that stops one.
    //
    // And said at the width the design was drawn at, when there is one. The
    // worst viewport is the rule for passing (Law 6), but it is the wrong
    // number to print beside a picture: a 1920 frame compared against a 768
    // render scored 45% here on a component that is 90% at the width it has a
    // design for, and the line read as though the component were broken.
    const at = score.viewports.find((v) => v.viewport === 'design') ?? null
    console.log(dim(
      at
        ? `  ${at.total}% at the design's own width (${at.width}px); ${score.total}% on ${score.worstViewport}, ` +
          `which has no design to compare against — worth looking at both.`
        : `  The render scored ${score.total}% against the design — worth looking at both.`,
    ))
  }

  advance(run, 'golden', { status: 'done', output: { baselines: frozen, test } })
  saveState(root, run)
  info(`Now on ${green(run.stage)}`)
}

function testPath(config: GridwrightConfig, name: string): string {
  return join(config.library.dir, '__tests__', `${name}.regression.spec.ts`)
}

/**
 * Writes a Playwright spec — once. If one already exists it is left alone,
 * because by then it may have assertions nobody wants overwritten by a
 * generator.
 *
 * And not at all when the project does not have Playwright. The spec landed in
 * a directory the tsconfig compiles, importing a package that was not
 * installed, and broke the typecheck of the repo it was written into. A tool
 * that adds a file which fails the build has done something worse than nothing
 * — the baselines are still frozen and still useful, and the person is told
 * the one command that makes the test real.
 */
function writeRegressionTest(
  root: string,
  config: GridwrightConfig,
  run: RunState,
  name: string,
): string | null {
  const rel = testPath(config, name)
  const abs = join(root, rel)
  if (existsSync(abs)) return null
  if (!hasPlaywright(root)) return null

  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, spec(config, run, name))
  return rel
}

/** Walks up to the repo root: a nested frontend usually declares its dev
 *  dependencies where the lockfile is, not beside its components. */
function hasPlaywright(root: string): boolean {
  let dir = root
  for (let up = 0; up < 6; up++) {
    const pkg = join(dir, 'package.json')
    if (existsSync(pkg)) {
      try {
        const json = JSON.parse(readFileSync(pkg, 'utf8')) as Record<string, Record<string, string>>
        const deps = { ...json.dependencies, ...json.devDependencies }
        if (deps['@playwright/test']) return true
      } catch {
        // A package.json we cannot read tells us nothing either way.
      }
    }
    if (existsSync(join(dir, '.git'))) break
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return false
}

/** The name the codebase uses, taken from the file `author` wrote. */
function componentName(run: RunState): string | null {
  const file = run.stages.author.output?.file
  if (typeof file !== 'string') return null
  const parts = file.replace(/\\/g, '/').split('/')
  const base = (parts[parts.length - 1] ?? '').replace(/\.[^.]+$/, '')
  const derived = base === 'index' ? (parts[parts.length - 2] ?? '') : base
  return /^[A-Z]/.test(derived) ? derived : null
}

/** The run's own screenshot, falling back to the shared directory for runs
 *  taken before each one kept its evidence. */
function shotFor(root: string, runId: string, viewport: string): string {
  const own = join(paths.runVerify(root, runId), `${viewport}.png`)
  return existsSync(own) ? own : join(paths.verify(root), `${viewport}.png`)
}

function spec(config: GridwrightConfig, run: RunState, name: string): string {
  // Every viewport that has a baseline, including the design's own width. A
  // frozen image no test looks at is dead weight.
  const score = run.stages.verify.output?.score as RunScore | undefined
  const heights = new Map(config.verify.viewports.map((v) => [v.name, v.height]))
  const tallest = Math.max(...config.verify.viewports.map((v) => v.height), 900)
  const viewports = (score?.viewports ?? [])
    .map((v) => `  { name: '${v.viewport}', width: ${v.width}, height: ${heights.get(v.viewport) ?? tallest} },`)
    .join('\n')

  return `import { test, expect } from '@playwright/test'

/**
 * Regression baseline for ${name} — generated by gridwright, then yours.
 *
 * This asks "did I break it?", not "does it match the design?". Fidelity to
 * Figma was checked once, when the component was built; the design will move on
 * and this must not fail because of it.
 *
 * Update the snapshots deliberately, with --update-snapshots, when a change to
 * the component is intended.
 */

const VIEWPORTS = [
${viewports}
]

for (const vp of VIEWPORTS) {
  test(\`${name} at \${vp.name}\`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height })
    // Point this at wherever the project renders components in isolation.
    await page.goto('/${name}')
    await page.evaluate(() => document.fonts.ready)

    await expect(page).toHaveScreenshot(\`\${vp.name}.png\`, {
      // Fonts and antialiasing differ between machines; the threshold absorbs
      // that without hiding a real layout change.
      maxDiffPixelRatio: 0.01,
    })
  })
}
`
}
