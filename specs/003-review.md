# Review — why a simple flow is not automating

> 2026-09-08 · after the first complete run
> Written to answer one question: is the flow hard, or did we make it hard?

The answer is the second one, and it is narrower than it looks. **The pipeline
works. The ruler does not.** Everything that has gone wrong lives in one place,
and that place is a bet we made early and never tested.

---

## What the numbers say

7,412 lines of source. 179 tests. 26 commits, of which **11 are fixes**.

Sort those 11 by what they were fixing:

| what broke | how many |
|---|---|
| **measuring** — tokens, distill, verify | **7** |
| plumbing — gitignore, auth message, build chaining | 4 |
| the flow itself — fetch, plan, author, survey, library | **0** |

Zero. In one complete run against a real project, the part everyone assumed was
hard — pull a design, distill it, decide what to reuse, write a component —
did not produce a single bug. `survey` found a component nobody had told it
about. `resolve` matched 9 of 9 values. `author` wrote a file that typechecks
and renders.

Every failure was in deciding whether the result was any good.

---

## The one number that explains it

The design node has 19 measurable nodes. Here they are:

```
Wrapper wide · Call to actions | Newsletter · Call to action
Vector · Content · Content · Text · Suscribe to Out Newsletter
Text blocks · Lorem ipsum dolor sit… · Button · Text padding · Text
sl-icon-santillana · sl-icon · SL-icon/md · Base/Icon · icon-container · icon
```

**Nine of them are Figma's own plumbing.** Six are one icon, nested six deep,
every level sharing the same 16×16 box. `Text padding` is a spacing wrapper.
The two `Content` nodes are instance boilerplate.

No competent developer writes those. The component that was produced has eight
elements and is *correct* — and the structural dimension, which carries half the
score, reported `only 8 of 19 matched`.

The IR preserves **Figma's structure**, and the pipeline grades against it as
though it were **the component's structure**. Those are different objects. Law 2
says the raw tree never reaches the model, and it was right — but the same tree
still reaches the ruler.

---

## The bet we made and never tested

Law 6 assumes structural fidelity can be measured automatically, and gives it
50% of the weight.

That assumption is doing all the damage:

- it needs a correspondence between design nodes and DOM elements that **does
  not exist naturally**, because a design tool's tree and a component's tree
  have no reason to agree
- every fix to it has produced another one. Identity matching, `path#occurrence`
  keying, pruning, `collapsePassThrough`, coverage gating — five attempts, and
  coverage is still 8/19
- `packages/verify` is 698 lines of source with **zero tests**, because what it
  does cannot be tested without a browser and a real project

Phase 2 was meant to catch exactly this. It was defined as *"calibrated on a
hand-written component"*, and it was calibrated on a synthetic three-node box
that could not fail. The properties that break it — nested instances, inline
SVG, responsive layout — were all absent.

Spec 002 diagnosed the ordering. It did not question the assumption underneath.

---

## What is actually needed

A developer checking this component looks at two images side by side and knows
in three seconds. That is not a lesser method: it is the method, and it does not
need a correspondence between two trees to exist.

The pipeline already has both images. It renders the component and it downloads
Figma's export. It just refuses to show them and insists on a number instead.

And the project already decided this everywhere else. Law 5: *the system
generates, the person decides.* Three gates exist because writing tokens,
creating structure and freezing a baseline are judgments. **Deciding whether a
component matches its design is the same kind of judgment**, and it is the one
we tried to automate.

---

## Three ways forward

### A — The ruler stops deciding, and starts reporting

`verify` renders, screenshots, and puts the two images in front of a person.
The measurements stay, as *evidence* rather than as a verdict: "the heading is
8px low, this colour is ΔE 24 off" is useful next to a picture and useless as a
percentage.

- deletes the threshold, the weights, the worst-viewport rule and the refine cap
- `refine` becomes what the person asks for, not what a number demands
- **loses**: no CI gate on fidelity. Regression baselines (Law 7) still work,
  and those were always the ones that belonged in CI

### B — Grade only what the component declares

The component labels the nodes it considers real, with `data-gw`. Nothing else
is graded. Coverage stops being a problem because the contract is explicit
instead of inferred.

- keeps the score, and makes it honest
- **costs**: the model has to label as it writes, and a wrong label is a wrong
  score with no way to tell
- the labelling rule is already in the skill, unused

### C — Keep chasing the correspondence

More heuristics: match by role and geometry together, weight by depth, learn
which Figma wrappers to ignore.

- this is the current path
- five attempts so far, coverage still 8/19
- it is an open research problem being solved on the side of a build tool

---

## Recommendation

**A**, and take the three days back.

The evidence is that the flow works and the ruler does not, after five attempts
at the ruler and none at the flow. Option A ships something usable this week: a
design goes in, tokens resolve, a component comes out, and a person approves it
against a picture — which is what happens today anyway, except today the person
also has to ignore a number that is wrong.

If the score matters later, **B** is the way back to it, and it will be easier
once components are being produced regularly and labelling has a reason to exist.

The one thing to stop doing is **C**.

---

## What survives either way

Worth saying, because the conclusion sounds harsher than the situation is. None
of this is wasted:

- `distill` and the IR — 1007KB to 3KB, and the model writes flex with gap
- `resolve` and the token gate — 9 of 9 values matched against the project's own
  system, after four fixes that each removed a class of false proposals
- `survey` — found a component by the node id in its own comment, which nothing
  else in the project could have done
- `conventions` — the difference between a file that renders and a file that
  works in the product
- the state machine — the order held under every one of these failures

That is the pipeline. It is the scoring that is the experiment, and experiments
are allowed to fail.
