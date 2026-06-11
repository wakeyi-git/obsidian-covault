import { describe, it, expect } from "vitest";
import { parseDeniedEvent, deniedDisplayPath } from "./deniedEvent";

describe("parseDeniedEvent (H-5 denied 식별)", () => {
	it("PouchDB 표준형({doc:{id,error,reason}})에서 id·읽기전용 사유를 찾는다", () => {
		const info = parseDeniedEvent({
			doc: { id: "note:모둠활동/토론.md", error: "forbidden", reason: "covault:shared-read-only" },
		});
		expect(info.id).toBe("note:모둠활동/토론.md");
		expect(info.sharedReadOnly).toBe(true);
	});

	it("중첩·배열 형태도 제한 깊이로 훑는다", () => {
		const info = parseDeniedEvent({
			result: { errors: [{ _id: "note:a.md", message: "forbidden: covault:shared-read-only" }] },
		});
		expect(info.id).toBe("note:a.md");
		expect(info.sharedReadOnly).toBe(true);
	});

	it("다른 사유(teacher only)는 읽기전용으로 분류하지 않는다", () => {
		const info = parseDeniedEvent({ doc: { id: "rtpart:x.md", error: "forbidden", reason: "teacher only" } });
		expect(info.sharedReadOnly).toBe(false);
		expect(info.id).toBe("rtpart:x.md");
	});

	it("형식 미상/순환 참조에도 안전", () => {
		const cyc: Record<string, unknown> = {};
		cyc.self = cyc;
		expect(parseDeniedEvent(cyc)).toEqual({ id: undefined, sharedReadOnly: false });
		expect(parseDeniedEvent(null)).toEqual({ id: undefined, sharedReadOnly: false });
		expect(parseDeniedEvent("oops")).toEqual({ id: undefined, sharedReadOnly: false });
	});

	it("deniedDisplayPath: note:/asset: 프리픽스 제거", () => {
		expect(deniedDisplayPath("note:a/b.md")).toBe("a/b.md");
		expect(deniedDisplayPath("asset:img.png")).toBe("img.png");
		expect(deniedDisplayPath(undefined)).toBe("?");
	});
});
