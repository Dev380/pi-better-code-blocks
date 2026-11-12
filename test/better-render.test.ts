import assert from "node:assert/strict";
import { test } from "node:test";
import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { type Component, type MarkdownTheme, type TuiMouseEvent, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { attach } from "../better-render.ts";

const copied: string[] = [];
const id = (text: string) => text;
const theme: MarkdownTheme = {
	heading: id,
	link: id,
	linkUrl: id,
	code: id,
	codeBlock: id,
	codeBlockBorder: id,
	quote: id,
	quoteBorder: id,
	hr: id,
	listBullet: id,
	bold: id,
	italic: id,
	strikethrough: id,
	underline: id,
};

type Transform = (markdown: string, width: number) => string;

/**
 * Stands in for pi-better-render's `RichMarkdown`: one row per line of the transformed Markdown,
 * indented by `paddingX`, with blank lines dropped and one row between blocks (as its own
 * `renderMarkdown` does). Every row that says `theirs` carries a copy button of its own.
 */
class StandIn implements Component {
	rows: string[] = [];
	private readonly text: string;
	private readonly paddingX: number;
	private readonly transform: Transform | undefined;

	constructor(text: string, paddingX: number, transform: Transform | undefined) {
		this.text = text;
		this.paddingX = paddingX;
		this.transform = transform;
	}

	render(width: number): string[] {
		const content = Math.max(1, width - this.paddingX * 2);
		const markdown = this.transform?.(this.text, content) ?? this.text;
		const prefix = " ".repeat(this.paddingX);
		const blocks = markdown
			.split(/\n{2,}/)
			.map((block) => block.trim())
			.filter(Boolean);
		this.rows = [];
		for (const block of blocks) {
			if (this.rows.length > 0) this.rows.push("");
			for (const line of block.split("\n")) this.rows.push(prefix + line.slice(0, content));
		}
		return this.rows;
	}

	invalidate(): void {}

	handleMouse(event: TuiMouseEvent): { handled?: boolean } | undefined {
		return this.rows[event.y]?.includes("theirs") && event.x < 6 ? { handled: true } : undefined;
	}
}

/** What pi-better-render keeps on the prototype, and what `attach()` wraps. */
const PATCH = Symbol.for("pi-better-render.assistant-patch");
const prototype = AssistantMessageComponent.prototype as unknown as Record<symbol, { factory?: unknown }>;
const inner: { current?: StandIn } = {};
prototype[PATCH] = {
	factory: (text: string, paddingX: number, _streaming: boolean, transform: Transform | undefined) => {
		inner.current = new StandIn(text, paddingX, transform);
		return inner.current;
	},
};

attach({ theme: () => theme, copy: async (text) => void copied.push(text) });

/** Builds a message the way pi-better-render does, and renders it at `width`. */
const render = (markdown: string, width = 60): { lines: string[]; component: Component } => {
	const factory = prototype[PATCH]?.factory as (text: string, paddingX: number, streaming: boolean, transform: Transform | undefined) => Component;
	const component = factory(markdown, 1, false, undefined);
	return { lines: component.render(width), component };
};

const text = (lines: string[]) => stripTerminalSequences(lines.join("\n"));
const click = (x: number, y: number): TuiMouseEvent => ({
	type: "click",
	button: "left",
	x,
	y,
	screenX: x,
	screenY: y,
	width: 60,
	height: 1,
	shift: false,
	alt: false,
	ctrl: false,
});
const labelColumn = (line: string): number => visibleWidth(line.slice(0, line.indexOf("⧉ copy")));

test("draws a box where the rich renderer had a code block", () => {
	const { lines } = render("intro\n\n```ts\nconst x = 1;\n```\n\noutro");
	const out = text(lines);
	assert.match(out, /^ intro$/m);
	assert.match(out, /╭─ ts ─+ +⧉ copy +─╮/);
	assert.match(out, /│ const x = 1; +│/);
	assert.match(out, /^ outro$/m);
	assert.ok(!out.includes("```"), "the fence was left to the rich renderer");
	assert.ok(!out.includes("pbcb"), "the sentinel leaked");
	for (const line of lines) assert.ok(visibleWidth(line) <= 60);
});

test("keeps the rich renderer's own rows and spacing around a box", () => {
	const { lines } = render("a\n\n```sh\nx\n```\n\nb");
	const shape = lines.map((line) => (/^[╭│╰]/.test(line.trim()) ? "<box>" : line.trim()));
	assert.deepEqual(shape, ["a", "", "<box>", "<box>", "<box>", "", "b"]);
	// The box is drawn at the rich renderer's content width, so the indent is its only extra cell.
	for (const row of lines.slice(2, 5)) assert.equal(visibleWidth(row), 60 - 2 + 1);
});

test("leaves a mermaid block to the rich renderer", () => {
	const { lines } = render("```mermaid\ngraph TD; A-->B\n```");
	assert.ok(!text(lines).includes("╭"), "a diagram has no box to draw");
	assert.match(text(lines), /graph TD/);
});

test("leaves an unterminated fence to the rich renderer while it streams", () => {
	const { lines } = render("```ts\nconst x = 1;");
	assert.ok(!text(lines).includes("╭"));
	assert.match(text(lines), /const x = 1;/);
});

test("leaves a block too narrow to box to the rich renderer", () => {
	const { lines } = render("```ts\nx\n```", 10);
	assert.ok(!text(lines).includes("╭"));
	assert.match(text(lines), /x/);
});

test("leaves a fence indented in a list item to the rich renderer", () => {
	// A sentinel would leave the item, so an indented fence keeps its own rendering.
	const { lines } = render("- item\n\n  ```ts\n  x\n  ```");
	assert.ok(!text(lines).includes("╭"));
});

test("copies the block under its label, and only there", async () => {
	const { lines, component } = render("```ts\nconst x = 1;\n```\n\n```sh\necho hi\n```");
	const rows = lines.flatMap((line, index) => (line.includes("⧉ copy") ? [index] : []));
	assert.equal(rows.length, 2);

	const first = rows[0] ?? 0;
	assert.equal(component.handleMouse?.(click(labelColumn(lines[first] ?? ""), first))?.handled, true);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(copied, ["const x = 1;"]);
	const after = text(component.render(60));
	assert.match(after, /✓ copied/);
	assert.equal(after.match(/⧉ copy/g)?.length, 1, "the untouched block kept its own label");
});

test("hands clicks outside a box back with the rich renderer's own rows", () => {
	const { lines, component } = render("```ts\nx\n```\n\ntheirs");
	// The box took rows 0-2 and the blank after it is the rich renderer's own spacing, so its
	// second row is the screen's fifth.
	const theirs = lines.findIndex((line) => line.includes("theirs"));
	assert.equal(theirs, 4);
	assert.equal(component.handleMouse?.(click(0, theirs))?.handled, true);
	assert.equal(component.handleMouse?.(click(0, 1)), undefined, "a click inside a box is not theirs");
});
