/**
 * The run stages: `fetch`, `distill`, and the `next` protocol.
 *
 * Law 1: Claude does not decide which stage comes next, it asks `gw next`.
 * That is why `next` has JSON output — it is a protocol between programs, not a
 * message.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  loadConfig, paths, newRunState, saveState, loadState, listRuns, activeRun,
  advance, markRunning, directive, resolveCredentials, isImplemented, pendingSections,
  sectionFinished, STAGES, STAGE_SPECS,
  type RunState, type GridwrightConfig, type IR, type CredentialOrigin, type SectionRef,
  type RawToken,
} from '@gridwright/core'
import {
  FigmaClient, FigmaError, parseFigmaUrl, distill, shouldHalt, extractAssets,
  toPascalCase, slugify, detectSections, stubSections, findNode,
  type FigmaNode, type SectionInfo,
} from '@gridwright/figma'
import { inferKind, readRegistry, findByIdentity } from '@gridwright/library'
import { ok, fail, info, warn, step, dim, bold, green, yellow, table, missingCredentials } from '../ui.js'
import { autorun, printStop } from './autorun.js'

function requireConfig(root: string): GridwrightConfig {
  const config = loadConfig(root)
  if (!config) {
    fail(
      `This project is not configured.`,
      'Run `gw init` at the root of the repo where the component will live.',
    )
  }
  return config
}

function requireClient(root: string): { client: FigmaClient; origin: CredentialOrigin } {
  const creds = resolveCredentials(root)
  if (!creds) missingCredentials()
  return { client: new FigmaClient({ token: creds.figmaToken }), origin: creds.origin }
}

/**
 * Where the rejected token actually came from decides the remedy, and telling
 * someone to run `gw auth login` when a stale `.env` outranks it sends them in
 * a circle: the project's .env wins over the machine config (Law 10.b), so the
 * new token would never be reached.
 *
 * Found by pointing gridwright at a real project whose committed token had
 * expired.
 */
export function authRemedy(origin: CredentialOrigin, root: string): string {
  switch (origin) {
    case 'project-dotenv':
      return `The token came from ${join(root, '.env')}, and that file takes precedence over ` +
        `the one saved on this machine — running \`gw auth login\` alone will NOT fix it. ` +
        `Update FIGMA_TOKEN in that .env, or remove the line so the machine credential is used.`
    case 'env':
      return 'The token came from the FIGMA_TOKEN environment variable, which outranks every ' +
        'other source. Unset it or update it in the shell that launched this.'
    case 'user-config':
      return 'Run `! gw auth login` in your terminal to replace it.'
  }
}

/** A readable, stable id: the frame name plus a counter. */
function makeRunId(root: string, frameSlug: string): string {
  const existing = new Set(listRuns(root).map((r) => r.id))
  for (let i = 1; i < 1000; i++) {
    const id = `${frameSlug}-${String(i).padStart(2, '0')}`
    if (!existing.has(id)) return id
  }
  return `${frameSlug}-${Date.now()}`
}

export async function build(root: string, url: string, opts: { mode?: 'component' | 'view' } = {}): Promise<void> {
  requireConfig(root)
  const ref = parseFigmaUrl(url)

  // Credentials are checked BEFORE opening the run: there is no point leaving a
  // half-created run behind only for it to die in `fetch` (Law 10,
  // "precondition").
  const { client, origin } = requireClient(root)

  step(`Querying Figma — node ${ref.nodeId}`)
  let doc: FigmaNode
  let meta: Pick<Awaited<ReturnType<FigmaClient['node']>>, 'components' | 'componentSets'> =
    { components: {}, componentSets: {} }
  try {
    const res = await client.node(ref.fileKey, ref.nodeId)
    doc = res.document
    meta = { components: res.components, componentSets: res.componentSets }
  } catch (e) {
    if (e instanceof FigmaError) {
      const hint = e.status === 401 || e.status === 403
        ? `${e.hint}\n\n${authRemedy(origin, root)}`
        : e.hint
      fail(e.message, hint)
    }
    throw e
  }

  const id = makeRunId(root, slugify(doc.name))
  const state = newRunState({
    id, mode: opts.mode ?? 'component', url,
    fileKey: ref.fileKey, nodeId: ref.nodeId, name: toPascalCase(doc.name),
  })
  mkdirSync(paths.run(root, id), { recursive: true })
  saveState(root, state)
  ok(`Run ${bold(id)} — frame "${doc.name}" → ${state.name}`)

  // A view with sections made from library components builds them first, in
  // parallel, and composes itself after. One without any is a single run,
  // the way views always were.
  if (state.mode === 'view') {
    const sections = detectSections(doc, meta.components, meta.componentSets)
    if (sections.some((sec) => sec.reusable)) {
      await buildView(root, state, doc, sections, client)
      printStop(autorun(root, state))
      return
    }
    info('No sections made from library components under this frame — building it as one view.')
  }

  await runFetch(root, state, doc, client)
  await runDistill(root, state)

  // Then as far as the CLI legitimately can. It stops at a gate, at a stage
  // that is the model's, or at one missing an input — and says which.
  printStop(autorun(root, state))
}

/**
 * Picks a run back up after a gate.
 *
 * The same chaining `build` does, from wherever the run currently sits. Without
 * it, approving a gate leaves you re-running stages by hand one at a time for
 * no reason — the CLI already knows which ones it can do.
 */
export function resume(root: string, id?: string): void {
  const run = id ? loadState(root, id) : activeRun(root)
  if (!run) fail('No open run.', 'Start one with `gw build "<figma-url>"`.')
  printStop(autorun(root, run))
}

/**
 * A view and its sections, built by the view.
 *
 * The view is the only run that writes anything shared (specs/004). So it
 * fetches the page once, gives every section to build its own run with its own
 * IR, reference and assets, and puts every section's values in its own
 * raw-tokens — `resolve` and `tokens` then run once, for the whole page, with
 * one gate and one name per colour. The sections wait at `plan` until the view
 * reaches `author`, and then run side by side.
 */
async function buildView(
  root: string,
  view: RunState,
  doc: FigmaNode,
  sections: SectionInfo[],
  client: FigmaClient,
): Promise<void> {
  const config = requireConfig(root)
  const registry = readRegistry(root, config)
  const { fileKey } = view.source

  // Reusable, reused, a repeat, or the view's own.
  const refs: SectionRef[] = []
  const firstOf = new Map<string, string>()
  for (const sec of sections) {
    if (!sec.reusable) {
      refs.push({ nodeId: sec.nodeId, name: sec.name, layerName: sec.layerName, reusable: false })
      continue
    }
    // A section of a page is chrome or content: a layout part or a module.
    // Anything else the name suggests is the name misleading — `overlay-form`
    // is a form set over an image, not a modal, and a section called "page"
    // is not a view.
    const kind = inferKind(sec.name) === 'layout' ? 'layout' : 'module'
    const base: SectionRef = {
      nodeId: sec.nodeId, name: toPascalCase(sec.name), layerName: sec.layerName,
      kind, reusable: true, identity: sec.identity!,
    }
    const existing = findByIdentity(registry, sec.identity!)
    if (existing) { refs.push({ ...base, reuses: existing[0] }); continue }
    const first = firstOf.get(sec.identity!)
    if (first) { refs.push({ ...base, sameAs: first }); continue }
    firstOf.set(sec.identity!, sec.nodeId)
    refs.push(base)
  }
  const toBuild = refs.filter((r) => r.reusable && !r.reuses && !r.sameAs)
  const inLibrary = new Set(sections.filter((sec) => sec.reusable).map((sec) => sec.nodeId))
  // Run ids from the name as the library wrote it, not the PascalCase one:
  // `solutions-entry-01`, not `solutionsentry-01`.
  const slugOf = new Map(sections.map((sec) => [sec.nodeId, slugify(sec.name)]))

  // fetch — one batch of reference images: the page, and every section to build.
  markRunning(view, 'fetch')
  saveState(root, view)
  const urls = await client.imageUrls(fileKey, [view.source.nodeId, ...toBuild.map((r) => r.nodeId)], { scale: 2 })
  const download = async (id: string, dest: string): Promise<boolean> => {
    const u = urls.get(id)
    if (!u) return false
    writeFileSync(dest, Buffer.from(await (await fetch(u)).arrayBuffer()))
    return true
  }

  // The view reads its sections as empty boxes — the thousands of nodes inside
  // them are their own runs' business (Law 2) — and extracts only the assets of
  // its own parts, or every section's images would be the page's too.
  const stubbed = stubSections(doc, inLibrary)
  writeFileSync(paths.rawTree(root, view.id), JSON.stringify(stubbed, null, 2) + '\n')
  const reference = await download(view.source.nodeId, paths.reference(root, view.id))
  const ownParts: FigmaNode = { ...doc, children: (doc.children ?? []).filter((c) => !inLibrary.has(c.id)) }
  const viewAssets = await extractAssets(
    client, ownParts, { fileKey, nodeId: view.source.nodeId },
    paths.runAssets(root, view.id), { prefix: slugify(doc.name) },
  )
  advance(view, 'fetch', {
    status: 'done',
    output: { reference, assets: viewAssets.assets.length, sections: refs.length, building: toBuild.length },
  })
  saveState(root, view)

  // Each section to build: its own run, at `plan`, with the shared stages
  // closed on the record by the view that did them.
  for (const ref of toBuild) {
    const subtree = findNode(doc, ref.nodeId)
    if (!subtree) continue
    const id = makeRunId(root, slugOf.get(ref.nodeId) ?? slugify(ref.name))
    const child = newRunState({
      id, mode: 'component',
      url: `https://www.figma.com/design/${fileKey}/section?node-id=${ref.nodeId.replace(':', '-')}`,
      fileKey, nodeId: ref.nodeId, name: ref.name,
    })
    child.parent = view.id
    ref.run = id
    mkdirSync(paths.run(root, id), { recursive: true })
    writeFileSync(paths.rawTree(root, id), JSON.stringify(subtree, null, 2) + '\n')

    const hasReference = await download(ref.nodeId, paths.reference(root, id))
    const assets = await extractAssets(
      client, subtree, { fileKey, nodeId: ref.nodeId },
      paths.runAssets(root, id), { prefix: slugify(ref.name) },
    )
    advance(child, 'fetch', { status: 'done', output: { reference: hasReference, assets: assets.assets.length, by: view.id } })

    const { ir, measurements, rawTokens } = distill(
      subtree, { fileKey, nodeId: ref.nodeId },
      { ...config.distill, assets: assetFiles(root, id) },
    )
    writeFileSync(paths.ir(root, id), JSON.stringify(ir, null, 2) + '\n')
    writeFileSync(paths.measurements(root, id), JSON.stringify(measurements, null, 2) + '\n')
    writeFileSync(paths.rawTokens(root, id), JSON.stringify(rawTokens, null, 2) + '\n')

    const halt = shouldHalt(ir, config.distill)
    if (halt.halt) {
      // Recorded and left where it is: the view cannot be composed until this
      // is fixed in Figma, and it says so at `author`.
      advance(child, 'distill', { status: 'failed', reason: halt.reason! })
      saveState(root, child)
      warn(`${ref.name}: ${halt.reason}`)
      continue
    }
    advance(child, 'distill', {
      status: 'done',
      output: { nodes: countNodes(ir), hash: ir.hash, rawTokens: rawTokens.length, measured: measurements.nodes.length },
    })
    for (const stage of ['resolve', 'tokens', 'library:ensure', 'survey'] as const) {
      advance(child, stage, { status: 'done', output: { by: view.id } })
    }
    saveState(root, child)
  }

  // The view's own IR, and the values of the whole page.
  markRunning(view, 'distill')
  saveState(root, view)
  const { ir, measurements, rawTokens } = distill(
    stubbed, { fileKey, nodeId: view.source.nodeId },
    { ...config.distill, assets: assetFiles(root, view.id) },
  )
  writeFileSync(paths.ir(root, view.id), JSON.stringify(ir, null, 2) + '\n')
  writeFileSync(paths.measurements(root, view.id), JSON.stringify(measurements, null, 2) + '\n')
  const page = mergeRawTokens([
    rawTokens,
    ...toBuild.filter((r) => r.run && existsSync(paths.rawTokens(root, r.run))).map((r) =>
      JSON.parse(readFileSync(paths.rawTokens(root, r.run!), 'utf8')) as RawToken[]),
  ])
  writeFileSync(paths.rawTokens(root, view.id), JSON.stringify(page, null, 2) + '\n')

  const halt = shouldHalt(ir, config.distill)
  if (halt.halt) {
    advance(view, 'distill', { status: 'failed', reason: halt.reason! })
    view.sections = refs
    saveState(root, view)
    fail('The view\'s own parts are not usable.', halt.reason)
  }
  advance(view, 'distill', {
    status: 'done',
    output: { nodes: countNodes(ir), hash: ir.hash, sections: refs.length, rawTokens: page.length },
  })
  view.sections = refs
  saveState(root, view)

  step(`${refs.length} sections under "${doc.name}" — ${page.length} values across the page`)
  printSections(root, refs)
}

/**
 * One list of design values for the whole page.
 *
 * The same colour arriving from four sections is one value used in four
 * places, not four values — which is the whole reason tokens are the view's to
 * resolve rather than each section's.
 */
function mergeRawTokens(lists: RawToken[][]): RawToken[] {
  const byKey = new Map<string, RawToken>()
  for (const list of lists) for (const t of list) {
    const key = `${t.kind}|${t.value}`
    const seen = byKey.get(key)
    if (seen) seen.usedIn = [...new Set([...seen.usedIn, ...t.usedIn])]
    else byKey.set(key, { ...t, usedIn: [...t.usedIn] })
  }
  return [...byKey.values()]
}

/** What the view's author needs to know about each section. */
function sectionInputs(root: string, view: RunState): Array<Record<string, unknown>> {
  return (view.sections ?? []).map((r) => {
    const child = r.run ? loadState(root, r.run) : null
    const file = child?.stages.author.output?.file
    return {
      name: r.name,
      layerName: r.layerName,
      reusable: r.reusable,
      ...(r.kind ? { kind: r.kind } : {}),
      ...(r.run ? { run: r.run, finished: child ? sectionFinished(child) : false } : {}),
      ...(typeof file === 'string' ? { file } : {}),
      ...(r.reuses ? { reuses: r.reuses } : {}),
      ...(r.sameAs ? { sameAs: r.sameAs } : {}),
    }
  })
}

function printSections(root: string, refs: SectionRef[]): void {
  for (const r of refs) {
    const child = r.run ? loadState(root, r.run) : null
    const [mark, what] = !r.reusable ? [dim('·'), dim('part of the view — not in the library')]
      : r.reuses ? [green('↻'), `already in the library as ${bold(r.reuses)}`]
      : r.sameAs ? [dim('='), dim('same component as another section here — built once')]
      : child?.stages.distill.status === 'failed' ? [yellow('!'), `run ${r.run} — ${yellow('distill failed')}`]
      : child ? [green('✓'), `run ${r.run} ${dim(`· ${child.stage}`)}`]
      : [yellow('!'), 'no run']
    const kind = r.kind ? r.kind.padEnd(8) : dim('—'.padEnd(8))
    console.log(`    ${mark} ${kind} ${r.name.padEnd(24)} ${what}`)
  }
}

async function runFetch(root: string, state: RunState, doc: FigmaNode, client: FigmaClient): Promise<void> {
  markRunning(state, 'fetch')
  saveState(root, state)

  writeFileSync(paths.rawTree(root, state.id), JSON.stringify(doc, null, 2) + '\n')

  // Reference image of the whole frame. Fidelity is measured against this
  // (Law 7); it is not one of the component's assets.
  let reference = false
  const urls = await client.imageUrls(state.source.fileKey, [state.source.nodeId], { scale: 2 })
  const refUrl = urls.get(state.source.nodeId)
  if (refUrl) {
    const buf = Buffer.from(await (await fetch(refUrl)).arrayBuffer())
    writeFileSync(paths.reference(root, state.id), buf)
    reference = true
  } else {
    warn('Figma returned no reference image for this node.')
  }

  const manifest = await extractAssets(
    client, doc,
    { fileKey: state.source.fileKey, nodeId: state.source.nodeId },
    paths.runAssets(root, state.id),
    { prefix: slugify(doc.name) },
  )

  step(`${manifest.assets.length} assets${manifest.optimized ? '' : ' (unoptimized: sharp missing)'}`)
  for (const a of manifest.assets) {
    const t = a.trimmed ? dim(` · trimmed ${a.trimmed.from} → ${a.trimmed.to}`) : ''
    console.log(`    ${dim('·')} ${a.file} ${dim(`${a.width}x${a.height}`)}${t}`)
  }

  advance(state, 'fetch', {
    status: 'done',
    output: { assets: manifest.assets.length, reference, optimized: manifest.optimized },
  })
  saveState(root, state)
}

async function runDistill(root: string, state: RunState): Promise<void> {
  const config = requireConfig(root)
  markRunning(state, 'distill')
  saveState(root, state)

  const doc = JSON.parse(readFileSync(paths.rawTree(root, state.id), 'utf8')) as FigmaNode
  const { ir, measurements, rawTokens } = distill(
    doc,
    { fileKey: state.source.fileKey, nodeId: state.source.nodeId },
    { ...config.distill, assets: assetFiles(root, state.id) },
  )

  writeFileSync(paths.ir(root, state.id), JSON.stringify(ir, null, 2) + '\n')
  writeFileSync(paths.measurements(root, state.id), JSON.stringify(measurements, null, 2) + '\n')
  // Kept for `resolve`, which runs later and cannot re-derive them without
  // re-fetching the whole tree.
  writeFileSync(paths.rawTokens(root, state.id), JSON.stringify(rawTokens, null, 2) + '\n')

  const rawSize = readFileSync(paths.rawTree(root, state.id), 'utf8').length
  const irSize = JSON.stringify(ir).length
  step(
    `IR: ${countNodes(ir)} nodes, ${rawTokens.length} raw values ` +
      dim(`(${fmtBytes(rawSize)} → ${fmtBytes(irSize)}, ${Math.round((1 - irSize / rawSize) * 100)}% smaller)`),
  )
  console.log(`    ${dim('hash')} ${ir.hash}`)

  printWarnings(ir)

  const halt = shouldHalt(ir, config.distill)
  if (halt.halt) {
    advance(state, 'distill', { status: 'failed', reason: halt.reason! })
    saveState(root, state)
    fail('The IR is not usable.', halt.reason)
  }

  advance(state, 'distill', {
    status: 'done',
    output: {
      nodes: countNodes(ir), warnings: ir.warnings.length, hash: ir.hash,
      rawTokens: rawTokens.length, measured: measurements.nodes.length,
    },
  })
  saveState(root, state)
}

/**
 * Errors and warnings are both shown in full; only `info` is collapsed to a
 * count.
 *
 * A dropped gradient is a `warn`, and collapsing it into "3 informational
 * warnings" hides exactly the thing someone needs to see — the design value
 * that will be missing from their component.
 */
function printWarnings(ir: IR): void {
  if (ir.warnings.length === 0) return
  const loud = ir.warnings.filter((w) => w.severity !== 'info')
  const quiet = ir.warnings.length - loud.length

  for (const w of loud.slice(0, 8)) {
    const mark = w.severity === 'error' ? yellow('!') : dim('!')
    console.log(`    ${mark} ${w.message}${w.path ? dim(` — ${w.path}`) : ''}`)
  }
  if (loud.length > 8) console.log(dim(`    … and ${loud.length - 8} more`))
  if (quiet > 0) console.log(dim(`    ${quiet} informational (unnamed layers, deep nesting)`))
}

/** The protocol. `--json` is what Claude consumes; without the flag it prints
 *  for a human. `--run` is how a section asks about itself: with several runs
 *  open at once, "the active run" is whichever changed last, which is nobody's
 *  section in particular. */
export function printNext(root: string, state: RunState | null, opts: { json: boolean; run?: string }): void {
  const run = state ?? (opts.run ? loadState(root, opts.run) : activeRun(root))
  if (!run) {
    if (opts.json) { console.log(JSON.stringify({ error: opts.run ? 'no-such-run' : 'no-active-run' })); process.exitCode = 1; return }
    info(opts.run ? `No run ${opts.run}. List them with \`gw status\`.` : 'No open run. Start one with `gw build <figma-url>`.')
    return
  }

  const d = directive(run, root, {
    ir: existsSync(paths.ir(root, run.id)) ? paths.ir(root, run.id) : undefined,
    reference: existsSync(paths.reference(root, run.id)) ? paths.reference(root, run.id) : undefined,
    assets: existsSync(paths.runAssets(root, run.id)) ? paths.runAssets(root, run.id) : undefined,
    survey: existsSync(paths.survey(root, run.id)) ? paths.survey(root, run.id) : undefined,
    // What kind of thing this is, and therefore where it goes. A heuristic on
    // the frame's name — the only signal there is before anything is built,
    // and a good one: nobody names a modal "Section". `plan` is a person's
    // step and overrides it, which is why a guess is allowed here.
    placement: placementInputFor(root, run),
  }, loadConfig(root)?.conventions)

  // A section's tokens were resolved by its view, once for the whole page. It
  // reads them there — and it waits until they are written, because a section
  // authored against tokens that do not exist yet writes raw values.
  if (run.parent) {
    const parent = loadState(root, run.parent)
    if (existsSync(paths.resolutions(root, run.parent))) d.inputs.resolutions = paths.resolutions(root, run.parent)
    const closing = run.stage === 'library:register' || run.stage === 'report'
    if (parent && !closing && STAGES.indexOf(parent.stage) < STAGES.indexOf('author')) {
      d.actor = 'code'
      d.action = `Waiting for the view ${parent.id} to reach author — its tokens and library are not ready yet.`
      d.inputs.waitingOn = parent.id
    }
  }

  if (run.mode === 'view' && run.sections) {
    d.inputs.sections = sectionInputs(root, run)
    const pending = run.stage === 'author' ? pendingSections(root, run) : []
    if (pending.length > 0) {
      d.action = `Build the ${pending.length} section${pending.length === 1 ? '' : 's'} first, in parallel — one agent each, ` +
        'every stage from plan to golden, --run on every command. The view is composed once they are all frozen.'
      d.inputs.pending = pending.map((p) => ({ run: p.run, name: p.name, kind: p.kind, stage: p.state?.stage ?? 'missing' }))
    }
  }

  if (opts.json) { console.log(JSON.stringify(d, null, 2)); return }

  console.log(bold(`Run ${run.id} — stage ${green(d.stage)}`))
  table([
    ['who', d.actor === 'agent' ? 'Claude' : d.actor === 'human' ? 'you' : 'the CLI'],
    ['what', d.action],
    ...(d.gate ? [['gate', d.gate] as [string, string]] : []),
  ])
  if (d.blocked) {
    console.log()
    warn(d.blocked.reason)
    console.log(dim(`  Phase 1 ends here. Stages from phases 2-5 are not built yet.`))
  }
  if (run.mode === 'view' && run.sections) {
    console.log()
    printSections(root, run.sections)
  }
}

export function status(root: string, opts: { json?: boolean } = {}): void {
  const runs = listRuns(root)
  if (opts.json) { console.log(JSON.stringify(runs, null, 2)); return }
  if (runs.length === 0) { info('No runs yet.'); return }

  // A view's sections are listed under it. Listed beside it, nine runs read as
  // nine unrelated components, with nothing to say which page they were for.
  const children = new Map<string, RunState[]>()
  for (const r of runs) if (r.parent) children.set(r.parent, [...(children.get(r.parent) ?? []), r])
  const ids = new Set(runs.map((r) => r.id))

  for (const r of runs) {
    if (r.parent && ids.has(r.parent)) continue
    const done = Object.values(r.stages).filter((s) => s.status === 'done').length
    console.log(`${bold(r.id)} ${dim(`${r.name} · ${r.mode}`)}`)
    console.log(`  ${green(String(done))} stages closed · current: ${yellow(r.stage)} ${dim(STAGE_SPECS[r.stage].summary)}`)
    const failed = Object.entries(r.stages).filter(([, s]) => s.status === 'failed')
    for (const [name, s] of failed) console.log(`  ${dim(`✗ ${name}: ${s.reason ?? ''}`)}`)

    const sections = children.get(r.id) ?? []
    if (sections.length > 0) {
      const finished = sections.filter(sectionFinished).length
      console.log(`  ${dim(`sections · ${finished} of ${sections.length} finished`)}`)
      for (const c of sections.sort((a, b) => a.name.localeCompare(b.name))) {
        const mark = sectionFinished(c) ? green('✓') : c.stages.distill.status === 'failed' ? yellow('!') : dim('·')
        console.log(`    ${mark} ${c.name.padEnd(24)} ${dim(c.id.padEnd(28))} ${yellow(c.stage)}`)
      }
    }
  }
}

export function showIr(root: string, id?: string): void {
  const run = id ? loadState(root, id) : activeRun(root)
  if (!run) fail('Could not find that run.', 'List them with `gw status`.')
  const p = paths.ir(root, run.id)
  if (!existsSync(p)) fail(`Run ${run.id} has no IR yet.`, 'Run `gw distill`.')
  process.stdout.write(readFileSync(p, 'utf8'))
}

function countNodes(ir: IR): number {
  const walk = (ns: IR['children']): number =>
    ns.reduce((acc, n) => acc + 1 + walk(n.children ?? []), 0)
  return walk(ir.children)
}

function fmtBytes(n: number): string {
  return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.round(n / 1024)}KB`
}

export { requireConfig, isImplemented }

/** The directory this run's output belongs in, from what the design is called. */
function placementInputFor(root: string, run: RunState): { kind: string; dir: string } | undefined {
  const placements = loadConfig(root)?.conventions?.placements
  if (!placements?.length) return undefined
  const kind = inferKind(run.name, run.mode)
  const match = placements.find((p) => p.kind === kind)
  return match ? { kind, dir: match.dir } : undefined
}

/** What `fetch` wrote, keyed by the Figma node it came from, so the IR can
 *  name the file rather than guess at it. */
function assetFiles(root: string, runId: string): Map<string, string> {
  const file = join(paths.runAssets(root, runId), 'manifest.json')
  if (!existsSync(file)) return new Map()
  try {
    const m = JSON.parse(readFileSync(file, 'utf8')) as { assets: Array<{ nodeId: string; file: string }> }
    return new Map(m.assets.map((a) => [a.nodeId, a.file]))
  } catch {
    return new Map()
  }
}
