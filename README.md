# pi-better-code-blocks

![what pi-better-code-blocks looks like](https://raw.githubusercontent.com/Dev380/pi-better-code-blocks/main/screenshot.png)

Code blocks in [Pi](https://github.com/earendil-works/pi)'s transcript are drawn as rounded,
org-modern-style boxes, with the declared language on the top border and a `⧉ copy` label that
copies the code when clicked.

```text
 ╭─ typescript ──────────────────────────────────────  ⧉ copy  ─╮
 │ export function greet(name: string): string {              │
 │   return `hello, ${name}`;                                 │
 │ }                                                          │
 ╰────────────────────────────────────────────────────────────╯
```

```
pi install npm:pi-better-code-blocks
```

- The language is whatever follows the opening fence (` ```ts `, ` ```python `, …). Fences without
  a language still get a box, just no language label.
- Clicking the label copies the code without the fences or indentation. It shows `✓ copied` for
  1.5s. Long lines wrap inside the box; the copied text is always the original source.
- Boxes are drawn everywhere Markdown is rendered in the TUI: assistant replies, thinking blocks,
  user messages and tool output. Narrow contexts (a code block in a deeply nested list, a very
  small terminal) fall back to Pi's normal fences.
- Only the fullscreen TUI delivers mouse clicks to components, so the label is hidden in the
  regular TUI mode. The boxes still render.
- Plain clicks elsewhere, drag-selection and copy-on-select work as before.

## How it works (hacky)

Pi has no public hook for how a Markdown code block is drawn
([earendil-works/pi#11276](https://github.com/earendil-works/pi/issues/11276)), so `patch.ts`
wraps the `Markdown` component's private `renderToken` and `render`, and adds `handleMouse`:

- `renderToken` replaces each `code` token with the box from `box.ts`.
- `render` strips a zero-width OSC marker from the label and records the label's row and column,
  so clicks map back to the right block after Pi has wrapped and padded the lines. Each block's
  marker carries an id that outlives the render, because Pi 1.5 reuses a block it has already
  drawn instead of asking `renderToken` again.
- `handleMouse` copies the block and re-renders the label for 1.5s.
- If another extension wraps a Markdown instance's `renderToken` after this one, `adopt()` takes
  the outer slot back, so its wrapper cannot rewrite the boxes. It still gets every other kind of
  token, and any block too narrow to box. [`pi-tidy`](https://github.com/Andy8647/pi-tidy) is the
  extension this exists for: its own code-block rules are what a wrapper would draw instead.

Built against Pi 1.5.0. If a Pi update renames these internals, the boxes disappear and Pi keeps
working.

## pi-better-render

[`pi-better-render`](https://github.com/JeffeyChou/pi-better-render) draws assistant replies with
its own `RichMarkdown` component instead of Pi's `Markdown`, so `patch.ts` never sees those blocks.
`better-render.ts` hooks the factory that builds them and draws the boxes there instead:

- each complete fence is swapped for a one-line sentinel before the rich renderer lexes the text,
  and the box is drawn on the sentinel's row, so its layout (and its cache) still works;
- everything else — math, tables, mermaid diagrams, its own copy buttons — is rendered by it,
  untouched. Clicks outside a box are handed back with the row numbers it expects;
- a fence they draw as a diagram (`mermaid`), one that is still streaming, one indented inside a
  list item and one too narrow to box all stay theirs.

`/better-render off` returns assistant replies to Pi's own renderer, and the boxes come back
through `patch.ts`. Thinking blocks, user messages and tool output always go through `patch.ts`.

If [`pi-copy-button`](https://github.com/jonaslsaa/pi-copy-button) is installed too, it decorates
the same Markdown instances and takes over their mouse handling, so its labels win and the
`⧉ copy` label here stops responding. The extension warns about this at startup; remove
`pi-copy-button` to use this one.

## Development

```bash
npm install
npm run check
npm test
```

`box.ts` is pure and testable; `patch.ts` owns the Pi integration, and `better-render.ts` the
pi-better-render one.
