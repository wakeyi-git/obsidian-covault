// @vitest-environment happy-dom
// UI 섹션 테스트 하니스(평가 P2-6): Obsidian이 HTMLElement에 더하는 DOM 확장을 happy-dom 위에 polyfill해
// 검증한다. 이 하니스가 동작해야 ChatSection 등 섹션 렌더를 jsdom에서 테스트할 수 있다(후속 증분).
import { describe, it, expect, beforeEach } from "vitest";
import "../harness/obsidianDom";

describe("Obsidian DOM 확장 polyfill (P2-6 하니스)", () => {
	let root: HTMLElement;
	beforeEach(() => {
		root = document.createElement("div");
	});

	it("createEl/createDiv/createSpan는 자식을 만들어 붙이고 그 자식을 반환", () => {
		const div = root.createDiv({ cls: "box" });
		expect(div.tagName).toBe("DIV");
		expect(div.parentElement).toBe(root);
		expect(div.classList.contains("box")).toBe(true);
		const span = div.createSpan({ text: "안녕" });
		expect(span.tagName).toBe("SPAN");
		expect(span.textContent).toBe("안녕");
		const a = div.createEl("a", { href: "https://x", text: "링크" });
		expect(a.getAttribute("href")).toBe("https://x");
	});

	it("info: cls 배열·attr·text·placeholder·value 적용", () => {
		const el = root.createEl("input", { cls: ["a", "b"], attr: { "data-id": "7", "aria-hidden": true }, value: "v", placeholder: "p" });
		expect(el.classList.contains("a") && el.classList.contains("b")).toBe(true);
		expect(el.getAttribute("data-id")).toBe("7");
		expect(el.getAttribute("aria-hidden")).toBe("true"); // attr는 String(v)로 적용
		expect((el as HTMLInputElement).value).toBe("v");
		expect(el.getAttribute("placeholder")).toBe("p");
	});

	it("empty()는 모든 자식을 제거", () => {
		root.createDiv();
		root.createSpan({ text: "x" });
		expect(root.childElementCount).toBe(2);
		root.empty();
		expect(root.childElementCount).toBe(0);
	});

	it("setText/appendText/addClass/removeClass/toggleClass/setAttr", () => {
		const el = root.createDiv();
		el.setText("처음");
		expect(el.textContent).toBe("처음");
		el.appendText("+추가");
		expect(el.textContent).toBe("처음+추가");
		el.addClass("x", "y");
		el.removeClass("x");
		expect(el.classList.contains("x")).toBe(false);
		expect(el.classList.contains("y")).toBe(true);
		el.toggleClass("on", true);
		expect(el.classList.contains("on")).toBe(true);
		el.toggleClass("on", false);
		expect(el.classList.contains("on")).toBe(false);
		el.setAttr("aria-label", "라벨");
		expect(el.getAttribute("aria-label")).toBe("라벨");
		el.setAttr("aria-label", null); // null이면 제거
		expect(el.hasAttribute("aria-label")).toBe(false);
	});

	it("show/hide/toggle은 display 스타일을 전환", () => {
		const el = root.createDiv();
		el.hide();
		expect(el.style.display).toBe("none");
		el.show();
		expect(el.style.display).toBe("");
		el.toggle(false);
		expect(el.style.display).toBe("none");
	});

	it("onClickEvent로 클릭 핸들러 등록", () => {
		const el = root.createDiv();
		let clicked = 0;
		el.onClickEvent(() => clicked++);
		el.dispatchEvent(new Event("click"));
		expect(clicked).toBe(1);
	});

	it("중첩 빌드: 메시지 행 구조(메타+본문)를 createDiv/createSpan 체인으로 구성", () => {
		// renderMessage가 만드는 구조를 대표 검증 — 하니스가 실제 섹션 렌더 패턴을 지탱하는지.
		const row = root.createDiv({ cls: "covault-chat-msg is-mine" });
		const meta = row.createDiv({ cls: "covault-chat-meta" });
		meta.createSpan({ cls: "covault-feedback-author", text: "홍길동" });
		row.createDiv({ cls: "covault-chat-body", text: "본문" });
		expect(row.querySelector(".covault-chat-meta .covault-feedback-author")?.textContent).toBe("홍길동");
		expect(row.querySelector(".covault-chat-body")?.textContent).toBe("본문");
		expect(row.classList.contains("is-mine")).toBe(true);
	});
});
