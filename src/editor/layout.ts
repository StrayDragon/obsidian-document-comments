import { EditorState, StateField } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { commentConfig, highlightsShown } from "./config";
import { authorColorCss } from "../author-colors";

// Defined ABOVE editorLayoutField: StateField.define evaluates `provide` EAGERLY
// at module load, and the provider arrow it builds references this helper. A
// `const` referenced before its definition line is in the temporal dead zone and
// throws ReferenceError — which would break every note. (Same trap as draft.ts.)
type EditorLayoutAttributes = {
	className: string;
	style: string;
};

const editorLayoutAttributes = (state: EditorState): EditorLayoutAttributes => {
	const cfg = state.facet(commentConfig);
	// The margin column is a pure overlay these days — it never reserves layout
	// space, so there is deliberately NO class mirroring "comments present". Only
	// state that changes the TEXT or card visibility rides on .cm-editor:
	// dc-highlights and dc-hide-resolved. Adding anything comment-count-dependent
	// here would re-cap or re-render the text, which is exactly the invasive
	// behavior we removed.

	const classes: string[] = [];
	// Highlights have their own toggle, so they persist both while the sidebar
	// panel hosts the cards and while the column is hidden entirely, except on
	// mobile (see highlightsShown).
	if (highlightsShown(cfg)) classes.push("dc-highlights");
	if (!cfg.showResolved()) classes.push("dc-hide-resolved");
	const draftColor = authorColorCss((cfg.highlightColorForAuthor ?? cfg.colorForAuthor)(cfg.author()));
	return {
		className: classes.join(" "),
		style: `--dc-highlight-color: ${draftColor}; --dc-draft-highlight-color: ${draftColor}`,
	};
};

/**
 * Mirrors the visibility state onto the `.cm-editor` element as plain classes
 * (`dc-highlights`, `dc-hide-resolved`) so the stylesheet can toggle highlights
 * with ordinary descendant selectors — no `:has()`. We route through CodeMirror's
 * `editorAttributes` facet rather than `classList` on `view.dom`, because
 * CodeMirror owns that element's className and rewrites it on reconfigure; a raw
 * `classList.add` gets silently dropped.
 *
 * The value recomputes on every transaction — including the empty `dispatch({})`
 * the plugin fires when a setting toggles — so the classes always track state.
 */
export const editorLayoutField = StateField.define<EditorLayoutAttributes>({
	create: editorLayoutAttributes,
	update: (value, tr) => {
		const next = editorLayoutAttributes(tr.state);
		return next.className === value.className && next.style === value.style ? value : next;
	},
	provide: (f) => EditorView.editorAttributes.from(f, ({ className, style }) => ({ class: className, style })),
});
