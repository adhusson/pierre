import type { CodeView } from '../components/CodeView';
import { SearchPanelWidget, type MatchRange } from '../editor/searchPanel';
import { TextDocument } from '../editor/textDocument';
import { createSpriteElement } from '../editor/sprite';
import type { CodeViewItem, SelectionSide } from '../types';
import { iterateOverDiff } from '../utils/iterateOverDiff';

let nextId = 0;
type Line = { id: string; side: SelectionSide; lineNumber: number };
// An item to search, with the load of its contents when its diff is partial (CodeView.getSearchItems).
export type SearchItem<LAnnotation> = { item: CodeViewItem<LAnnotation>; loading?: Promise<void> };

export class CodeViewSearch<LAnnotation, Caret> {
  private name = `diffs-search-${nextId++}`;
  private panel?: SearchPanelWidget;
  private host?: HTMLElement;
  private document?: TextDocument;
  private lines: Line[] = [];
  private rowIndexes = new Map<string, Map<string, number>>();
  private matches = new Map<number, MatchRange[]>();
  private current?: MatchRange;
  private highlights = new Highlight();
  private activeHighlight = new Highlight();
  private styles = new Set<HTMLStyleElement>();
  private reveal = false;
  private loads = new Set<string>();  // items whose load this panel waited for: a load that failed is not asked again
  version = 0;  // changes with the matches: the overview ruler repaints its marks
  private markKeys = new Map<string, Set<string>>();  // item id -> "side:lineNumber" of its matched rows
  private pointerInPanel = false;

  constructor(private viewer: CodeView<LAnnotation, Caret>) {}

  open(root: HTMLElement) {
    if (this.panel) { this.panel.focus(); return; }
    const entries = this.viewer.getSearchItems();
    this.document = new TextDocument('file:///diff-search', this.index(entries));
    const host = this.host = document.createElement('div');
    host.dataset.codeSearch = '';
    host.style.cssText = 'position:sticky;top:0;height:0;z-index:10';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>
      :host{font:13px/20px system-ui;color:var(--diffs-fg,#222)}
      [data-search-panel]{position:absolute;right:32px;top:4px;padding:6px;background:var(--diffs-bg,#fff);border:1px solid #8888;border-radius:6px;box-shadow:0 3px 10px #0002}
      [data-search-grid],[data-search-nav],[data-input-box]{display:flex;align-items:center;gap:4px}
      [data-input-box]{position:relative}[data-search-toggles]{display:flex;position:absolute;right:3px}
      input{box-sizing:border-box;width:280px;max-width:45vw;padding:4px 76px 4px 6px;border:1px solid #8888;border-radius:3px;background:transparent;color:inherit;font:inherit}
      button{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:3px;border:0;border-radius:3px;background:transparent;color:inherit;cursor:pointer}
      button:hover,button[aria-pressed=true]{background:#8883}button:disabled{opacity:.35;cursor:default}svg{width:16px;height:16px;fill:currentColor}
      [data-matches]{white-space:nowrap;font-size:12px}[data-no-matches]{color:#c33}[data-replace-cell]{display:none}
    </style><span></span>`;
    shadow.prepend(createSpriteElement());
    host.addEventListener('keydown', event => event.stopPropagation());
    host.addEventListener('pointerdown', event => { event.stopPropagation(); this.pointerInPanel = true; setTimeout(() => this.pointerInPanel = false); });
    root.prepend(host);
    CSS.highlights.set(this.name, this.highlights);
    CSS.highlights.set(`${this.name}-active`, this.activeHighlight);
    this.activeHighlight.priority = 1;
    this.panel = new SearchPanelWidget({
      textDocument: this.document, containerElement: shadow.querySelector('span')!, defaultQuery: '',
      scrollToMatch: match => this.goTo(match),
      onUpdate: (matches, options) => {
        this.matches.clear(); this.markKeys.clear(); this.version++;
        for (const match of matches) {
          const line = this.document!.positionAt(match[0]).line;
          const found = this.matches.get(line) ?? [];
          found.push(match); this.matches.set(line, found);
          const row = this.lines[line], keys = this.markKeys.get(row.id) ?? new Set<string>();
          keys.add(`${row.side}:${row.lineNumber}`); this.markKeys.set(row.id, keys);
        }
        this.current = undefined;
        if (matches[0] && options?.syncSelection !== false) { this.goTo(matches[0]); return matches[0]; }
        this.paint(); this.viewer.render();  // the ruler's marks, on the next frame
        return undefined;  // "N results": the next navigation goes to the first match
      },
      onClose: () => { this.cleanUp(); this.viewer.render(); root.focus({ preventScroll: true }); },
    });
    // Vimium blurs a field on Escape and swallows the key (see the palette in the app): focus lost to nothing closes the search
    // The field also blurs while the panel removes itself, before the removal completes: after it, the panel is gone.
    shadow.querySelector('input')!.addEventListener('blur', event => { if (!event.relatedTarget && !this.pointerInPanel) queueMicrotask(() => this.panel?.close()); });
    this.awaitLoads(entries, true);
  }

  // Index the items again, with the same query: after setItems, and when the contents of a partial diff have arrived.
  // jump: go to the first match. After setItems the app's own position for the new item stays, and Enter goes to the first match.
  refresh(jump = true) {
    if (!this.panel || !this.document) return;
    this.viewer.render(true);  // a new item gets its diff at layout; loaded contents reach the item's diff there too
    const entries = this.viewer.getSearchItems();
    this.document.applyResolvedEdits([{ start: 0, end: this.document.getText().length, text: this.index(entries) }], false);
    this.panel.updateMatches(jump ? undefined : { syncSelection: false });
    this.awaitLoads(entries, jump);
  }

  // -> the search text: one line per row of the unified diff, in order. this.lines and this.rowIndexes map the rows back.
  private index(entries: SearchItem<LAnnotation>[]): string {
    const text: string[] = [];
    this.lines = []; this.rowIndexes.clear();
    for (const { item } of entries) {
      const indexes = new Map<string, number>();
      this.rowIndexes.set(item.id, indexes);
      const add = (side: SelectionSide, lineNumber: number, contents: string, other?: number) => {
        indexes.set(`${side}:${lineNumber}`, this.lines.length);
        if (other != null) indexes.set(`deletions:${other}`, this.lines.length);
        this.lines.push({ id: item.id, side, lineNumber });
        text.push(contents.endsWith('\n') ? contents : contents + '\n');
      };
      if (item.type === 'file') {
        item.file.contents.split(/\r?\n/).forEach((line, i) => add('additions', i + 1, line));
      } else {
        iterateOverDiff({ diff: item.fileDiff, diffStyle: 'unified', expandedHunks: true, callback: ({ type, additionLine, deletionLine }) => {
          if (additionLine) add('additions', additionLine.lineNumber, item.fileDiff.additionLines[additionLine.lineIndex], type !== 'change' ? deletionLine?.lineNumber : undefined);
          else if (deletionLine) add('deletions', deletionLine.lineNumber, item.fileDiff.deletionLines[deletionLine.lineIndex]);
        } });
      }
    }
    return text.join('');
  }

  private awaitLoads(entries: SearchItem<LAnnotation>[], jump: boolean) {
    const loading: Promise<void>[] = [];
    for (const { item, loading: load } of entries) if (load && !this.loads.has(item.id)) { this.loads.add(item.id); loading.push(load); }
    if (loading.length) Promise.allSettled(loading).then(() => this.refresh(jump));
  }

  keys(id: string): ReadonlySet<string> | undefined { return this.markKeys.get(id); }

  private goTo(match: MatchRange) {
    this.current = match;
    this.reveal = true;
    const line = this.lines[this.document!.positionAt(match[0]).line];
    if (line.side === 'additions' && this.viewer.revealLine(line.id, line.lineNumber)) this.viewer.render(true);  // the expansion takes effect at layout, before the scroll target is resolved
    this.viewer.scrollTo({ type: 'line', ...line, align: 'center', behavior: 'instant' });
    this.viewer.render(true);
  }

  paint() {
    if (!this.panel || !this.document) return;
    this.highlights.clear(); this.activeHighlight.clear();
    for (const style of this.styles) if (!style.isConnected) { style.remove(); this.styles.delete(style); }
    const rendered = this.viewer.getRenderedItems();
    if (rendered[0]) {
      const theme = getComputedStyle(rendered[0].element);
      for (const name of ['--diffs-bg', '--diffs-fg']) this.host!.style.setProperty(name, theme.getPropertyValue(name));
      this.host!.style.colorScheme = theme.colorScheme;
    }
    for (const { id, element } of rendered) {
      const shadow = element.shadowRoot, indexes = this.rowIndexes.get(id);
      if (!shadow || !indexes) continue;
      if (!shadow.querySelector(`[data-search-style="${this.name}"]`)) {
        const style = document.createElement('style'); style.dataset.searchStyle = this.name;
        style.textContent = `::highlight(${this.name}){background:var(--diffs-editor-match-highlight-bg,#ff963266)}::highlight(${this.name}-active){background:var(--diffs-editor-match-bg,#ffc04d);color:#111}`;
        shadow.append(style); this.styles.add(style);
      }
      for (const node of shadow.querySelectorAll<HTMLElement>('[data-line]')) {
        const side = node.closest('[data-deletions]') || node.dataset.lineType === 'change-deletion' ? 'deletions' : 'additions';
        const index = indexes.get(`${side}:${node.dataset.line}`);
        if (index == null) continue;
        for (const match of this.matches.get(index) ?? []) {
          const start = this.document.positionAt(match[0]).character;
          const end = start + match[1] - match[0], range = document.createRange();
          const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
          let offset = 0, started = false;
          for (let text = walker.nextNode(); text; text = walker.nextNode()) {
            const length = text.textContent!.length;
            if (!started && start < offset + length) { range.setStart(text, start - offset); started = true; }
            if (started && end <= offset + length) { range.setEnd(text, end - offset); break; }
            offset += length;
          }
          if (!started || range.collapsed) continue;
          const active = match === this.current;
          (active ? this.activeHighlight : this.highlights).add(range);
          if (active && this.reveal) {
            const code = node.closest<HTMLElement>('[data-code]')!;
            const rect = range.getBoundingClientRect(), bounds = code.getBoundingClientRect();
            code.scrollLeft += rect.left < bounds.left ? rect.left - bounds.left : Math.max(0, rect.right - bounds.right);
            this.reveal = false;
          }
        }
      }
    }
  }

  cleanUp() {
    this.panel?.cleanup(); this.panel = undefined;
    this.host?.remove(); this.host = undefined;
    this.document = undefined; this.lines = []; this.rowIndexes.clear(); this.matches.clear(); this.loads.clear(); this.markKeys.clear(); this.version++;
    this.current = undefined; this.highlights.clear(); this.activeHighlight.clear();
    CSS.highlights.delete(this.name); CSS.highlights.delete(`${this.name}-active`);
    for (const style of this.styles) style.remove();
    this.styles.clear();
  }
}
