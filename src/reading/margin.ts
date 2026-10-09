import { App, MarkdownView, Notice, setIcon } from "obsidian";
import { Result } from "better-result";
import { ParsedComment, TextRange } from "../format/types";
import { hasMarginAnchor, parseComments } from "../format/parse";
import { Card, CardCallbacks } from "../ui/card";
import { cardSignature } from "../ui/card-format";
import {
	Change,
	computeAppendReply,
	computeDeleteComment,
	computeDeleteEntry,
	computeEditEntry,
	computeSetResolved,
	computeToggleReaction,
} from "../editor/edits";
import { applyCommentEdit, insertComment as routeInsertComment } from "../editor/routing";
import { AnchorDamage, anchorDamage, computeRepairAnchors } from "../editor/anchor-repair";
import { syncHighlights } from "./highlight";
import { highlightsShown } from "../editor/config";
import { closestSpanId, spanSelector } from "../util/css";
import { stackTops } from "../ui/stack";
import { CARD_GAP, FLASH_MS, MARGIN_TAB_GUARD } from "../ui/constants";
import { buildDraftComposer } from "../ui/draft-composer";
import { EmptySubmitAction } from "../ui/draft-behavior";
import { authorColorCss, type AuthorColorResolver } from "../author-colors";
import { isHtmlElement } from "../util/dom";

export type ReadingDeps = {
	app: App;
	getAuthor: () => string;
	colorForAuthor: AuthorColorResolver;
	highlightColorForAuthor: AuthorColorResolver;
	showComments: () => boolean;
	showResolved: () => boolean;
	showHighlights: () => boolean;
	allowEmptyComments: () => boolean;
	/** While the sidebar panel is open, the inline column steps aside. */
	sidebarOpen: () => boolean;
	/** Reveal a thread in the sidebar — used by a margin card too tall to fit. */
	openInSidebar?: (id: string) => void;
	/** True on Obsidian mobile — no floating column; just drive highlight visibility. */
	isMobile?: () => boolean;
};

/** A margin column for one reading-view container, aligned to highlight spans. */
class ReadingMargin {
	private container: HTMLElement;
	private scroller: HTMLElement;
	private cards = new Map<string, Card>();
	private comments: ParsedComment[] = [];
	private damage = new Map<string, AnchorDamage>();
	private activeId: string | null = null;
	/** Minimize grip pinned to the pane's top-right corner; present only while the
	 *  column has visible cards. Toggling it hides the overlay (`dc-collapsed`). */
	private tabEl: HTMLElement | null = null;
	private tabCountEl: HTMLElement | null = null;
	private draft: TextRange | null = null;
	private draftText = "";
	private draftEmptyAction: EmptySubmitAction = "none";
	private draftTargetHighlightId: string | undefined;
	private draftEl: HTMLElement | null = null;
	private draftAnchor: HTMLElement | null = null;
	private cb: CardCallbacks;
	private scrollHandler = () => this.position();
	private resizeObserver: ResizeObserver;
	private animFrames = 0;
	private animatingLoop = false;
	private destroyed = false;

	constructor(
		private readingView: HTMLElement,
		private view: MarkdownView,
		private deps: ReadingDeps,
	) {
		this.container = readingView.createDiv("doc-comment-margin");
		this.scroller = (readingView.querySelector(".markdown-preview-view") as HTMLElement) ?? readingView;
		this.cb = {
			getAuthor: () => deps.getAuthor(),
			onHover: (id, active) => this.setActive(active ? id : null),
			onClickAnchor: (id) => this.flashAnchor(id),
			onResize: () => this.position(),
			animateLayout: () => this.animateLayout(),
			revealComposer: (id) => this.revealComposer(id),
			reply: (id, text) =>
				this.edit((doc) =>
					computeAppendReply(doc, id, {
						createdAt: new Date().toISOString(),
						author: deps.getAuthor(),
						text,
					}),
				),
			setResolved: (id, resolved) => void this.edit((doc) => computeSetResolved(doc, id, resolved)),
			remove: (id) => void this.edit((doc) => computeDeleteComment(doc, id)),
			editEntry: (id, index, text) => void this.edit((doc) => computeEditEntry(doc, id, index, text)),
			deleteEntry: (id, index) => void this.edit((doc) => computeDeleteEntry(doc, id, index)),
			toggleReaction: ({ id, entry, emoji }) =>
				void this.edit((doc) => computeToggleReaction({ doc, id, entry, emoji, author: deps.getAuthor() })),
			openInSidebar: (id) => deps.openInSidebar?.(id),
			repairAnchor: (id) => void this.edit((doc) => computeRepairAnchors(doc, new Set([id]))),
		};

		this.scroller.addEventListener("scroll", this.scrollHandler, { passive: true });
		this.resizeObserver = new ResizeObserver(() => this.position());
		this.resizeObserver.observe(this.scroller);
		this.readingView.addEventListener("mouseover", this.onMouseOver);
		this.readingView.addEventListener("mouseout", this.onMouseOut);
		this.readingView.addEventListener("mousedown", this.onMouseDown);
	}

	async refresh(text?: string): Promise<void> {
		const file = this.view.file;
		if (!file) return;
		let data: string;
		try {
			// Use the caller's just-written content if given; otherwise read fresh (NOT
			// cachedRead, which can lag right after a write and show stale state).
			data = text ?? (await this.deps.app.vault.read(file));
		} catch {
			return; // file vanished or unreadable — keep the last render
		}
		const parsed = parseComments(data);
		const all = parsed.filter(hasMarginAnchor);
		// Sidebar open → inline cards step aside (the panel lists them instead).
		this.comments = this.deps.showComments() && !this.deps.sidebarOpen() ? all : [];
		// Reading view is where a broken line shows, so its cards offer the repair too.
		this.damage = this.comments.length > 0 ? anchorDamage(data, parsed) : new Map<string, AnchorDamage>();
		this.reconcileCards();
		this.position();
	}

	private async edit(compute: (doc: string) => Result<Change[], string>): Promise<Result<void, string>> {
		const file = this.view.file;
		if (!file) {
			const result = Result.err("No file is open.");
			new Notice(`Couldn't save the comment: ${result.error}`);
			return result;
		}
		// Route through the open editor when there is one (undo history + unsaved
		// buffer) instead of a bare disk write that races the editor's autosave.
		const result = await applyCommentEdit(this.deps.app, file, compute);
		result.match({
			ok: (newData) => void this.refresh(newData),
			err: (message) => new Notice(`Couldn't save the comment: ${message}`),
		});
		return result.map(() => undefined);
	}

	private reconcileCards(): void {
		const present = new Set(this.comments.map((c) => c.id));
		for (const [id, card] of this.cards) {
			if (!present.has(id)) {
				card.destroy();
				card.el.remove();
				this.cards.delete(id);
				if (this.activeId === id) this.activeId = null;
			}
		}
		const cardView = {
			app: this.deps.app,
			sourcePath: () => this.view.file?.path ?? "",
			collapsible: true,
			colorForAuthor: this.deps.colorForAuthor,
		};
		for (const c of this.comments) {
			const existing = this.cards.get(c.id);
			if (!existing) {
				const card = new Card(c, this.cb, cardView);
				this.cards.set(c.id, card);
				this.container.appendChild(card.el);
				card.setAnchorDamage(this.damage.get(c.id) ?? null);
			} else {
				if (existing.signature !== cardSignature(c)) existing.update(c);
				existing.refreshAuthorColors();
				existing.setAnchorDamage(this.damage.get(c.id) ?? null);
			}
		}
		this.readingView.toggleClass("dc-hide-resolved", !this.deps.showResolved());
		this.syncTab();
	}

	private visibleCards(): number {
		return this.comments.filter((c) => this.deps.showResolved() || c.status !== "resolved").length;
	}

	private isCollapsed(): boolean {
		return this.container.classList.contains("dc-collapsed");
	}

	private expand(): void {
		if (!this.isCollapsed()) return;
		this.container.classList.remove("dc-collapsed");
		this.updateTabAffordance();
		this.position();
	}

	private toggleCollapsed(): void {
		this.container.classList.toggle("dc-collapsed", !this.isCollapsed());
		this.updateTabAffordance();
		this.position();
	}

	private updateTabAffordance(): void {
		if (!this.tabEl) return;
		const collapsed = this.isCollapsed();
		const icon = this.tabEl.querySelector<HTMLElement>(".dc-margin-tab__icon");
		if (icon) setIcon(icon, collapsed ? "chevrons-left" : "chevrons-right");
		this.tabEl.setAttribute("aria-label", collapsed ? "Show comments" : "Minimize comments");
		this.tabEl.setAttribute("aria-pressed", String(collapsed));
	}

	/** Keep the minimize grip in sync with the visible cards: create it with the
	 *  first card, remove it with the last, and refresh the count. */
	private syncTab(): void {
		const count = this.visibleCards();
		if (count > 0 && !this.tabEl) {
			const tab = this.container.createEl("button", {
				cls: "dc-margin-tab",
				attr: { "aria-label": "Minimize comments", "aria-pressed": "false" },
			});
			const icon = tab.createSpan({ cls: "dc-margin-tab__icon" });
			setIcon(icon, "chevrons-right");
			this.tabCountEl = tab.createSpan({ cls: "dc-margin-tab__count" });
			tab.addEventListener("click", () => this.toggleCollapsed());
			this.tabEl = tab;
		} else if (count === 0 && this.tabEl) {
			this.tabEl.remove();
			this.tabEl = null;
			this.tabCountEl = null;
			this.container.classList.remove("dc-collapsed");
		}
		if (this.tabCountEl) this.tabCountEl.textContent = String(count);
	}

	private position(): void {
		if (this.destroyed) return;
		const draftColor = authorColorCss(this.deps.highlightColorForAuthor(this.deps.getAuthor()));
		this.readingView.style.setProperty("--dc-highlight-color", draftColor);
		this.readingView.style.setProperty("--dc-draft-highlight-color", draftColor);
		// The margin is a pure overlay pinned to the right edge, so the reading
		// text always keeps Obsidian's native width/centering — no sizer cap, no
		// re-centering. `dc-margin` only makes the reading-view element
		// `position: relative` so the absolutely positioned overlay (cards or a
		// lone draft composer) has a containing block; unlike the editor, Obsidian
		// doesn't force position on the reading-view element. `dc-highlights` keeps
		// the in-text underlines visible independently of the column.
		const visibleCount = this.comments.filter((c) => this.deps.showResolved() || c.status !== "resolved").length;
		this.readingView.toggleClass("dc-margin", visibleCount > 0 || !!this.draft);
		this.readingView.toggleClass("dc-highlights", highlightsShown(this.deps));
		const topRef = this.readingView.getBoundingClientRect().top;
		// Gather geometry (reads) first, then write every top in one pass — cards are
		// absolutely positioned, so a top write can't change any height.
		const placements: Array<{ el: HTMLElement; top: number; height: number }> = [];
		// `guardTop` keeps a card that anchors near the very top out from under the
		// minimize grip; cards below the grip keep exact anchor alignment.
		const guardTop = this.tabEl !== null;
		for (const c of this.comments) {
			const card = this.cards.get(c.id);
			if (!card) continue;
			const span = this.scroller.querySelector(spanSelector(c.id));
			if (!span) {
				card.el.addClass("dc-offscreen");
				continue;
			}
			card.el.removeClass("dc-offscreen");
			if (card.el.offsetHeight === 0) continue;
			const top = span.getBoundingClientRect().top - topRef;
			placements.push({
				el: card.el,
				top: top + (guardTop ? Math.max(0, MARGIN_TAB_GUARD - top) : 0),
				height: card.el.offsetHeight,
			});
		}
		if (this.draftEl && this.draftAnchor) {
			const top = this.draftAnchor.getBoundingClientRect().top - topRef;
			placements.push({
				el: this.draftEl,
				top: top + (guardTop ? Math.max(0, MARGIN_TAB_GUARD - top) : 0),
				height: this.draftEl.offsetHeight,
			});
		}
		const tops = stackTops(placements, CARD_GAP);
		placements.forEach((p, i) => p.el.setCssStyles({ top: `${tops[i]}px` }));
	}

	/** Show an inline draft composer for a new comment (Reading-view "Add").
	 *  `expected` is the source text at [from,to], verified when the write lands. */
	showDraft(
		from: number,
		to: number,
		range: Range,
		expected: string,
		emptyAction: EmptySubmitAction,
		targetHighlightId?: string,
	): void {
		this.clearDraft();
		const span = this.scroller.createSpan({ cls: "doc-comment-span dc-draft" });
		span.detach();
		try {
			range.surroundContents(span);
		} catch {
			new Notice("Select within a single paragraph to comment in reading view.");
			return;
		}
		this.draftAnchor = span;
		this.draft = { from, to };
		this.draftText = expected;
		this.draftEmptyAction = emptyAction;
		this.draftTargetHighlightId = targetHighlightId;
		this.draftEl = this.buildDraftEl();
		this.container.appendChild(this.draftEl);
		// A freshly opened composer must never be stranded inside a collapsed
		// column, so auto-expand when one starts.
		this.expand();
		this.position();
		window.setTimeout(() => {
			const ta = this.draftEl?.querySelector("textarea");
			if (ta instanceof HTMLTextAreaElement) ta.focus();
		}, 0);
	}

	private buildDraftEl(): HTMLElement {
		const { el } = buildDraftComposer({
			emptyAction: this.draftEmptyAction,
			onCancel: () => this.clearDraft(),
			onSubmit: async (text) => {
				const draft = this.draft;
				const expected = this.draftText;
				const targetHighlightId = this.draftTargetHighlightId;
				if (!draft) return Result.err("The comment draft no longer exists.");
				const result = await this.insertComment(draft.from, draft.to, text, expected, targetHighlightId);
				if (result.isOk()) this.clearDraft();
				return result;
			},
		});
		return el;
	}

	private async insertComment(
		from: number,
		to: number,
		text: string,
		expected: string,
		targetHighlightId?: string,
	): Promise<Result<void, string>> {
		const file = this.view.file;
		if (!file) {
			const result = Result.err("No file is open.");
			new Notice(`Couldn't add the comment: ${result.error}`);
			return result;
		}
		const result = await routeInsertComment(
			this.deps.app,
			file,
			from,
			to,
			text,
			this.deps.getAuthor(),
			expected,
			this.deps.allowEmptyComments(),
			targetHighlightId,
		);
		result.match({
			ok: () => void this.refresh(),
			err: (message) => new Notice(`Couldn't add the comment: ${message}`),
		});
		return result.map(() => undefined);
	}

	private clearDraft(): void {
		if (this.draftAnchor) {
			// Unwrap the temp highlight span, restoring the original text nodes.
			const parent = this.draftAnchor.parentNode;
			if (parent) {
				while (this.draftAnchor.firstChild) parent.insertBefore(this.draftAnchor.firstChild, this.draftAnchor);
				parent.removeChild(this.draftAnchor);
				parent.normalize();
			}
			this.draftAnchor = null;
		}
		this.draftEl?.remove();
		this.draftEl = null;
		this.draft = null;
		this.draftText = "";
		this.draftEmptyAction = "none";
		this.draftTargetHighlightId = undefined;
		// Re-run layout so the composer's `dc-margin` containing block is dropped
		// immediately on cancel — the editor margin gets this for free via its
		// dispatch cycle; the reading margin has to ask for it.
		this.position();
	}

	private setActive(id: string | null): void {
		if (this.activeId === id) return;
		if (this.activeId) {
			this.cards.get(this.activeId)?.setActive(false);
			this.markHighlight(this.activeId, false);
		}
		this.activeId = id;
		if (id) {
			this.cards.get(id)?.setActive(true);
			this.markHighlight(id, true);
		}
	}

	private markHighlight(id: string, active: boolean): void {
		this.scroller.querySelectorAll(spanSelector(id)).forEach((s) => s.classList.toggle("is-active", active));
	}

	/** Clicking a margin card flashes its highlighted text — no scroll (it's aligned). */
	private flashAnchor(id: string): void {
		this.setActive(id);
		const span = this.scroller.querySelector(spanSelector(id));
		if (!span) return;
		span.classList.add("dc-flash");
		window.setTimeout(() => span.classList.remove("dc-flash"), FLASH_MS);
	}

	/** Scroll the reading view the minimum needed to reveal a just-opened composer. */
	private revealComposer(id: string): void {
		const card = this.cards.get(id);
		if (!card) return;
		window.requestAnimationFrame(() => {
			const box = card.el.querySelector(".dc-field--composer");
			if (!isHtmlElement(box)) return;
			const c = box.getBoundingClientRect();
			const s = this.scroller.getBoundingClientRect();
			let delta = 0;
			if (c.bottom > s.bottom) delta = c.bottom - s.bottom + 12;
			else if (c.top < s.top) delta = c.top - s.top - 12;
			if (delta) this.scroller.scrollTop += delta;
		});
	}

	/** Drive the stacking for a few frames so neighbors follow a card's open/close
	 *  height animation smoothly (mirrors the editor margin). */
	private animateLayout(): void {
		this.animFrames = 14;
		this.position();
		if (this.animatingLoop) return;
		this.animatingLoop = true;
		const tick = (): void => {
			this.position();
			if (this.animFrames-- > 0) {
				window.requestAnimationFrame(tick);
			} else {
				this.animatingLoop = false;
			}
		};
		window.requestAnimationFrame(tick);
	}

	private onMouseOver = (e: MouseEvent): void => {
		const id = closestSpanId(e.target);
		if (id) this.setActive(id);
	};

	private onMouseOut = (e: MouseEvent): void => {
		const span = e.target instanceof Element ? e.target.closest(".doc-comment-span") : null;
		if (!span) return;
		const to = e.relatedTarget;
		if (to instanceof Node && span.contains(to)) return;
		this.setActive(null);
	};

	private onMouseDown = (e: MouseEvent): void => {
		const id = closestSpanId(e.target);
		if (id) this.setActive(id);
	};

	destroy(): void {
		this.destroyed = true;
		this.clearDraft();
		this.scroller.removeEventListener("scroll", this.scrollHandler);
		this.resizeObserver.disconnect();
		this.readingView.removeEventListener("mouseover", this.onMouseOver);
		this.readingView.removeEventListener("mouseout", this.onMouseOut);
		this.readingView.removeEventListener("mousedown", this.onMouseDown);
		// The container we own goes away; the state classes sit on Obsidian's
		// reading-view element, so clear them explicitly rather than leaving them
		// (e.g. a stale `position: relative` from `dc-margin`).
		this.readingView.removeClasses(["dc-margin", "dc-highlights", "dc-hide-resolved"]);
		for (const card of this.cards.values()) card.destroy();
		this.tabEl = null;
		this.tabCountEl = null;
		this.container.remove();
		this.cards.clear();
	}
}

/** Tracks one ReadingMargin per reading-view container, creating/destroying as
 *  markdown leaves enter/leave preview mode. */
export class ReadingMarginManager {
	private margins = new Map<HTMLElement, ReadingMargin>();

	constructor(private deps: ReadingDeps) {}

	refresh(): void {
		const mobile = this.deps.isMobile?.() ?? false;
		const active = new Set<HTMLElement>();
		for (const leaf of this.deps.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (!(view instanceof MarkdownView) || view.getMode() !== "preview") continue;
			const rv = view.containerEl.querySelector(".markdown-reading-view");
			if (!isHtmlElement(rv)) continue;
			active.add(rv);
			// Against the text this pane shows, not the file: an editing pane on the same
			// note is ahead of the file until it saves, and this pane shows its text.
			const shown = view.getViewData();
			if (shown) syncHighlights(rv, shown);
			if (mobile) {
				// Mobile: no floating overlay and no position containing block. Just
				// keep the in-text highlights' visibility in sync with the toggles.
				// Comments are read/created via the sidebar.
				rv.toggleClass("dc-highlights", highlightsShown(this.deps));
				rv.toggleClass("dc-hide-resolved", !this.deps.showResolved());
				rv.removeClasses(["dc-margin"]);
				const draftColor = authorColorCss(this.deps.highlightColorForAuthor(this.deps.getAuthor()));
				rv.style.setProperty("--dc-highlight-color", draftColor);
				rv.style.setProperty("--dc-draft-highlight-color", draftColor);
				continue;
			}
			let margin = this.margins.get(rv);
			if (!margin) {
				margin = new ReadingMargin(rv, view, this.deps);
				this.margins.set(rv, margin);
			}
			void margin.refresh();
		}
		for (const [rv, margin] of this.margins) {
			if (!active.has(rv)) {
				margin.destroy();
				this.margins.delete(rv);
			}
		}
	}

	/** Show the inline new-comment composer on the active reading view. */
	startDraft(
		view: MarkdownView,
		from: number,
		to: number,
		range: Range,
		expected: string,
		emptyAction: EmptySubmitAction,
		targetHighlightId?: string,
	): void {
		const rv = view.containerEl.querySelector(".markdown-reading-view");
		if (!isHtmlElement(rv)) return;
		let margin = this.margins.get(rv);
		if (!margin) {
			margin = new ReadingMargin(rv, view, this.deps);
			this.margins.set(rv, margin);
			void margin.refresh();
		}
		margin.showDraft(from, to, range, expected, emptyAction, targetHighlightId);
	}

	destroy(): void {
		for (const margin of this.margins.values()) margin.destroy();
		this.margins.clear();
	}
}
