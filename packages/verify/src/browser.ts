/**
 * The browser side: render at a viewport, then read back what is actually
 * there.
 *
 * Two things come out of every page: the DOM's own boxes, and a screenshot.
 * The boxes carry the structural and chromatic dimensions; the screenshot only
 * feeds the perceptual one, which is the noisy quarter.
 */

import { chromium, type Browser, type Page } from 'playwright'
import type { Box, MeasuredNode, ColorProbe } from '@gridwright/core'

export interface RenderResult {
  root: Box
  nodes: MeasuredNode[]
  /** Colour sampled at each design probe, in the same order. */
  sampled: string[]
  screenshot: Buffer
}

export interface RenderOptions {
  url: string
  width: number
  height: number
  probes: ColorProbe[]
  /** Elements smaller than this in either axis are skipped. Below it you are
   *  measuring dividers, icon strokes and layout artefacts, not structure. */
  minSize?: number
  /** Waits for fonts before measuring. A render captured mid-font-swap reports
   *  text boxes at the fallback's metrics, and every heading looks misplaced. */
  timeoutMs?: number
}

export async function withBrowser<T>(fn: (b: Browser) => Promise<T>): Promise<T> {
  const browser = await chromium.launch()
  try {
    return await fn(browser)
  } finally {
    await browser.close()
  }
}

export async function render(browser: Browser, opts: RenderOptions): Promise<RenderResult> {
  const page = await browser.newPage({
    viewport: { width: opts.width, height: opts.height },
    deviceScaleFactor: 1,
  })
  try {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))

    await page.goto(opts.url, { waitUntil: 'networkidle', timeout: opts.timeoutMs ?? 30_000 })
    await page.evaluate(() => document.fonts.ready)
    // One frame after fonts settle, so layout has actually reflowed.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))))

    const root = await page.evaluate(() => {
      const el = document.getElementById('gw-root')?.firstElementChild ?? document.getElementById('gw-root')
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    })

    if (!root || root.width === 0 || root.height === 0) {
      const why = errors.length ? ` The page threw: ${errors[0]}` : ''
      throw new Error(`The component rendered nothing at ${opts.width}px.${why}`)
    }

    const nodes = await collectBoxes(page, opts.minSize ?? 4)
    const sampled = await sampleColors(page, root, opts.probes)
    // `fullPage`, or the clip stops at the viewport: a 1255px section rendered
    // in a 900px viewport was captured as its top 900px, the reference was
    // resized to match — squashed to 0.72 of its height — and the perceptual
    // score compared two different pictures. The viewport is left alone rather
    // than grown to fit, because a component sized in vh would reflow.
    const screenshot = await page.screenshot({
      fullPage: true,
      clip: { x: root.x, y: root.y, width: root.width, height: root.height },
    })

    return { root, nodes, sampled, screenshot }
  } finally {
    await page.close()
  }
}

/**
 * Walks the rendered tree the same way distill walks the Figma one, so the two
 * lists can be matched by depth and reading order.
 *
 * Invisible and zero-size elements are dropped: they have no counterpart in a
 * design, and counting them would shift every index at their depth — turning
 * one stray `<span>` into a cascade of false findings.
 */
async function collectBoxes(page: Page, minSize: number): Promise<MeasuredNode[]> {
  return page.evaluate((min) => {
    const out: Array<Record<string, unknown>> = []
    const root = document.getElementById('gw-root')
    if (!root) return out as never

    const roleOf = (el: Element): string => {
      const tag = el.tagName.toLowerCase()
      if (/^h[1-6]$/.test(tag)) return 'heading'
      if (tag === 'img' || tag === 'picture' || tag === 'video') return 'image'
      if (tag === 'svg') return 'icon'
      if (tag === 'button' || (tag === 'a' && el.getAttribute('role') === 'button')) return 'button'
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return 'input'
      if (tag === 'hr') return 'divider'
      const hasText = Array.from(el.childNodes).some(
        (n) => n.nodeType === 3 && (n.textContent ?? '').trim().length > 0,
      )
      return hasText ? 'text' : 'container'
    }

    const walk = (el: Element, depth: number, path: string) => {
      const style = getComputedStyle(el)
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return
      const r = el.getBoundingClientRect()
      if (r.width < min || r.height < min) return

      const label = el.getAttribute('data-gw') ?? ''
      const name = label || el.tagName.toLowerCase()
      const here = path ? `${path} / ${name}` : name
      out.push({
        path: here, name, label, role: roleOf(el), depth,
        x: r.x, y: r.y, width: r.width, height: r.height,
      })
      let i = 0
      for (const child of Array.from(el.children)) walk(child, depth + 1, here), i++
    }

    // Depth 0 is the component's own outermost element, matching the Figma frame.
    const first = root.firstElementChild
    if (first) walk(first, 0, '')
    return out as never
  }, minSize) as unknown as MeasuredNode[]
}

/**
 * Reads the colour each design probe asks about.
 *
 * Two things it deliberately does not do.
 *
 * It does not read pixels. A pixel read is at the mercy of antialiasing on any
 * edge, and this is meant to be the dimension without noise — the value comes
 * off the element's computed style instead.
 *
 * And it does not always read `backgroundColor`. On a text node the design's
 * fill is the colour of the glyphs, and the centre of a text box lands between
 * them: sampling there returns the background and reports every correct
 * heading as a chromatic failure. Five of five failures on a real run were
 * exactly that, on a component whose colours were right throughout.
 */
async function sampleColors(page: Page, root: Box, probes: ColorProbe[]): Promise<string[]> {
  if (probes.length === 0) return []
  return page.evaluate(
    ({ root, probes }) => {
      // Chromium does not normalise computed colours to rgb(). Tailwind v4
      // declares its palette in oklch, and `getComputedStyle` hands that back
      // as `oklch(0.205 0 0)` — `color-mix` as `oklab(…)`. Parsing only rgb()
      // read every one of them as transparent: ΔE 100 on text that was the
      // right colour. Anything that is not rgb() is painted onto one canvas
      // pixel and read back, which is the browser's own conversion to sRGB.
      const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
      const SENTINEL = '#010203'
      const toHex = (value: string): string => {
        const hex = (r: number, g: number, b: number) =>
          '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')

        const m = value.match(/^rgba?\(([^)]+)\)$/)
        if (m) {
          const [r, g, b, a] = m[1]!.split(/[\s,/]+/).filter(Boolean).map((v) => parseFloat(v))
          if (a !== undefined && a < 0.05) return 'transparent'
          return hex(r!, g!, b!)
        }
        if (!ctx || !value || value === 'transparent' || value === 'none') return 'transparent'

        ctx.fillStyle = SENTINEL
        ctx.fillStyle = value
        // An assignment the canvas does not understand is ignored silently.
        if (ctx.fillStyle === SENTINEL && value.toLowerCase() !== SENTINEL) return 'transparent'
        ctx.clearRect(0, 0, 1, 1)
        ctx.fillRect(0, 0, 1, 1)
        const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
        if (a! < 13) return 'transparent'
        return hex(r!, g!, b!)
      }

      // Deepest first: the node's own label when the component has it, then
      // outward until one resolves. A probe on the `<path>` inside an
      // illustration finds the `<svg>`; one on the text inside a reused
      // `<Button />` finds the button.
      const labelled = (chain: string[]): Element | null => {
        for (let i = chain.length - 1; i >= 0; i--) {
          const el = chain[i] ? document.querySelector(`[data-gw="${CSS.escape(chain[i]!)}"]`) : null
          if (el) return el
        }
        return null
      }

      return probes.map((p) => {
        // Identity first when the component labelled its nodes, geometry
        // otherwise. Geometry is enough for a background; for text it only has
        // to land inside the right element, not on a glyph.
        const x = root.x + p.u * root.width
        const y = root.y + p.v * root.height
        let el = labelled(p.within ?? (p.label ? [p.label] : [])) ?? document.elementFromPoint(x, y)

        if (p.property === 'color') {
          // The glyphs are painted by whatever element owns the text, which may
          // be a child of the box the design measured.
          const withText = el?.querySelector('*') && !el.textContent?.trim()
            ? el.querySelector('*')
            : el
          return withText ? toHex(getComputedStyle(withText).color) : 'transparent'
        }

        // An SVG is painted by `fill`, not by a background. Figma reports the
        // vector's own paint as a fill like any other, so a probe on an
        // illustration asked for `backgroundColor` on an `<svg>` — always
        // transparent, always ΔE 100, on artwork that was the right colour.
        //
        // The computed value is read rather than the attribute, because
        // `fill="currentColor"` is how a component that lets the block decide
        // the colour is written, and Chromium resolves it here.
        const svg = el?.closest('svg')
        if (svg) {
          const painted = svg.querySelector('path, circle, rect, polygon, g') ?? svg
          const fill = toHex(getComputedStyle(painted).fill)
          if (fill !== 'transparent') return fill
        }

        // Walk up through transparent backgrounds to whatever actually paints.
        while (el) {
          const hex = toHex(getComputedStyle(el).backgroundColor)
          if (hex !== 'transparent') return hex
          el = el.parentElement
        }
        return toHex(getComputedStyle(document.body).backgroundColor)
      })
    },
    { root, probes },
  )
}
