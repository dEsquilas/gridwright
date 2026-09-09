/**
 * `gw report` — the page someone looks at to decide.
 *
 * The first version led with three red percentages and never showed the design.
 * You cannot judge "does this match?" without the thing it should match, and a
 * number is not that thing — a correct component scored 40% and the page had no
 * way to say so.
 *
 * So the comparison comes first and everything else is support. Side by side,
 * a drag-to-compare overlay, and the diff; the tokens, the IR and the stage log
 * are folded away underneath, useful once you have already decided something is
 * worth looking into.
 *
 * Static HTML with the images inlined. It has to open from a gitignored
 * directory months later, on a machine with nothing installed.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  activeRun, advance, listRuns, loadConfig, loadState, paths, saveState,
  type IR, type Measurements, type RunScore, type RunState, type GridwrightConfig,
} from '@gridwright/core'
import type { Resolution } from '@gridwright/tokens'
import { ok, fail, info, dim } from '../ui.js'

export interface ReportArgs { run?: string; open?: boolean }

export function runReport(root: string, args: ReportArgs): void {
  const config = loadConfig(root)
  if (!config) fail('This project is not configured.', 'Run `gw init` first.')
  const run = args.run ? loadState(root, args.run) : activeRun(root) ?? listRuns(root)[0]
  if (!run) fail('No run to report on.', 'Start one with `gw build "<figma-url>"`.')

  const dir = paths.dashboard(root)
  mkdirSync(dir, { recursive: true })
  const out = join(dir, 'index.html')
  writeFileSync(out, page(root, config, run, listRuns(root)))

  ok(`Dashboard written to ${out}`)
  console.log(dim('  Side by side, drag to compare, and the diff — the design is in there now.'))

  // The flag existed and did nothing: it was declared, parsed, and never read,
  // so `gw report --open` printed a path and left you to find it yourself.
  if (args.open) openInBrowser(out)
  else console.log(dim(`  open ${out}`))

  if (run.stage === 'report') {
    advance(run, 'report', { status: 'done', output: { file: out } })
    saveState(root, run)
  }
}

/**
 * Hands the file to the desktop rather than starting a server.
 *
 * The page inlines every image as a data URI for exactly this reason: a
 * `file://` URL with no origin cannot fetch a sibling PNG, and a dashboard
 * that needs a server to look at is one nobody looks at.
 */
function openInBrowser(file: string): void {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start'
    : 'xdg-open'
  try {
    execFileSync(cmd, [file], { stdio: 'ignore' })
  } catch {
    // Headless, or no desktop. The path was already printed above.
    console.log(dim('  Could not open a browser here — the path above is the page.'))
  }
}

interface ViewportView {
  name: string
  width: number
  total: number
  render: string | null
  diff: string | null
  /** True when a Figma frame of this width exists. Comparing a 375px render
   *  against a 1920px design produces a red blob that means nothing. */
  hasReference: boolean
  dimensions: RunScore['viewports'][number]['dimensions']
}

function page(root: string, config: GridwrightConfig, run: RunState, all: RunState[]): string {
  const ir = readJson<IR>(paths.ir(root, run.id))
  const measurements = readJson<Measurements>(paths.measurements(root, run.id))
  const resolutions = readJson<Resolution[]>(paths.resolutions(root, run.id)) ?? []
  const score = run.stages.verify.output?.score as RunScore | undefined

  const design = findDesign(root, run)
  const designWidth = measurements?.root.width ?? 0
  const component = componentName(run)

  const views: ViewportView[] = (score?.viewports ?? []).map((v) => ({
    name: v.viewport,
    width: v.width,
    total: v.total,
    render: inlineImage(join(root, '.gridwright', 'verify', `${v.viewport}.png`)),
    diff: inlineImage(join(root, '.gridwright', 'verify', `${v.viewport}-diff.png`)),
    // Within 10%: a 1440 render against a 1440 frame is the same layout, a
    // 375 render against it is a different one.
    hasReference: designWidth > 0 && Math.abs(v.width - designWidth) / designWidth < 0.1,
    dimensions: v.dimensions,
  }))

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${esc(component)} — gridwright</title>
<style>
  :root { --ink:#1a1a1a; --muted:#6b6b6b; --line:#e6e3de; --bg:#fbfbfa; --panel:#fff;
          --ok:#16a34a; --warn:#d97706; --bad:#dc2626; --accent:#2563eb; }
  * { box-sizing:border-box; }
  body { margin:0; padding:32px; background:var(--bg); color:var(--ink);
         font:14px/1.55 ui-sans-serif,-apple-system,Segoe UI,Roboto,sans-serif; }
  main { max-width:1240px; margin:0 auto; }
  h1 { font-size:20px; margin:0 0 2px; }
  h2 { font-size:14px; margin:32px 0 10px; padding-bottom:6px; border-bottom:1px solid var(--line); }
  .sub { color:var(--muted); margin-bottom:24px; font-size:13px; }
  code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12.5px; }

  .bar { display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-bottom:14px; }
  .seg { display:inline-flex; border:1px solid var(--line); border-radius:7px; overflow:hidden; background:var(--panel); }
  .seg button { border:0; background:none; padding:7px 13px; font:inherit; font-size:13px;
                cursor:pointer; color:var(--muted); border-right:1px solid var(--line); }
  .seg button:last-child { border-right:0; }
  .seg button.on { background:var(--ink); color:#fff; }
  .seg button[disabled] { opacity:.4; cursor:not-allowed; }
  .grow { flex:1; }

  .stage { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:16px; }
  .cols { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
  .cols.one { grid-template-columns:1fr; }
  .pane h3 { font-size:11px; text-transform:uppercase; letter-spacing:.05em;
             color:var(--muted); margin:0 0 8px; font-weight:600; }
  .pane img { width:100%; display:block; border:1px solid var(--line); border-radius:5px; background:#fff; }

  /* Drag to compare. Both images sit in the same box and the top one is clipped. */
  .wipe { position:relative; user-select:none; cursor:ew-resize; border:1px solid var(--line);
          border-radius:5px; overflow:hidden; background:#fff; }
  .wipe img { display:block; width:100%; }
  .wipe img.top { position:absolute; inset:0; height:100%; object-fit:cover; object-position:top left;
                  clip-path:inset(0 0 0 50%); }
  .wipe .handle { position:absolute; top:0; bottom:0; width:2px; background:var(--accent); left:50%; }
  .wipe .handle::after { content:'◄ ►'; position:absolute; top:14px; left:50%; transform:translateX(-50%);
                         background:var(--accent); color:#fff; font-size:10px; padding:3px 7px;
                         border-radius:20px; white-space:nowrap; }
  .wipe .tag { position:absolute; top:10px; font-size:10px; text-transform:uppercase; letter-spacing:.06em;
               background:rgba(0,0,0,.6); color:#fff; padding:3px 7px; border-radius:4px; }
  .wipe .tag.l { left:10px; } .wipe .tag.r { right:10px; }

  .note { background:#fff7ec; border:1px solid #f0d9b5; color:#8a5a10; border-radius:7px;
          padding:11px 13px; font-size:13px; margin-bottom:14px; }
  .verdict { display:flex; gap:22px; align-items:baseline; margin-top:14px; padding-top:14px;
             border-top:1px solid var(--line); flex-wrap:wrap; font-size:13px; }
  .verdict b { font-size:15px; }
  .pass { color:var(--ok); } .fail { color:var(--bad); } .na { color:var(--muted); }

  table { border-collapse:collapse; width:100%; font-size:13px; }
  td,th { text-align:left; padding:6px 9px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:600; font-size:11px; text-transform:uppercase; letter-spacing:.04em; }
  .tag-b { display:inline-block; padding:1px 7px; border-radius:99px; font-size:11px; font-weight:600; }
  .t-exact{background:#eef7f0;color:var(--ok)} .t-near{background:#fdf4e7;color:var(--warn)}
  .t-new{background:#eef3fd;color:var(--accent)}
  details { margin-bottom:8px; } summary { cursor:pointer; color:var(--muted); padding:6px 0; }
  pre { background:var(--panel); border:1px solid var(--line); border-radius:7px; padding:12px;
        overflow:auto; max-height:400px; font-size:12px; }
  .muted { color:var(--muted); }
</style></head><body><main>

<h1>${esc(component)}</h1>
<div class="sub">run <code>${esc(run.id)}</code> · node <code>${esc(run.source.nodeId)}</code>${
  designWidth ? ` · design is ${Math.round(designWidth)}px wide` : ''}</div>

${viewer(views, design)}
${tokensSection(resolutions)}
${detailsSection(ir, run, all)}

<p class="muted" style="margin-top:36px;font-size:12px">
  Generated by gridwright. Images are inlined, so this file works on its own.
</p>

<script>
const VIEWS = ${JSON.stringify(views.map((v) => ({
    name: v.name, width: v.width, total: v.total,
    render: v.render, diff: v.diff, hasReference: v.hasReference,
    dimensions: v.dimensions,
  })))};
const DESIGN = ${JSON.stringify(design)};
let vp = VIEWS.findIndex(v => v.hasReference);
if (vp < 0) vp = 0;
let mode = 'side';

function render() {
  const v = VIEWS[vp];
  if (!v) return;
  document.querySelectorAll('#vpSeg button').forEach((b, i) => b.classList.toggle('on', i === vp));
  document.querySelectorAll('#modeSeg button').forEach(b => {
    b.classList.toggle('on', b.dataset.mode === mode);
    // Nothing to compare against without a design at this width.
    // Comparing is always allowed. A render at another width is still worth
    // seeing beside the design — it just is not a fidelity measurement, and
    // the note says so.
    b.disabled = !DESIGN && b.dataset.mode !== 'render';
  });

  const stage = document.getElementById('stage');
  const warn = !v.hasReference && DESIGN
    ? '<div class="note"><b>' + v.width + 'px is not the width this frame was drawn at.</b> ' +
      'Compare freely — the layout is meant to differ here — but the numbers below are not ' +
      'a fidelity measurement, because there is no design at this width to be faithful to. ' +
      'The viewport marked \u25cf is the one that is.</div>'
    : '';

  let body;
  if (!DESIGN) {
    body = '<div class="cols one"><div class="pane"><h3>Render</h3><img src="' + v.render + '"></div></div>';
  } else if (mode === 'render') {
    body = '<div class="cols one"><div class="pane"><h3>Render · ' + v.width + 'px</h3><img src="' + v.render + '"></div></div>';
  } else if (mode === 'side') {
    body = '<div class="cols">' +
      '<div class="pane"><h3>Design · Figma</h3><img src="' + DESIGN + '"></div>' +
      '<div class="pane"><h3>Render · ' + v.width + 'px</h3><img src="' + v.render + '"></div></div>';
  } else if (mode === 'wipe') {
    body = '<div class="pane"><h3>Drag to compare</h3><div class="wipe" id="wipe">' +
      '<img src="' + v.render + '">' +
      '<img class="top" id="wipeTop" src="' + DESIGN + '">' +
      '<span class="tag l">render</span><span class="tag r">design</span>' +
      '<div class="handle" id="wipeH"></div></div></div>';
  } else {
    body = v.diff
      ? '<div class="pane"><h3>Diff · red is different, grey is masked text</h3><img src="' + v.diff + '"></div>'
      : '<div class="cols one"><div class="pane muted">No diff for this viewport.</div></div>';
  }

  stage.innerHTML = warn + body + verdict(v);
  if (mode === 'wipe' && v.hasReference) setupWipe();
}

function verdict(v) {
  const parts = v.dimensions.map(d => d.unavailable
    ? '<span class="na">' + d.dimension + ': not measured</span>'
    : '<span>' + d.dimension + ': <b>' + d.score + '%</b></span>');
  return '<div class="verdict">' + parts.join('') +
    '<span class="muted" style="flex:1"></span>' +
    '<span class="muted">the numbers are evidence, not a verdict \\u2014 what you see decides</span></div>';
}

function setupWipe() {
  const box = document.getElementById('wipe');
  const top = document.getElementById('wipeTop');
  const h = document.getElementById('wipeH');
  let dragging = false;
  const move = (x) => {
    const r = box.getBoundingClientRect();
    const p = Math.max(0, Math.min(1, (x - r.left) / r.width));
    top.style.clipPath = 'inset(0 0 0 ' + (p * 100) + '%)';
    h.style.left = (p * 100) + '%';
  };
  box.addEventListener('mousedown', e => { dragging = true; move(e.clientX); });
  window.addEventListener('mousemove', e => { if (dragging) move(e.clientX); });
  window.addEventListener('mouseup', () => { dragging = false; });
  box.addEventListener('touchmove', e => move(e.touches[0].clientX), { passive: true });
}

document.getElementById('vpSeg').addEventListener('click', e => {
  const i = [...e.currentTarget.children].indexOf(e.target);
  if (i >= 0) { vp = i; render(); }
});
document.getElementById('modeSeg').addEventListener('click', e => {
  if (e.target.dataset.mode && !e.target.disabled) { mode = e.target.dataset.mode; render(); }
});
render();
</script>
</main></body></html>`
}

function viewer(views: ViewportView[], design: string | null): string {
  if (views.length === 0) {
    return `<h2>Comparison</h2><p class="muted">Not verified yet — run <code>gw verify</code>.</p>`
  }

  const vpButtons = views.map((v) => {
    // The dot marks the width the design was drawn at — the one where the
    // numbers mean something.
    const mark = v.hasReference ? ' ●' : ''
    return `<button>${esc(v.name)} ${v.width}${mark}</button>`
  }).join('')

  return `<h2>Comparison</h2>
<div class="bar">
  <div class="seg" id="vpSeg">${vpButtons}</div>
  <div class="seg" id="modeSeg">
    <button data-mode="side">Side by side</button>
    <button data-mode="wipe">Drag to compare</button>
    <button data-mode="diff">Diff</button>
    <button data-mode="render">Render only</button>
  </div>
</div>
${design ? '' : '<div class="note">No design image on this run — only the render is shown. `gw build` fetches it from Figma.</div>'}
<div class="stage" id="stage"></div>`
}

function tokensSection(resolutions: Resolution[]): string {
  if (resolutions.length === 0) return ''
  const counts = {
    exact: resolutions.filter((r) => r.bucket === 'exact').length,
    near: resolutions.filter((r) => r.bucket === 'near').length,
    new: resolutions.filter((r) => r.bucket === 'new').length,
  }
  const rows = resolutions.map((r) => `<tr>
      <td><span class="tag-b t-${r.bucket}">${r.bucket}</span></td>
      <td><code>${esc(r.raw.value.slice(0, 60))}</code></td>
      <td>${r.match ? `<code>${esc(r.match.name)}</code>` : '<span class="muted">—</span>'}</td>
      <td class="muted">${esc(r.note ?? '')}</td>
    </tr>`).join('')

  return `<h2>Tokens</h2>
<p class="muted">${counts.exact} already in the system · ${counts.near} using the system's value · ${counts.new} new</p>
<details><summary>All ${resolutions.length}</summary>
<table><tr><th>bucket</th><th>design value</th><th>system token</th><th>note</th></tr>${rows}</table>
</details>`
}

function detailsSection(ir: IR | null, run: RunState, all: RunState[]): string {
  const stages = Object.entries(run.stages)
    .filter(([, s]) => s.status !== 'pending')
    .map(([name, s]) => `<tr><td><code>${esc(name)}</code></td><td>${esc(s.status)}</td>
      <td class="muted">${esc(s.reason ?? '')}</td></tr>`).join('')

  const warnings = ir?.warnings.length
    ? `<table>${ir.warnings.slice(0, 12).map((w) =>
        `<tr><td>${esc(w.severity)}</td><td>${esc(w.message)}</td></tr>`).join('')}</table>`
    : '<p class="muted">No warnings from distill.</p>'

  const history = all.length > 1
    ? `<details><summary>History · ${all.length} runs</summary><table>${
        all.slice(0, 15).map((r) => {
          const s = (r.stages.verify.output?.score as RunScore | undefined)?.total
          return `<tr><td><code>${esc(r.id)}</code></td><td>${esc(r.name)}</td>
            <td>${s !== undefined ? `${s}%` : '<span class="muted">—</span>'}</td>
            <td class="muted">${esc(r.stage)}</td></tr>`
        }).join('')}</table></details>`
    : ''

  return `<h2>Details</h2>
<details><summary>Distill warnings${ir ? ` · hash ${esc(ir.hash)}` : ''}</summary>${warnings}</details>
<details><summary>Stages</summary><table>${stages}</table></details>
${ir ? `<details><summary>The IR</summary><pre>${esc(JSON.stringify(ir, null, 2))}</pre></details>` : ''}
${history}`
}

/** Figma's export: from the frozen baseline first, then from the run. */
function findDesign(root: string, run: RunState): string | null {
  const name = componentName(run)
  return inlineImage(join(paths.baselines(root), `${name}.design.png`))
    ?? inlineImage(paths.reference(root, run.id))
}

/** The name the codebase uses, not the Figma frame's. */
function componentName(run: RunState): string {
  const file = run.stages.author.output?.file
  if (typeof file !== 'string') return run.name
  const parts = file.replace(/\\/g, '/').split('/')
  const base = (parts[parts.length - 1] ?? '').replace(/\.[^.]+$/, '')
  const derived = base === 'index' ? (parts[parts.length - 2] ?? '') : base
  return /^[A-Z]/.test(derived) ? derived : run.name
}

function inlineImage(path: string): string | null {
  if (!existsSync(path)) return null
  return `data:image/png;base64,${readFileSync(path).toString('base64')}`
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}
