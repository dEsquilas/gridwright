import { describe, it, expect } from 'vitest'
import { newRunState, advance, directive, sectionFinished, type RunState } from '../src/state.js'
import { STAGES, STAGE_SPECS, isImplemented, firstBlockingStage } from '../src/stages.js'

const make = (): RunState => newRunState({
  id: 'hero-about-us-01', mode: 'component',
  url: 'https://figma.com/design/X?node-id=1-2',
  fileKey: 'X', nodeId: '1:2', name: 'HeroAboutUs',
})

describe('state machine — Law 1', () => {
  it('a run starts at fetch, not at init', () => {
    // `init` belongs to the project, not to the run.
    expect(make().stage).toBe('fetch')
  })

  it('advances in the order the spec defines', () => {
    const s = make()
    advance(s, 'fetch', { status: 'done' })
    expect(s.stage).toBe('distill')
    advance(s, 'distill', { status: 'done' })
    expect(s.stage).toBe('resolve')
  })

  // This is the whole point of the law: the order is not argued for, it is
  // enforced.
  it('refuses to close a stage that is not the current one', () => {
    const s = make()
    expect(() => advance(s, 'author', { status: 'done' })).toThrow(/cannot close/)
    expect(s.stage).toBe('fetch')
  })

  it('a failed stage does not move the pointer, so it can be retried', () => {
    const s = make()
    advance(s, 'fetch', { status: 'failed', reason: 'Figma returned 404' })
    expect(s.stage).toBe('fetch')
    expect(s.stages.fetch.reason).toBe('Figma returned 404')
  })

  it('skipping demands a reason: a stage that did not run has to say why', () => {
    const s = make()
    advance(s, 'fetch', { status: 'done' })
    advance(s, 'distill', { status: 'done' })
    advance(s, 'resolve', { status: 'done' })
    expect(() => advance(s, 'tokens', { status: 'skipped' })).toThrow()
  })

  it('the mandatory ones cannot be skipped even with a reason', () => {
    const s = make()
    for (const st of ['fetch', 'distill', 'resolve'] as const) advance(s, st, { status: 'done' })
    expect(s.stage).toBe('tokens')
    expect(() => advance(s, 'tokens', { status: 'skipped', reason: 'no new tokens' }))
      .toThrow(/mandatory/)
  })

  it('the three mandatory stages are the ones that build the system', () => {
    const mandatory = STAGES.filter((s) => STAGE_SPECS[s].mandatory)
    expect(mandatory).toEqual(['tokens', 'library:ensure', 'library:register'])
  })

  /**
   * A gate is for a decision that is expensive to undo, not for every decision.
   *
   * `plan` and `golden` used to stop the pipeline, and stopping meant the run
   * ended with nothing to judge — the point is looking at a result, and there
   * is no result until it is built. A component is a new file and a baseline is
   * a PNG; both are one `git checkout` away from gone.
   *
   * `tokens` writes to a file the whole team shares, where a badly named token
   * is inherited rather than reverted. That one still asks.
   */
  it('only what is expensive to undo still asks', () => {
    const gates = STAGES.filter((s) => STAGE_SPECS[s].gate)
    expect(gates).toContain('tokens')
    expect(gates).toContain('library:ensure')
    expect(gates).not.toContain('plan')
    expect(gates).not.toContain('golden')
  })
})

describe('protocol — what Claude gets back from `gw next`', () => {
  it('states the stage, who runs it and whether there is a gate', () => {
    const d = directive(make(), '/repo')
    expect(d).toMatchObject({ run: 'hero-about-us-01', stage: 'fetch', actor: 'code' })
    expect(d.gate).toBeNull()
  })

  it('flags the gate on the stages that have one', () => {
    const s = make()
    for (const st of ['fetch', 'distill', 'resolve'] as const) advance(s, st, { status: 'done' })
    expect(directive(s, '/repo').gate).toMatch(/human approval/)
  })

  it('every stage is built, so nothing reports as blocked', () => {
    for (const s of STAGES) expect(isImplemented(s)).toBe(true)
    expect(firstBlockingStage()).toBeNull()
  })

  /**
   * `blocked` is kept even with nothing to block. It is how the protocol admits
   * a gap instead of pretending a stage ran, and the next stage added will need
   * it — the last two gaps (`resolve`, then `survey`) both read as finished
   * from the outside until something said otherwise.
   */
  it('still reports a gap when one exists', () => {
    const s = make()
    for (const st of STAGES.slice(1, STAGES.indexOf('report'))) {
      advance(s, st, { status: 'done' })
    }
    const d = directive(s, '/repo')
    expect(d.stage).toBe('report')
    expect(d.blocked).toBeUndefined()
  })

  // A view is a composition: skipping survey there rebuilds the button, the
  // card and the hero the project already has.
  it('survey cannot be skipped in view mode', () => {
    const view = newRunState({
      id: 'home-01', mode: 'view', url: 'x', fileKey: 'X', nodeId: '1:2', name: 'HomePage',
    })
    for (const st of STAGES.slice(1, STAGES.indexOf('survey'))) {
      advance(view, st, { status: 'done' })
    }
    expect(() => advance(view, 'survey', { status: 'skipped', reason: 'nothing to reuse' }))
      .toThrow(/cannot be skipped in view mode/)
  })

  it('but can be skipped for a single component', () => {
    const s = make()
    for (const st of STAGES.slice(1, STAGES.indexOf('survey'))) {
      advance(s, st, { status: 'done' })
    }
    expect(() => advance(s, 'survey', { status: 'skipped', reason: 'single component, nothing to compose' }))
      .not.toThrow()
  })
})

describe('sections of a view — specs/004', () => {
  const section = (): RunState => {
    const s = newRunState({
      id: 'overlay-form-01', mode: 'component',
      url: 'https://figma.com/design/X?node-id=1-3', fileKey: 'X', nodeId: '1:3', name: 'OverlayForm',
    })
    s.parent = 'home-01'
    return s
  }

  // The registry and the barrel are one file each; sections registering
  // themselves in parallel would write them at the same time.
  it('a section is told that registering it is the view\'s job', () => {
    const s = section()
    s.stage = 'library:register'
    const d = directive(s, '/repo')
    expect(d.actor).toBe('code')
    expect(d.inputs.owner).toBe('home-01')
    expect(d.action).toMatch(/stop/i)
  })

  it('and so is its report', () => {
    const s = section()
    s.stage = 'report'
    expect(directive(s, '/repo').inputs.owner).toBe('home-01')
  })

  it('a section is finished once it is frozen', () => {
    const s = section()
    expect(sectionFinished(s)).toBe(false)
    s.stages.golden = { status: 'done' }
    expect(sectionFinished(s)).toBe(true)
  })

  it('a run with no parent is untouched', () => {
    const s = make()
    s.stage = 'library:register'
    expect(directive(s, '/repo').inputs.owner).toBeUndefined()
  })
})
