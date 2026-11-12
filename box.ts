/**
 * Draws a code block as a rounded, org-modern-style box:
 *
 *     ╭─ typescript ──────────────── ⧉ copy ─╮
 *     │ const answer = 42;                    │
 *     ╰───────────────────────────────────────╯
 *
 * Pure rendering only. `patch.ts` supplies the theme, the copy label and a zero-width marker
 * at the label, so a click can be mapped back to the block after Pi has wrapped and padded the
 * lines.
 */
import {
	type MarkdownTheme,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

/** Below this a box cannot hold a readable code line; Pi's own rendering is left alone. */
export const MIN_BOX_WIDTH = 12;

/** The label a box's top border carries, and what it says once the code is on the clipboard. */
const LABEL = "⧉ copy";
const DONE = "✓ copied";

/** The label slot's width: the widest state, so the top border does not move while copying. */
export const LABEL_WIDTH = Math.max(visibleWidth(LABEL), visibleWidth(DONE));

/** The clickable label, dim and centered in a fixed-width slot. */
export function copyLabel(copied: boolean): string {
	const text = copied ? DONE : LABEL;
	const pad = Math.max(0, LABEL_WIDTH - visibleWidth(text));
	const left = Math.floor(pad / 2);
	return `\x1b[2m${" ".repeat(left)}${text}${" ".repeat(pad - left)}\x1b[22m`;
}

/** Keep at least this many dashes between the language and the copy label. */
const MIN_DASHES = 2;
const ELLIPSIS = "…";

const TL = "╭";
const TR = "╮";
const BL = "╰";
const BR = "╯";
const H = "─";
const V = "│";

/** A zero-width OSC sequence. It survives wrapping and is stripped again before display. */
const MARKER = /\x1b\]7798;(\d+)\x07/g;

export const marker = (index: number): string => `\x1b]7798;${index}\x07`;

export interface Hit {
	row: number;
	start: number;
	end: number;
	block: number;
}

export interface CodeBox {
	lines: string[];
	/** Where the copy label landed, when one was drawn. */
	label?: { line: number; col: number; width: number };
}

export interface CodeBoxOptions {
	code: string;
	lang?: string;
	/** Available content width in cells, as passed to Markdown's renderToken. */
	width: number;
	theme: Pick<MarkdownTheme, "codeBlock" | "codeBlockBorder" | "highlightCode">;
	/** Already styled and padded to `labelWidth`; omit to draw no copy label. */
	label?: string;
	labelWidth?: number;
	/** Zero-width marker inserted right before the label. */
	marker?: string;
}

export function renderCodeBox(options: CodeBoxOptions): CodeBox | undefined {
	const width = Math.floor(options.width);
	if (width < MIN_BOX_WIDTH) return undefined;

	const border = options.theme.codeBlockBorder;
	const lang = languageName(options.lang);
	const label = options.label;
	const labelWidth = label === undefined ? 0 : (options.labelWidth ?? visibleWidth(label));
	const at = options.marker ?? "";

	// The top border carries the language on the left and the copy label on the right. When
	// space runs out, shorten the language first, then drop it, then give up on the label.
	let top: { line: string; col: number } | undefined;
	let drewLabel = false;
	if (label) {
		const maxLang = width - labelWidth - 8 - MIN_DASHES;
		if (maxLang >= 2) top = topBorder(width, truncateToWidth(lang, maxLang, ELLIPSIS), label, labelWidth, at, border);
		top ??= topBorder(width, "", label, labelWidth, at, border);
		drewLabel = top !== undefined;
	}
	if (!top) {
		const maxLang = width - 6;
		const short = maxLang >= 2 ? truncateToWidth(lang, maxLang, ELLIPSIS) : "";
		top = topBorder(width, short, undefined, 0, "", border);
	}
	if (!top) return undefined;

	const inner = width - 4; // "│ " + content + " │"
	const body = codeLines(options).flatMap((line) =>
		wrapTextWithAnsi(line, inner).map((part) => {
			const padding = Math.max(0, inner - visibleWidth(part));
			return border(`${V} `) + part + " ".repeat(padding) + border(` ${V}`);
		}),
	);

	return {
		lines: [top.line, ...body, border(`${BL}${H.repeat(width - 2)}${BR}`)],
		...(drewLabel ? { label: { line: 0, col: top.col, width: labelWidth } } : {}),
	};
}

function topBorder(
	width: number,
	lang: string,
	label: string | undefined,
	labelWidth: number,
	marker: string,
	border: (text: string) => string,
): { line: string; col: number } | undefined {
	const left = lang ? `${TL}${H} ${lang} ` : TL;

	if (!label) {
		const fill = width - visibleWidth(left) - 1;
		if (fill < 1) return undefined;
		return { line: border(left + H.repeat(fill) + TR), col: 0 };
	}

	const fill = width - visibleWidth(left) - labelWidth - 4; // " " + label + " ─╮"
	if (fill < MIN_DASHES) return undefined;
	const prefix = border(left + H.repeat(fill) + " ");
	return { line: prefix + marker + label + border(` ${H}${TR}`), col: visibleWidth(prefix) };
}

/** The highlighted (or plain) code lines, never empty so the box always has a body. */
function codeLines(options: CodeBoxOptions): string[] {
	const { code, lang, theme } = options;
	const lines = theme.highlightCode
		? theme.highlightCode(code, lang)
		: code.split("\n").map((line) => theme.codeBlock(line));
	return lines.length > 0 ? lines : [""];
}

/** The fence's info string, minus control characters and anything after the first word. */
export function languageName(raw: string | undefined): string {
	if (!raw) return "";
	const clean = stripTerminalSequences(raw)
		.replaceAll(/[\u0000-\u001f\u007f]/g, "")
		.trim();
	return clean.split(/\s+/)[0] ?? "";
}

/**
 * Removes the zero-width markers from rendered lines and reports where each copy label ended up.
 * Runs on the final (wrapped, padded) lines, so columns match the mouse event coordinates.
 */
export function stripMarkers(lines: readonly string[], labelWidth: number): { lines: string[]; hits: Hit[] } {
	const out: string[] = [];
	const hits: Hit[] = [];
	for (const line of lines) {
		const marks = [...line.matchAll(MARKER)];
		const first = marks[0];
		if (!first) {
			out.push(line);
			continue;
		}
		out.push(line.replace(MARKER, ""));
		const start = visibleWidth(line.slice(0, first.index));
		hits.push({ row: out.length - 1, start, end: start + labelWidth, block: Number(first[1]) });
	}
	return { lines: out, hits };
}
