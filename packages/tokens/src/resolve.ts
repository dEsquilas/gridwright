/**
 * Law 4 — the three buckets.
 *
 * Every value the design brings is sorted into exact, near or new. The middle
 * one is the point of the whole exercise: a colour half a ΔE away from one the
 * project already has is not a new token, it is the same colour drawn by
 * someone who picked it by eye. Matching on string equality would create a
 * second `neutral-900` and start the rot that ends with nobody knowing which
 * one to use.
 */

import { deltaE, type RawToken } from '@gridwright/core'
import type { ExistingToken, TokenKind } from './read.js'
import { sameShadow } from './shadow.js'

export type Bucket = 'exact' | 'near' | 'new'

export interface Resolution {
  bucket: Bucket
  raw: RawToken
  /** The project token to use. Present for exact and near. */
  match?: ExistingToken
  /** How far off, for `near`: ΔE for colours, pixels for lengths. */
  distance?: number
  /** Why it landed in `new`, or why the drift is acceptable. */
  note?: string
  /** Proposed name, filled in by the agent at the `tokens` stage. */
  proposedName?: string
  /**
   * For a composite in `new`: the parts the system does not have. A border is a
   * width and a colour, and when only the colour is missing, only the colour
   * needs a name — the gate used to ask for one for the whole `1px solid #9aa3ad`,
   * and write it as a single token.
   */
  missing?: Array<{ label: string; kind: TokenKind; value: string }>
}

export interface ResolveOptions {
  colorToleranceDeltaE: number
  /** Design lengths are snapped to the existing scale within this many pixels. */
  spacingTolerancePx?: number
}

export function resolveTokens(
  raw: RawToken[],
  existing: ExistingToken[],
  opts: ResolveOptions,
): Resolution[] {
  return raw.map((token) => resolveOne(token, existing, opts))
}

function resolveOne(raw: RawToken, existing: ExistingToken[], opts: ResolveOptions): Resolution {
  const candidates = existing.filter((e) => e.kind === kindOf(raw) && e.comparable)

  if (raw.kind === 'color') return resolveColor(raw, candidates, opts)
  if (raw.kind === 'spacing' || raw.kind === 'radius') return resolveLength(raw, candidates, opts)
  if (raw.kind === 'border') return resolveComposite(raw, existing, opts, borderParts(raw.value))
  if (raw.kind === 'typography') return resolveTypography(raw, candidates, existing, opts)
  if (raw.kind === 'gradient') return resolveComposite(raw, existing, opts, gradientParts(raw.value))
  if (raw.kind === 'shadow') {
    // Compared as painted layers rather than as text: the same stack is written
    // one way by Figma and another by a config, and often in another order.
    const match = candidates.find((c) => sameShadow(c.value, raw.value))
    if (match) return { bucket: 'exact', raw, match }
    return { bucket: 'new', raw, note: 'no shadow in the system paints the same layers' }
  }

  const exact = candidates.find((c) => normalize(c.value) === normalize(raw.value))
  if (exact) return { bucket: 'exact', raw, match: exact }
  return { bucket: 'new', raw, note: `no ${raw.kind} token with this value` }
}

interface Part { label: string; kind: TokenKind; value: string }

/**
 * Borders and typography are not values, they are compositions.
 *
 * `1px solid #9aa3ad` is a width, a style and a colour; a design system holds
 * those separately and Tailwind writes them as `border border-neutral-500`.
 * Comparing the whole string finds nothing, so gridwright asked to create a
 * token for a border whose every part the project already had — which is the
 * rot Law 4 exists to prevent, produced by the tool meant to prevent it.
 *
 * Found on a real run: three of four proposed tokens were compositions of
 * things already in the config.
 */
function resolveComposite(
  raw: RawToken,
  existing: ExistingToken[],
  opts: ResolveOptions,
  parts: Part[],
): Resolution {
  if (parts.length === 0) {
    return { bucket: 'new', raw, note: `could not read this ${raw.kind} as parts` }
  }

  const found: string[] = []
  const missing: string[] = []
  const missingParts: Array<{ label: string; kind: TokenKind; value: string }> = []

  for (const part of parts) {
    const candidates = existing.filter((e) => e.kind === part.kind && e.comparable)
    const asRaw: RawToken = { kind: part.kind === 'color' ? 'color' : 'spacing', value: part.value, usedIn: raw.usedIn }
    const r = part.kind === 'color'
      ? resolveColor(asRaw, candidates, opts)
      : resolveLength(asRaw, candidates, opts)

    if (r.bucket === 'new') {
      missing.push(`${part.label} ${part.value}`)
      missingParts.push({ label: part.label, kind: part.kind, value: part.value })
    } else found.push(`${part.label} → ${r.match!.name}`)
  }

  if (missing.length === 0) {
    return {
      bucket: 'exact', raw,
      // No single token to point at, because there should not be one.
      note: `already expressible: ${found.join(', ')}. A composite token would duplicate them.`,
    }
  }
  return {
    bucket: 'new', raw,
    note: found.length > 0
      ? `${found.join(', ')} exist; missing ${missing.join(', ')}`
      : `none of its parts are in the system`,
    missing: missingParts,
  }
}

/**
 * What actually needs a name at the gate: single values, never composites.
 *
 * A composite in `new` is replaced by the parts it is missing, and the same
 * value arriving from several places — a colour in a border and in a gradient —
 * is asked about once. What gets written is then a colour or a length a
 * utility can use, not a `1px solid #9aa3ad` filed as one token.
 */
export function pendingParts(resolutions: Resolution[]): Resolution[] {
  const out = new Map<string, Resolution>()
  for (const r of resolutions) {
    if (r.bucket !== 'new') continue
    const parts: Resolution[] = r.missing?.length
      ? r.missing.map((m) => ({
          bucket: 'new' as const,
          raw: { kind: m.kind as RawToken['kind'], value: m.value, usedIn: r.raw.usedIn },
          note: `the ${m.label} of ${r.raw.value}`,
        }))
      : [r]
    for (const p of parts) {
      // A colour with alpha is its opaque colour, used faintly. Tailwind writes
      // that as `bg-ink/10`, so `#181a191a` beside `#181a19` is one token to
      // name, not two — and naming the faint one `ink-10` is exactly the kind
      // of near-duplicate Law 4 exists to keep out.
      const faint = p.raw.kind === 'color' ? opaque(p.raw.value) : null
      const value = faint ?? p.raw.value
      const key = `${p.raw.kind}|${value}`
      const seen = out.get(key)
      if (seen) seen.raw = { ...seen.raw, usedIn: [...new Set([...seen.raw.usedIn, ...p.raw.usedIn])] }
      else {
        out.set(key, {
          ...p,
          raw: { ...p.raw, value, usedIn: [...p.raw.usedIn] },
          ...(faint ? { note: `${p.note ? `${p.note}; ` : ''}also used with alpha, as ${p.raw.value} — write it as /opacity` } : {}),
        })
      }
    }
  }
  return [...out.values()]
}

/** `#rrggbbaa` with real transparency, as `#rrggbb`. Anything else, null. */
function opaque(value: string): string | null {
  const m = value.trim().toLowerCase().match(/^#([0-9a-f]{6})([0-9a-f]{2})$/)
  if (!m || m[2] === 'ff') return null
  return `#${m[1]}`
}

/** `1px solid #9aa3ad` → a width and a colour. The style is not a token. */
function borderParts(value: string): Part[] {
  const m = value.trim().match(/^(\S+)\s+\w+\s+(\S+)$/)
  if (!m) return []
  return [
    { label: 'width', kind: 'border', value: m[1]! },
    { label: 'colour', kind: 'color', value: m[2]! },
  ]
}

/**
 * A gradient is its colour stops.
 *
 * `linear-gradient(180deg, #f8f7f7 50%, #004a55 50%)` is two colours the
 * project already has, arranged. Tailwind writes it as
 * `bg-gradient-to-b from-cream-200 to-primary-800`, so a token for the whole
 * thing would freeze an arrangement and duplicate two palette entries at once.
 *
 * The angle and the stop positions belong to the component, not the system:
 * the same two colours cut at 70% is the same palette, a different design.
 */
function gradientParts(value: string): Part[] {
  const out: Part[] = []
  let i = 0
  for (const m of value.matchAll(/#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})\b/gi)) {
    out.push({ label: `stop ${++i}`, kind: 'color', value: m[0] })
  }
  return out
}

/**
 * `Roboto/700/32px/40px` → family, weight, size, line height.
 *
 * Only the size is matched. A project's fontSize token carries its own line
 * height, family lives in fontFamily and weight is a utility — treating the
 * four as one value is what made every heading look like a new token.
 */
/**
 * `Roboto/400/20px/24px` against the project's type scale.
 *
 * Size alone is not an identity. This project has `h6` at 20/24/700 and
 * `paragraph-lg` at 20/24/400, and matching on size took whichever the config
 * declared first — so body copy measured off the design at weight 400 resolved
 * to the bold one. The note is what an agent reads to pick a class, so the
 * wrong winner there is a bold paragraph in the component, and nothing
 * downstream calls it out: the geometry is close enough to score well.
 *
 * Family is deliberately not matched. A design names the face, a Tailwind
 * `fontSize` entry does not carry one, and the project has already decided
 * what its sans is.
 */
function resolveTypography(
  raw: RawToken,
  candidates: ExistingToken[],
  existing: ExistingToken[],
  opts: ResolveOptions,
): Resolution {
  const [, weight, size, lineHeight] = raw.value.split('/')
  if (!size) return resolveComposite(raw, existing, opts, [])

  const sized = candidates.filter((c) => toPx(c.value) !== null && toPx(c.value) === toPx(size))
  if (sized.length === 0) {
    return resolveComposite(raw, existing, opts, [{ label: 'size', kind: 'typography', value: size }])
  }

  // Line height first: it is the one that moves the box, and a wrong one shows
  // up as every element below it sitting in the wrong place.
  const score = (c: ExistingToken) =>
    (lineHeight && c.lineHeight && toPx(c.lineHeight) === toPx(lineHeight) ? 2 : 0) +
    (weight && c.fontWeight && c.fontWeight === weight.trim() ? 1 : 0)

  const best = sized.reduce((a, b) => (score(b) > score(a) ? b : a))

  // A token that declares nothing about weight is not disagreeing about it —
  // a Tailwind `fontSize` entry is allowed to be only a size and a line
  // height. Only a value that differs is a mismatch worth flagging.
  const contradicts =
    (!!lineHeight && !!best.lineHeight && toPx(best.lineHeight) !== toPx(lineHeight)) ||
    (!!weight && !!best.fontWeight && best.fontWeight !== weight.trim())
  const full = !contradicts

  return {
    bucket: 'exact',
    raw,
    // No match on the composite itself: a token for the whole triple would
    // duplicate a scale the project already has.
    note: full
      ? `already expressible: size ${size}, line height ${lineHeight}, weight ${weight} → ${best.name}. A composite token would duplicate them.`
      : `closest is ${best.name} (${best.value}${best.lineHeight ? `/${best.lineHeight}` : ''}` +
        `${best.fontWeight ? `/${best.fontWeight}` : ''}); the design asks for ${size}/${lineHeight}/${weight}. ` +
        `Check it before using it.`,
    ...(full ? { match: best } : {}),
  }
}

function typographyParts(value: string): Part[] {
  const bits = value.split('/')
  if (bits.length < 3) return []
  return [{ label: 'size', kind: 'typography', value: bits[2]! }]
}

function resolveColor(raw: RawToken, candidates: ExistingToken[], opts: ResolveOptions): Resolution {
  let best: { token: ExistingToken; d: number } | null = null
  for (const c of candidates) {
    const d = deltaE(raw.value, c.value)
    if (!best || d < best.d) best = { token: c, d }
  }

  if (!best) return { bucket: 'new', raw, note: 'the project declares no comparable colours' }
  if (best.d === 0) return { bucket: 'exact', raw, match: best.token, distance: 0 }

  if (best.d <= opts.colorToleranceDeltaE) {
    return {
      bucket: 'near',
      raw,
      match: best.token,
      distance: round(best.d),
      // Stated as a decision, not a coincidence: the pipeline is choosing the
      // system's value over the design's, and that has to be visible.
      note: `the design brings ${raw.value}, the system has ${best.token.value} (ΔE ${round(best.d)}). Using the system's.`,
    }
  }

  return {
    bucket: 'new',
    raw,
    distance: round(best.d),
    note: `closest is ${best.token.name} at ΔE ${round(best.d)} — far enough to be a different colour`,
  }
}

/**
 * Lengths snap to the existing scale.
 *
 * A design that says 14 against a 4/8/12/16 scale is not asking for a new
 * token, it is a design bug. Reported as a near match so the component uses the
 * scale, and so the drift is on the record instead of being absorbed into the
 * system as a permanent oddity.
 */
function resolveLength(raw: RawToken, candidates: ExistingToken[], opts: ResolveOptions): Resolution {
  const want = toPx(raw.value)
  if (want === null) return { bucket: 'new', raw, note: 'not a length we can compare' }

  let best: { token: ExistingToken; d: number } | null = null
  for (const c of candidates) {
    const have = toPx(c.value)
    if (have === null) continue
    const d = Math.abs(have - want)
    if (!best || d < best.d) best = { token: c, d }
  }

  if (!best) return { bucket: 'new', raw, note: 'the project declares no comparable lengths' }
  if (best.d === 0) return { bucket: 'exact', raw, match: best.token, distance: 0 }

  const tolerance = opts.spacingTolerancePx ?? 2
  if (best.d <= tolerance) {
    return {
      bucket: 'near',
      raw,
      match: best.token,
      distance: best.d,
      note: `${raw.value} is ${best.d}px off ${best.token.name} (${best.token.value}). ` +
        `Off-scale by ${best.d}px is a design slip, not a new token — using the scale.`,
    }
  }

  return { bucket: 'new', raw, distance: best.d, note: `nearest is ${best.token.name}, ${best.d}px away` }
}

/** How many new tokens is too many. A run wanting fifteen is not extending the
 *  system, it is a design that left it. */
export function overBudget(resolutions: Resolution[], max: number): boolean {
  return resolutions.filter((r) => r.bucket === 'new').length > max
}

export function summarize(resolutions: Resolution[]): Record<Bucket, number> {
  return {
    exact: resolutions.filter((r) => r.bucket === 'exact').length,
    near: resolutions.filter((r) => r.bucket === 'near').length,
    new: resolutions.filter((r) => r.bucket === 'new').length,
  }
}

function kindOf(raw: RawToken): TokenKind {
  switch (raw.kind) {
    case 'color': case 'gradient': return 'color'
    case 'spacing': return 'spacing'
    case 'typography': return 'typography'
    case 'radius': return 'radius'
    case 'shadow': return 'shadow'
    case 'border': return 'border'
    default: return 'other'
  }
}

/** rem is assumed to be 16px — the browser default and Tailwind's own basis. */
export function toPx(value: string): number | null {
  const m = value.trim().match(/^(-?\d+(?:\.\d+)?)(px|rem|em)?$/)
  if (!m) return null
  const n = parseFloat(m[1]!)
  return m[2] === 'rem' || m[2] === 'em' ? n * 16 : n
}

function normalize(v: string): string {
  return v.trim().toLowerCase().replace(/\s+/g, ' ')
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}
