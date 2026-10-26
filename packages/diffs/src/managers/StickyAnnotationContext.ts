import type { CodeViewLocalManagerContext } from '../components/CodeView';

// Opt-in, unified CodeView annotations: move the original rows, never clone them.
export class StickyAnnotationContext<LAnnotation, Caret> {
	dirty = true;
	styles = new Map<HTMLElement, Record<string, string>>();
	animations = new Map<HTMLElement, { animation: Animation; timeline: ViewTimeline; start: number; distance: number }>();
	timelines = new WeakMap<HTMLElement, ViewTimeline>();
	update(viewer: CodeViewLocalManagerContext<LAnnotation, Caret>) {
		if (!this.dirty) return;
		this.dirty = false;
		const next = new Map<HTMLElement, Record<string, string>>(), pins = new Map<HTMLElement, { annotation: HTMLElement; start: number; distance: number }>();
		const option = viewer.options.stickyAnnotationContext;
		if (option && viewer.root && typeof ViewTimeline !== "undefined" && (viewer.options.diffStyle ?? "split") === "unified") {
			const viewport = viewer.root.getBoundingClientRect();
			const headerOffset = viewer.getStickyHeaderOffset();
			const top = viewport.top + viewer.root.clientTop + headerOffset;
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
					for (const row of rows) contextHeight += row.getBoundingClientRect().height;
					const availableHeight = viewer.root.clientHeight - headerOffset - contextHeight;
					if (bounds.height <= availableHeight) continue;
					const headers = option.headerSelector ? wrappers.flatMap(wrapper => [...wrapper.querySelectorAll<HTMLElement>(option.headerSelector!)]).filter(header => header.getBoundingClientRect().height && header.parentElement!.getBoundingClientRect().height > availableHeight) : [];
					const lastHeader = headers.at(-1);
					const bottom = lastHeader ? lastHeader.parentElement!.getBoundingClientRect().bottom - lastHeader.getBoundingClientRect().height : bounds.bottom;
					const distance = bottom - bounds.top;
					if (distance <= 0) continue;
					const pin = (node: HTMLElement) => {
						next.set(node, { position: "relative", top: "0px", "z-index": "4" });
						pins.set(node, { annotation, start: availableHeight, distance });
					};
					next.set(code!, { overflow: "visible", contain: "layout style" });
					next.set(content, { isolation: "isolate" });
					for (const row of rows) {
						pin(row);
						const number = gutter?.querySelector<HTMLElement>(`[data-column-number][data-line-index="${row.dataset.lineIndex}"]`);
						if (number) pin(number);
					}
					for (const wrapper of wrappers) next.set(wrapper, { "--diffs-sticky-context-bottom": `${top + contextHeight}px` });
					for (const header of headers) next.set(header, { position: "sticky", top: `${headerOffset + contextHeight}px`, "z-index": "3" });
				}
			}
		}
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
			const animation = node.animate({ translate: ["0px 0px", `0px ${distance}px`] }, {
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
	}
}

