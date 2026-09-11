/**
 * Any colour a stylesheet can declare, as the hex a design is compared in.
 *
 * The token reader used to call a colour comparable only when it was a hex or an
 * `rgb()`. Tailwind v4 declares its whole palette in `oklch()`, and shadcn
 * declares its own in `oklch()` too — so in a stock Vite + shadcn project not
 * one colour was ever comparable, and every colour a design brought was
 * proposed as a new token. `oklch(20.5% 0 none)` is `#171717`; nothing could
 * tell.
 *
 * Converted rather than compared in OKLCH, because ΔE is computed in Lab from
 * sRGB — the space the design's own values arrive in — and one comparison
 * method for everything beats two that can disagree.
 */

/** `#rrggbb`, or null for anything that is not a colour we can place. */
export function parseCssColor(input: string): string | null {
  const v = input.trim().toLowerCase()

  const hex = v.match(/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/)
  if (hex) {
    let h = hex[1]!
    if (h.length <= 4) h = h.split('').map((c) => c + c).join('')
    return `#${h.slice(0, 6)}`
  }

  const fn = v.match(/^(rgba?|oklch)\((.*)\)$/)
  if (!fn) return null
  const [channels, alpha] = fn[2]!.split('/').map((p) => p.trim())
  const parts = channels!.split(/[\s,]+/).filter(Boolean)
  if (parts.length < 3) return null
  // A colour that is barely there is not a colour a design means.
  if (alpha !== undefined && number(alpha, 1) < 0.05) return null

  if (fn[1] === 'oklch') {
    const [l, c, h] = parts
    return oklchToHex(number(l!, 1), number(c!, 0.4), hue(h!))
  }

  const [r, g, b] = parts.map((p) => number(p, 255))
  if (parts.length > 3 && alpha === undefined && number(parts[3]!, 1) < 0.05) return null
  return toHex(r! / 255, g! / 255, b! / 255)
}

/**
 * OKLCH to sRGB, by way of OKLab and linear light (Björn Ottosson's matrices,
 * which are what CSS Color 4 specifies).
 *
 * Out-of-gamut values are clamped, which is what a browser paints.
 */
export function oklchToHex(l: number, c: number, h: number): string {
  const rad = (h * Math.PI) / 180
  const a = c * Math.cos(rad)
  const b = c * Math.sin(rad)

  const l_ = l + 0.3963377774 * a + 0.2158037573 * b
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b
  const s_ = l - 0.0894841775 * a - 1.291485548 * b
  const [L, M, S] = [l_ ** 3, m_ ** 3, s_ ** 3]

  const r = 4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S
  const g = -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S
  const bl = -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S

  const gamma = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055)
  return toHex(gamma(r), gamma(g), gamma(bl))
}

function toHex(r: number, g: number, b: number): string {
  const byte = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, '0')
  return `#${byte(r)}${byte(g)}${byte(b)}`
}

/** A channel: a plain number, or a percentage of `full`. `none` is zero. */
function number(token: string, full: number): number {
  if (token === 'none') return 0
  if (token.endsWith('%')) return (parseFloat(token) / 100) * full
  return parseFloat(token)
}

function hue(token: string): number {
  if (token === 'none') return 0
  if (token.endsWith('turn')) return parseFloat(token) * 360
  if (token.endsWith('rad')) return (parseFloat(token) * 180) / Math.PI
  return parseFloat(token)
}
