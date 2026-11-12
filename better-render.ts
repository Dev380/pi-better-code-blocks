/**
 * pi-better-render draws assistant replies with its own `RichMarkdown` instead of Pi's `Markdown`,
 * so `patch.ts` never sees those code blocks and the boxes disappear from them. `RichMarkdown`
 * does not extend `Markdown`; it is built by a factory that pi-better-render keeps on
 * `AssistantMessageComponent.prototype`, so this wraps that factory:
 *
 * - the text is passed through a transform that swaps each complete fence for a one-line sentinel,
 *   so the rich renderer lays out everything around it and the box takes the sentinel's row;
 * - every other block (math, tables, a mermaid diagram) stays theirs, and so do its copy buttons:
 *   clicks outside a box are handed back with the row numbers it expects.
 *
 * Mermaid is deliberately left alone — a fence they draw as a diagram has no box to draw — as is a
 * fence that is still streaming or too narrow to box. With pi-better-render absent, `attach()` is a
 * no-op and `patch.ts` draws every box.
 */
import { AssistantMessageComponent, copyToClipboard, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type MarkdownTheme,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { type Hit, copyLabel, LABEL_WIDTH, languageName, MIN_BOX_WIDTH, renderCodeBox } from "./box.ts";
import { COPIED_MS, fullscreen, notifyCopyError, refresh, requestRender } from "./patch.ts";

type Theme = Pick<MarkdownTheme, "codeBlock" | "codeBlockBorder" | "highlightCode">;
type Transform = (markdown: string, width: number) => string;
type Factory = (text: string, paddingX: number, streaming: boolean, transform: Transform | undefined) => Component;

/** Where pi-better-render keeps the factory and the original `updateContent`. */
const PATCH = Symbol.for("pi-better-render.assistant-patch");

interface RendererPatch {
	factory?: Factory;
}

export interface AttachOptions {
	/** Overrides the theme the boxes draw with; tests use this. */
	theme?: () => Theme;
	/** Overrides the clipboard write; tests use this. */
	copy?: (text: string) => Promise<void>;
}

let theme: () => Theme = getMarkdownTheme;
let copy: (text: string) => Promise<void> = copyToClipboard;

/**
 * Wraps pi-better-render's factory so the components it builds draw boxes. True only when it just
 * did so: the caller then redraws the tree, whose components were built without the wrapper.
 */
export function attach(options: AttachOptions = {}): boolean {
	theme = options.theme ?? getMarkdownTheme;
	copy = options.copy ?? copyToClipboard;

	const patch = patchOf();
	if (!patch || typeof patch.factory !== "function") return false;
	if (intercepted.has(patch)) return false;

	let build = patch.factory;
	Object.defineProperty(patch, "factory", {
		configurable: true,
		enumerable: true,
		get: () => boxed(build),
		// It re-applies its patch after a reload; the next `factory` read wraps that one too.
		set: (next: Factory) => {
			build = next;
		},
	});
	intercepted.add(patch);
	return true;
}

/** The record pi-better-render installs, if it is installed at all. */
function patchOf(): RendererPatch | undefined {
	const value = (AssistantMessageComponent.prototype as unknown as Record<symbol, unknown>)[PATCH];
	return typeof value === "object" && value !== null ? (value as RendererPatch) : undefined;
}

const intercepted = new WeakSet<object>();

/** The wrapper for a factory, remembered so a per-delta rebuild does not allocate a new one. */
let lastBuild: Factory | undefined;
let lastBoxed: Factory | undefined;
function boxed(build: Factory): Factory {
	if (lastBuild === build && lastBoxed) return lastBoxed;
	lastBuild = build;
	lastBoxed = (text, paddingX, streaming, transform) => {
		const boxes = new Boxes();
		const composed: Transform = (markdown, width) => boxify(transform ? transform(markdown, width) : markdown, width, boxes);
		return new BoxedMarkdown(build(text, paddingX, streaming, composed), boxes, paddingX);
	};
	return lastBoxed;
}

/**
 * The boxes of one render, by the sentinel their row carries. A sentinel is unique to its instance,
 * so a block that happens to spell one out cannot be mistaken for it.
 */
class Boxes {
	private readonly prefix = `pbcb${Math.random().toString(36).slice(2, 6)}`;
	private bySentinel = new Map<string, Block>();
	private byId = new Map<number, Block>();
	private next = 0;

	reset(): void {
		this.bySentinel.clear();
		this.byId.clear();
		this.next = 0;
	}

	add(code: string, lang: string | undefined): string {
		const block = { id: this.next++, code, lang };
		this.bySentinel.set(`${this.prefix}${block.id}`, block);
		this.byId.set(block.id, block);
		return `${this.prefix}${block.id}`;
	}

	/** The block whose sentinel this rendered row holds. */
	find(row: string): Block | undefined {
		if (!row.includes(this.prefix)) return undefined;
		for (const [sentinel, block] of this.bySentinel) if (row.includes(sentinel)) return block;
		return undefined;
	}

	get(id: number): Block | undefined {
		return this.byId.get(id);
	}
}

type Block = { id: number; code: string; lang?: string };

const FENCE = /^(`{3,}|~{3,})[ \t]*(.*)$/;
const CLOSE = /^(`{3,}|~{3,})[ \t]*$/;

/**
 * Swaps every fenced code block for a sentinel line. Blank lines keep the sentinel a block of its
 * own: a fence interrupts a paragraph, a plain line would join one. Only a fence at the left margin
 * is taken — an indented one belongs to a list item, where a sentinel would split the item.
 */
function boxify(markdown: string, width: number, boxes: Boxes): string {
	boxes.reset();
	if (width < MIN_BOX_WIDTH) return markdown; // narrower than a box: the rich renderer's own is better

	const lines = markdown.split("\n");
	const out: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		const open = FENCE.exec(line);
		const close = open ? closing(lines, i + 1, open[1] ?? "") : -1;
		if (!open || close < 0) {
			out.push(line); // not a fence, or one still streaming: theirs to draw
			continue;
		}
		const lang = languageName(open[2]);
		if (lang.toLowerCase() === "mermaid") {
			out.push(...lines.slice(i, close + 1));
		} else {
			out.push("", boxes.add(lines.slice(i + 1, close).join("\n"), lang || undefined), "");
		}
		i = close;
	}
	return out.join("\n");
}

/** The index of the fence that closes one opened at `from`, or -1 while it is still open. */
function closing(lines: readonly string[], from: number, fence: string): number {
	for (let i = from; i < lines.length; i++) {
		const match = CLOSE.exec(lines[i] ?? "");
		const marker = match?.[1];
		if (marker && marker[0] === fence[0] && marker.length >= fence.length) return i;
	}
	return -1;
}

/**
 * A rich-rendered message with this extension's boxes on its code blocks. Its own rows are passed
 * through untouched, and so are its clicks: only the label rows are answered here.
 */
class BoxedMarkdown implements Component {
	private readonly inner: Component;
	private readonly boxes: Boxes;
	private readonly paddingX: number;
	private copied?: number;
	private cache?: {
		inner: readonly string[];
		copied: number | undefined;
		lines: string[];
		/** Outer row → the inner row it came from; a box's rows are absent. */
		source: number[];
		hits: Hit[];
	};

	constructor(inner: Component, boxes: Boxes, paddingX: number) {
		this.inner = inner;
		this.boxes = boxes;
		this.paddingX = paddingX;
	}

	render(width: number): string[] {
		const inner = this.inner.render(width);
		const cached = this.cache;
		if (cached && cached.inner === inner && cached.copied === this.copied) return cached.lines;

		const contentWidth = Math.max(1, width - this.paddingX * 2);
		const prefix = " ".repeat(this.paddingX);
		const boxTheme = theme();
		const lines: string[] = [];
		const source: number[] = [];
		const hits: Hit[] = [];
		inner.forEach((row, y) => {
			const block = this.boxes.find(row);
			const box = block
				? renderCodeBox({
						code: block.code,
						lang: block.lang,
						width: contentWidth,
						theme: boxTheme,
						label: fullscreen() ? copyLabel(this.copied === block.id) : undefined,
						labelWidth: LABEL_WIDTH,
					})
				: undefined;
			if (!block || !box) {
				source[lines.length] = y;
				lines.push(row);
				return;
			}
			const top = lines.length;
			for (const line of box.lines) lines.push(prefix + line);
			if (box.label) {
				const start = this.paddingX + box.label.col;
				hits.push({ row: top, start, end: start + box.label.width, block: block.id });
			}
		});

		this.cache = { inner, copied: this.copied, lines, source, hits };
		return lines;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const cache = this.cache;
		if (!cache) return undefined;
		if (event.type === "click" && event.button === "left") {
			const hit = cache.hits.find((h) => h.row === event.y && event.x >= h.start && event.x < h.end);
			if (hit) {
				this.copy(hit.block);
				return { handled: true, render: true };
			}
		}
		const row = cache.source[event.y];
		if (row === undefined) return undefined;
		const inner = this.inner as Component & { handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined };
		return inner.handleMouse?.({ ...event, y: row });
	}

	invalidate(): void {
		this.cache = undefined;
		this.inner.invalidate?.();
	}

	private copy(block: number): void {
		const code = this.boxes.get(block)?.code;
		if (code === undefined) return;
		void copy(code).then(() => {
			this.copied = block;
			requestRender();
			setTimeout(() => {
				if (this.copied !== block) return;
				this.copied = undefined;
				requestRender();
			}, COPIED_MS);
		}, notifyCopyError);
	}
}

/** Redraws the transcript after `attach()`, so messages built before it pick up the boxes. */
export function attachAndRefresh(options?: AttachOptions): void {
	if (attach(options)) refresh();
}
