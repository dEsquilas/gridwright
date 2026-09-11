/**
 * Law 1 — The workflow is state on disk, not text in a prompt.
 *
 * The opposite has already been tried: an earlier project has a five-phase
 * workflow written in prose, and the agent skips the similarity-analysis phase
 * every time the request looks simple. A prompt is a suggestion; a long prompt
 * is a suggestion that also dilutes as context grows.
 *
 * Here the order is not argued for, it is enforced: `advance()` only accepts
 * the stage that is actually current, and the mandatory ones cannot be skipped
 * even when explicitly asked.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { paths } from './paths.js'
import { STAGES, STAGE_SPECS, isImplemented, type Stage, type Actor } from './stages.js'

export type StageStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed' | 'blocked'

export interface StageRecord {
  status: StageStatus
  startedAt?: string
  finishedAt?: string
  /** Required for `skipped` and `failed`: a stage that did not run has to say
   *  why. It does not vanish from the history. */
  reason?: string
  /** Data the stage produced that later stages need. */
  output?: Record<string, unknown>
}

export type RunMode = 'component' | 'view'

export interface RunState {
  version: 1
  id: string
  mode: RunMode
  source: { url: string; fileKey: string; nodeId: string }
  /** Proposed component name. Refined during `plan`. */
  name: string
  stage: Stage
  stages: Record<Stage, StageRecord>
  /**
   * For a section: the view run that owns it.
   *
   * A section goes through every stage, but the ones that write something the
   * whole project shares are the parent's — tokens once for the whole page, the
   * library's structure once, and registration in order at the end. That is
   * what lets sections run side by side without stepping on each other.
   */
  parent?: string
  /** For a view: its immediate children, classified, and where each one is. */
  sections?: SectionRef[]
  createdAt: string
  updatedAt: string
}

export interface SectionRef {
  nodeId: string
  /** What it is registered as: the component set's name, or the layer's. */
  name: string
  /** The layer's name in the view — what the view's IR calls it. The view's
   *  author matches the two: `home-signals` in the IR is `OverlayForm` in the
   *  library. */
  layerName: string
  /** module or layout, for a reusable section. */
  kind?: string
  /** Made from a main component, so it belongs in the library. A section that
   *  is not was drawn for this page, and is built as part of the view. */
  reusable: boolean
  /** Component set or main component. Two sections with one identity are one. */
  identity?: string
  /** The run building it. Absent when it is reused or is part of the view. */
  run?: string
  /** Already in the library under this name: reused, not rebuilt. */
  reuses?: string
  /** Another section in this view with the same identity is the one built. */
  sameAs?: string
}

/** What `gw next` hands back to Claude. This is the whole protocol. */
export interface Directive {
  run: string
  stage: Stage
  actor: Actor
  action: string
  inputs: Record<string, unknown>
  gate: string | null
  /** When the stage is not built yet we say so explicitly instead of
   *  pretending it ran. */
  blocked?: { reason: string; phase: number }
}

export function newRunState(args: {
  id: string
  mode: RunMode
  url: string
  fileKey: string
  nodeId: string
  name: string
}): RunState {
  const now = new Date().toISOString()
  const stages = Object.fromEntries(
    STAGES.map((s) => [s, { status: 'pending' as StageStatus }]),
  ) as Record<Stage, StageRecord>
  return {
    version: 1,
    id: args.id,
    mode: args.mode,
    source: { url: args.url, fileKey: args.fileKey, nodeId: args.nodeId },
    name: args.name,
    // `init` belongs to the project, not to the run: a run starts at fetch.
    stage: 'fetch',
    stages,
    createdAt: now,
    updatedAt: now,
  }
}

export function saveState(root: string, state: RunState): void {
  const path = paths.state(root, state.id)
  mkdirSync(dirname(path), { recursive: true })
  state.updatedAt = new Date().toISOString()
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n')
}

export function loadState(root: string, id: string): RunState | null {
  const path = paths.state(root, id)
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8')) as RunState
}

/** Runs ordered by update time, most recent first. */
export function listRuns(root: string): RunState[] {
  const dir = paths.runs(root)
  if (!existsSync(dir)) return []
  const out: RunState[] = []
  for (const id of readdirSync(dir)) {
    const s = loadState(root, id)
    if (s) out.push(s)
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/** The open run, if there is one. This is what the SessionStart hook queries in
 *  order to resume after an interruption. */
export function activeRun(root: string): RunState | null {
  return listRuns(root).find((r) => r.stage !== 'report' || r.stages.report.status !== 'done') ?? null
}

export function markRunning(state: RunState, stage: Stage): void {
  state.stages[stage] = { ...state.stages[stage], status: 'running', startedAt: new Date().toISOString() }
}

/**
 * Closes a stage and moves the pointer. It refuses to close a stage that is not
 * the current one: if Claude tries to jump from `fetch` to `author`, this
 * throws.
 */
export function advance(
  state: RunState,
  stage: Stage,
  result: { status: 'done' | 'skipped' | 'failed'; reason?: string; output?: Record<string, unknown> },
): void {
  if (state.stage !== stage) {
    throw new Error(
      `cannot close "${stage}": the run is at "${state.stage}". ` +
        `Stages are not skipped (Law 1).`,
    )
  }
  if (result.status === 'skipped') {
    // A view is a composition. Skipping survey there means reimplementing the
    // button, the card and the hero that already exist, and six views later
    // nobody can tell which Card is the real one. For a single component it is
    // merely useful; here it is the whole point.
    if (stage === 'survey' && state.mode === 'view') {
      throw new Error(
        'survey cannot be skipped in view mode. A view without it rebuilds what ' +
          'the project already has.',
      )
    }
    if (STAGE_SPECS[stage].mandatory) {
      throw new Error(
        `"${stage}" is mandatory and cannot be skipped. ` +
          `It is one of the stages that build the system.`,
      )
    }
    if (!result.reason) {
      throw new Error(`skipping "${stage}" requires a reason: a stage that did not run has to say why`)
    }
  }
  if (result.status === 'failed' && !result.reason) {
    throw new Error(`marking "${stage}" as failed requires a reason`)
  }

  state.stages[stage] = {
    ...state.stages[stage],
    status: result.status,
    finishedAt: new Date().toISOString(),
    ...(result.reason ? { reason: result.reason } : {}),
    ...(result.output ? { output: result.output } : {}),
  }

  if (result.status === 'failed') return // stay on the stage so it can be retried

  const i = STAGES.indexOf(stage)
  if (i < STAGES.length - 1) state.stage = STAGES[i + 1]!
}

/**
 * The protocol. Claude does not decide which stage comes next: it asks this.
 */
export function directive(
  state: RunState,
  root: string,
  inputs: Record<string, unknown> = {},
  conventions?: unknown,
): Directive {
  const stage = state.stage
  const spec = STAGE_SPECS[stage]
  const base: Directive = {
    run: state.id,
    stage,
    actor: spec.actor,
    action: spec.summary,
    inputs: { root, name: state.name, mode: state.mode, ...inputs },
    // Asked as a choice, never as an open question: the agent turns the
    // decision into options and the person picks one.
    gate: spec.gate ? 'Requires human approval before advancing (Law 5). Ask with options, not an open question.' : null,
  }
  // `author` and `plan` need the project's own shape, not just its paths. A
  // component written in the wrong shape compiles, renders, scores well and
  // does not work in the product — and nothing downstream checks for that,
  // because every check gridwright has is about fidelity to the design.
  if ((stage === 'author' || stage === 'plan') && conventions) {
    base.inputs.conventions = conventions

    // The one entry that applies arrives in `inputs.placement`, decided by the
    // caller — the taxonomy lives in `library`, and core cannot depend on it.
    // `plan` proposes a path and `author` writes the file, and both were
    // choosing from a list of directories with nothing to say which was for
    // what, so a header, a modal and a view all went where the most files
    // already were.
  }

  // A section's last two stages are the view's to close. `library:register`
  // writes the registry and the barrel, which every section shares, so the
  // parent does it for all of them in order; and there is no report of one
  // section, there is the view's.
  if (state.parent && (stage === 'library:register' || stage === 'report')) {
    base.actor = 'code'
    base.action = `Closed by the view run ${state.parent}. This section is finished — stop here.`
    base.inputs.owner = state.parent
    base.gate = null
  }

  if (!isImplemented(stage)) {
    base.blocked = {
      reason: `Stage "${stage}" belongs to phase ${spec.phase} of the spec and is not built yet.`,
      phase: spec.phase,
    }
  }
  return base
}

/**
 * A section is finished when it has been frozen.
 *
 * `golden` rather than `report`, because the last two stages of a section are
 * the parent's: it is done with everything that is its own to do.
 */
export function sectionFinished(run: RunState): boolean {
  const g = run.stages.golden.status
  return g === 'done' || g === 'skipped'
}

/**
 * A section that finished without being built: skipped on the record, so it
 * wrote no file and there is nothing of it to register.
 *
 * The view's `library:register` asked every finished section for its file and
 * stopped at the first that had none — a section distill refused, skipped with
 * `gw skip`. Every section after it stayed out of the library, and the view,
 * whose register stage is mandatory, could never close.
 */
export function sectionSkipped(run: RunState): boolean {
  return sectionFinished(run) && run.stages.author.status === 'skipped'
}

/** The sections of a view that still have work to do, with their runs. */
export function pendingSections(root: string, view: RunState): Array<SectionRef & { state: RunState | null }> {
  return (view.sections ?? [])
    .filter((s) => s.run)
    .map((s) => ({ ...s, state: loadState(root, s.run!) }))
    .filter((s) => !s.state || !sectionFinished(s.state))
}
