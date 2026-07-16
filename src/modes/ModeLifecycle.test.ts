import { describe, expect, it } from "vitest";
import { ModeLifecycle } from "./ModeLifecycle";

describe("ModeLifecycle", () => {
	it("겹친 교체를 직렬화해 이전 모드를 완전히 정지한 뒤 다음 모드를 시작", async () => {
		const events: string[] = [];
		const lifecycle = new ModeLifecycle<{ id: string; stop(): Promise<void> }>();
		const replace = (id: string) => lifecycle.replace(
			() => ({ id, stop: async () => { events.push(`stop:${id}`); } }),
			async () => { events.push(`start:${id}`); },
		);
		await Promise.all([replace("a"), replace("b")]);
		expect(events).toEqual(["start:a", "stop:a", "start:b"]);
		expect(lifecycle.current?.id).toBe("b");
	});

	it("시작 실패 인스턴스를 정리하고 다음 전환을 계속 허용", async () => {
		let stopped = 0;
		const lifecycle = new ModeLifecycle<{ stop(): Promise<void> }>();
		await expect(lifecycle.replace(() => ({ stop: async () => { stopped++; } }), async () => { throw new Error("boom"); })).rejects.toThrow("boom");
		expect(stopped).toBe(1);
		expect(lifecycle.current).toBeNull();
		await lifecycle.replace(() => ({ stop: async () => {} }), async () => {});
		expect(lifecycle.current).not.toBeNull();
	});
});
