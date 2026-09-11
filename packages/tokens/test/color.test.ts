import { describe, it, expect } from 'vitest'
import { deltaE } from '@gridwright/core'
import { parseCssColor } from '../src/color.js'

describe('colours as a stylesheet declares them', () => {
  // The case that made every colour in a shadcn project incomparable: Tailwind
  // v4's neutral-900, declared in oklch, is the #171717 a design brings.
  it('reads Tailwind v4 oklch, percentages and `none` included', () => {
    expect(parseCssColor('oklch(20.5% 0 none)')).toBe('#171717')
  })

  it('reads the fractional form shadcn declares', () => {
    expect(parseCssColor('oklch(0.205 0 0)')).toBe('#171717')
  })

  // Tailwind v4's violet-500. The ruler measured this exact colour in a render
  // as #8e51ff, through the browser's own conversion.
  it('lands a saturated oklch where the browser paints it', () => {
    const got = parseCssColor('oklch(60.6% 0.25 292.717)')!
    expect(deltaE(got, '#8e51ff')).toBeLessThan(1)
  })

  it('reads hex in every length, and drops its alpha', () => {
    expect(parseCssColor('#FFF')).toBe('#ffffff')
    expect(parseCssColor('#7f56d9')).toBe('#7f56d9')
    expect(parseCssColor('#7f56d9cc')).toBe('#7f56d9')
  })

  it('reads rgb() with commas or spaces', () => {
    expect(parseCssColor('rgb(127, 86, 217)')).toBe('#7f56d9')
    expect(parseCssColor('rgb(127 86 217 / 0.8)')).toBe('#7f56d9')
  })

  it('is not fooled by something that is not a colour', () => {
    expect(parseCssColor('var(--primary)')).toBeNull()
    expect(parseCssColor('transparent')).toBeNull()
    expect(parseCssColor('1px solid #000')).toBeNull()
  })

  it('treats a colour that is barely there as no colour', () => {
    expect(parseCssColor('oklch(0.5 0.1 200 / 0.01)')).toBeNull()
  })
})
