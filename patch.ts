/**
 * Pi has no hook for how a Markdown code block is drawn, so this patches Pi's Markdown component:
 *
 * - `renderToken` turns each `code` token into a rounded box (see `box.ts`).
 * - `render` strips the zero-width label markers from the final lines and remembers their rows.
 * - `handleMouse` copies a block when its label is clicked.
 *
 * Another extension can wrap a Markdown instance's `renderToken` after this one (pi-tidy does);
 * `adopt()` keeps the boxes on top of such a wrapper. If a Pi update renames these internals,
 * `install()` is a no-op and Pi keeps working.
 */
import { AssistantMessageComponent, copyToClipboard, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	Markdown,
	type MarkdownTheme,
	TuiAltScreen,
	type TUI,
	type Token,
	type Tokens,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { type Hit, marker, renderCodeBox, stripMarkers } from "./box.ts";

const LABEL = "⧉ copy";
const DONE = "✓ copied";
const LABEL_WIDTH = Math.max(visibleWidth(LABEL), visibleWidth(DONE));
const COPIED_MS = 1500;
const dim = (text: string) => `\x1b[2m${text}\x1b[22m`;

type Block = { code: string; lang?: string };
type Copied = { block: number };

type MarkdownInternals = {
	theme: MarkdownTheme;
	renderToken(token: Token, width: number, nextTokenType?: string, styleContext?: unknown): string[];
	render(width: number): string[];
	invalidate(): void;
	handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
};

type State = {
	/** Boxes by the id their marker carries; ids outlive the render that made them. */
	blocks: Map<number, Block>;
	full?: boolean;
	copied?: Copied;
	out?: { raw: string[]; copied: Copied | undefined; lines: string[]; hits: Hit[] };
};

const STATE = Symbol.for("pi-better-code-blocks.state");
const PATCHED = Symbol.for("pi-better-code-blocks.patched");

/** Set by pi-copy-button, which patches the same internals and owns the Markdown instances it decorates. */
const COPY_BUTTON = Symbol.for("pi-copy-button.updateContent");

export const copyButtonInstalled = (): boolean => COPY_BUTTON in AssistantMessageComponent.prototype;

let tui: TUI | undefined;
let ctx: ExtensionContext | undefined;

const fullscreen = (): boolean => tui === undefined || tui instanceof TuiAltScreen;

export function useTui(next: TUI | undefined): void {
	tui = next;
}

export function useContext(next: ExtensionContext | undefined): void {
	ctx = next;
}

export interface InstallOptions {
	/** Overrides the TUI check; tests use this to render as if in fullscreen. */
	isFullscreen?: () => boolean;
	/** Overrides the clipboard write; tests use this. */
	copy?: (text: string) => Promise<void>;
	/** How long the `✓ copied` label stays; tests shorten it. */
	resetMs?: number;
}

export function install(options: InstallOptions = {}): void {
	const proto = Markdown.prototype as unknown as MarkdownInternals & { [PATCHED]?: true };
	if (proto[PATCHED]) return;
	if (typeof proto.renderToken !== "function" || typeof proto.render !== "function") return;
	proto[PATCHED] = true;

	const isFullscreen = options.isFullscreen ?? fullscreen;
	const copy = options.copy ?? copyToClipboard;
	const resetMs = options.resetMs ?? COPIED_MS;
	const baseRenderToken = proto.renderToken;
	const baseRender = proto.render;

	/**
	 * A code token's id, stable across re-renders. Pi 1.5 reuses a block it has already drawn,
	 * marker and all, so the id has to outlive the render that made it.
	 */
	const ids = new WeakMap<object, number>();
	let nextId = 0;
	const idOf = (token: Token): number => {
		let id = ids.get(token);
		if (id === undefined) ids.set(token, (id = nextId++));
		return id;
	};

	/** The box for a `code` token, or undefined when Pi's own fences are kept. */
	const drawCode = (md: MarkdownInternals, token: Token, width: number, nextTokenType?: string): string[] | undefined => {
		if (token.type !== "code") return undefined;

		const code = token as Tokens.Code;
		const state = stateOf(md);
		const full = isFullscreen();
		const id = idOf(token);
		state.blocks.set(id, { code: code.text, lang: code.lang });
		const box = renderCodeBox({
			code: code.text,
			lang: code.lang,
			width,
			theme: md.theme,
			label: full ? labelFor(state.copied?.block === id) : undefined,
			labelWidth: LABEL_WIDTH,
			marker: full ? marker(id) : undefined,
		});
		if (!box) {
			state.blocks.delete(id);
			return undefined;
		}
		if (nextTokenType && nextTokenType !== "space") box.lines.push("");
		return box.lines;
	};

	/**
	 * Extensions such as pi-tidy wrap a Markdown instance's `renderToken` after this one, so their
	 * wrapper would meet a box where it expects Pi's fences and rewrite it. Take the outer slot back:
	 * the box comes from the token itself, so a displaced wrapper is still asked about every other
	 * token, and about a block too narrow to box. pi-copy-button is the exception: it decorates the
	 * same instances, and taking its slot would leave both sets of labels dead.
	 */
	const adopted = new WeakMap<MarkdownInternals, MarkdownInternals["renderToken"]>();
	const adopt = (md: MarkdownInternals): void => {
		if (copyButtonInstalled()) return;
		const own = Object.getOwnPropertyDescriptor(md, "renderToken");
		if (!own) {
			adopted.delete(md); // our wrapper is gone again: the prototype draws on its own
			return;
		}
		if (own.value === adopted.get(md)) return;
		const below = own.value as MarkdownInternals["renderToken"];
		const outer: MarkdownInternals["renderToken"] = function (this: MarkdownInternals, token, width, nextTokenType, styleContext) {
			return drawCode(this, token, width, nextTokenType) ?? below.call(this, token, width, nextTokenType, styleContext);
		};
		adopted.set(md, outer);
		Object.defineProperty(md, "renderToken", { ...own, value: outer, writable: true, configurable: true });
	};

	proto.renderToken = function (this: MarkdownInternals, token, width, nextTokenType, styleContext) {
		// Reached through a wrapper we displaced: hand Pi its own lines instead of boxing them twice.
		if (adopted.has(this)) return baseRenderToken.call(this, token, width, nextTokenType, styleContext);
		return drawCode(this, token, width, nextTokenType) ?? baseRenderToken.call(this, token, width, nextTokenType, styleContext);
	};

	proto.render = function (this: MarkdownInternals, width) {
		const state = stateOf(this);
		const full = isFullscreen();
		if (state.full !== undefined && state.full !== full) this.invalidate();
		state.full = full;
		adopt(this);

		const raw = baseRender.call(this, width);
		const copied = state.copied;
		if (state.out?.raw !== raw || state.out.copied !== copied) {
			state.out = { raw, copied, ...stripMarkers(raw, LABEL_WIDTH) };
			// Drop the ids no marker carries any more, so a streamed block's old versions go too.
			const live = new Set(state.out.hits.map((hit) => hit.block));
			for (const id of state.blocks.keys()) if (!live.has(id)) state.blocks.delete(id);
		}
		return state.out.lines;
	};

	proto.handleMouse = function (this: MarkdownInternals, event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click" || event.button !== "left") return undefined;
		const state = stateOf(this);
		const hit = state.out?.hits.find((h) => h.row === event.y && event.x >= h.start && event.x < h.end);
		const block = hit ? state.blocks.get(hit.block) : undefined;
		if (!hit || !block) return undefined;

		const done: Copied = { block: hit.block };
		void copy(block.code).then(
			() => {
				state.copied = done;
				this.invalidate();
				tui?.requestRender();
				setTimeout(() => {
					if (state.copied !== done) return;
					state.copied = undefined;
					this.invalidate();
					tui?.requestRender();
				}, resetMs);
			},
			(error: unknown) =>
				ctx?.ui.notify(`Copy failed: ${error instanceof Error ? error.message : String(error)}`, "error"),
		);
		return { handled: true };
	};
}

function stateOf(md: MarkdownInternals): State {
	const self = md as unknown as { [STATE]?: State };
	return (self[STATE] ??= { blocks: new Map() });
}

/** Centers the label in a fixed-width slot, so the top border does not move while copying. */
function labelFor(copied: boolean): string {
	const text = copied ? DONE : LABEL;
	const pad = Math.max(0, LABEL_WIDTH - visibleWidth(text));
	const left = Math.floor(pad / 2);
	return dim(" ".repeat(left) + text + " ".repeat(pad - left));
}
