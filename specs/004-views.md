# 004 — Views: the parent builds, the sections run in parallel

A view is a composition. Building one used to mean building its sections by
hand first, one run each, and then running the view — the order was right and
nothing enforced it. This spec makes the view the thing you point gridwright at,
and the view takes care of its sections.

**Guiding decision**: the parent is the only run that writes anything shared.
Sections run in parallel and each goes through every stage, but the stages that
touch the design system — tokens, the library's structure, the registry — happen
once, in the parent, in order. That is what lets them run side by side without
stepping on each other.

---

## What was verified before writing this

Against a real file (Forebound, `home`, node `6360:57053`, 1440×11447):

- **A view's sections are its immediate children.** Ten full-width children,
  stacked in a vertical auto-layout. Detecting them automatically got all ten.
- **Listing them by hand did not.** A hand-made list of the same view missed
  three sections, included a background rectangle from inside another frame,
  and included two node ids that do not exist in the file. The person's job is
  to confirm the list, not to write it.
- **Figma already says which sections are reusable.** Nine children are
  `INSTANCE`s of a main component; one is a plain `FRAME` — a background and a
  subtitle placed by hand, for that page only.
- **The instance name is not the component's name.** `home-signals` is an
  instance of `overlay-form`, `home-papers` of `media-panel`, `nav-main` of a
  component called `Frame 87`.
- **Two runs in one repo collide today.** `activeRun` returns the newest open
  run, so any command without `--run` takes the wrong one; and the verify
  harness lives in a fixed `.gridwright/harness/` that it deletes on start and
  on close.

## Decisions

### 1. You point at the parent; gridwright lists the sections; you confirm

`gw build --view <url>` fetches the parent once and classifies each immediate
child. The list is printed and `plan` — the model's stage — asks the person to
confirm it before anything is built. A hand-written list is the override for
when detection is wrong, not the input.

### 2. Reusable or the view's own

| Immediate child | Becomes | In the library |
|---|---|---|
| `INSTANCE` of a main component | a section, with its own run | yes — as a module or a layout part |
| anything else (`FRAME`, `GROUP`…) | part of the view | no |

The kind of a reusable section comes from its name, the same way it does for a
single component: `nav-main` and `nav-footer` are layout parts, the rest are
modules.

### 3. Identity is the component set

Two instances of the same main component are one section to build. A section
whose component set is already registered is reused, not rebuilt — which is
what makes the second view cheap. The name comes from the component set, unless
the set is named like scaffolding (`Frame 87`, `Property 1=Default`), in which
case the instance's name wins.

### 4. The parent writes everything shared

In order:

1. **fetch** — the parent node once, every section's reference image in one
   batch, every section's assets.
2. **distill** — each section gets its own IR and measurements. The view's own
   IR has the sections as empty boxes: the model composing the page must not
   read the three thousand nodes inside them (Law 2), and `verify` measures
   each section as a box.
3. **resolve + tokens** — the union of every value in every section. One gate,
   not one per section, and one name per colour rather than one per section
   that happens to use it (Law 4).
4. **library:ensure, survey** — once.
5. **the sections** — in parallel. Each one takes its own run from `plan` to
   `golden`, every stage, `--run` on every command.
6. **author** — the view: it composes the sections and builds its own parts.
   It cannot start while a section is unfinished.
7. **verify, golden** — the whole page.
8. **library:register** — each section, one after another; then the view is
   recorded as a view.

### 5. Same tree, not worktrees

Work done in a worktree only comes back through a commit and a merge, and
gridwright never commits. With decision 4, a section only ever writes its own
files — its component, its run directory, its baseline folder — so the tree does
not need splitting. The two collisions that remain are fixed in code: every
command a section runs takes `--run`, and the harness lives inside its run.

### 6. The view is not in the library

A view is registered nowhere a component would be: it is recorded in
`.gridwright/views.json`, committed, and the dashboard lists it under *Views*
with its goldens. The library — registry and barrel — holds only what can be
reused.

## Non-goals

- Several breakpoints of one view drawn as separate frames. One frame, one view.
- Detecting a view without `--view`. A catalogue board and a documentation page
  both look like views to a heuristic; the flag is the person saying it is one.
- Parallelism inside the CLI. The CLI decides what can run in parallel and hands
  it out; the agent is what runs it.
