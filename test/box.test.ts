import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type MarkdownTheme,
	sliceByColumn,
	stripTerminalSequences,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { MIN_BOX_WIDTH, marker, renderCodeBox, stripMarkers } from "../box.ts";

const id = (text: string) => text;
const border = (text: string) => `\x1b[38;5;8m${text}\x1b[39m`;
const theme: Pick<MarkdownTheme, "codeBlock" | "codeBlockBorder"> = { codeBlock: id, codeBlockBorder: border };

const plain = (line: string) => stripTerminalSequences(line);
const label = "⧉ copy";
const labelWidth = visibleWidth(label);

test("draws a rounded box with the language on the top border", () => {
	const box = renderCodeBox({ code: "const x = 1;", lang: "ts", width: 40, theme });
	assert.ok(box);
	assert.equal(box.lines.length, 3);
	for (const line of box.lines) assert.equal(visibleWidth(line), 40);

	const [top, body, bottom] = box.lines.map(plain);
	assert.match(top ?? "", /^╭─ ts ─+╮$/);
	assert.match(body ?? "", /^│ const x = 1; +│$/);
	assert.match(bottom ?? "", /^╰─+╯$/);
});

test("puts the copy label on the top border and reports its column", () => {
	const box = renderCodeBox({
		code: "ls",
		lang: "sh",
		width: 40,
		theme,
		label,
		labelWidth,
		marker: marker(0),
	});
	assert.ok(box?.label);
	assert.equal(box.label.line, 0);
	assert.equal(box.label.width, labelWidth);

	const { lines, hits } = stripMarkers(box.lines, labelWidth);
	assert.equal(hits.length, 1);
	assert.deepEqual(hits[0], { row: 0, start: box.label.col, end: box.label.col + labelWidth, block: 0 });
	assert.equal(plain(sliceByColumn(lines[0] ?? "", box.label.col, labelWidth)), label);
	for (const line of lines) assert.ok(!line.includes("\x1b]7798"), "marker leaked");
});

test("omits the language label when the fence has none", () => {
	const box = renderCodeBox({ code: "plain", width: 30, theme });
	assert.ok(box);
	assert.match(plain(box.lines[0] ?? ""), /^╭─+╮$/);
});

test("wraps long code lines inside the box", () => {
	const code = "const veryLongVariableName = 'a string that does not fit';";
	const box = renderCodeBox({ code, lang: "ts", width: 20, theme });
	assert.ok(box);
	assert.ok(box.lines.length > 3, "expected the code to wrap");
	for (const line of box.lines) assert.equal(visibleWidth(line), 20);

	const text = box.lines.map(plain).join("\n");
	assert.match(text, /veryLong/);
	assert.match(text, /does not/);
});

test("falls back below the minimum width", () => {
	assert.equal(renderCodeBox({ code: "x", lang: "ts", width: MIN_BOX_WIDTH - 1, theme }), undefined);
	assert.ok(renderCodeBox({ code: "x", lang: "ts", width: MIN_BOX_WIDTH, theme }));
});

test("truncates a language that does not fit next to the label", () => {
	const box = renderCodeBox({
		code: "x",
		lang: "typescriptreact",
		width: 20,
		theme,
		label,
		labelWidth,
		marker: marker(0),
	});
	assert.ok(box?.label);
	const top = plain(box.lines[0] ?? "");
	assert.match(top, /╭─ typ… ─+ ⧉ copy ─╮/);
	assert.equal(visibleWidth(top), 20);
});

test("drops the language before the copy label when space is tight", () => {
	const box = renderCodeBox({
		code: "x",
		lang: "typescript",
		width: 16,
		theme,
		label,
		labelWidth,
		marker: marker(0),
	});
	assert.ok(box?.label);
	const top = plain(box.lines[0] ?? "");
	assert.match(top, /^╭─+ ⧉ copy ─╮$/);
});

test("drops the copy label when only the language fits", () => {
	const box = renderCodeBox({
		code: "x",
		lang: "typescript",
		width: 12,
		theme,
		label,
		labelWidth,
		marker: marker(0),
	});
	assert.ok(box);
	assert.equal(box.label, undefined);
	assert.match(plain(box.lines[0] ?? ""), /^╭─ types… ─╮$/);
	assert.ok(!box.lines.join("").includes("\x1b]7798"));
});

test("keeps one body line for empty code", () => {
	const box = renderCodeBox({ code: "", lang: "ts", width: 20, theme });
	assert.ok(box);
	assert.equal(box.lines.length, 3);
});

test("handles wide characters without breaking the border", () => {
	const box = renderCodeBox({ code: "日本語のコード", lang: "日本語", width: 16, theme });
	assert.ok(box);
	for (const line of box.lines) assert.equal(visibleWidth(line), 16);
	assert.match(plain(box.lines[0] ?? ""), /^╭─ 日本語 ─+╮$/);
});

test("stripMarkers removes every marker and keeps row indices", () => {
	const raw = ["a" + marker(3) + "b", "plain", "x" + marker(7) + "y"];
	const { lines, hits } = stripMarkers(raw, 5);
	assert.deepEqual(lines, ["ab", "plain", "xy"]);
	assert.deepEqual(hits, [
		{ row: 0, start: 1, end: 6, block: 3 },
		{ row: 2, start: 1, end: 6, block: 7 },
	]);
});
