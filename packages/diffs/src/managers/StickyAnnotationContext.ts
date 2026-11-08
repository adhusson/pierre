import type { CodeViewLocalManagerContext } from '../components/CodeView';

// Opt-in, unified CodeView annotations: move the original rows, never clone them.
export class StickyAnnotationContext<LAnnotation, Caret> {
	dirty = true;
	styles = new Map<HTMLElement, Record<string, string>>();
	animations = new Map<HTMLElement, { animation: Animation; timeline: ViewTimeline; start: number; distance: number }>();
	timelines = new WeakMap<HTMLElement, ViewTimeline>();
	tops = new Map<HTMLElement, number[]>();  // the sticky places of the rows of each pinned annotation (relative to the scrollport), kept while the annotation stays pinned
	update(viewer: CodeViewLocalManagerContext<LAnnotation, Caret>) {
		if (!this.dirty) return;
		this.dirty = false;
		const next = new Map<HTMLElement, Record<string, string>>(), pins = new Map<HTMLElement, { annotation: HTMLElement; start: number; distance: number }>();
		const option = viewer.options.stickyAnnotationContext, seen = new Set<HTMLElement>();
		if (option && viewer.root && typeof ViewTimeline !== "undefined" && (viewer.options.diffStyle ?? "split") === "unified") {
			const viewport = viewer.root.getBoundingClientRect();
			const headerOffset = viewer.getStickyHeaderOffset();
			const viewportTop = viewport.top + viewer.root.clientTop;
			for (const { codeUnified, item } of viewer.getRenderedItems()) {
				if (!item.annotations?.length) continue;
				const code = codeUnified, content = code?.querySelector<HTMLElement>("[data-content]");
				if (!content) continue;
				const gutter = code!.querySelector<HTMLElement>("[data-gutter]");
				for (const annotation of content.querySelectorAll<HTMLElement>(":scope > [data-line-annotation]")) {
					const bounds = annotation.getBoundingClientRect();
					const wrappers = [...annotation.querySelectorAll<HTMLSlotElement>("slot")].flatMap(slot => slot.assignedElements() as HTMLElement[]);
					const rows: HTMLElement[] = [];
					for (let row = annotation.previousElementSibling as HTMLElement | null; row && !row.hasAttribute("data-separator") && !row.hasAttribute("data-line-annotation") && rows.length < (option.lines ?? 6); row = row.previousElementSibling as HTMLElement | null) {
						if (row.hasAttribute("data-line")) rows.unshift(row);
					}
					if (!rows.length) continue;
					let contextHeight = 0;
					const rowHeights = rows.map(row => row.getBoundingClientRect().height);
					const rowOffsets = rowHeights.map(height => {
						const offset = contextHeight;
						contextHeight += height;
						return offset;
					});
					const stackHeight = headerOffset + contextHeight, availableHeight = viewer.root.clientHeight - stackHeight;
					// An annotation taller than minHeight gets the context (default: taller than the space under the context, so that it can hide the context)
					const minHeight = option.minHeight ?? availableHeight;
					if (bounds.height <= minHeight) continue;
					// The rows' sticky places: a stack under the header. Pinned first while the annotation's top is between the header and the stack's bottom (the annotation
					// opened there, or the view jumped there), the rows keep the places they have: the stack would move them down, over the annotation's start. They keep
					// these places until the annotation's top is at or below the stack's bottom again (the rows are at their own places then, so the stack moves nothing)
					const annotationTop = bounds.top - viewportTop;
					let tops = this.tops.get(annotation);
					if (tops && (annotationTop >= stackHeight || tops.length !== rows.length)) tops = undefined;
					if (!tops) {
						const kept = annotationTop > headerOffset && annotationTop < stackHeight;
						tops = rowOffsets.map(offset => (kept ? annotationTop - contextHeight : headerOffset) + offset);
					}
					const stackBottom = tops[tops.length - 1] + rowHeights[rowHeights.length - 1];
					const headers = option.headerSelector ? wrappers.flatMap(wrapper => [...wrapper.querySelectorAll<HTMLElement>(option.headerSelector!)]).filter(header => header.getBoundingClientRect().height && header.parentElement!.getBoundingClientRect().height > minHeight) : [];
					// The rows stay until the header that its parent pushes up last begins to move. A header pushed up before that (a thread's bar
					// inside the card, with the thread line at the end of the wrapper after it) goes under the rows, as the card's content does
					const bottom = headers.length ? Math.max(...headers.map(header => header.parentElement!.getBoundingClientRect().bottom - header.getBoundingClientRect().height)) : bounds.bottom;
					const distance = bottom - bounds.top;
					if (distance <= 0) continue;
					this.tops.set(annotation, tops);
					seen.add(annotation);
					const start = viewer.root.clientHeight - stackBottom + distance, push = stackBottom;
					const pin = (node: HTMLElement, top: number) => {
						next.set(node, { position: "sticky", top: `${top}px`, "z-index": "4" });
						pins.set(node, { annotation, start, distance: push });
					};
					next.set(code!, { overflow: "visible", contain: "layout style" });
					next.set(content, { isolation: "isolate" });
					rows.forEach((row, i) => {
						pin(row, tops![i]);
						const number = gutter?.querySelector<HTMLElement>(`[data-column-number][data-line-index="${row.dataset.lineIndex}"]`);
						if (number) pin(number, tops![i]);
					});
					for (const wrapper of wrappers) next.set(wrapper, { "--diffs-sticky-context-bottom": `${viewportTop + stackBottom}px` });
					for (const header of headers) next.set(header, { position: "sticky", top: `${stackBottom}px`, "z-index": "3" });
				}
			}
		}
		for (const annotation of [...this.tops.keys()]) if (!seen.has(annotation)) this.tops.delete(annotation);
		// Read all geometry before writing styles; restore nodes leaving the range.
		for (const [node, previous] of this.styles) if (!next.has(node)) {
			for (const [key, value] of Object.entries(previous)) if (value) node.style.setProperty(key, value); else node.style.removeProperty(key);
			this.styles.delete(node);
		}
		for (const [node, values] of next) {
			if (!this.styles.has(node)) this.styles.set(node, Object.fromEntries(Object.keys(values).map(key => [key, node.style.getPropertyValue(key)])));
			for (const [key, value] of Object.entries(values)) if (node.style.getPropertyValue(key) !== value) node.style.setProperty(key, value);
		}
		for (const [node, previous] of this.animations) if (!pins.has(node)) {
			previous.animation.cancel();
			this.animations.delete(node);
		}
		for (const [node, { annotation, start, distance }] of pins) {
			let timeline = this.timelines.get(annotation);
			if (!timeline) this.timelines.set(annotation, timeline = new ViewTimeline({ subject: annotation, axis: "block" }));
			const previous = this.animations.get(node);
			if (previous && previous.timeline === timeline && Math.abs(previous.start - start) < .001 && Math.abs(previous.distance - distance) < .001) continue;
			previous?.animation.cancel();
			const animation = node.animate({ translate: ["0px 0px", `0px -${distance}px`] }, {
				timeline, rangeStart: `entry calc(0% + ${start}px)`, rangeEnd: `entry calc(0% + ${start + distance}px)`, fill: "both"
			});
			this.animations.set(node, { animation, timeline, start, distance });
		}
	}
	cleanUp() {
		for (const [node, previous] of this.styles) for (const [key, value] of Object.entries(previous)) if (value) node.style.setProperty(key, value); else node.style.removeProperty(key);
		this.styles.clear();
		for (const { animation } of this.animations.values()) animation.cancel();
		this.animations.clear();
		this.tops.clear();
	}
}

