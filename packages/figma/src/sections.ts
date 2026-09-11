/**
 * The sections of a view, and which of them belong in the library.
 *
 * A view's sections are its immediate children. That was checked against a
 * real page before it was written down: ten full-width children stacked in a
 * vertical auto-layout, and taking the immediate children found all ten. A list
 * of the same page written by hand missed three, included a background
 * rectangle from inside another frame, and named two nodes that do not exist.
 * So gridwright lists them and a person confirms — never the other way round.
 *
 * Figma already says which ones are reusable. An `INSTANCE` was made from a
 * main component: it is a section, it has its own run and it ends up in the
 * library. Anything else was drawn for that page and stays part of the view.
 */

import type { FigmaComponentMeta, FigmaComponentSetMeta, FigmaNode } from './types.js'

export interface SectionInfo {
  nodeId: string
  /** The layer's name in the view. Not always what the component is called:
   *  `home-signals` is an instance of `overlay-form`. */
  layerName: string
  /** What it goes by: its component set's name, unless that is scaffolding. */
  name: string
  type: string
  /** Made from a main component, so it belongs in the library. */
  reusable: boolean
  /**
   * What makes two sections the same section: the component set, or the main
   * component when it is not part of a set. Two instances of it in one view are
   * built once, and an identity already in the registry is reused, not rebuilt.
   */
  identity?: string
  width: number
  height: number
}

/**
 * The immediate children of a view, classified.
 *
 * Hidden layers and zero-size nodes are left out — they are the designer's
 * leftovers, and one of them would otherwise become a run that renders
 * nothing.
 */
export function detectSections(
  root: FigmaNode,
  components: Record<string, FigmaComponentMeta> = {},
  componentSets: Record<string, FigmaComponentSetMeta> = {},
): SectionInfo[] {
  const out: SectionInfo[] = []
  for (const child of root.children ?? []) {
    if (child.visible === false) continue
    const box = child.absoluteBoundingBox
    if (!box || box.width <= 0 || box.height <= 0) continue

    const reusable = child.type === 'INSTANCE' && !!child.componentId
    const component = child.componentId ? components[child.componentId] : undefined
    const setId = component?.componentSetId
    const libraryName = setId ? componentSets[setId]?.name : component?.name

    out.push({
      nodeId: child.id,
      layerName: child.name,
      name: sectionName(child.name, reusable ? libraryName : undefined),
      type: child.type,
      reusable,
      ...(reusable ? { identity: setId ?? child.componentId } : {}),
      width: box.width,
      height: box.height,
    })
  }
  return out
}

/**
 * A name worth keeping for a section.
 *
 * The component set's, because that is what every other view will know it by:
 * registering `home-signals` would make the next page that uses `overlay-form`
 * under another layer name build a second copy. But a set called `Frame 87`, or
 * one whose "name" is a list of variant properties, is not a name — the
 * instance's is better.
 *
 * Library names in the wild carry a description after an em dash, "hero —
 * Cabecera"; the part before it is the identifier.
 */
export function sectionName(layerName: string, libraryName?: string): string {
  const clean = (s: string) => s.split(/\s+[—–]\s+/)[0]!.trim()
  if (libraryName && !isScaffolding(libraryName)) return clean(libraryName)
  return clean(layerName)
}

function isScaffolding(name: string): boolean {
  return /=/.test(name)
    || /^(frame|group|component|instance|rectangle|section)\s*\d*$/i.test(name.trim())
}

/**
 * A copy of the view with each reusable section emptied out.
 *
 * What the model composing the page reads: a stack of boxes, one per section,
 * and the view's own parts in full. Not the thousands of nodes inside the
 * sections — each of those has its own run and its own IR (Law 2) — and the
 * boxes are what `verify` measures the page against.
 */
export function stubSections(root: FigmaNode, ids: Set<string>): FigmaNode {
  const copy = (n: FigmaNode): FigmaNode => ({
    ...n,
    ...(n.children
      ? { children: ids.has(n.id) ? [] : n.children.map(copy) }
      : {}),
  })
  return copy(root)
}

/** One subtree, found by id. */
export function findNode(root: FigmaNode, id: string): FigmaNode | null {
  if (root.id === id) return root
  for (const c of root.children ?? []) {
    const hit = findNode(c, id)
    if (hit) return hit
  }
  return null
}
