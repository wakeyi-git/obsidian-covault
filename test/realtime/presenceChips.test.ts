// @vitest-environment happy-dom
// PresenceChips 렌더 조건(검토 2026-07): awareness "change"는 모든 참가자의 커서 이동마다
// 발화하므로, 참가자 구성(id·이름)이 그대로면 DOM을 재구축하지 않아야 한다 — 대인원 방에서
// 타이핑 중 렌더 부하(입력 지연 체감)의 원인이 되던 경로.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import "../harness/obsidianDom";
import { PresenceChips } from "../../src/core/realtime/presenceChips";

describe("PresenceChips 재렌더 조건", () => {
	let doc: Y.Doc;
	let awareness: Awareness;
	let container: HTMLElement;
	let chips: PresenceChips;

	beforeEach(() => {
		doc = new Y.Doc();
		awareness = new Awareness(doc);
		container = document.createElement("div");
		chips = new PresenceChips(container, awareness);
	});

	afterEach(() => {
		chips.destroy();
		awareness.destroy();
		doc.destroy();
	});

	/** 원격 참가자 상태 주입(자기 자신은 clientID 제외 규칙으로 걸러지므로 임의 id 사용). */
	function setRemote(clientId: number, state: Record<string, unknown> | null): void {
		const states = awareness.getStates() as Map<number, Record<string, unknown>>;
		if (state === null) {
			states.delete(clientId);
			awareness.emit("change", [{ added: [], updated: [], removed: [clientId] }, "test"]);
		} else {
			const added = !states.has(clientId);
			states.set(clientId, state);
			awareness.emit("change", [
				{ added: added ? [clientId] : [], updated: added ? [] : [clientId], removed: [] },
				"test",
			]);
		}
	}

	it("참가자 합류/이탈 시에는 칩을 다시 그린다", () => {
		expect(container.querySelectorAll(".covault-presence-chip").length).toBe(0);
		setRemote(101, { user: { name: "가람" } });
		expect(container.querySelectorAll(".covault-presence-chip").length).toBe(1);
		setRemote(102, { user: { name: "나래" } });
		expect(container.querySelectorAll(".covault-presence-chip").length).toBe(2);
		setRemote(101, null);
		const remaining = container.querySelectorAll(".covault-presence-chip");
		expect(remaining.length).toBe(1);
		expect(remaining[0].textContent).toBe("나래");
	});

	it("커서 이동(구성 불변)에는 DOM을 재구축하지 않는다", () => {
		setRemote(101, { user: { name: "가람" }, cursor: { anchor: 0 } });
		const chipBefore = container.querySelector(".covault-presence-chip");
		expect(chipBefore).not.toBeNull();
		// 같은 참가자의 커서만 이동 — awareness "change"는 발화하지만 칩 구성은 동일.
		for (let pos = 1; pos <= 20; pos++) {
			setRemote(101, { user: { name: "가람" }, cursor: { anchor: pos } });
		}
		const chipAfter = container.querySelector(".covault-presence-chip");
		expect(chipAfter).toBe(chipBefore); // 동일 노드 유지 = 재구축 없음
	});

	it("이름 변경은 재렌더한다", () => {
		setRemote(101, { user: { name: "가람" } });
		setRemote(101, { user: { name: "가람2" } });
		expect(container.querySelector(".covault-presence-chip")?.textContent).toBe("가람2");
	});
});
