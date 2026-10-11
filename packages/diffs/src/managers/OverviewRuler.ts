import type { CodeViewLocalManagerContext } from '../components/CodeView';

const SVG_NS = "http://www.w3.org/2000/svg";

export class OverviewRuler<LAnnotation, Caret> {
	dirty = true;
	host: HTMLStyleElement | undefined;
	track: SVGSVGElement | undefined;
	paths: SVGPathElement[] | undefined;
	viewer: CodeViewLocalManagerContext<LAnnotation, Caret> | undefined;
	height = 0;
	extent = 0;
	fileId: string | undefined;
	searchVersion: number | undefined;
	image: string | undefined;
	overflowY = "";

	invalidate() {
		this.dirty = true;
	}

	setup(viewer: CodeViewLocalManagerContext<LAnnotation, Caret>) {
		this.viewer = viewer;
		const host = this.host = document.createElement("style");
		host.dataset.overviewRuler = "";
		host.textContent = `
			[data-overview-scrollbar]{scrollbar-width:auto;scrollbar-color:auto}
			[data-overview-scrollbar]::-webkit-scrollbar{width:28px;height:28px}
			[data-overview-scrollbar]::-webkit-scrollbar-track{background:var(--diffs-overview-bg,#f6f8fa) var(--diffs-overview-image,none) center/100% 100% no-repeat}
			[data-overview-scrollbar]::-webkit-scrollbar-thumb{background:var(--diffs-overview-viewport,#80808024);border:0;border-radius:0}
			[data-overview-scrollbar]::-webkit-scrollbar-button{display:none}
			[data-overview-scrollbar]::-webkit-scrollbar-corner{background:var(--diffs-overview-bg,#f6f8fa)}
		`;
		const track = this.track = document.createElementNS(SVG_NS, "svg");
		track.setAttribute("preserveAspectRatio", "none");
		this.paths = ["deletions", "additions", "matches"].map(() => {
			const path = document.createElementNS(SVG_NS, "path");
			track.append(path);
			return path;
		});
		this.overflowY = viewer.root!.style.overflowY;
		viewer.root!.style.overflowY = "scroll";
		viewer.root!.dataset.overviewScrollbar = "";
		viewer.root!.prepend(host);
		// Not inherited: a new image restyles the root and its scrollbar only, not every element in the viewer
		try { CSS.registerProperty({ name: "--diffs-overview-image", syntax: "*", inherits: false, initialValue: "none" }); } catch { /* registered already, or unsupported: the property inherits */ }
	}

	sync(viewer: CodeViewLocalManagerContext<LAnnotation, Caret>) {
		if (!viewer.root || !viewer.options.overviewRuler) {
			this.cleanUp();
			return;
		}
		if (!this.host) this.setup(viewer);
	}

	// search: the open search's match rows per item, and a version that changes with them. They are a third, yellow path.
	update(viewer: CodeViewLocalManagerContext<LAnnotation, Caret>, search?: { version: number; keys(id: string): ReadonlySet<string> | undefined }) {
		this.sync(viewer);
		if (!this.host) return;
		const height = viewer.getHeight();
		if (this.dirty || height !== this.height) {
			this.dirty = true;
			this.height = height;
		}
		const scroll = viewer.getScrollTop();
		const boundary = scroll + viewer.getStickyHeaderOffset();
		const record = viewer.items.findLast(record => viewer.getItemTopOffset() + record.top <= boundary) ?? viewer.items[0];
		if (!record || record.type !== "diff" || record.item.collapsed) {
			this.clear();
			return;
		}
		const extent = viewer.getScrollHeight();
		const layout = this.dirty || record.item.id !== this.fileId || extent !== this.extent, matches = search != null && search.version !== this.searchVersion;
		if (!layout && !matches) return;
		const root = viewer.root!, trackHeight = root.clientHeight, scrollHeight = root.scrollHeight, fileTop = viewer.getItemTopOffset() + record.top;
		const tolerance = trackHeight > 0 ? scrollHeight / trackHeight : 0;  // the content height of one track pixel: smaller moves are not drawn
		const regions = record.instance.getOverviewRulerRegions(tolerance);
		if (regions == null || height <= 0 || extent <= 0) {
			this.clear();
			return;
		}
		const span = (top: number, height: number): [number, number] => {
			const y = Math.min(trackHeight - 2, Math.floor((fileTop + top) * trackHeight / scrollHeight));
			return [y, Math.min(trackHeight, Math.max(y + 2, Math.ceil((fileTop + top + height) * trackHeight / scrollHeight)))];
		};
		if (layout) {
			this.track!.setAttribute("viewBox", `0 0 28 ${trackHeight}`);
			this.fileId = record.item.id;
			this.host!.dataset.fileId = this.fileId;
			this.extent = extent;
			const bands: [number, number][][] = [[], []];
			for (const region of regions) {
				const side = region.side === "deletions" ? 0 : 1;
				const [y, end] = span(region.top, region.height);
				const previous = bands[side].at(-1);
				if (previous && y <= previous[1]) previous[1] = Math.max(previous[1], end);
				else bands[side].push([y, end]);
			}
			const edges = bands.flatMap((bands, side) => bands.flatMap(([top, bottom]) => [{ y: top, side, change: 1 }, { y: bottom, side, change: -1 }])).sort((a, b) => a.y - b.y);
			const active = [0, 0], paths = ["", ""];
			let top = 0;
			for (const edge of edges) {
				if (edge.y > top) for (let side = 0; side < 2; side++) {
					if (!active[side]) continue;
					const width = active[1 - side] ? 14 : 28, x = active[1 - side] ? side * 14 : 0;
					paths[side] += `M${x} ${top}h${width}v${edge.y - top}h-${width}z`;
				}
				active[edge.side] += edge.change;
				top = edge.y;
			}
			this.paths![0].setAttribute("d", paths[0]);
			this.paths![1].setAttribute("d", paths[1]);
			this.dirty = false;
		}
		const keys = search?.keys(record.item.id);
		this.searchVersion = search?.version;
		this.paths![2].setAttribute("d", keys?.size ? record.instance.getOverviewRulerMarks(keys, tolerance).map(mark => { const [y, end] = span(mark.top, mark.height); return `M0 ${y}h8v${end - y}h-8z`; }).join("") : "");
		const style = getComputedStyle(root), theme = record.element ? getComputedStyle(record.element) : style;
		this.track!.style.colorScheme = theme.colorScheme;
		this.paths![0].style.fill = style.getPropertyValue("--diffs-overview-deletion") || theme.getPropertyValue("--diffs-bg-deletion") || "#ffebe9";
		this.paths![1].style.fill = style.getPropertyValue("--diffs-overview-addition") || theme.getPropertyValue("--diffs-bg-addition") || "#dafbe1";
		this.paths![2].style.fill = style.getPropertyValue("--diffs-overview-match") || "#ffd33d";
		const image = `url("data:image/svg+xml,${encodeURIComponent(new XMLSerializer().serializeToString(this.track!))}")`;
		if (image === this.image) return;  // the same picture: the browser keeps its decoded image
		this.image = image;
		root.style.setProperty("--diffs-overview-image", image);
	}

	private clear() {
		this.viewer?.root?.style.removeProperty("--diffs-overview-image");
		this.image = undefined;
		this.fileId = undefined;
		this.dirty = true;
		if (this.host) delete this.host.dataset.fileId;
	}

	cleanUp() {
		this.clear();
		this.host?.remove();
		const root = this.viewer?.root;
		if (root) {
			root.style.overflowY = this.overflowY;
			delete root.dataset.overviewScrollbar;
		}
		this.host = undefined;
		this.track = undefined;
		this.paths = undefined;
		this.viewer = undefined;
	}
}
