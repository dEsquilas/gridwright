# Gridwright

End-to-end layout pipeline. A Figma node goes in; a built, visually verified
component registered in the project's design system comes out. Driven from
Claude Code.

[![license: MIT](https://img.shields.io/badge/license-MIT-16a34a)](LICENSE)
![tests: 184](https://img.shields.io/badge/tests-184%20passing-16a34a)

> **The design comes in as a node and leaves as a system.**
>
> Gridwright does not generate components: it builds the project's design system
> one node at a time. Every run leaves the repo with more resolved tokens, more
> registered components and more verified surface. If a component turns out fine
> but contributed nothing to the system, the run failed.

---

## The idea

The obvious temptation is to write a long prompt explaining to an agent how to
build a layout. That has been tried: an earlier repo has a five-phase workflow
written in prose, and the agent skips the analysis phase every time the request
looks simple. **A prompt is a suggestion.**

Gridwright inverts the split. The state machine lives on disk and a CLI enforces
it. Claude does not decide which stage comes next: it asks.

![The control loop: gw next returns a directive, Claude does the creative work, gw verify measures, and the score is evidence a person reads rather than a gate. state.json on disk is the single source of truth.](docs/protocol.svg)

```console
$ gw next --json
{
  "run": "hero-about-us-01",
  "stage": "author",
  "actor": "agent",
  "action": "write the component",
  "inputs": {
    "ir": "…/ir.json",
    "reference": "…/reference.png",
    "placement": { "kind": "module", "dir": "components/modules" },
    "conventions": { "shapes": [ … ], "breakpoints": [ … ], "docs": [ … ] }
  },
  "gate": null
}
```

The split of labour is explicit:

| Code does this | The model does this |
|---|---|
| Pull the node, the assets and the reference | Write the component idiomatically for this repo |
| Distill the tree into the IR | Name things, decide the prop API |
| Match and classify tokens | Name the new tokens |
| Index existing components | Decide what to reuse |
| Render, measure, diff | Read the diff and fix it |

If it can be checked with an assert, the model does not do it. If it needs
judgment about code that already exists, the program does not do it.

The measuring was built before the generating, deliberately. A generative
pipeline without a calibrated metric is a text generator with extra steps: you
cannot tell a good run from a bad one, so you cannot close the loop. The ruler
first, then the factory.

---

## Architecture

Three layers. The Claude Code plugin is a thin shell that only teaches the
protocol; all the logic lives in the `gw` binary; the outputs land in the
consuming project.

![Architecture: a thin Claude Code plugin on top, the gw CLI in the middle split into six packages, and two outputs at the bottom — the .gridwright working directory and the consuming project.](docs/architecture.svg)

```
packages/
├── core/     IR types, state machine, scoring, config, credentials
├── figma/    API client, distill, asset and vector extraction
├── tokens/   read the project's tokens, classify, write back
├── library/  registry, barrel, survey, placements, conventions
├── verify/   ephemeral harness, Playwright, perceptual diff
└── cli/      the gw binary, and the dashboard it generates
```

Six, not the eight the first spec drew. The adapters ended up inside `verify`'s
harness and the dashboard inside `cli`, and neither earned a package of its own.

**Stack**: TypeScript, Node, pnpm workspaces. Vitest throughout, Playwright and
Vite for `verify`, `sharp` for asset extraction and the perceptual diff,
`ts-morph` for reading and writing the token config. Five runtime dependencies
in total — a diff is one loop over pixels, and a native binary for that is
supply-chain surface for nothing.

---

## Install

> **Not on npm yet.** Until it is published, both routes below mean cloning
> this repo and linking the binary — `pnpm install && pnpm build && pnpm link
> --global` from the root. The commands are written as they will read once
> there is a package.

There are two ways in, and the recommended one is not the one you type.

![Two terminal windows. The first hands the whole job to Claude Code — install the CLI, install the plugin, init the project, build the node — and stops to ask the person to run `gw auth login` themselves. The second does the same four steps by hand.](docs/install.svg)

### Recommended — hand it to the agent

gridwright is built to be driven by Claude Code, so the shortest path is to say
so. In the repo where the component will live:

```
> Install gridwright and set it up for this project.
> Then build https://www.figma.com/design/<KEY>/<name>?node-id=3978-35299
```

It will install the CLI, add the plugin that teaches it the protocol, run
`gw init`, and start the pipeline. The plugin holds no logic — three commands,
one skill, one hook. It teaches Claude to ask `gw next` and obey, and it
surfaces a run left open in a previous session. Everything it knows, the CLI
enforces anyway.

**It will stop and ask you for the Figma token.** That is deliberate and it is
the one step no agent performs:

```
! gw auth login
```

The `!` prefix runs it in your shell, outside the conversation. A token that
appears in a message is in the transcript, in the context, and in whatever
persistent memory is attached — it has to be treated as compromised from then
on. `gw auth login` reads from hidden stdin and validates against the API
before saving anything, to `~/.config/gridwright/credentials.json` with mode
`0600`. There is no `--token` flag: an argument lands in the shell history and
in `ps`.

### Manual — you drive

```bash
npm i -g @gridwright/cli     # the engine
gw auth login                # once per machine
```

And in Claude Code, the plugin:

```
/plugin marketplace add BalbianoLuciano/gridwright
/plugin install gridwright@gridwright
```

---

## A run, step by step

Four steps. Only the first asks you anything.

![Two terminal windows. `gw init` prints where each kind of thing goes — modules, views, layout parts, primitives, overlays — marking what it found in the repo and what it is proposing, then asks whether to change any of it. `gw build` fetches the node, extracts one SVG asset, distills 140KB into a 4KB IR, resolves all 16 design values against tokens the project already has, and stops at `plan`.](docs/run.svg)

**1. `gw init`, once per repo.** It does not ask what it can find out: the
framework comes from `package.json`, the token file is searched for rather than
assumed, and how a component is written is read off the components already
there.

It does ask about one thing. A project's directory vocabulary is genuinely
ambiguous — `modules`, `blocks`, `sections`, `views`, `pages`, `templates`,
`layouts`, `partials` — every ecosystem picks a few and no two pick the same
few. So gridwright recognises the whole vocabulary, shows you what it matched,
names the runner-up when a kind matched twice, and lets you correct any of it.
The runner-up matters: a repo with both `templates/layouts` and
`templates/partials` keeps its page shell in one and its header and footer in
the other, and nothing in the filesystem says which. `--yes` accepts the
detection; no TTY means no prompt, so CI still works.

**2. `gw build <url>`.** Fetch, distill, resolve, write tokens, scaffold the
library, survey what already exists. Everything a program can decide, decided —
and then it stops at `plan`, because proposing files and props is judgment, not
arithmetic.

**3. The loop.** From here the CLI hands out one stage at a time and the agent
executes it:

```
gw next --json   →   do exactly that stage   →   gw done   →   gw next --json   →   …
```

When you close `author`, hand over both halves:

```bash
gw done --output '{"file": "components/modules/NewsletterBanner/index.tsx",
                   "props": {"fieldValues": {"title": "…", "text": "…"}}}'
```

The **file** is what `verify`, `golden` and `library:register` all operate on.
The **props** are what mounts it, and they cannot be worked out downstream: the
IR names the design's slots, the component names its props by whatever
convention the project follows, and only whoever wrote the file knows the
mapping. Use the design's own copy — it is on each node's `default`. A
paragraph two lines long where the design has three moves every box under it,
and the score then reports a layout problem that is really a copy problem.

**4. `gw report --open`.** The library, and how each piece got there.

| Command | |
|---|---|
| `gw build <url>` | opens a run and executes as far as it goes |
| `gw next [--json] [--run <id>]` | which stage is up and who runs it — **the protocol** |
| `gw done [--output …]` | that stage is finished, here is what it produced |
| `gw skip <stage> --reason` | it did not run, and why — on the record |
| `gw verify` | render, measure, score |
| `gw refine [--focus=…]` | the worst dimension, and what moved |
| `gw golden` | freeze the design and the baselines |
| `gw report [--open]` | the library dashboard |
| `gw status` | runs and the stage each one is on |
| `gw auth status` | which credential is in use and where it came from |

The URL must come from Figma's **"Copy link to selection"**. An address-bar URL
with no `node-id` is rejected, and correctly so.

---

## A whole view

```bash
gw build --view "https://www.figma.com/design/<KEY>/<name>?node-id=<page-frame>"
```

Point it at the page. Its sections are the page's immediate children, and
gridwright lists them itself — a hand-written list of the same page, on a real
file, missed three sections, included a background rectangle and named two nodes
that did not exist. Your part is confirming the list, not writing it.

```
→ 10 sections under "home" — 62 values across the page
    ✓ module   Hero                     run hero-01 · plan
    ✓ module   SolutionsEntry           run solutions-entry-01 · plan
    ✓ layout   NavMain                  run nav-main-01 · plan
    ✓ module   OverlayForm              run overlay-form-01 · plan
    · —        43                       part of the view — not in the library
    …
```

Figma already says which sections are reusable. An **instance** of a library
component becomes a section with its own run, and goes to the library as a
module or a layout part. Anything else was drawn for that page, and is built
inside the view. Two instances of one component set are built once, and a
component already in the library is reused rather than rebuilt — which is what
makes the second page cheap. Sections are named after their component set, not
their layer: `home-signals` is an instance of `overlay-form`, and registering
the layer's name would make the next page that uses it build a second one.

**The view is the only run that writes anything shared.** It fetches the page
once, resolves every section's values together — one tokens gate, and one name
per colour instead of one per section that uses it — and at the end registers
the sections one after another. That is what lets the sections themselves run
side by side, each through every stage from `plan` to `golden`, with `--run` on
every command. The view is composed once they are all frozen; `gw done` refuses
before that.

**A view is not a library component.** Nothing imports a page, so it is
recorded in `.gridwright/views.json` rather than the registry, and the
dashboard lists it under *Views* with its own goldens.

To see where a view stands, `gw report --open`. The view is there from the
moment it is built — before anything is composed — with a table of its sections
and what each one is doing: building, and at which stage; in the library;
reused; or part of the page. Each name opens that section, and each section
says which views use it. The rail groups everything by what it is: views,
modules, layout parts. `gw status` lists the sections under their view too.

```
home-01 Home · view
  3 stages closed · current: tokens
  sections · 0 of 9 finished
    · Hero                     hero-01                      plan
    · NavFooter                nav-footer-01                plan
    …
```

---

## The IR

The raw tree of a frame is 2,000 to 5,000 nodes. Feeding it to the model is not
just expensive: it produces **worse** results, because the model latches onto
the `absoluteBoundingBox` values it sees and writes `position: absolute`. The
distillation always sits between Figma and the model.

![Why the IR exists: a raw Figma tree of thousands of nodes and hundreds of kilobytes is distilled into a semantic IR of about 4KB. Auto-layout maps to flex and variants map to props. A frame without auto-layout halts the pipeline.](docs/distill.svg)

```json
{
  "name": "HeroAboutUs",
  "source": { "file": "D7qf…", "node": "3978:35299", "frameName": "Hero About Us" },
  "layout": { "kind": "flex", "dir": "col", "gap": 24, "align": "center" },
  "tokens": { "bg": "#1a1a1a" },
  "children": [
    { "role": "image", "label": "HeroBackground", "name": "Hero Background",
      "asset": "hero-about-us-background.png", "ratio": "32/9" },
    { "role": "heading", "label": "AboutUs", "name": "About us",
      "level": 1, "slot": "title", "default": "About us" }
  ],
  "warnings": [],
  "hash": "a3f2c1d4e5b6"
}
```

**`label` is the contract.** It is not the layer name — Figma names a text layer
after its own contents, so the honest name for a paragraph is the whole
paragraph. The IR issues something short, PascalCase and unique instead, the
component copies it into `data-gw`, and that is how `verify` knows which
rendered element is which. Copy it exactly; renaming one to something that
reads better measures the wrong box.

**`asset` is the file that was actually written.** Bitmaps come back as PNG and
drawings as SVG — a logo or an illustration is a `VECTOR` in Figma, not an
image fill, and looking only for image fills lost every one of them silently.

Two of the translations are isomorphisms, not heuristics:

**Auto-layout is flex with gap.** `layoutMode` + `itemSpacing` +
`primaryAxisAlignItems` map one to one onto `flex-col gap-6 justify-*`. Valuable
side effect: gridwright **cannot** generate margins between siblings, because
Figma never gives it that information.

**Variants are props.** A component with `Size=Large, State=Hover` hands over
the matrix without anything being invented.

And an uncomfortable corollary: if the Figma does not use auto-layout, there is
no layout to extract. A better prompt will not fix that. `distill` detects it
and halts.

```console
✗ The IR is not usable.

  7 nodes are absolutely positioned (the tolerated maximum is 5).
  This frame does not use auto-layout, so there is no layout to infer.
  A better prompt will not fix this: it gets fixed in Figma.
```

---

## Tokens, before the component

Every value the design brings — a colour, a spacing, a radius, a shadow, a type
triple — is held against what the project already has and lands in one of three
buckets.

| Bucket | Meaning | What happens |
|---|---|---|
| **exact** | the system already has this value | use the token, write nothing |
| **near** | within ΔE 1, or a couple of pixels | use the *system's* value, report the drift |
| **new** | nothing in the system is close | needs a name, and a person to approve it |

Two things make the buckets honest. **Composites are decomposed**, because
`1px solid #9aa3ad` is a width and a colour and `Roboto/400/20px/24px` is a
size, a line height and a weight — comparing those as strings finds nothing and
asks you to create a token for a border whose every part the project already
had. And **the framework's own scale counts as the system**: a project on
Tailwind's defaults has `spacing.4`, so proposing `16px` as a new token is
proposing a duplicate.

Type resolves on all three parts, not the size alone. One project has
`fontSize.h6` at 20/24/700 and `fontSize.paragraph-lg` at 20/24/400; matching
on size took whichever the config declared first, and body copy measured at
weight 400 resolved to the bold one. Nothing downstream catches that — the
geometry is close enough to score well.

The whole stage runs before a line of the component is written. The other way
round, the model writes `bg-[#1a1a1a]` and someone refactors.

---

## The stages

![The pipeline: fifteen stages from init to report, plus auth as a precondition, colour-coded by who runs each one — deterministic code, Claude, or you. A bar on the left marks the three human gates.](docs/pipeline.svg)

**Three human gates: `init`, `tokens` and `library:ensure`.** A gate is for
what is expensive to undo, and all three write something into a repo that
outlives the run: the configuration, the design system, the library's
structure. A badly generated component is rewritten in ten minutes; a
contaminated token system is inherited forever.

Everything else runs to the end. The pipeline builds the component, freezes the
baselines and registers it, and *then* a person judges the result — because it
was going to be built either way, and what is left is the adjustments.

A different three cannot be skipped at all, reason or no reason: `tokens`,
`library:ensure` and `library:register`. Those are the stages that turn a run
into a contribution to the design system rather than just a file — and
therefore the first ones a hurried agent would drop.

---

## Verification, and what it is for

Figma's text engine and Chromium's differ in kerning and antialiasing: a
**perfect** component comes out 3–8% different at the pixel level. A raw diff
threshold at 1% is never reached, and at 10% anything passes. Hence a composite
score:

| Dimension | Weight | How it is measured | Noise |
|---|---|---|---|
| Structural | 50% | bounding boxes, ±2px tolerance | none |
| Chromatic | 25% | computed colour per node, ΔE CIEDE2000 | none |
| Perceptual | 25% | pixel diff with a mask over text | high |

![Two terminal windows. `gw verify` scores four viewports and marks `design` — the width the frame was actually drawn at — as the only one with a reference; its findings name the node by its `data-gw` label. `gw golden` freezes five images into one folder for the component.](docs/verify.svg)

**Nodes are matched by their `data-gw`, not by position.** Matching on tree
position cannot work — a component does not reproduce Figma's tree, and a Figma
button carries six levels of instance wrappers no sane developer writes. So a
design node with no counterpart is *reported*, never paired with a stranger,
and nodes inside something the component draws as one piece are counted as
collapsed rather than missing.

Which means a reused primitive has to forward the attribute. A `<Button>` that
does not declare `data-gw` drops it, and JSX accepts an undeclared `data-*` on
a component **with no type error** — it compiles, it renders, and the label is
simply not in the DOM. `verify` reports that as *not found in the render* on a
node you did label.

That is what makes a finding actionable. `Content2 — width off by +592px` names
an element you can find; the same run before labels said `width off by +1240px`
about a node that was never its counterpart.

**Only one viewport has a design to be faithful to.** A Figma frame is one
width. Rendering at three others and comparing all of them against it produces
measurements with no ground truth behind them, so the width the design was
drawn at is always rendered and always marked. The worst viewport still decides
whether a run passes (Law 6) — if it breaks on mobile it is broken — but the
report says which number means what.

**The score is evidence, not a verdict**, and `gw report` is the page it gets
read on: every module and view the project has, and for each one the design
beside the render — side by side, drag to compare, or the diff — with the props
it takes, the tokens it uses, and how its values resolved. A percentage cannot
tell you whether a component is right. Two pictures and a slider can.

---

## What a run leaves behind

```
.gridwright/
  runs/<id>/            the IR, measurements, resolutions, screenshots — gitignored
  baselines/<Name>/     figma.png, design.png, mobile.png…  — committed, they are tests
  views.json            the views — committed, and kept out of the library
  dashboard/index.html  the library

<placement dir>/<Name>            the component
<placement dir>/__tests__/…      a Playwright spec, if the project has Playwright
<library barrel>                 one export line, unless it is a view
<registry>.json                  path, node, props, the tokens it uses, the score
<tailwind config|css>            any token the design needed and did not have
```

Nothing here is decoration. A view is registered but never exported, because a
view is a leaf — it composes, and nothing composes it. The baselines are
committed because a regression suite whose baselines are gitignored does not
exist for anybody but the person who ran it (Law 7). And the spec is written
only when the project actually has Playwright: a tool that adds a file which
fails your build has done something worse than nothing.

---

## Development

```bash
pnpm install
pnpm test        # 184 tests
pnpm typecheck
pnpm build
```

The `distill` tests run against fixtures shaped like real Figma API responses,
including a frame without auto-layout that **must** make the pipeline halt.

The diagrams in `docs/` are hand-written SVG — no build step, no diagramming
dependency, and they render on npm as well as on GitHub. The terminal windows
show real output, copied from runs against a real project rather than composed
for the page.

---

## Known gaps

Written down rather than left to be discovered.

- **CSS tokens are read, not fully evaluated.** Tailwind v4 and shadcn
  stylesheets resolve — `var()` is followed, `oklch()` becomes hex, the
  installed `theme.css` is the framework's scale, and two-term `calc()` is
  worked out. Anything more elaborate — nested `calc()`, `color-mix()`,
  `light-dark()` — is kept as written and counts as incomparable, so a token
  built that way is never offered as a match.
- **A whole view has been built and handed out, not yet composed end to end.**
  On a real ten-section page, the sections were classified, deduplicated, given
  their own runs and made to wait for the view; no page has yet gone all the
  way to composed, registered and frozen.
- **`survey` is name-first.** It matches what a design and a component are
  called, falls back to a rough shape, and says which signal it used. It will
  miss a component that does the same job under a different name.
- **`refine` has never run for real.** It exists, it is tested, and every
  measurement so far was read straight off `gw verify` instead.
- **The threshold is lenient when there is no reference image.** The perceptual
  dimension drops out, the other two are reweighted, and structural ends up
  carrying two thirds — so a component visibly 8px off can still clear 90. A
  per-dimension floor would fix it; today it is only pinned by a test.
- **`gw init` at the root of a nested project guesses wrong rather than
  failing.** A React app under `src/theme/` is detected as `vue3` with no
  tokens. Run it where the frontend actually lives.
- **The adapter is named `react19` regardless of the installed version.** It
  does not matter until the adapter writes code — React 19 dropped
  `forwardRef` and made `ref` a normal prop.
- **Not published yet.** No npm package, and the plugin has only ever been
  installed from a local checkout.

---

## Non-goals

- It does not generate design. It translates the design that exists.
- It does not fix a badly built Figma. It detects and reports it.
- No data fetching, routing or business logic.
- It does not chase pixel-perfect.
- It does not publish, commit or push anything on its own.

---

## License

[MIT](LICENSE) © Luciano Balbiano
