import assert from "node:assert/strict";
import { test } from "node:test";
import {
	Container,
	Markdown,
	type MarkdownTheme,
	Text,
	type TuiMouseEvent,
	stripTerminalSequences,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { install } from "../patch.ts";

const copied: string[] = [];
// Patch once for this test process, as if the transcript were fullscreen.
install({
	isFullscreen: () => true,
	copy: async (text) => {
		copied.push(text);
	},
	resetMs: 10,
});

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

const render = (source: string, width: number) => new Markdown(source, 0, 0, theme).render(width);

/** The mouse handler `install()` adds to the Markdown prototype. */
type Clickable = Markdown & { handleMouse?(event: TuiMouseEvent): { handled?: boolean } | undefined };
const text = (lines: string[]) => stripTerminalSequences(lines.join("\n"));

const click = (x: number, y: number, height = 1): TuiMouseEvent => ({
	type: "click",
	button: "left",
	x,
	y,
	screenX: x,
	screenY: y,
	width: 80,
	height,
	shift: false,
	alt: false,
	ctrl: false,
});

/** The visible column of the copy label's first glyph in a rendered line. */
const labelColumn = (line: string): number => visibleWidth(line.slice(0, line.indexOf("⧉ copy")));

test("renders a fenced code block as a box with its language and copy label", () => {
	const lines = render("```ts\nconst x = 1;\n```", 40);
	const out = text(lines);
	assert.match(out, /╭─ ts ─+ +⧉ copy +─╮/);
	assert.match(out, /│ const x = 1; +│/);
	assert.match(out, /╰─+╯/);
	assert.ok(!out.includes("\x1b]7798"), "marker leaked");
	for (const line of lines) assert.equal(visibleWidth(line), 40);
});

test("renders a fence without a language without an empty label", () => {
	const out = text(render("```\nplain\n```", 30));
	assert.match(out, /^╭─+ +⧉ copy +─╮$/m);
});

test("leaves ordinary markdown alone", () => {
	const lines = render("hello **world**", 40);
	assert.equal(stripTerminalSequences(lines[0] ?? "").trimEnd(), "hello world");
});

test("falls back to Pi's fences when the box would be too narrow", () => {
	const out = text(render("```ts\nx\n```", 8));
	assert.match(out, /```ts/);
	assert.ok(!out.includes("╭"));
});

test("boxes every code block in a message", () => {
	const out = text(render("```ts\na\n```\n\ntext\n\n```sh\nb\n```", 40));
	assert.equal(out.match(/╭─/g)?.length, 2);
});

test("keeps boxes across Pi's render cache and invalidate()", () => {
	const md = new Markdown("```ts\nx\n```", 0, 0, theme);
	const first = md.render(40);
	assert.deepEqual(md.render(40), first);
	md.invalidate();
	assert.match(text(md.render(40)), /╭─ ts/);
});

test("fits a box inside a blockquote", () => {
	const lines = render("> ```ts\n> x\n> ```", 40);
	for (const line of lines) assert.equal(visibleWidth(line), 40);
	assert.match(text(lines), /│ ╭─ ts ─+ +⧉ copy +─╮/);
});

test("copies the block when its label is clicked", async () => {
	const md = new Markdown("```ts\nconst x = 1;\n```", 0, 0, theme);
	const lines = md.render(40);
	const row = lines.findIndex((line) => line.includes("⧉ copy"));
	assert.ok(row >= 0);
	const x = labelColumn(lines[row] ?? "");

	assert.equal((md as Clickable).handleMouse?.(click(x, row))?.handled, true);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(copied, ["const x = 1;"]);
	assert.match(text(md.render(40)), /✓ copied/);
});

test("ignores clicks elsewhere", () => {
	const md = new Markdown("```ts\nx\n```", 0, 0, theme);
	const lines = md.render(40);
	const row = lines.findIndex((line) => line.includes("⧉ copy"));
	assert.equal((md as Clickable).handleMouse?.(click(0, row)), undefined);
	assert.equal((md as Clickable).handleMouse?.(click(labelColumn(lines[row] ?? ""), row + 1)), undefined);
});

test("translates clicks through a container", async () => {
	const md = new Markdown("```ts\nsecond\n```", 0, 0, theme);
	const container = new Container();
	container.addChild(new Text("first", 0, 0));
	container.addChild(md);
	const lines = container.render(80);
	assert.equal(lines.length, 4); // "first", top border, body, bottom border
	const row = lines.findIndex((line) => line.includes("⧉ copy"));
	assert.equal(row, 1);
	const x = labelColumn(lines[row] ?? "");

	assert.equal(container.handleMouse(click(x, row, lines.length))?.handled, true);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(copied.at(-1), "second");
});

test("shows the copied label only on the block that was clicked", async () => {
	const md = new Markdown("```ts\nfirst\n```\n\n```ts\nsecond\n```", 0, 0, theme);
	const lines = md.render(40);
	const rows = lines.flatMap((line, index) => (line.includes("⧉ copy") ? [index] : []));
	assert.equal(rows.length, 2);

	const second = rows[1] ?? 0;
	assert.equal((md as Clickable).handleMouse?.(click(labelColumn(lines[second] ?? ""), second))?.handled, true);
	await new Promise((resolve) => setTimeout(resolve, 0));

	const after = text(md.render(40));
	assert.match(after, /✓ copied/);
	assert.equal(after.match(/⧉ copy/g)?.length, 1, "the untouched block kept its own label");
	assert.equal(copied.at(-1), "second");
});
