/**
 * Asset extraction. This is a port of an earlier project's Figma image
 * extractor, with three changes.
 *
 * 1. It finds the SMALLEST frame containing an image, not the loose image
 *    itself. That detail came from the original and is what makes the asset
 *    come out at the design's size rather than at the bitmap's source size.
 * 2. `sharp.trim()` to strip the transparent padding Figma adds around
 *    content: without it you get checkerboard squares over light backgrounds
 *    and dimensions that do not match the design.
 * 3. Figma's signed URLs are NOT stored in the manifest (Law 10.c). The
 *    original kept them around; they are temporary credentials with legs.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FigmaClient } from './client.js'
import type { FigmaNode } from './types.js'
import { hasImageFill, isVectorArtwork, slugify } from './distill.js'

export interface AssetRecord {
  file: string
  layer: string
  layerPath: string
  nodeId: string
  width: number
  height: number
  bytes: number
  /** How much the trim shrank it, if at all. It is the signal that there was
   *  transparent padding. */
  trimmed?: { from: string; to: string }
}

export interface AssetManifest {
  extractedAt: string
  sourceFile: string
  sourceNode: string
  assets: AssetRecord[]
  /** If sharp was unavailable the assets are still saved, unoptimized, and we
   *  say so. */
  optimized: boolean
}

interface ImageTarget {
  id: string
  name: string
  path: string
  width: number
  height: number
  /** Bitmaps come back as PNG; drawings come back as SVG, which scales, inlines
   *  and can take its colour from the block that hosts it. */
  format: 'png' | 'svg'
}

export function findImageTargets(node: FigmaNode, parentPath = '', out: ImageTarget[] = []): ImageTarget[] {
  const path = parentPath ? `${parentPath} / ${node.name}` : node.name
  if (node.visible === false) return out

  const box = node.absoluteBoundingBox
  const record = (format: 'png' | 'svg') => {
    out.push({
      id: node.id,
      name: node.name,
      path,
      width: Math.round(box?.width ?? 0),
      height: Math.round(box?.height ?? 0),
      format,
    })
    return out
  }

  if (hasImageFill(node)) return record('png')
  if (isVectorArtwork(node)) return record('svg')

  for (const child of node.children ?? []) findImageTargets(child, path, out)
  return out
}

export async function extractAssets(
  client: FigmaClient,
  root: FigmaNode,
  source: { fileKey: string; nodeId: string },
  outDir: string,
  opts: { scale?: number; prefix?: string } = {},
): Promise<AssetManifest> {
  const targets = findImageTargets(root)
  mkdirSync(outDir, { recursive: true })

  const sharp = await loadSharp()
  const manifest: AssetManifest = {
    extractedAt: new Date().toISOString(),
    sourceFile: source.fileKey,
    sourceNode: source.nodeId,
    assets: [],
    optimized: sharp !== null,
  }

  if (targets.length === 0) {
    writeManifest(outDir, manifest)
    return manifest
  }

  // The URLs live only inside this function: consumed and dropped. Two calls,
  // because the API takes one format per request.
  const urls = new Map<string, string>()
  for (const format of ['png', 'svg'] as const) {
    const ids = targets.filter((t) => t.format === format).map((t) => t.id)
    if (ids.length === 0) continue
    for (const [id, url] of await client.imageUrls(source.fileKey, ids, { format, scale: opts.scale ?? 2 })) {
      urls.set(id, url)
    }
  }

  const used = new Set<string>()
  for (const target of targets) {
    const url = urls.get(target.id)
    if (!url) continue

    const buf = Buffer.from(await (await fetch(url)).arrayBuffer())
    const file = uniqueName(nameFor(target.name, opts.prefix, `.${target.format}`), used)
    const dest = join(outDir, file)

    const record: AssetRecord = {
      file, layer: target.name, layerPath: target.path, nodeId: target.id,
      width: target.width, height: target.height, bytes: buf.length,
    }

    // An SVG is already the smallest it will be, and sharp would rasterize it.
    if (target.format === 'svg') {
      writeFileSync(dest, buf)
    } else if (sharp) {
      const before = await sharp(buf).metadata()
      const out = await sharp(buf).trim({ threshold: 1 }).png({ compressionLevel: 9 }).toBuffer()
      const after = await sharp(out).metadata()
      writeFileSync(dest, out)
      record.bytes = out.length
      if (before.width !== after.width || before.height !== after.height) {
        record.trimmed = { from: `${before.width}x${before.height}`, to: `${after.width}x${after.height}` }
      }
      record.width = after.width ?? record.width
      record.height = after.height ?? record.height
    } else {
      writeFileSync(dest, buf)
    }

    manifest.assets.push(record)
  }

  writeManifest(outDir, manifest)
  return manifest
}

function writeManifest(dir: string, m: AssetManifest): void {
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m, null, 2) + '\n')
}

function nameFor(layerName: string, prefix?: string, ext = '.png'): string {
  const slug = slugify(layerName)
  // The original treated hero/banner separately because it is almost always the
  // background asset, and being able to find it by name matters.
  if (/hero|banner/.test(slug)) return prefix ? `hero-${prefix}${ext}` : `hero${ext}`
  return prefix ? `${prefix}-${slug}${ext}` : `${slug}${ext}`
}

/** Two layers can share a name. The original resolved this with a global index,
 *  which meant adding one image renamed every other one. */
function uniqueName(name: string, used: Set<string>): string {
  if (!used.has(name)) { used.add(name); return name }
  const ext = name.match(/\.[a-z]+$/)?.[0] ?? ''
  const base = ext ? name.slice(0, -ext.length) : name
  let i = 2
  while (used.has(`${base}-${i}${ext}`)) i++
  const final = `${base}-${i}${ext}`
  used.add(final)
  return final
}

/** sharp is a native module: when it is missing we save the assets unoptimized
 *  instead of breaking the whole run. */
async function loadSharp(): Promise<((input?: Buffer) => any) | null> {
  try {
    const mod = await import('sharp')
    return (mod.default ?? mod) as any
  } catch {
    return null
  }
}
