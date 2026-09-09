/**
 * Law 6 — the composite score.
 *
 * Figma's text engine and Chromium's disagree on kerning, hinting and
 * antialiasing, so a *perfect* component still comes out 3–8% different at the
 * pixel level. A raw diff threshold at 1% is never reached; at 10% anything
 * passes. Three dimensions instead, weighted by how much rendering noise each
 * one carries.
 *
 * Everything here is pure arithmetic over already-collected numbers. No
 * browser, no images — so the rule can be tested, and calibrated, without one.
 */

import type { Box, MeasuredNode } from './measure.js'
import { iou, normalize, edgeDeltas } from './measure.js'

export type Dimension = 'structural' | 'chromatic' | 'perceptual'

/** Below this share of matched nodes, the structural dimension reports rather
 *  than scores. Two thirds is generous: it still tolerates a component that
 *  legitimately collapses a third of the design's wrappers. */
export const MIN_COVERAGE = 0.65

export interface NodeFinding {
  path: string
  /**
   * The `data-gw` the design asked for.
   *
   * This is the half a person can act on: `path` says where the node is in
   * Figma, `label` says what to type. A finding printed as
   * "Wrapper full / Wrapper wide / Call to actions | Newsletter / Call to
   * action / Content / Content" is unreadable and, worse, ambiguous — that
   * design has two `Content`.
   */
  label?: string
  /** What moved and by how much, in render pixels. Actionable; a number is not. */
  edge: string
  delta: number
  overlap: number
}

export interface DimensionScore {
  dimension: Dimension
  score: number
  findings: NodeFinding[]
  /**
   * How much of the design this score actually covers, 0 to 1.
   *
   * A precondition, not a quality: a number computed over a broken pairing is
   * worse than no number, because it looks actionable. The agent writes, gets a
   * figure back, and has no way to tell "this scored low" from "this was not
   * measurable".
   */
  coverage?: number
  /**
   * Design nodes that sit inside something the component renders as one piece,
   * and so have no counterpart by construction.
   *
   * A Figma button is a frame holding a text-padding frame holding a text node
   * beside an icon instance. The component writes `<Button label={…} />`. Those
   * three nodes are not missing — nobody was ever going to write them — and
   * counting them against coverage made a correctly built component look half
   * unmatched. They are excluded from coverage and reported as a number.
   */
  collapsed?: number
  /** Present when the dimension could not be measured at all. A missing
   *  dimension is reported, never scored as zero — a zero would say "wrong"
   *  when the truth is "unknown". */
  unavailable?: string
}

export interface ViewportScore {
  viewport: string
  width: number
  total: number
  dimensions: DimensionScore[]
}

export interface RunScore {
  /** The worst viewport, not the average. If it breaks on mobile, it is broken. */
  total: number
  worstViewport: string
  passed: boolean
  threshold: number
  viewports: ViewportScore[]
}

export interface Weights {
  structural: number
  chromatic: number
  perceptual: number
}

// --- structural --------------------------------------------------------------

/**
 * Matches design nodes to rendered ones, then scores each pair by overlap.
 *
 * Matching by geometry alone would be circular: a badly placed element would
 * pair with whatever happens to sit where it should have been, and score well.
 * Identity is the thing that survives being wrong.
 *
 * **By `data-gw` label**, which the IR issues and the component copies. Not the
 * layer name and not the path: a component does not reproduce Figma's tree, so
 * the same node sits at a different path on each side, and Figma routinely
 * gives two siblings the same name.
 *
 * **By depth and reading order** only when the component carries no labels at
 * all. That fallback is fragile in a way that is easy to miss — it pairs
 * `design[i]` with `rendered[i]` at the same depth, so one wrapper div or one
 * inlined `<svg>` shifts every pair after it. It exists so an unlabelled
 * component gets a number rather than an error, and the number says to label.
 *
 * The two are never mixed. They were, and it was worse than either: identity
 * claimed what it could, then reading order paired the leftovers with
 * strangers, and a component whose only real fault was one misnamed label came
 * back with `width off by +1240px` on a node that was never its counterpart.
 * A design node with no label of its own is now reported, not paired.
 */
export function scoreStructural(
  design: MeasuredNode[],
  designRoot: Box,
  rendered: MeasuredNode[],
  renderedRoot: Box,
  tolerancePx: number,
): DimensionScore {
  if (design.length === 0) {
    return { dimension: 'structural', score: 0, findings: [], unavailable: 'the design has no measurable nodes' }
  }
  if (rendered.length === 0) {
    return { dimension: 'structural', score: 0, findings: [], unavailable: 'nothing rendered' }
  }

  const pairs = rendered.some((n) => n.label)
    ? pairByLabel(design, rendered)
    : pairByReadingOrder(design, rendered)

  // Tolerance is in render pixels; overlap is normalized. Convert once.
  const slack = renderedRoot.width > 0 ? tolerancePx / renderedRoot.width : 0

  const findings: NodeFinding[] = []
  let sum = 0
  let matched = 0
  let missing = 0
  let collapsed = 0

  for (const d of design) {
    const r = pairs.get(d)
    if (!r) {
      // Inside something the component draws as one piece — a `<Button />` in
      // place of Figma's four nested frames. Not a fault, and not scored.
      if (isCollapsed(d, design, rendered, pairs)) {
        collapsed++
        findings.push({ path: d.path, label: d.label, edge: 'collapsed', delta: 0, overlap: 0 })
        continue
      }
      missing++
      findings.push({ path: d.path, label: d.label, edge: 'missing', delta: 0, overlap: 0 })
      continue
    }

    matched++
    const dn = normalize(d, designRoot)
    const rn = normalize(r, renderedRoot)
    const overlap = iou(dn, rn)

    // Within tolerance counts as exact: a 1px rounding difference is not a bug.
    const scored = overlap >= 1 - slack * 2 ? 1 : overlap
    sum += scored

    if (scored < 0.98) {
      const expected = {
        x: dn.x * renderedRoot.width, y: dn.y * renderedRoot.height,
        width: dn.width * renderedRoot.width, height: dn.height * renderedRoot.height,
      }
      for (const e of edgeDeltas(expected, r, tolerancePx)) {
        findings.push({ path: d.path, label: d.label, edge: e.edge, delta: e.delta, overlap: round(overlap) })
      }
    }
  }

  // Over what was comparable, not over the whole design.
  //
  // Averaging in a zero for every unmatched node folded two different facts
  // into one number: "this node is 40px off" and "this node was never found".
  // The first is a fix, the second is a label — and the reader could not tell
  // which one the percentage was complaining about. Coverage carries the
  // second now, and it is the thing that decides whether the score means
  // anything at all.
  const score = matched === 0 ? 0 : (sum / matched) * 100
  const comparable = matched + missing
  const coverage = comparable === 0 ? 0 : matched / comparable

  // A missing node is the finding that unblocks every other one, so it sorts
  // above a delta however large. `collapsed` is information, and sorts last.
  const rank = (f: NodeFinding) => (f.edge === 'missing' ? 0 : f.edge === 'collapsed' ? 2 : 1)
  findings.sort((a, b) => rank(a) - rank(b) || Math.abs(b.delta) - Math.abs(a.delta) || a.overlap - b.overlap)

  const base = {
    dimension: 'structural' as const,
    score: round(score),
    findings: findings.slice(0, 16),
    coverage: round(coverage),
    ...(collapsed > 0 ? { collapsed } : {}),
  }

  if (coverage < MIN_COVERAGE) {
    return {
      ...base,
      // Reported instead of scored. Below this the pairing itself is in doubt,
      // and every delta after the first mismatch is a phantom: fixing them
      // means reshaping the DOM to chase a correspondence that was never real.
      unavailable:
        `only ${matched} of ${comparable} design nodes could be matched to the render. ` +
        `Give the component's nodes the data-gw labels the IR issued before reading this as a score.`,
    }
  }
  return base
}

/**
 * Exact `data-gw` match, with same-label siblings resolved in reading order.
 *
 * Figma lets siblings share a name and the IR numbers the collisions, but a
 * label can still legitimately appear twice in a repeated row. Grouping by
 * label and pairing within the group in reading order handles that without
 * letting a mismatch anywhere else in the tree shift the pairing.
 */
function pairByLabel(design: MeasuredNode[], rendered: MeasuredNode[]): Map<MeasuredNode, MeasuredNode> {
  const keyed = (ns: MeasuredNode[]) => {
    const groups = new Map<string, MeasuredNode[]>()
    for (const n of ns) {
      if (!n.label) continue
      const list = groups.get(n.label) ?? []
      list.push(n)
      groups.set(n.label, list)
    }
    const m = new Map<string, MeasuredNode>()
    for (const [label, list] of groups) {
      list.sort((a, b) => a.y - b.y || a.x - b.x)
      list.forEach((n, i) => m.set(`${label}#${i}`, n))
    }
    return m
  }

  const dk = keyed(design)
  const rk = keyed(rendered)
  const pairs = new Map<MeasuredNode, MeasuredNode>()
  for (const [key, d] of dk) {
    const r = rk.get(key)
    if (r) pairs.set(d, r)
  }
  return pairs
}

/** The unlabelled fallback: `design[i]` against `rendered[i]` at each depth. */
function pairByReadingOrder(design: MeasuredNode[], rendered: MeasuredNode[]): Map<MeasuredNode, MeasuredNode> {
  const byDepth = (ns: MeasuredNode[]) => {
    const m = new Map<number, MeasuredNode[]>()
    for (const n of ns) {
      const list = m.get(n.depth) ?? []
      list.push(n)
      m.set(n.depth, list)
    }
    // Reading order within a depth: top to bottom, then left to right.
    for (const list of m.values()) list.sort((a, b) => a.y - b.y || a.x - b.x)
    return m
  }

  const dd = byDepth(design)
  const rr = byDepth(rendered)
  const pairs = new Map<MeasuredNode, MeasuredNode>()
  for (const [depth, designNodes] of dd) {
    const pool = rr.get(depth) ?? []
    designNodes.forEach((d, i) => {
      const r = pool[i]
      if (r) pairs.set(d, r)
    })
  }
  return pairs
}

/**
 * Whether this design node lives inside something the component renders whole.
 *
 * Two conditions, and both are needed.
 *
 * The nearest design ancestor that matched is **not a container** — it is a
 * button, an image, an icon, an input. Those are leaves in code however many
 * frames Figma nests inside them. A container that swallowed its children is a
 * real omission, and the first cut of this check called it collapsed too,
 * which quietly excused every unlabelled node in the tree.
 *
 * And that ancestor's rendered counterpart has **no labelled descendant** —
 * the component really did stop there, rather than labelling some of the
 * subtree and forgetting the rest.
 *
 * Ancestry comes off the path rather than a parent link, which both sides
 * already build the same way: a node is inside another when its path starts
 * with the other's.
 */
function isCollapsed(
  node: MeasuredNode,
  design: MeasuredNode[],
  rendered: MeasuredNode[],
  pairs: Map<MeasuredNode, MeasuredNode>,
): boolean {
  let nearest: MeasuredNode | null = null
  for (const d of design) {
    if (d === node || !pairs.has(d)) continue
    if (!node.path.startsWith(`${d.path} / `)) continue
    if (!nearest || d.path.length > nearest.path.length) nearest = d
  }
  if (!nearest || nearest.role === 'container') return false

  const counterpart = pairs.get(nearest)!
  return !rendered.some((r) => r.label && r.path.startsWith(`${counterpart.path} / `))
}

// --- chromatic ---------------------------------------------------------------

/**
 * CIEDE2000. Worth the arithmetic: euclidean distance in sRGB calls
 * #1A1A1B and #1A1A1A meaningfully different, which starts token rot in
 * `resolve` and false failures here.
 */
export function deltaE(hex1: string, hex2: string): number {
  const [l1, a1, b1] = labOf(hex1)
  const [l2, a2, b2] = labOf(hex2)

  const kL = 1, kC = 1, kH = 1
  const c1 = Math.hypot(a1, b1)
  const c2 = Math.hypot(a2, b2)
  const cBar = (c1 + c2) / 2
  const g = 0.5 * (1 - Math.sqrt(cBar ** 7 / (cBar ** 7 + 25 ** 7)))
  const a1p = (1 + g) * a1
  const a2p = (1 + g) * a2
  const c1p = Math.hypot(a1p, b1)
  const c2p = Math.hypot(a2p, b2)
  const h1p = hueOf(b1, a1p)
  const h2p = hueOf(b2, a2p)

  const dLp = l2 - l1
  const dCp = c2p - c1p
  let dhp = 0
  if (c1p * c2p !== 0) {
    dhp = h2p - h1p
    if (dhp > 180) dhp -= 360
    else if (dhp < -180) dhp += 360
  }
  const dHp = 2 * Math.sqrt(c1p * c2p) * Math.sin(rad(dhp) / 2)

  const lBarP = (l1 + l2) / 2
  const cBarP = (c1p + c2p) / 2
  let hBarP = h1p + h2p
  if (c1p * c2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) hBarP += h1p + h2p < 360 ? 360 : -360
    hBarP /= 2
  }

  const t = 1 - 0.17 * Math.cos(rad(hBarP - 30)) + 0.24 * Math.cos(rad(2 * hBarP))
    + 0.32 * Math.cos(rad(3 * hBarP + 6)) - 0.20 * Math.cos(rad(4 * hBarP - 63))
  const dTheta = 30 * Math.exp(-(((hBarP - 275) / 25) ** 2))
  const rc = 2 * Math.sqrt(cBarP ** 7 / (cBarP ** 7 + 25 ** 7))
  const sl = 1 + (0.015 * (lBarP - 50) ** 2) / Math.sqrt(20 + (lBarP - 50) ** 2)
  const sc = 1 + 0.045 * cBarP
  const sh = 1 + 0.015 * cBarP * t
  const rt = -Math.sin(rad(2 * dTheta)) * rc

  return Math.sqrt(
    (dLp / (kL * sl)) ** 2 +
    (dCp / (kC * sc)) ** 2 +
    (dHp / (kH * sh)) ** 2 +
    rt * (dCp / (kC * sc)) * (dHp / (kH * sh)),
  )
}

export interface ProbeResult { from: string; label?: string; expected: string; got: string; deltaE: number }

/**
 * ΔE ≤ 1 is "indistinguishable to a trained eye" and scores full marks. Beyond
 * that it falls off linearly to ΔE 10, which is unmistakably a different colour.
 */
export function scoreChromatic(probes: ProbeResult[], tolerance = 1): DimensionScore {
  if (probes.length === 0) {
    return { dimension: 'chromatic', score: 0, findings: [], unavailable: 'no colour probes taken' }
  }
  let sum = 0
  const findings: NodeFinding[] = []
  for (const p of probes) {
    const over = Math.max(0, p.deltaE - tolerance)
    const s = Math.max(0, 1 - over / 9)
    sum += s
    if (s < 0.98) {
      findings.push({
        path: `${p.from}: ${p.expected} → ${p.got}`,
        // The label plus the two colours, which is the whole finding. The path
        // was Figma's, and on an icon instance it ran to eleven segments of
        // component plumbing that named nothing the reader could act on.
        ...(p.label ? { label: `${p.label}: ${p.expected} → ${p.got}` } : {}),
        edge: 'colour',
        delta: round(p.deltaE, 1),
        overlap: round(s),
      })
    }
  }
  findings.sort((a, b) => b.delta - a.delta)
  return { dimension: 'chromatic', score: round((sum / probes.length) * 100), findings: findings.slice(0, 12) }
}

// --- perceptual ---------------------------------------------------------------

/** Share of differing pixels, text already masked out by the caller. */
export function scorePerceptual(differing: number, compared: number): DimensionScore {
  if (compared <= 0) {
    return { dimension: 'perceptual', score: 0, findings: [], unavailable: 'nothing to compare' }
  }
  const ratio = differing / compared
  return { dimension: 'perceptual', score: round(Math.max(0, 1 - ratio) * 100), findings: [] }
}

// --- composition ---------------------------------------------------------------

export function combine(dims: DimensionScore[], weights: Weights): number {
  // An unavailable dimension is dropped and the rest reweighted, rather than
  // counted as zero. Scoring "unknown" as "wrong" makes the number a lie.
  const usable = dims.filter((d) => !d.unavailable)
  if (usable.length === 0) return 0
  const total = usable.reduce((acc, d) => acc + weights[d.dimension], 0)
  if (total <= 0) return 0
  return round(usable.reduce((acc, d) => acc + d.score * weights[d.dimension], 0) / total)
}

/**
 * Whether the dimensions contradict each other badly enough to distrust them.
 *
 * Nothing in the pipeline could falsify its own ruler. `refine` attributes 100%
 * of every gap to the component, always, and spends its iteration cap editing
 * code that may be correct.
 *
 * A real run had perceptual at 95.67% and structural at 48.93% on the same
 * render. Two rulers measuring one object, 47 points apart. The pixels say the
 * component looks like the design; the boxes say it does not — which means the
 * correspondence between design nodes and rendered ones is broken, not the
 * layout. Sending an agent to fix that leads it to reproduce five nested
 * instance wrappers around an `<svg>`: the score would rise and the component
 * would get worse.
 */
export function inconsistency(viewport: ViewportScore): string | null {
  const by = (d: Dimension) => viewport.dimensions.find((x) => x.dimension === d)
  const structural = by('structural')
  const perceptual = by('perceptual')
  if (!structural || !perceptual || structural.unavailable || perceptual.unavailable) return null

  if (perceptual.score >= 90 && structural.score < 60) {
    return (
      `perceptual ${perceptual.score}% against structural ${structural.score}% on the same render. ` +
      `The pixels say this matches the design and the boxes say it does not, which points at the ` +
      `matching between design and render rather than at the layout. ` +
      `Reshaping the DOM to close that gap would make the component worse and the score better.`
    )
  }
  return null
}

/** The worst viewport, never the average (Law 6). */
export function combineViewports(viewports: ViewportScore[], threshold: number): RunScore {
  if (viewports.length === 0) {
    return { total: 0, worstViewport: '—', passed: false, threshold, viewports }
  }
  const worst = viewports.reduce((a, b) => (b.total < a.total ? b : a))
  return {
    total: worst.total,
    worstViewport: worst.viewport,
    passed: worst.total >= threshold,
    threshold,
    viewports,
  }
}

// --- colour space ------------------------------------------------------------

function labOf(hex: string): [number, number, number] {
  const { r, g, b } = parseHex(hex)
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const R = lin(r / 255), G = lin(g / 255), B = lin(b / 255)

  // sRGB → XYZ (D65), then XYZ → CIELAB.
  const x = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / 0.95047
  const y = R * 0.2126729 + G * 0.7151522 + B * 0.0721750
  const z = (R * 0.0193339 + G * 0.1191920 + B * 0.9503041) / 1.08883
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29)
  const fx = f(x), fy = f(y), fz = f(z)
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

export function parseHex(hex: string): { r: number; g: number; b: number } {
  let h = hex.replace('#', '').trim()
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  return {
    r: parseInt(h.slice(0, 2), 16) || 0,
    g: parseInt(h.slice(2, 4), 16) || 0,
    b: parseInt(h.slice(4, 6), 16) || 0,
  }
}

const rad = (deg: number) => (deg * Math.PI) / 180
function hueOf(b: number, ap: number): number {
  if (b === 0 && ap === 0) return 0
  const h = (Math.atan2(b, ap) * 180) / Math.PI
  return h >= 0 ? h : h + 360
}

function round(n: number, decimals = 2): number {
  const f = 10 ** decimals
  return Math.round(n * f) / f
}
