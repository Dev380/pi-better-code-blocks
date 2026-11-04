/**
 * Code blocks in Pi's transcript as rounded boxes with their declared language on the top
 * border and a `⧉ copy` label that copies the code when clicked (fullscreen TUI).
 *
 * Pi has no hook for rendering parts of a Markdown message, so `install()` wraps the Markdown
 * component's internals; see `patch.ts`. If those internals change, the boxes disappear and Pi
 * keeps working.
 */
import { AssistantMessageComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { install, useContext, useTui } from "./patch.ts";

/** Set by pi-copy-button, which patches the same internals and owns the Markdown instances it decorates. */
const COPY_BUTTON = Symbol.for("pi-copy-button.updateContent");

const conflict = () => COPY_BUTTON in AssistantMessageComponent.prototype;

export default function (pi: ExtensionAPI) {
	install();
	let warned = false;
	pi.on("session_start", async (_event, context) => {
		useContext(context);
		if (!context.hasUI) return;
		if (!warned && conflict()) {
			warned = true;
			context.ui.notify(
				"pi-copy-button is also installed and overrides this extension's copy labels. Remove it to use pi-better-code-blocks.",
				"warning",
			);
		}
		// A widget factory is the only public way to reach the TUI (for requestRender and the UI mode).
		context.ui.setWidget("pi-better-code-blocks", (t) => {
			useTui(t);
			return { render: () => [], invalidate: () => {} };
		});
	});
	pi.on("session_shutdown", async () => {
		useTui(undefined);
		useContext(undefined);
	});
}
