/**
 * Pi has no hook for how a Markdown code block is drawn, so this patches Pi's Markdown component:
 *
 * - `renderToken` turns each `code` token into a rounded box (see `box.ts`).
 * - `render` strips the zero-width label markers from the final lines and remembers their rows.
 * - `handleMouse` copies a block when its label is clicked.
 *
 * If a Pi update renames these internals, `install()` is a no-op and Pi keeps working.
 */
import { copyToClipboard, type ExtensionContext } from "@earendil-works/pi-coding-agent";
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
	blocks: Block[];
	/** Last array returned by Pi's own render, to recognize its cache hits. */
	raw?: string[];
	full?: boolean;
	copied?: Copied;
	out?: { raw: string[]; copied: Copied | undefined; lines: string[]; hits: Hit[] };
};

const STATE = Symbol.for("pi-better-code-blocks.state");
const PATCHED = Symbol.for("pi-better-code-blocks.patched");

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

	proto.renderToken = function (this: MarkdownInternals, token, width, nextTokenType, styleContext) {
		if (token.type !== "code") return baseRenderToken.call(this, token, width, nextTokenType, styleContext);

		const code = token as Tokens.Code;
		const state = stateOf(this);
		const full = isFullscreen();
		const index = state.blocks.push({ code: code.text, lang: code.lang }) - 1;
		const box = renderCodeBox({
			code: code.text,
			lang: code.lang,
			width,
			theme: this.theme,
			label: full ? labelFor(state.copied?.block === index) : undefined,
			labelWidth: LABEL_WIDTH,
			marker: full ? marker(index) : undefined,
		});
		if (!box) {
			state.blocks.pop();
			return baseRenderToken.call(this, token, width, nextTokenType, styleContext);
		}
		if (nextTokenType && nextTokenType !== "space") box.lines.push("");
		return box.lines;
	};

	proto.render = function (this: MarkdownInternals, width) {
		const state = stateOf(this);
		const full = isFullscreen();
		if (state.full !== undefined && state.full !== full) this.invalidate();
		state.full = full;

		const previous = state.blocks;
		state.blocks = [];
		const raw = baseRender.call(this, width);
		if (raw === state.raw) state.blocks = previous; // Pi's line cache: renderToken did not run
		state.raw = raw;

		const copied = state.copied;
		if (state.out?.raw !== raw || state.out.copied !== copied) {
			state.out = { raw, copied, ...stripMarkers(raw, LABEL_WIDTH) };
		}
		return state.out.lines;
	};

	proto.handleMouse = function (this: MarkdownInternals, event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click" || event.button !== "left") return undefined;
		const state = stateOf(this);
		const hit = state.out?.hits.find((h) => h.row === event.y && event.x >= h.start && event.x < h.end);
		const block = hit ? state.blocks[hit.block] : undefined;
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
	return (self[STATE] ??= { blocks: [] });
}

/** Centers the label in a fixed-width slot, so the top border does not move while copying. */
function labelFor(copied: boolean): string {
	const text = copied ? DONE : LABEL;
	const pad = Math.max(0, LABEL_WIDTH - visibleWidth(text));
	const left = Math.floor(pad / 2);
	return dim(" ".repeat(left) + text + " ".repeat(pad - left));
}
