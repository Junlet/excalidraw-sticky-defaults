/**
 * Watches open Excalidraw drawings and rewrites the labels of **newly created**
 * sticky notes.
 *
 * HOW CHANGES ARE OBSERVED
 * ------------------------
 * ExcalidrawAutomate in the version this plugin targets has no `onChange` hook,
 * and the Excalidraw plugin dispatches no scene-change event, so the scene is
 * polled: one comparison of `getSceneVersion()` per tick, which is a number, and
 * the element array is only examined when that number moves. A view's first scan
 * only records the notes that already exist -- this feature is about new notes,
 * so opening a drawing must not rewrite history, and a note the user retypes by
 * hand must not be overwritten either. That is also why the `seen` set exists.
 *
 * WHY THE WRITE WAITS FOR EDITING TO END
 * --------------------------------------
 * A new note immediately opens its text editor. Rewriting `fontFamily` /
 * `textAlign` while that editor is live would fight the user's typing, so a
 * note whose label is currently being edited is skipped and retried on the next
 * tick. The cost is one frame of centred text before it snaps left.
 */

import type { App } from "obsidian";
import {
	boundLabelOf,
	isNoop,
	isStickyNote,
	labelPatch,
	type ElementLike,
	type LabelPatch,
	type StickyDefaults,
} from "./defaults";

/** How often the scene version is checked. Cheap enough to feel instant. */
export const TICK_MS = 300;

/** `id` of the Excalidraw plugin in Obsidian's plugin registry. */
const EXCALIDRAW_PLUGIN_ID = "obsidian-excalidraw-plugin";

/** The parts of the Excalidraw view this plugin reads. */
interface ExcalidrawViewLike {
	excalidrawAPI?: {
		getSceneElements?: () => unknown;
		getAppState?: () => { editingTextElement?: unknown } | undefined;
	} | null;
	getSceneVersion?: (elements: unknown[]) => number;
}

/** The parts of ExcalidrawAutomate this plugin calls. */
interface AutomateLike {
	copyViewElementsToEAforEditing(elements: unknown[]): void;
	getElement(id: string): Record<string, unknown> | undefined;
	addElementsToView(
		repositionToCursor?: boolean,
		save?: boolean,
		newElementsOnTop?: boolean,
		shouldRestoreElements?: boolean,
		captureUpdate?: unknown
	): Promise<boolean>;
	destroy?(): void;
}

/** Per-drawing bookkeeping. */
interface ViewState {
	/** Last scene version examined. */
	version: number;
	/** Sticky-note ids already accounted for. */
	seen: Set<string>;
}

/** Reads the editing state out of whatever `getAppState()` returned. */
function editingIds(state: unknown): { id?: unknown; containerId?: unknown } {
	const editing = (state as { editingTextElement?: unknown } | undefined)
		?.editingTextElement;
	if (!editing || typeof editing !== "object") return {};
	const element = editing as { id?: unknown; containerId?: unknown };
	return { id: element.id, containerId: element.containerId };
}

/** Keeps sticky notes in line with the configured defaults. */
export class StickyNoteFixer {
	private readonly states = new WeakMap<object, ViewState>();

	/** Warned once when ExcalidrawAutomate could not be reached. */
	private warned = false;

	/**
	 * @param app - The Obsidian app.
	 * @param readDefaults - Current settings, read live so a slider takes effect
	 *   without restarting the poller.
	 */
	constructor(
		private readonly app: App,
		private readonly readDefaults: () => StickyDefaults
	) {}

	/**
	 * One poll: check every open drawing for sticky notes created since the last
	 * look and align their labels.
	 */
	tick(): void {
		const defaults = this.readDefaults();
		if (isNoop(defaults)) return;

		for (const view of this.views()) {
			const api = view.excalidrawAPI;
			if (!api?.getSceneElements) continue;
			const elements = api.getSceneElements();
			if (!Array.isArray(elements)) continue;

			const version = this.sceneVersion(view, elements);
			const existing = this.states.get(view as object);
			if (!existing) {
				// First scan of this drawing: remember what is already there so
				// existing notes are left untouched.
				const seen = new Set<string>();
				for (const element of elements as ElementLike[]) {
					if (isStickyNote(element) && typeof element.id === "string") {
						seen.add(element.id);
					}
				}
				this.states.set(view as object, { version, seen });
				continue;
			}
			if (version === existing.version) continue;
			existing.version = version;
			void this.reconcile(view, elements as ElementLike[], existing, defaults, false);
		}
	}

	/**
	 * Applies the defaults to every sticky note in every open drawing.
	 *
	 * Used by the command of the same name: unlike {@link tick} this ignores the
	 * "new only" rule, but still leaves a note alone while its editor is open.
	 *
	 * @returns How many labels were rewritten.
	 */
	async applyToExisting(): Promise<number> {
		const defaults = this.readDefaults();
		if (isNoop(defaults)) return 0;

		let changed = 0;
		for (const view of this.views()) {
			const elements = view.excalidrawAPI?.getSceneElements?.();
			if (!Array.isArray(elements)) continue;
			const state = this.states.get(view as object) ?? {
				version: -1,
				seen: new Set<string>(),
			};
			this.states.set(view as object, state);
			changed += await this.reconcile(
				view,
				elements as ElementLike[],
				state,
				defaults,
				true
			);
		}
		return changed;
	}

	/** Open Excalidraw views, in workspace order. */
	private views(): ExcalidrawViewLike[] {
		const leaves = this.app.workspace.getLeavesOfType("excalidraw");
		const views: ExcalidrawViewLike[] = [];
		for (const leaf of leaves) {
			if (leaf.view) views.push(leaf.view as unknown as ExcalidrawViewLike);
		}
		return views;
	}

	/** A cheap change detector for one drawing. */
	private sceneVersion(view: ExcalidrawViewLike, elements: unknown[]): number {
		if (typeof view.getSceneVersion === "function") {
			try {
				return view.getSceneVersion(elements);
			} catch {
				// Fall through to the length, which still catches additions.
			}
		}
		return elements.length;
	}

	/**
	 * Rewrites the labels that need it.
	 *
	 * @param view - The drawing.
	 * @param elements - Its scene.
	 * @param state - Per-drawing bookkeeping.
	 * @param defaults - What to force.
	 * @param force - Handle notes already recorded as seen.
	 * @returns How many labels were rewritten.
	 */
	private async reconcile(
		view: ExcalidrawViewLike,
		elements: ElementLike[],
		state: ViewState,
		defaults: StickyDefaults,
		force: boolean
	): Promise<number> {
		const patches: Array<{ labelId: string; patch: LabelPatch }> = [];

		for (const note of elements) {
			if (!isStickyNote(note) || typeof note.id !== "string") continue;
			if (!force && state.seen.has(note.id)) continue;

			const label = boundLabelOf(note, elements);
			if (!label || typeof label.id !== "string") {
				state.seen.add(note.id);
				continue;
			}
			// Leave the note alone while its text editor is live; the next tick
			// retries once the user has clicked away.
			if (this.isEditing(view, label)) continue;

			const patch = labelPatch(label, defaults);
			state.seen.add(note.id);
			if (patch) patches.push({ labelId: label.id, patch });
		}

		if (patches.length === 0) return 0;
		return (await this.write(view, elements, patches)) ? patches.length : 0;
	}

	/** Whether this label's text editor is open right now. */
	private isEditing(view: ExcalidrawViewLike, label: ElementLike): boolean {
		let state: unknown;
		try {
			state = view.excalidrawAPI?.getAppState?.();
		} catch {
			return false;
		}
		const { id, containerId } = editingIds(state);
		if (id === undefined && containerId === undefined) return false;
		return id === label.id || containerId === label.id;
	}

	/**
	 * Commits the patches through ExcalidrawAutomate.
	 *
	 * The same route the Excalidraw plugin uses for its own element edits:
	 * copy the scene elements onto a workbench, mutate the copies, then let
	 * `addElementsToView()` merge them back with proper version bumps and
	 * redrawing. `"NEVER"` is passed as the capture action so an automatic,
	 * cosmetic fix does not land on the undo stack.
	 *
	 * @returns True when the elements were committed.
	 */
	private async write(
		view: ExcalidrawViewLike,
		elements: ElementLike[],
		patches: Array<{ labelId: string; patch: LabelPatch }>
	): Promise<boolean> {
		const ea = this.acquireAutomate(view);
		if (!ea) {
			if (!this.warned) {
				this.warned = true;
				console.warn(
					"[excalidraw-sticky-defaults] 取不到 ExcalidrawAutomate，" +
						"便签默认设置未生效。请确认 Excalidraw 插件已启用且是最新版本。"
				);
			}
			return false;
		}

		try {
			const targets = patches
				.map((entry) => elements.find((el) => el.id === entry.labelId))
				.filter((el): el is ElementLike => el !== undefined);
			if (targets.length === 0) return false;

			ea.copyViewElementsToEAforEditing(targets);
			for (const entry of patches) {
				const target = ea.getElement(entry.labelId);
				if (!target) continue;
				if (entry.patch.fontFamily !== undefined) {
					target.fontFamily = entry.patch.fontFamily;
				}
				if (entry.patch.fontSize !== undefined) {
					target.fontSize = entry.patch.fontSize;
				}
				if (entry.patch.textAlign !== undefined) {
					target.textAlign = entry.patch.textAlign;
				}
				if (entry.patch.verticalAlign !== undefined) {
					target.verticalAlign = entry.patch.verticalAlign;
				}
			}
			return await ea.addElementsToView(false, true, false, false, "NEVER");
		} catch (error) {
			console.error(
				"[excalidraw-sticky-defaults] 写入便签label失败",
				error
			);
			return false;
		} finally {
			ea.destroy?.();
		}
	}

	/**
	 * Mints an ExcalidrawAutomate bound to one view.
	 *
	 * `getAPI(view)` is Excalidraw's own factory, so the instance belongs to this
	 * view and cannot disturb `window.ExcalidrawAutomate` or another drawing.
	 */
	private acquireAutomate(view: ExcalidrawViewLike): AutomateLike | null {
		const registry = (this.app as unknown as {
			plugins?: { plugins?: Record<string, unknown> };
		}).plugins;
		const plugin = registry?.plugins?.[EXCALIDRAW_PLUGIN_ID] as
			| { ea?: { getAPI?: (target: unknown) => AutomateLike } }
			| undefined;
		const factory = plugin?.ea;
		if (!factory || typeof factory.getAPI !== "function") return null;
		try {
			return factory.getAPI(view) ?? null;
		} catch {
			return null;
		}
	}
}
