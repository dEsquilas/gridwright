/**
 * `gw report` — the project's component library, and how each piece got there.
 *
 * It started as a report on one run: three red percentages and no picture of
 * the design. You cannot judge "does this match?" without the thing it should
 * match, so the comparison came first and the numbers moved underneath.
 *
 * But one run is a receipt, not a dashboard. What a person actually wants is
 * the library — every module and every view the project has, what each one is,
 * and how it went when gridwright built it. So the spine is the registry and
 * the baselines, both of which are per component and both of which outlive the
 * run that produced them; a run is the detail you open, not the subject.
 *
 * Static HTML with the images inlined. It has to open from a gitignored
 * directory months later, on a machine with nothing installed.
 */

import { execFileSync } from 'node:child_process'
import { Script } from 'node:vm'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  activeRun, advance, listRuns, loadConfig, loadState, paths, saveState,
  type IR, type Measurements, type RunScore, type RunState, type GridwrightConfig,
} from '@gridwright/core'
import { readRegistry, type RegistryEntry } from '@gridwright/library'
import type { Resolution } from '@gridwright/tokens'
import { ok, fail, dim } from '../ui.js'

export interface ReportArgs { run?: string; open?: boolean }

/** How many entries get their images inlined. Past this the page is measured in
 *  tens of megabytes, and nobody scrolls that far anyway. */
const MAX_ENTRIES = 40

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

/** One thing the project has: a module or a view, with the evidence behind it. */
interface Entry {
  name: string
  mode: 'component' | 'view'
  /** Built but never registered — visible, and marked, so a run that stopped
   *  short is not invisible in the very page meant to show what exists. */
  registered: boolean
  path: string
  node: string
  runId: string | null
  runs: number
  updatedAt: string
  score: number | null
  props: string[]
  tokens: string[]
  designWidth: number
  design: string | null
  views: ViewportView[]
  warnings: Array<{ severity: string; message: string }>
  resolutions: Array<{ bucket: string; value: string; token: string | null; note: string }>
  stages: Array<{ name: string; status: string; reason: string }>
}

export function runReport(root: string, args: ReportArgs): void {
  const config = loadConfig(root)
  if (!config) fail('This project is not configured.', 'Run `gw init` first.')

  const runs = listRuns(root)
  const entries = library(root, config, runs)
  if (entries.length === 0) {
    fail(
      'Nothing to show yet.',
      'No component is registered and no run has been verified. Start one with `gw build "<figma-url>"`.',
    )
  }

  // Which entry opens first: the run just reported on, else the newest.
  const focus = args.run ? loadState(root, args.run) : activeRun(root) ?? runs[0] ?? null
  const focusName = focus ? componentName(focus) : entries[0]!.name
  const selected = Math.max(0, entries.findIndex((e) => e.name === focusName))

  const dir = paths.dashboard(root)
  mkdirSync(dir, { recursive: true })
  const out = join(dir, 'index.html')
  const html = page(config, entries, selected)

  // Parse the script before writing it. A page whose JS does not compile
  // renders as a blank white rectangle with no error anywhere a person will
  // look, and it took one stray apostrophe — `\'` inside a template literal
  // collapses to a bare quote, which closed the string it was meant to be in.
  // Compiling is not running: this checks syntax and executes nothing.
  const script = html.slice(html.lastIndexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'))
  try {
    new Script(script)
  } catch (e) {
    fail(
      'The dashboard was generated with a syntax error in its script, so it would render blank.',
      `${e instanceof Error ? e.message : String(e)}\n\nThis is a bug in gridwright, not in your project.`,
    )
  }

  writeFileSync(out, html)

  ok(`Dashboard written to ${out}`)
  const views = entries.filter((e) => e.mode === 'view').length
  const modules = entries.length - views
  console.log(dim(`  ${modules} module${modules === 1 ? '' : 's'}${views ? ` and ${views} view${views === 1 ? '' : 's'}` : ''} in the library.`))

  if (args.open) openInBrowser(out)
  else console.log(dim(`  open ${out}`))

  if (focus && focus.stage === 'report') {
    advance(focus, 'report', { status: 'done', output: { file: out } })
    saveState(root, focus)
  }
}

/**
 * Every module and view the project has.
 *
 * The registry is the spine: it is what `library:register` writes and what
 * survives its run. A run that was built but never registered is included and
 * marked, because a dashboard that hides unfinished work answers the wrong
 * question.
 */
function library(root: string, config: GridwrightConfig, runs: RunState[]): Entry[] {
  const registry = readRegistry(root, config)
  const latestRun = new Map<string, RunState>()
  for (const run of runs) {
    const name = componentName(run)
    // `listRuns` is newest first, so the first one wins.
    if (!latestRun.has(name)) latestRun.set(name, run)
  }

  const entries: Entry[] = []
  const seen = new Set<string>()

  for (const [name, reg] of Object.entries(registry)) {
    seen.add(name)
    entries.push(entryFor(root, name, reg, latestRun.get(name) ?? null, true))
  }
  for (const [name, run] of latestRun) {
    if (seen.has(name)) continue
    if (!run.stages.verify.output?.score && !run.stages.author.output?.file) continue
    entries.push(entryFor(root, name, null, run, false))
  }

  // Registered first, then by name: a library is browsed alphabetically.
  return entries
    .sort((a, b) => Number(b.registered) - Number(a.registered) || a.name.localeCompare(b.name))
    .slice(0, MAX_ENTRIES)
}

function entryFor(
  root: string,
  name: string,
  reg: RegistryEntry | null,
  run: RunState | null,
  registered: boolean,
): Entry {
  const ir = run ? readJson<IR>(paths.ir(root, run.id)) : null
  const measurements = run ? readJson<Measurements>(paths.measurements(root, run.id)) : null
  const score = run?.stages.verify.output?.score as RunScore | undefined
  const resolutions = run ? readJson<Resolution[]>(join(paths.run(root, run.id), 'resolutions.json')) : null

  const designWidth = measurements?.root.width ?? 0
  const viewports = score?.viewports
    ?? reg?.viewports?.map((v) => ({
      viewport: v.name, width: v.width, total: v.total,
      dimensions: [] as RunScore['viewports'][number]['dimensions'],
    }))
    ?? []

  const views: ViewportView[] = viewports.map((v) => ({
    name: v.viewport,
    width: v.width,
    total: v.total,
    // The frozen baseline first: it is per component and it is committed, so it
    // is still there long after the run that made it was cleaned up.
    render: renderImage(root, name, v.viewport, run),
    diff: run ? shot(root, run.id, `${v.viewport}-diff.png`) : null,
    // Within 10%: a 1440 render against a 1440 frame is the same layout, a
    // 375 render against it is a different one.
    hasReference: designWidth > 0 && Math.abs(v.width - designWidth) / designWidth < 0.1,
    dimensions: v.dimensions,
  }))

  const atDesign = score?.viewports.find((v) => v.viewport === 'design')

  return {
    name,
    mode: reg?.mode ?? run?.mode ?? 'component',
    registered,
    path: reg?.path ?? (typeof run?.stages.author.output?.file === 'string' ? run.stages.author.output.file : ''),
    node: reg?.figma.node ?? run?.source.nodeId ?? '',
    runId: run?.id ?? null,
    runs: reg?.runs ?? (run ? 1 : 0),
    updatedAt: reg?.updatedAt ?? run?.createdAt ?? '',
    score: reg?.score ?? atDesign?.total ?? score?.total ?? null,
    props: reg?.props ?? [],
    tokens: reg?.tokens ?? [],
    designWidth,
    design: designImage(root, name, run),
    views,
    warnings: (ir?.warnings ?? []).slice(0, 12).map((w) => ({ severity: w.severity, message: w.message })),
    resolutions: (resolutions ?? []).map((r) => ({
      bucket: r.bucket,
      value: r.raw.value.slice(0, 60),
      token: r.match?.name ?? null,
      note: r.note ?? '',
    })),
    stages: run
      ? Object.entries(run.stages)
          .filter(([, st]) => st.status !== 'pending')
          .map(([n, st]) => ({ name: n, status: st.status, reason: st.reason ?? '' }))
      : [],
  }
}

function page(config: GridwrightConfig, entries: Entry[], selected: number): string {
  const modules = entries.filter((e) => e.mode !== 'view')
  const views = entries.filter((e) => e.mode === 'view')

  const button = (e: Entry) => {
    const i = entries.indexOf(e)
    const pct = e.score !== null ? `${Math.round(e.score)}%` : '—'
    return `<button data-i="${i}" data-name="${esc(e.name.toLowerCase())}"${i === selected ? ' class="on"' : ''}>` +
      `${esc(e.name)}<span class="pct">${esc(pct)}</span></button>`
  }

  const group = (label: string, list: Entry[]) =>
    list.length === 0 ? '' : `<div class="group">${esc(label)} · ${list.length}</div>${list.map(button).join('')}`

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Component library — gridwright</title>
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
  /* The library rail. The dashboard used to be one run; this is the project. */
  .shell { display:grid; grid-template-columns:250px 1fr; gap:26px; align-items:start; }
  .rail { position:sticky; top:32px; max-height:calc(100vh - 64px); overflow:auto;
          border:1px solid var(--line); border-radius:10px; background:var(--panel); padding:8px; }
  .rail h2 { margin:6px 8px 8px; border:0; padding:0; }
  .rail input { width:100%; padding:7px 9px; margin:0 0 8px; font:inherit; font-size:13px;
                border:1px solid var(--line); border-radius:7px; background:var(--bg); }
  .rail .group { color:var(--muted); font-size:10.5px; text-transform:uppercase;
                 letter-spacing:.06em; margin:12px 8px 5px; font-weight:600; }
  .rail button { display:flex; width:100%; align-items:baseline; gap:8px; text-align:left;
                 border:0; background:none; font:inherit; font-size:13px; cursor:pointer;
                 padding:7px 9px; border-radius:7px; color:var(--ink); }
  .rail button:hover { background:var(--bg); }
  .rail button.on { background:var(--ink); color:#fff; }
  .rail button .pct { margin-left:auto; font-size:11.5px; font-variant-numeric:tabular-nums;
                      opacity:.75; }
  .rail button.on .pct { opacity:.9; }
  .rail .none { color:var(--muted); padding:8px 9px; font-size:13px; }

  .chips { display:flex; flex-wrap:wrap; gap:5px; margin:2px 0 0; }
  .chips code { background:var(--panel); border:1px solid var(--line); border-radius:5px;
                padding:2px 7px; }
  .meta { display:flex; gap:20px; flex-wrap:wrap; font-size:12.5px; color:var(--muted);
          margin-bottom:22px; }
  .badge { display:inline-block; padding:1px 8px; border-radius:99px; font-size:11px;
           font-weight:600; background:#eef3fd; color:var(--accent); vertical-align:2px; }
  .badge.view { background:#f3eefd; color:#7c3aed; }
  .badge.unreg { background:#fdf4e7; color:var(--warn); }
  @media (max-width: 900px) { .shell { grid-template-columns:1fr; } .rail { position:static; max-height:none; } }
</style></head><body><main>

<div class="shell">
  <aside class="rail">
    <h2>Library</h2>
    <input id="filter" type="search" placeholder="Filter…" autocomplete="off">
    <div id="list">
      ${group('Modules', modules)}
      ${group('Views', views)}
      <div class="none" id="noMatch" hidden>Nothing matches.</div>
    </div>
  </aside>
  <section id="detail"></section>
</div>

<p class="muted" style="margin-top:36px;font-size:12px">
  Generated by gridwright${config.library?.registry ? ` from <code>${esc(config.library.registry)}</code> and the frozen baselines` : ''}.
  Images are inlined, so this file works on its own.
</p>

<script>
const LIBRARY = ${JSON.stringify(entries)};
let cur = ${selected};
let vp = 0;
let mode = 'side';

function entry() { return LIBRARY[cur]; }

function pickViewport() {
  const e = entry();
  const i = e.views.findIndex(v => v.hasReference);
  vp = i >= 0 ? i : 0;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);
}

function renderDetail() {
  const e = entry();
  const badge = e.mode === 'view'
    ? '<span class="badge view">view</span>'
    : '<span class="badge">module</span>';
  const unreg = e.registered ? '' : ' <span class="badge unreg">not registered</span>';

  const meta = [
    e.path ? '<span><code>' + esc(e.path) + '</code></span>' : '',
    e.node ? '<span>node <code>' + esc(e.node) + '</code></span>' : '',
    e.designWidth ? '<span>design ' + Math.round(e.designWidth) + 'px wide</span>' : '',
    e.runs ? '<span>' + e.runs + ' run' + (e.runs === 1 ? '' : 's') + '</span>' : '',
    e.updatedAt ? '<span>' + esc(e.updatedAt.slice(0, 10)) + '</span>' : '',
  ].filter(Boolean).join('');

  document.getElementById('detail').innerHTML =
    '<h1>' + esc(e.name) + ' ' + badge + unreg + '</h1>' +
    '<div class="meta">' + meta + '</div>' +
    viewerShell(e) +
    surfaceSection(e) +
    tokensSection(e) +
    detailsSection(e);

  const vpSeg = document.getElementById('vpSeg');
  if (vpSeg) {
    vpSeg.addEventListener('click', ev => {
      const i = [...ev.currentTarget.children].indexOf(ev.target);
      if (i >= 0) { vp = i; renderStage(); }
    });
    document.getElementById('modeSeg').addEventListener('click', ev => {
      if (ev.target.dataset.mode && !ev.target.disabled) { mode = ev.target.dataset.mode; renderStage(); }
    });
    renderStage();
  }
}

function viewerShell(e) {
  if (e.views.length === 0) {
    return '<h2>Comparison</h2><p class="muted">Not verified yet \u2014 run <code>gw verify</code>.</p>';
  }
  const buttons = e.views.map(v =>
    '<button>' + esc(v.name) + ' ' + v.width + (v.hasReference ? ' \u25cf' : '') + '</button>').join('');
  return '<h2>Comparison</h2>' +
    '<div class="bar"><div class="seg" id="vpSeg">' + buttons + '</div>' +
    '<div class="seg" id="modeSeg">' +
    '<button data-mode="side">Side by side</button>' +
    '<button data-mode="wipe">Drag to compare</button>' +
    '<button data-mode="diff">Diff</button>' +
    '<button data-mode="render">Render only</button></div></div>' +
    (e.design ? '' : '<div class="note">No design image for this one \u2014 only the render is shown.</div>') +
    '<div class="stage" id="stage"></div>';
}

function renderStage() {
  const e = entry();
  const v = e.views[vp];
  if (!v) return;
  document.querySelectorAll('#vpSeg button').forEach((b, i) => b.classList.toggle('on', i === vp));
  document.querySelectorAll('#modeSeg button').forEach(b => {
    b.classList.toggle('on', b.dataset.mode === mode);
    // Comparing is always allowed. A render at another width is still worth
    // seeing beside the design \u2014 it just is not a fidelity measurement,
    // and the note says so.
    b.disabled = !e.design && b.dataset.mode !== 'render';
  });

  const warn = !v.hasReference && e.design
    ? '<div class="note"><b>' + v.width + 'px is not the width this frame was drawn at.</b> ' +
      'Compare freely \u2014 the layout is meant to differ here \u2014 but the numbers below are not ' +
      'a fidelity measurement, because there is no design at this width to be faithful to. ' +
      'The viewport marked \u25cf is the one that is.</div>'
    : '';

  const missing = '<div class="cols one"><div class="pane muted">No image for this viewport.</div></div>';
  let body;
  if (!v.render) {
    body = missing;
  } else if (!e.design || mode === 'render') {
    body = '<div class="cols one"><div class="pane"><h3>Render \u00b7 ' + v.width + 'px</h3><img src="' + v.render + '"></div></div>';
  } else if (mode === 'side') {
    body = '<div class="cols">' +
      '<div class="pane"><h3>Design \u00b7 Figma</h3><img src="' + e.design + '"></div>' +
      '<div class="pane"><h3>Render \u00b7 ' + v.width + 'px</h3><img src="' + v.render + '"></div></div>';
  } else if (mode === 'wipe') {
    body = '<div class="pane"><h3>Drag to compare</h3><div class="wipe" id="wipe">' +
      '<img src="' + v.render + '">' +
      '<img class="top" id="wipeTop" src="' + e.design + '">' +
      '<span class="tag l">render</span><span class="tag r">design</span>' +
      '<div class="handle" id="wipeH"></div></div></div>';
  } else {
    body = v.diff
      ? '<div class="pane"><h3>Diff \u00b7 red is different, grey is masked text</h3><img src="' + v.diff + '"></div>'
      : '<div class="cols one"><div class="pane muted">No diff kept for this viewport.</div></div>';
  }

  document.getElementById('stage').innerHTML = warn + body + verdict(v);
  if (mode === 'wipe' && e.design && v.render) setupWipe();
}

function verdict(v) {
  if (v.dimensions.length === 0) {
    return '<div class="verdict"><span>' + v.total + '%</span>' +
      '<span class="muted" style="flex:1"></span>' +
      '<span class="muted">from the registry \u2014 no run detail kept</span></div>';
  }
  const parts = v.dimensions.map(d => d.unavailable
    ? '<span class="na">' + d.dimension + ': not measured</span>'
    : '<span>' + d.dimension + ': <b>' + d.score + '%</b></span>');
  return '<div class="verdict">' + parts.join('') +
    '<span class="muted" style="flex:1"></span>' +
    '<span class="muted">the numbers are evidence, not a verdict \u2014 what you see decides</span></div>';
}

function surfaceSection(e) {
  if (e.props.length === 0 && e.tokens.length === 0) return '';
  const chips = list => '<div class="chips">' + list.map(x => '<code>' + esc(x) + '</code>').join('') + '</div>';
  return '<h2>Surface</h2>' +
    (e.props.length ? '<p class="muted" style="margin:0 0 6px">Props</p>' + chips(e.props) : '') +
    (e.tokens.length ? '<p class="muted" style="margin:14px 0 6px">Tokens it uses \u00b7 ' + e.tokens.length + '</p>' + chips(e.tokens) : '');
}

function tokensSection(e) {
  if (e.resolutions.length === 0) return '';
  const n = b => e.resolutions.filter(r => r.bucket === b).length;
  const rows = e.resolutions.map(r =>
    '<tr><td><span class="tag-b t-' + esc(r.bucket) + '">' + esc(r.bucket) + '</span></td>' +
    '<td><code>' + esc(r.value) + '</code></td>' +
    '<td>' + (r.token ? '<code>' + esc(r.token) + '</code>' : '<span class="muted">\u2014</span>') + '</td>' +
    '<td class="muted">' + esc(r.note) + '</td></tr>').join('');
  return '<h2>How its values resolved</h2>' +
    '<p class="muted">' + n('exact') + ' already in the system \u00b7 ' + n('near') +
    " using the system's value \u00b7 " + n('new') + ' new</p>' +
    '<details><summary>All ' + e.resolutions.length + '</summary>' +
    '<table><tr><th>bucket</th><th>design value</th><th>system token</th><th>note</th></tr>' +
    rows + '</table></details>';
}

function detailsSection(e) {
  if (e.stages.length === 0 && e.warnings.length === 0) return '';
  const stages = e.stages.map(s =>
    '<tr><td><code>' + esc(s.name) + '</code></td><td>' + esc(s.status) +
    '</td><td class="muted">' + esc(s.reason) + '</td></tr>').join('');
  const warnings = e.warnings.length
    ? '<table>' + e.warnings.map(w =>
        '<tr><td>' + esc(w.severity) + '</td><td>' + esc(w.message) + '</td></tr>').join('') + '</table>'
    : '<p class="muted">No warnings from distill.</p>';
  return '<h2>The run that built it</h2>' +
    (e.runId ? '<p class="muted">' + esc(e.runId) + '</p>' : '') +
    '<details><summary>Distill warnings</summary>' + warnings + '</details>' +
    (stages ? '<details><summary>Stages</summary><table>' + stages + '</table></details>' : '');
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

document.getElementById('list').addEventListener('click', e => {
  const b = e.target.closest('button[data-i]');
  if (!b) return;
  document.querySelectorAll('#list button').forEach(x => x.classList.remove('on'));
  b.classList.add('on');
  cur = Number(b.dataset.i);
  mode = 'side';
  pickViewport();
  renderDetail();
  window.scrollTo({ top: 0 });
});

document.getElementById('filter').addEventListener('input', e => {
  const q = e.target.value.trim().toLowerCase();
  let shown = 0;
  document.querySelectorAll('#list button[data-i]').forEach(b => {
    const hit = !q || b.dataset.name.includes(q);
    b.hidden = !hit;
    if (hit) shown++;
  });
  document.querySelectorAll('#list .group').forEach(g => {
    let n = 0;
    for (let el = g.nextElementSibling; el && el.tagName === 'BUTTON'; el = el.nextElementSibling) {
      if (!el.hidden) n++;
    }
    g.hidden = n === 0;
  });
  document.getElementById('noMatch').hidden = shown > 0;
});

pickViewport();
renderDetail();
</script>
</main></body></html>`
}

/** Hands the file to the desktop rather than starting a server.
 *
 *  The page inlines every image for exactly this reason: a `file://` URL with
 *  no origin cannot fetch a sibling PNG, and a dashboard that needs a server to
 *  look at is one nobody looks at. */
function openInBrowser(file: string): void {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start'
    : 'xdg-open'
  try {
    execFileSync(cmd, [file], { stdio: 'ignore' })
  } catch {
    console.log(dim('  Could not open a browser here \u2014 the path above is the page.'))
  }
}

/**
 * Figma's export: the frozen one first, then the run's.
 *
 * `<Name>/figma.png` rather than a flat `<Name>.design.png`, which is what it
 * was called until it collided with the render frozen for the viewport named
 * `design`. Baselines written before the folders still read, because they are
 * committed and nobody should have to regenerate them to look at a page.
 */
function designImage(root: string, name: string, run: RunState | null): string | null {
  return inlineImage(join(paths.baseline(root, name), 'figma.png'))
    // Flat names, from before each thing got a folder.
    ?? inlineImage(join(paths.baselines(root), `${name}.figma.png`))
    ?? inlineImage(join(paths.baselines(root), `${name}.design.png`))
    ?? (run ? inlineImage(paths.reference(root, run.id)) : null)
}

/**
 * The component as it renders, at one viewport.
 *
 * The frozen baseline first: it is per component and committed, so it is still
 * there long after the run that made it was cleaned up. The exception is a
 * legacy `<Name>.design.png` with no `<Name>.figma.png` beside it — that file
 * is the design, not a render, and reading it here is what put the same image
 * in both panes and made a component look like a perfect match.
 */
function renderImage(root: string, name: string, viewport: string, run: RunState | null): string | null {
  const own = inlineImage(join(paths.baseline(root, name), `${viewport}.png`))
  if (own) return own

  // Flat names, from before each thing got a folder. The exception is a
  // `<Name>.design.png` with no `<Name>.figma.png` beside it: that file is the
  // design, not a render, and reading it here is what put the same image in
  // both panes and made a component look like a perfect match.
  const legacy = viewport === 'design'
    && !existsSync(join(paths.baselines(root), `${name}.figma.png`))
  if (!legacy) {
    const frozen = inlineImage(join(paths.baselines(root), `${name}.${viewport}.png`))
    if (frozen) return frozen
  }
  return run ? shot(root, run.id, `${viewport}.png`) : null
}

/** A run's screenshot, falling back to the shared directory for runs taken
 *  before each one kept its own evidence. */
function shot(root: string, runId: string, file: string): string | null {
  return inlineImage(join(paths.runVerify(root, runId), file))
    ?? inlineImage(join(paths.verify(root), file))
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
