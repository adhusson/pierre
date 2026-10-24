import type { CodeViewLocalManagerContext } from '../components/CodeView';

// Opt-in, unified CodeView annotations: move the original rows, never clone them.
export class StickyAnnotationContext<LAnnotation, Caret> {
	styles = new Map<HTMLElement, Record<string, string>>();
	animations = new Map<HTMLElement, { animation: Animation; start: number; distance: number }>();
	timeline: ScrollTimeline | undefined;
	update(viewer: CodeViewLocalManagerContext<LAnnotation, Caret>) {
		const next = new Map<HTMLElement, Record<string, string>>(), pins = new Map<HTMLElement, { start: number; distance: number }>();
		const option = viewer.options.stickyAnnotationContext;
		const offset = (node: HTMLElement) => this.animations.has(node) ? parseFloat(getComputedStyle(node).translate.split(" ")[1]) || 0 : 0;
		const pin = (node: HTMLElement, start: number, distance: number) => {
			if (distance <= 0) return;
			next.set(node, { position: "relative", top: "0px", "z-index": "4" });
			pins.set(node, { start, distance });
		};
		if (option && viewer.root && typeof ScrollTimeline !== "undefined" && (viewer.options.diffStyle ?? "split") === "unified") {
			if (this.timeline?.source !== viewer.root) this.timeline = new ScrollTimeline({ source: viewer.root, axis: "block" });
			const scroll = viewer.root.scrollTop, viewport = viewer.root.getBoundingClientRect();
			const top = viewport.top + viewer.root.clientTop + viewer.getStickyHeaderOffset();
			for (const { codeUnified, item } of viewer.getRenderedItems()) {
				if (!item.annotations?.length) continue;
				const code = codeUnified, content = code?.querySelector<HTMLElement>("[data-content]");
				if (!content) continue;
				const gutter = code!.querySelector<HTMLElement>("[data-gutter]");
				for (const annotation of content.querySelectorAll<HTMLElement>(":scope > [data-line-annotation]")) {
					const bounds = annotation.getBoundingClientRect();
					if (bounds.height <= viewport.height - viewer.getStickyHeaderOffset() || bounds.bottom <= top || bounds.top >= viewport.bottom) continue;
					const wrappers = [...annotation.querySelectorAll<HTMLSlotElement>("slot")].flatMap(slot => slot.assignedElements() as HTMLElement[]);
					const headers = option.headerSelector ? wrappers.flatMap(wrapper => [...wrapper.querySelectorAll<HTMLElement>(option.headerSelector!)]).filter(header => header.getBoundingClientRect().height) : [];
					const rows: HTMLElement[] = [];
					for (let row = annotation.previousElementSibling as HTMLElement | null; row && !row.hasAttribute("data-separator") && rows.length < (option.lines ?? 6); row = row.previousElementSibling as HTMLElement | null) {
						if (row.hasAttribute("data-line")) rows.unshift(row);
					}
					if (!rows.length) continue;
					const first = rows[0], last = rows.at(-1)!;
					const start = first.getBoundingClientRect().top - offset(first);
					const end = last.getBoundingClientRect().bottom - offset(last);
					const lastHeader = headers.at(-1);
					const bottom = lastHeader ? lastHeader.parentElement!.getBoundingClientRect().bottom - lastHeader.getBoundingClientRect().height : bounds.bottom;
					const distance = bottom - end, rangeStart = scroll + start - top;
					if (distance <= 0) continue;
					// Keep horizontally scrolled code behind the stationary gutter.
					next.set(content, { isolation: "isolate" });
					for (const row of rows) {
						pin(row, rangeStart, distance);
						const number = gutter?.querySelector<HTMLElement>(`[data-column-number][data-line-index="${row.dataset.lineIndex}"]`);
						if (number) pin(number, rangeStart, distance);
					}
					for (const wrapper of wrappers) next.set(wrapper, { "--diffs-sticky-context-bottom": `${top + end - start}px` });
					for (const header of headers) {
						const parent = header.parentElement!.getBoundingClientRect(), rect = header.getBoundingClientRect();
						if (parent.height <= viewport.height - viewer.getStickyHeaderOffset()) continue;
						const previous = offset(header);
						pin(header, scroll + rect.top - previous - top - (end - start), parent.bottom - rect.bottom + previous);
					}
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
		for (const [node, { start, distance }] of pins) {
			const previous = this.animations.get(node);
			if (previous && Math.abs(previous.start - start) < .001 && Math.abs(previous.distance - distance) < .001) continue;
			previous?.animation.cancel();
			const animation = node.animate({ translate: ["0px 0px", `0px ${distance}px`] }, {
				timeline: this.timeline, rangeStart: `${start}px`, rangeEnd: `${start + distance}px`, fill: "both"
			});
			this.animations.set(node, { animation, start, distance });
		}
	}
	cleanUp() {
		for (const [node, previous] of this.styles) for (const [key, value] of Object.entries(previous)) if (value) node.style.setProperty(key, value); else node.style.removeProperty(key);
		this.styles.clear();
		for (const { animation } of this.animations.values()) animation.cancel();
		this.animations.clear();
		this.timeline = undefined;
	}
}
