/**
 * Obsidian이 런타임에 HTMLElement.prototype에 더하는 DOM 확장(createEl/createDiv/createSpan/empty/setText/
 * addClass…)을 happy-dom 위에 polyfill한다(평가 P2-6 — UI 섹션 테스트 하니스). UI 코드가 이 확장을 광범위하게
 * 쓰므로(createDiv 293·createEl 200·createSpan 130회 등) 이 모듈을 import해야 섹션 렌더를 jsdom에서 구동할 수 있다.
 *
 * 사용: UI 테스트 파일 상단에 `// @vitest-environment happy-dom` + `import "../harness/obsidianDom";`.
 * (전역 node 환경 테스트에는 영향을 주지 않도록 파일별 환경 + 명시 import로 격리.)
 */

interface DomElInfo {
	cls?: string | string[];
	text?: string;
	attr?: Record<string, string | number | boolean | null>;
	href?: string;
	type?: string;
	value?: string;
	placeholder?: string;
	title?: string;
}

function applyInfo(el: HTMLElement, info?: DomElInfo): void {
	if (!info) return;
	if (info.cls) el.addClass(...(Array.isArray(info.cls) ? info.cls : [info.cls]));
	if (info.text !== undefined) el.setText(info.text);
	if (info.attr) for (const [k, v] of Object.entries(info.attr)) if (v != null) el.setAttribute(k, String(v));
	if (info.href !== undefined) el.setAttribute("href", info.href);
	if (info.type !== undefined) el.setAttribute("type", info.type);
	if (info.value !== undefined) (el as HTMLInputElement).value = info.value;
	if (info.placeholder !== undefined) el.setAttribute("placeholder", info.placeholder);
	if (info.title !== undefined) el.setAttribute("title", info.title);
}

let installed = false;

/** HTMLElement.prototype에 Obsidian 확장을 설치(멱등). happy-dom 환경에서 1회 호출되면 충분. */
export function installObsidianDom(): void {
	if (installed || typeof HTMLElement === "undefined") return;
	installed = true;
	const proto = HTMLElement.prototype as unknown as Record<string, unknown>;

	proto.createEl = function (this: HTMLElement, tag: string, info?: DomElInfo, cb?: (el: HTMLElement) => void): HTMLElement {
		const el = this.ownerDocument.createElement(tag) as HTMLElement;
		this.appendChild(el);
		applyInfo(el, info);
		cb?.(el);
		return el;
	};
	proto.createDiv = function (this: HTMLElement, info?: DomElInfo, cb?: (el: HTMLElement) => void): HTMLElement {
		return (this as unknown as { createEl: (t: string, i?: DomElInfo, c?: (el: HTMLElement) => void) => HTMLElement }).createEl("div", info, cb);
	};
	proto.createSpan = function (this: HTMLElement, info?: DomElInfo, cb?: (el: HTMLElement) => void): HTMLElement {
		return (this as unknown as { createEl: (t: string, i?: DomElInfo, c?: (el: HTMLElement) => void) => HTMLElement }).createEl("span", info, cb);
	};
	proto.empty = function (this: HTMLElement): void {
		while (this.firstChild) this.removeChild(this.firstChild);
	};
	proto.detach = function (this: HTMLElement): void {
		this.parentNode?.removeChild(this);
	};
	proto.setText = function (this: HTMLElement, text: string): void {
		this.textContent = text;
	};
	proto.appendText = function (this: HTMLElement, text: string): void {
		this.appendChild(this.ownerDocument.createTextNode(text));
	};
	proto.addClass = function (this: HTMLElement, ...classes: string[]): void {
		this.classList.add(...classes);
	};
	proto.removeClass = function (this: HTMLElement, ...classes: string[]): void {
		this.classList.remove(...classes);
	};
	proto.toggleClass = function (this: HTMLElement, classes: string | string[], value: boolean): void {
		for (const c of Array.isArray(classes) ? classes : [classes]) this.classList.toggle(c, value);
	};
	proto.setAttr = function (this: HTMLElement, name: string, value: string | number | boolean | null): void {
		if (value === null || value === false) this.removeAttribute(name);
		else this.setAttribute(name, value === true ? "" : String(value));
	};
	proto.show = function (this: HTMLElement): void {
		this.style.display = "";
	};
	proto.hide = function (this: HTMLElement): void {
		this.style.display = "none";
	};
	proto.toggle = function (this: HTMLElement, show: boolean): void {
		this.style.display = show ? "" : "none";
	};
	proto.onClickEvent = function (this: HTMLElement, cb: (ev: MouseEvent) => void): void {
		this.addEventListener("click", cb as EventListener);
	};
}

installObsidianDom();
