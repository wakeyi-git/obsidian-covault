// obsidianFetch의 AbortSignal 존중(평가 P2-5). requestUrl은 네이티브 취소를 지원하지 않지만, shim이
// signal을 존중해 응답을 버리고 AbortError로 reject → PouchDB 복제 루프가 일시정지·취소 시 멈춘다.
import { describe, it, expect } from "vitest";
import { withAbort, makeAbortError } from "./obsidianFetch";

describe("withAbort", () => {
	it("signal 없으면 원래 promise를 그대로 전달", async () => {
		await expect(withAbort(undefined, Promise.resolve(42))).resolves.toBe(42);
	});

	it("이미 abort된 signal이면 즉시 AbortError로 reject", async () => {
		const ac = new AbortController();
		ac.abort();
		await expect(withAbort(ac.signal, Promise.resolve("x"))).rejects.toMatchObject({ name: "AbortError" });
	});

	it("진행 중 abort되면 응답을 버리고 AbortError로 reject", async () => {
		const ac = new AbortController();
		let resolveInner: (v: string) => void = () => {};
		const inner = new Promise<string>((r) => (resolveInner = r));
		const raced = withAbort(ac.signal, inner);
		ac.abort();
		await expect(raced).rejects.toMatchObject({ name: "AbortError" });
		resolveInner("늦은 응답"); // 네이티브 요청이 뒤늦게 끝나도 결과는 버려진다(이미 reject됨)
		await expect(raced).rejects.toMatchObject({ name: "AbortError" });
	});

	it("abort 없이 정상 완료되면 결과를 전달", async () => {
		const ac = new AbortController();
		await expect(withAbort(ac.signal, Promise.resolve("ok"))).resolves.toBe("ok");
	});

	it("내부 promise가 reject되면 그 오류를 그대로 전달", async () => {
		const ac = new AbortController();
		await expect(withAbort(ac.signal, Promise.reject(new Error("network")))).rejects.toThrow("network");
	});

	it("makeAbortError는 표준 AbortError(DOMException)", () => {
		const e = makeAbortError();
		expect(e).toBeInstanceOf(DOMException);
		expect(e.name).toBe("AbortError");
	});
});
