import { describe, it, expect } from 'vitest'
import { detectSections, sectionName, stubSections, findNode, type FigmaNode } from '../src/index.js'

// Shaped after a real page: a vertical stack of full-width children, most of
// them instances of library components and one drawn for that page only.
const box = (y: number, height: number) => ({ x: 0, y, width: 1440, height })

const page: FigmaNode = {
  id: '1:1', name: 'home', type: 'FRAME', layoutMode: 'VERTICAL',
  absoluteBoundingBox: box(0, 4000),
  children: [
    { id: '1:2', name: 'hero — Cabecera', type: 'INSTANCE', componentId: 'c-hero', absoluteBoundingBox: box(0, 800),
      children: [{ id: '1:20', name: 'Title', type: 'TEXT', characters: 'Hi', absoluteBoundingBox: box(40, 60) }] },
    { id: '1:3', name: 'home-signals', type: 'INSTANCE', componentId: 'c-form-a', absoluteBoundingBox: box(800, 1000) },
    { id: '1:4', name: 'nav-main', type: 'INSTANCE', componentId: 'c-nav', absoluteBoundingBox: box(1800, 200) },
    { id: '1:5', name: '43', type: 'FRAME', absoluteBoundingBox: box(2000, 760),
      children: [{ id: '1:50', name: 'surface', type: 'RECTANGLE', absoluteBoundingBox: box(2000, 760) }] },
    { id: '1:6', name: 'other-signals', type: 'INSTANCE', componentId: 'c-form-b', absoluteBoundingBox: box(2760, 900) },
    { id: '1:7', name: 'draft', type: 'INSTANCE', componentId: 'c-hero', visible: false, absoluteBoundingBox: box(3660, 300) },
  ],
}

const components = {
  'c-hero': { name: 'Variant=Interior, Breakpoint=1440px', componentSetId: 'set-hero' },
  'c-form-a': { name: 'Property 1=Default', componentSetId: 'set-form' },
  'c-form-b': { name: 'Property 1=Dark', componentSetId: 'set-form' },
  'c-nav': { name: 'Frame 87' },
}
const componentSets = {
  'set-hero': { name: 'hero — Cabecera' },
  'set-form': { name: 'overlay-form — Formulario sobre medio' },
}

describe('sections of a view — its immediate children', () => {
  const sections = detectSections(page, components, componentSets)

  it('takes the immediate children, and leaves hidden ones out', () => {
    expect(sections.map((s) => s.layerName)).toEqual(['hero — Cabecera', 'home-signals', 'nav-main', '43', 'other-signals'])
  })

  // Figma already says which are reusable: an instance was made from a main
  // component. The frame was drawn for this page.
  it('an instance is reusable; a frame drawn for the page is not', () => {
    expect(sections.find((s) => s.layerName === '43')?.reusable).toBe(false)
    expect(sections.filter((s) => s.reusable)).toHaveLength(4)
  })

  // Two variants of one component set are one section to build.
  it('identity is the component set, so two variants of one set are one section', () => {
    const a = sections.find((s) => s.layerName === 'home-signals')!
    const b = sections.find((s) => s.layerName === 'other-signals')!
    expect(a.identity).toBe('set-form')
    expect(b.identity).toBe(a.identity)
  })

  it('a component outside any set is identified by the component itself', () => {
    expect(sections.find((s) => s.layerName === 'nav-main')?.identity).toBe('c-nav')
  })

  // `home-signals` is an instance of `overlay-form`. Registering the layer's
  // name would make the next page that uses overlay-form build a second one.
  it('is named after the component set, not the layer', () => {
    expect(sections.find((s) => s.layerName === 'home-signals')?.name).toBe('overlay-form')
    expect(sections.find((s) => s.layerName === 'hero — Cabecera')?.name).toBe('hero')
  })

  it('falls back to the layer name when the component is named like scaffolding', () => {
    expect(sections.find((s) => s.layerName === 'nav-main')?.name).toBe('nav-main')
  })
})

describe('section names', () => {
  it('drops the description after an em dash', () => {
    expect(sectionName('x', 'media-panel — Panel con medio')).toBe('media-panel')
  })

  it('does not take a list of variant properties for a name', () => {
    expect(sectionName('home-papers', 'Theme=Default, Breakpoint=Desktop')).toBe('home-papers')
  })

  it('does not take "Frame 87" for a name', () => {
    expect(sectionName('nav-main', 'Frame 87')).toBe('nav-main')
  })
})

describe('the view as the model reads it', () => {
  const stubbed = stubSections(page, new Set(['1:2', '1:3']))

  // The sections are their own runs' business: the view reads a box each.
  it('empties the sections it was given and nothing else', () => {
    expect(findNode(stubbed, '1:2')?.children).toEqual([])
    expect(findNode(stubbed, '1:5')?.children).toHaveLength(1)
  })

  it('keeps each section as a box, so the page can still be measured', () => {
    expect(findNode(stubbed, '1:2')?.absoluteBoundingBox).toEqual(box(0, 800))
  })

  it('does not touch the original', () => {
    expect(findNode(page, '1:2')?.children).toHaveLength(1)
  })
})
