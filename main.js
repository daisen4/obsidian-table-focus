'use strict';
const {Plugin, Modal, MarkdownRenderChild, PluginSettingTab, Setting, Notice, MarkdownView, MarkdownRenderer, Component} = require('obsidian');

// 純粋な計算。ノート・DOM・設定ファイルには触れない。
const DEFAULTS = Object.freeze({frozenRows:1, frozenColumns:2, maxHeightVh:70, zebra:false, fullscreenButton:true, highlights:[], boundedColumns:false, columnMinEm:6, columnMaxEm:22, widthMode:'natural'});
const BAR_HEIGHT = 36;
const HIGHLIGHT_COLORS = Object.freeze(['red','yellow','green','blue']);
const HIGHLIGHT_LIMIT = 3, HIGHLIGHT_TEXT_MAX = 20;
// 強調規則の丸め。不正な組は捨て、保存するのは既知のキー（text・color）だけ。
function normalizeHighlights(value) {
 const result = [];
 if (!Array.isArray(value)) return result;
 for (const item of value) {
  if (result.length >= HIGHLIGHT_LIMIT) break;
  if (!item || typeof item !== 'object' || typeof item.text !== 'string' || !HIGHLIGHT_COLORS.includes(item.color)) continue;
  const text = item.text.trim();
  if (text.length > 0 && text.length <= HIGHLIGHT_TEXT_MAX) result.push({text, color:item.color});
 }
 return result;
}
// セルの文字に含まれる最初の規則の色を返す。当たらなければnull。
function matchHighlight(text, rules) {
 if (typeof text !== 'string') return null;
 for (const rule of rules) if (rule.text && text.includes(rule.text)) return rule.color;
 return null;
}
const WIDTH_MODES = Object.freeze(['natural','fit','ratio']);
function normalizeSettings(input) {
 const data = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
 const result = {};
 for (const [key, fallback] of Object.entries(DEFAULTS)) {
  const value = data[key];
  if (key === 'highlights') result[key] = normalizeHighlights(value);
  else if (key === 'widthMode') result[key] = WIDTH_MODES.includes(value) ? value : fallback;
  else if (typeof fallback === 'boolean') result[key] = typeof value === 'boolean' ? value : fallback;
  else {
   const [min,max] = ({maxHeightVh:[30,95],columnMinEm:[2,12],columnMaxEm:[4,40]})[key] ?? [0,5];
   result[key] = Number.isInteger(value) && value >= min && value <= max ? value : fallback;
  }
 }
 if (result.columnMinEm > result.columnMaxEm) { result.columnMinEm = DEFAULTS.columnMinEm; result.columnMaxEm = DEFAULTS.columnMaxEm; }
 return result;
}
// 文字数の比で列幅を配る（FR-014）。全角は2・半角は1、空欄は平均から除き、重みは最小2。
// 下限・上限に当たった列を固定して残りを再配分する。幅は切り捨てた整数pxで、合計は枠を超えない。
function ratioWidths(rows, boxWidth, minPx, maxPx) {
 const count = rows[0]?.length ?? 0;
 const length = text => Array.from(String(text ?? '')).reduce((sum,ch) => sum + (ch.charCodeAt(0) > 0xff ? 2 : 1), 0);
 const weights = Array.from({length:count},(_,c) => {
  const lengths = rows.map(row => length(row[c])).filter(n => n > 0);
  return Math.max(2,lengths.length ? lengths.reduce((a,b) => a + b,0) / lengths.length : 0);
 });
 const widths = new Array(count).fill(0), fixed = new Array(count).fill(false);
 let remain = Math.max(boxWidth,minPx * count);
 for (let pass = 0; pass < count + 1; pass++) {
  const free = weights.map((_,c) => c).filter(c => !fixed[c]);
  if (!free.length) break;
  const sum = free.reduce((total,c) => total + weights[c],0);
  const shares = free.map(c => remain * weights[c] / sum);
  const violators = free.filter((c,i) => shares[i] < minPx || shares[i] > maxPx);
  if (!violators.length) { free.forEach((c,i) => { widths[c] = shares[i]; }); break; }
  for (const c of violators) { widths[c] = Math.min(maxPx,Math.max(minPx,remain * weights[c] / sum)); fixed[c] = true; remain -= widths[c]; }
 }
 return widths.map(width => Math.floor(width + 1e-9));
}
// 編集中の文書の行から、カーソル行を含むMarkdown表の範囲{start,end}（両端を含む）を返す。なければnull（FR-015）。
// 表は「見出し行→区切り行→連続する|を含む本文行」。フロントマター・コードブロックの中、引用・箇条書き・字下げの表は対象外。
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const NESTED_LINE = /^(\s*([>*+-]|\d+[.)])\s|\t| {4})/;
function findTableAtLine(lines, index) {
 if (!Array.isArray(lines) || !Number.isInteger(index) || index < 0 || index >= lines.length) return null;
 let i = 0;
 if (lines[0]?.trim() === '---') {
  const close = lines.findIndex((line,n) => n > 0 && line.trim() === '---');
  if (close > 0) i = close + 1;
 }
 const hasPipe = line => typeof line === 'string' && line.includes('|');
 while (i <= index) {
  const line = String(lines[i]);
  const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  if (fence) {
   const mark = fence[1], closing = new RegExp(`^ {0,3}\\${mark[0]}{${mark.length},}\\s*$`);
   let end = i + 1;
   while (end < lines.length && !closing.test(lines[end])) end++;
   if (index <= end) return null;
   i = end + 1; continue;
  }
  if (hasPipe(line) && !NESTED_LINE.test(line) && hasPipe(lines[i + 1]) && TABLE_DELIMITER.test(lines[i + 1]) && !NESTED_LINE.test(lines[i + 1])) {
   let end = i + 1;
   while (end + 1 < lines.length && lines[end + 1].trim() !== '' && hasPipe(lines[end + 1])) end++;
   if (index <= end) return {start:i,end};
   i = end + 1; continue;
  }
  i++;
 }
 return null;
}
function needsFocus(width, height, boxWidth, maxHeight) {
 return [width,height,boxWidth,maxHeight].every(n => Number.isFinite(n) && n > 0)
  && (width > boxWidth || height > maxHeight);
}
function offsets(heights, widths, rowCount, columnCount, barHeight) {
 const prefix = (sizes, count, start) => {
  const result = []; let position = start;
  for (const size of sizes.slice(0, count)) { result.push(position); position += size; }
  return result;
 };
 return {tops:prefix(heights,rowCount,barHeight), lefts:prefix(widths,columnCount,0)};
}
// DOMへの適用。変更前の値を保管し、自分が加えた装飾だけ戻す。
class Decorations {
 constructor() { this.entries = new Map(); }
 entry(el) {
  if (!this.entries.has(el)) this.entries.set(el,{classes:new Map(),styles:new Map()});
  return this.entries.get(el);
 }
 class(el,name,enabled) {
  const record = this.entry(el);
  if (!record.classes.has(name)) record.classes.set(name,el.classList.contains(name));
  const wanted = enabled || record.classes.get(name);
  if (el.classList.contains(name) !== wanted) el.classList[wanted ? 'add' : 'remove'](name);
 }
 style(el,name,value) {
  const record = this.entry(el);
  if (!record.styles.has(name)) record.styles.set(name,{value:el.style.getPropertyValue(name),priority:el.style.getPropertyPriority(name)});
  const original = record.styles.get(name);
  const wanted = value === null ? original.value : value;
  const priority = value === null ? original.priority : '';
  if (el.style.getPropertyValue(name) === wanted && el.style.getPropertyPriority(name) === priority) return;
  if (wanted) el.style.setProperty(name,wanted,priority); else el.style.removeProperty(name);
 }
 clear() {
  for (const [el,record] of this.entries) {
   for (const [name,present] of record.classes) {
    if (el.classList.contains(name) !== present) el.classList[present ? 'add' : 'remove'](name);
   }
   for (const [name,original] of record.styles) {
    if (original.value) el.style.setProperty(name,original.value,original.priority); else el.style.removeProperty(name);
   }
  }
  this.entries.clear();
 }
}
function readingBox(table) {
 const box = table.parentElement;
 if (!box?.classList.contains('el-table') || !box.closest('.markdown-reading-view')) return null;
 for (const selector of ['.markdown-source-view','.markdown-embed','.popover','.canvas-node','.block-language-dataview','.block-language-dataviewjs','.bases-view']) {
  if (table.closest(selector)) return null;
 }
 return box;
}
function simpleRows(table) {
 const rows = Array.from(table.rows);
 const count = rows[0]?.cells.length;
 if (!count || rows.some(row => row.cells.length !== count || Array.from(row.cells).some(cell => (cell.rowSpan ?? 1) !== 1 || (cell.colSpan ?? 1) !== 1))) return null;
 return rows;
}
class TableController {
 constructor(owner,table,modal = false) {
  this.owner = owner; this.table = table; this.modal = modal;
  this.win = table.ownerDocument.defaultView; this.decorations = new Decorations();
  this.frame = null; this.attempts = 0; this.disposed = false; this.box = null; this.bar = null; this.query = '';
  this.changed = () => { this.attempts = 0; this.schedule(); };
  this.observer = new this.win.ResizeObserver(this.changed);
  this.observer.observe(table); this.win.addEventListener('resize',this.changed);
  this.schedule();
 }
 schedule() {
  if (this.disposed || this.frame !== null) return;
  this.frame = this.win.requestAnimationFrame(() => {
   this.frame = null;
   const ready = this.update();
   if (!ready && ++this.attempts < 120) this.schedule();
  });
 }
 clear() {
  this.bar?.remove(); this.bar = null; this.decorations.clear(); this.widthKey = null; this.naturalRect = null; this.widthRect = null;
 }
 // 幅はクラスとCSS変数だけで指定し、設定オフでは元の値へ戻す。
 resetWidths(rows) {
  const d = this.decorations;
  d.class(this.table,'tf-widths',false); d.class(this.table,'tf-widths-locked',false);
  d.class(this.table,'tf-fit',false);
  for (const name of ['--tf-table-width','--tf-min-width','--tf-max-width','--tf-box-width']) d.style(this.table,name,null);
  for (const row of rows) for (const cell of row.cells) d.style(cell,'--tf-col-width',null);
 }
 measureWidths(rows,box,maxHeight) {
  const table = this.table, d = this.decorations, settings = this.owner.settings;
  const font = parseFloat(this.win.getComputedStyle(table).fontSize) || 16;
  // 検索はキーに含めない。全行の内容・枠幅・文字サイズ・設定が変わったときだけ測る。
  const key = JSON.stringify([box.clientWidth,this.win.innerHeight,font,settings.columnMinEm,settings.columnMaxEm,settings.widthMode,
   rows.map(row => Array.from(row.cells,cell => cell.textContent))]);
  const current = table.getBoundingClientRect();
  if (key === this.widthKey && this.widthRect && Math.abs(current.width-this.widthRect.width)<0.5 && Math.abs(current.height-this.widthRect.height)<0.5) return this.naturalRect;
  this.widthKey = null; this.naturalRect = null; this.widthRect = null;
  this.resetWidths(rows);
  for (const row of rows) d.class(row,'tf-filtered-out',false);
  const rect = table.getBoundingClientRect();
  if (!this.modal && !needsFocus(rect.width,rect.height,box.clientWidth,maxHeight)) return rect;
  d.class(table,'tf-table',true);
  d.style(table,'--tf-min-width',`${settings.columnMinEm * font}px`);
  d.style(table,'--tf-max-width',`${settings.columnMaxEm * font}px`);
  const minPx = settings.columnMinEm * font, maxPx = settings.columnMaxEm * font;
  let widths;
  if (settings.widthMode === 'ratio') {
   // Cは文字数だけから幅を決める。測定は不要で、検索で行を隠しても全行から計算するので変わらない。
   widths = ratioWidths(rows.map(row => Array.from(row.cells,cell => cell.textContent)),box.clientWidth,minPx,maxPx);
   d.class(table,'tf-widths',true);
  } else {
   // Bの枠幅に収める指定は測定中だけ効く（固定後は実測の列幅をそのまま使う）。
   d.class(table,'tf-fit',settings.widthMode === 'fit');
   if (settings.widthMode === 'fit') d.style(table,'--tf-box-width',`${box.clientWidth}px`);
   d.class(table,'tf-widths',true);
   widths = Array.from(rows[0].cells,cell => Math.max(minPx,Math.min(maxPx,cell.getBoundingClientRect().width)));
  }
  for (const row of rows) Array.from(row.cells).forEach((cell,c) => d.style(cell,'--tf-col-width',`${widths[c]}px`));
  d.style(table,'--tf-table-width',`${widths.reduce((sum,width) => sum + width,0)}px`);
  d.class(table,'tf-widths-locked',true);
  this.widthKey = key; this.naturalRect = {width:rect.width,height:rect.height};
  return this.naturalRect;
 }
 update() {
  if (this.disposed) return true;
  const table = this.table;
  if (!table.isConnected) { this.clear(); return false; }
  const box = this.modal ? table.parentElement : readingBox(table);
  if (box !== this.box) {
   this.clear();
   if (this.box) this.observer.unobserve(this.box);
   this.box = box;
   if (box) this.observer.observe(box);
  }
  if (!box) { this.clear(); return true; }
  const rows = simpleRows(table);
  const settings = this.owner.settings;
  const maxHeight = this.modal ? this.win.innerHeight - 24 : this.win.innerHeight * settings.maxHeightVh / 100;
  if (!rows) { this.clear(); return true; }
  if (!settings.boundedColumns && this.widthKey) { this.resetWidths(rows); this.widthKey = null; this.naturalRect = null; this.widthRect = null; }
  const rect = settings.boundedColumns ? this.measureWidths(rows,box,maxHeight) : table.getBoundingClientRect();
  if (!this.modal && !this.query.trim() && !rows.some(row => row.classList.contains('tf-filtered-out')) && !needsFocus(rect.width,rect.height,box.clientWidth,maxHeight)) { this.clear(); return rect.width > 0 && rect.height > 0; }
  const d = this.decorations;
  d.class(box,'tf-box',true); d.style(box,'--tf-max-height',`${maxHeight}px`);
  d.class(table,'tf-table',true); d.class(table,'tf-zebra',settings.zebra);
  // バーは.el-tableの内側にだけ作る。描画途中の外側へは置かない。
  if (!this.bar) {
   const doc = table.ownerDocument;
   this.bar = doc.createElement('div'); this.bar.classList.add('tf-bar');
   this.button = doc.createElement('button'); this.button.type = 'button';
   this.button.textContent = this.modal ? 'Close (Esc)' : 'Full screen';
   this.button.addEventListener('click',() => this.modal ? this.modal.close() : this.owner.openTable(table));
   const input = doc.createElement('input'); input.type = 'search'; input.classList.add('tf-search');
   input.placeholder = 'Search in table'; input.setAttribute('aria-label','Search in table'); input.value = this.query;
   input.addEventListener('input',() => { this.query = input.value; box.scrollTop = 0; this.changed(); });
   this.count = doc.createElement('span'); this.count.setAttribute('role','status');
   this.count.setAttribute('aria-live','polite'); this.count.classList.add('tf-search-count');
   this.bar.append(this.button,input,this.count);
   if (this.modal) {
    const message = doc.createElement('span'); message.textContent = 'Shown as of when it was opened. Close and reopen to refresh.';
    this.bar.append(message);
   }
   box.insertBefore(this.bar,table);
  }
  if (!this.modal && !settings.fullscreenButton) this.button.remove();
  else if (!this.button.parentElement) this.bar.insertBefore(this.button,this.bar.children[0]);
  const query = this.query.trim().toLowerCase();
  let total = 0, matched = 0;
  const heights = rows.map(row => {
   const body = Array.from(row.cells).some(cell => cell.tagName === 'TD');
   const visible = !body || !query || Array.from(row.cells).some(cell => cell.textContent.toLowerCase().includes(query));
   d.class(row,'tf-filtered-out',!visible);
   if (body) { total++; if (visible) matched++; }
   return visible ? row.getBoundingClientRect().height : 0;
  });
  const countText = `${matched} / ${total} rows`;
  if (this.count.textContent !== countText) this.count.textContent = countText;
  const widths = Array.from(rows[0].cells,cell => cell.getBoundingClientRect().width);
  const positions = offsets(heights,widths,settings.frozenRows,settings.frozenColumns,this.bar ? BAR_HEIGHT : 0);
  rows.forEach((row,r) => Array.from(row.cells).forEach((cell,c) => {
   d.class(cell,'tf-fz-r',r < positions.tops.length); d.class(cell,'tf-fz-c',c < positions.lefts.length);
   // 強調は本文のセルだけ（見出しのthは対象外）。色が変わったら前の色を外し、残さない。
   const wanted = cell.tagName === 'TD' ? matchHighlight(cell.textContent,settings.highlights) : null;
   const current = HIGHLIGHT_COLORS.find(color => cell.classList.contains(`tf-hl-${color}`)) ?? null;
   if (current !== wanted) {
    if (current) d.class(cell,`tf-hl-${current}`,false);
    if (wanted) d.class(cell,`tf-hl-${wanted}`,true);
   }
   d.style(cell,'--tf-top',r < positions.tops.length ? `${positions.tops[r]}px` : null);
   d.style(cell,'--tf-left',c < positions.lefts.length ? `${positions.lefts[c]}px` : null);
  }));
  if (settings.boundedColumns) { const bounds = table.getBoundingClientRect(); this.widthRect = {width:bounds.width,height:bounds.height}; }
  return true;
 }
 dispose() {
  if (this.disposed) return;
  this.disposed = true;
  if (this.frame !== null) this.win.cancelAnimationFrame(this.frame);
  this.frame = null; this.observer.disconnect(); this.win.removeEventListener('resize',this.changed); this.clear();
 }
}
function cleanClone(table) {
 // コピーに付いてきた装飾を取り除き、新しい実測位置だけを付け直す。
 const visit = el => {
  for (const name of Array.from(el.classList)) if (name.startsWith('tf-')) el.classList.remove(name);
  for (const name of Array.from(el.style)) if (name.startsWith('--tf-')) el.style.removeProperty(name);
  el.removeAttribute('id');
  for (const child of el.children) visit(child);
 };
 visit(table); return table;
}
class TableModal extends Modal {
 constructor(owner,table) {
  super(owner.app); this.owner = owner; this.table = table;
  this.opener = table.ownerDocument.activeElement;
 }
 onOpen() {
  const doc = this.contentEl.ownerDocument;
  this.modalEl.classList.add('tf-modal'); this.contentEl.replaceChildren();
  const preview = doc.createElement('div'); preview.classList.add('markdown-preview-view','markdown-rendered','tf-preview');
  const box = doc.createElement('div'); box.classList.add('el-table');
  const clone = cleanClone(this.table.cloneNode(true));
  box.append(clone); preview.append(box); this.contentEl.append(preview);
  this.controller = new TableController(this.owner,clone,this);
  this.controller.query = this.owner.controllers.get(this.table)?.query ?? '';
  this.onKey = event => {
   if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.close(); }
  };
  this.contentEl.addEventListener('keydown',this.onKey);
  // Modalの接続後なので、バーはここで作れる。後続の寸法変化はobserverで測り直す。
  this.controller.update(); this.controller.bar?.querySelectorAll('button')[0]?.focus();
 }
 onClose() {
  this.controller?.dispose(); this.contentEl.removeEventListener('keydown',this.onKey);
  this.contentEl.replaceChildren();
  if (this.owner.activeModal === this) this.owner.activeModal = null;
  if (this.opener?.isConnected) this.opener.focus({preventScroll:true});
 }
}
class TableChild extends MarkdownRenderChild {
 constructor(el,owner,table) { super(el); this.owner = owner; this.table = table; }
 onunload() { this.owner.removeTable(this.table); }
}
class TableFocusSettings extends PluginSettingTab {
 constructor(owner) { super(owner.app,owner); this.owner = owner; }
 display() {
  this.containerEl.replaceChildren();
  const owner = this.owner;
  const change = (key,value) => owner.updateSettings({[key]:value}).catch(() => {
   new Notice('Table Focus: Could not save the settings. Change a setting and try again.');
  });
  for (const [key,name,min,max,description] of [
   ['frozenRows','Frozen rows',0,5,'Number of rows from the top, including the header row. 0 freezes none.'],
   ['frozenColumns','Frozen columns',0,5,'Number of columns from the left. 0 freezes none.'],
   ['maxHeightVh','Maximum frame height (%)',30,95,'Share of the visible area height. Only long tables get a frame.']
  ]) {
   new Setting(this.containerEl).setName(name).setDesc(description).addSlider(slider =>
    slider.setLimits(min,max,1).setValue(owner.settings[key]).setDynamicTooltip().onChange(value => change(key,value)));
  }
  for (const [key,name,description] of [
   ['zebra','Alternate row colors','Colors alternate rows using the theme background color.'],
   ['fullscreenButton','Full screen button','Shows "Full screen" at the top left of the scroll frame.']
  ]) {
   new Setting(this.containerEl).setName(name).setDesc(description).addToggle(toggle =>
    toggle.setValue(owner.settings[key]).onChange(value => change(key,value)));
  }
  // 強調ルール: 固定3枠。文字が空の枠は使わない。変更のたびに全枠を保存し直す（空・不正は丸めで捨てる）。
  const drafts = Array.from({length:HIGHLIGHT_LIMIT},(_,i) => ({
   text:owner.settings.highlights[i]?.text ?? '', color:owner.settings.highlights[i]?.color ?? HIGHLIGHT_COLORS[0]
  }));
  const saveRules = () => change('highlights',drafts.map(draft => ({text:draft.text,color:draft.color})));
  drafts.forEach((draft,i) => {
   new Setting(this.containerEl).setName(`Highlight rule ${i + 1}`)
    .setDesc('Colors only the body cells that contain this text. An empty rule is not used. Header cells are not affected.')
    .addText(text => text.setPlaceholder('e.g. ×').setValue(draft.text).onChange(value => { draft.text = value; return saveRules(); }))
    .addDropdown(menu => menu.addOptions({red:'Red',yellow:'Yellow',green:'Green',blue:'Blue'}).setValue(draft.color).onChange(value => { draft.color = value; return saveRules(); }));
  });
  new Setting(this.containerEl).setName('Adjust column widths')
   .setDesc('Keeps short columns compact and wraps long text at the maximum width. Turn off to return to automatic widths.')
   .addToggle(toggle => toggle.setValue(owner.settings.boundedColumns).onChange(value => change('boundedColumns',value)));
  new Setting(this.containerEl).setName('Width mode')
   .setDesc('Works only while "Adjust column widths" is on. Fit content: the usual automatic widths. Fit to the frame: fits the whole table to the frame width (the full-screen frame while maximized) and gives more width to columns with longer content. Distribute by text length: splits the frame width by the ratio of each column\'s average text length. Text that does not fit wraps vertically.')
   .addDropdown(menu => menu.addOptions({natural:'Fit content',fit:'Fit to the frame (automatic)',ratio:'Distribute by text length'}).setValue(owner.settings.widthMode).onChange(value => change('widthMode',value)));
  for (const [key,name,desc,min,max] of [
   ['columnMinEm','Minimum column width (em)','Columns never get narrower than this. The width is based on the font size. The default is 6em and the range is 2 to 12.',2,12],
   ['columnMaxEm','Maximum column width (em)','Long text wraps at this width. Lower values make the table narrower and taller. The default is 22em and the range is 4 to 40. If the minimum exceeds the maximum, both return to their defaults.',4,40]
  ]) new Setting(this.containerEl).setName(name).setDesc(desc)
   .addSlider(slider => slider.setLimits(min,max,1).setValue(owner.settings[key]).setDynamicTooltip().onChange(value => change(key,value)));
 }
}
// プラグイン本体。表示とプラグイン設定以外には書き込まない。
class TableFocus extends Plugin {
 async onload() {
  this.controllers = new Map(); this.activeModal = null; this.stopped = false; this.opening = false; this.saveQueue = Promise.resolve();
  try { this.settings = normalizeSettings(await this.loadData()); }
  catch { this.settings = normalizeSettings(); new Notice('Table Focus: Could not load the settings. Showing the defaults.'); }
  if (this.stopped) return;
  this.addSettingTab(new TableFocusSettings(this));
  // 編集モードの入口（FR-015）。通常表示は広げず、押した時だけ全画面を開く。登録なので無効化で消える。
  const activeView = () => this.app.workspace.getActiveViewOfType(MarkdownView);
  const open = view => this.openFromView(view).catch(() => new Notice('Table Focus: Could not display the table.'));
  this.addCommand({id:'open-table-at-cursor', name:'View the table at the cursor in full screen', checkCallback:checking => {
   const view = activeView();
   if (!view || view.getMode() !== 'source') return false;
   if (!checking) open(view);
   return true;
  }});
  this.addRibbonIcon('table','View table in full screen (edit mode)',() => open(activeView()));
  this.registerMarkdownPostProcessor((el,ctx) => {
   if (this.stopped) return;
   const tables = el.tagName === 'TABLE' ? [el] : Array.from(el.querySelectorAll('table'));
   for (const table of tables) {
    if (this.controllers.has(table)) continue;
    this.controllers.set(table,new TableController(this,table));
    ctx.addChild(new TableChild(el,this,table));
   }
  });
 }
 updateSettings(patch) {
  if (this.stopped) return Promise.resolve();
  this.settings = normalizeSettings({...this.settings,...patch});
  for (const controller of this.controllers.values()) controller.changed();
  this.activeModal?.controller.changed();
  const snapshot = {...this.settings};
  this.saveQueue = this.saveQueue.catch(() => {}).then(() => this.saveData(snapshot));
  return this.saveQueue;
 }
 openTable(table) {
  if (this.stopped || this.activeModal || !table.isConnected || !readingBox(table) || !simpleRows(table)) return;
  this.activeModal = new TableModal(this,table); this.activeModal.open();
 }
 // 編集中の文書からカーソルの表を取り出し、閲覧と同じ描画の複製を全画面で開く。文書は読むだけで書かない。
 async openFromView(view) {
  if (this.stopped || this.activeModal || this.opening) return;
  if (!view) { new Notice('Table Focus: Open a note in edit mode, put the cursor in a table, and try again.'); return; }
  if (view.getMode() !== 'source') { new Notice('Table Focus: In reading view, use the "Full screen" button at the top left of the table.'); return; }
  const lines = view.editor.getValue().split('\n');
  const block = findTableAtLine(lines, view.editor.getCursor().line);
  if (!block) { new Notice('Table Focus: The cursor is not in a table. Put the cursor in a table cell or row. Tables inside quotes, lists and code blocks are not supported.'); return; }
  this.opening = true;
  const component = new Component(); component.load();
  let snapshot = null, fixable = true;
  try {
   const host = view.containerEl.ownerDocument.createElement('div');
   await MarkdownRenderer.render(this.app, lines.slice(block.start, block.end + 1).join('\n'), host, view.file?.path ?? '', component);
   const table = host.querySelectorAll('table')[0];
   fixable = !table || simpleRows(table) !== null;
   if (table && fixable) snapshot = cleanClone(table.cloneNode(true));
  } catch { snapshot = null; }
  // 描画に使った部品と一時の表の制御は、複製を取った直後に撤去する。
  finally { component.unload(); this.opening = false; }
  if (this.stopped) return;
  if (!fixable) { new Notice('Table Focus: This table has merged cells or similar, so it cannot be frozen and cannot be opened in full screen.'); return; }
  if (!snapshot) { new Notice('Table Focus: Could not display the table.'); return; }
  this.openSnapshot(snapshot);
 }
 openSnapshot(table) {
  if (this.stopped || this.activeModal) return;
  this.activeModal = new TableModal(this,table); this.activeModal.open();
 }
 removeTable(table) {
  if (this.activeModal?.table === table) this.activeModal.close();
  this.controllers.get(table)?.dispose(); this.controllers.delete(table);
 }
 onunload() {
  this.stopped = true;
  this.activeModal?.close();
  for (const table of this.controllers.keys()) this.removeTable(table);
 }
}
TableFocus.layout = Object.freeze({normalizeSettings,needsFocus,offsets,matchHighlight,ratioWidths,findTableAtLine});
// DOM層を独立して再利用できる。Obsidianの有効化なしで実機の寸法検証にも使う。
TableFocus.Controller = TableController;
module.exports = TableFocus;
