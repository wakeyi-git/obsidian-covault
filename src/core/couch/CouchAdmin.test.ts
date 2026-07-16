// 평가 S-3 회귀: DB 생성 후 _security 설정이 실패하면 — _security가 빈 DB는 인증된 모든
// 사용자에게 개방되므로 — 이번에 새로 만든 DB만 삭제(롤백)하고, 기존 DB는 건드리지 않는다.
import { describe, it, expect } from "vitest";
import { CouchAdmin } from "./CouchAdmin";

type Call = { method: string; url: string };

/** fetch 스텁: 경로 패턴별 canned 응답 + 호출 기록. */
function stubFetch(opts: { dbPutStatus: number }): { calls: Call[]; fetch: typeof fetch } {
	const calls: Call[] = [];
	const res = (status: number, body: unknown = {}) =>
		({ status, text: async () => JSON.stringify(body) }) as unknown as Response;
	const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = String(input);
		const method = init?.method ?? "GET";
		calls.push({ method, url });
		if (url.includes("/_users/")) {
			if (method === "GET") return res(200, { _rev: "1-a" });
			return res(201, { ok: true });
		}
		if (url.endsWith("/_security")) return res(500, { reason: "boom" }); // 보안 설정 실패 주입
		if (method === "PUT") return res(opts.dbPutStatus, opts.dbPutStatus < 300 ? { ok: true } : { error: "exists" });
		if (method === "DELETE") return res(200, { ok: true });
		return res(404, {});
	};
	return { calls, fetch: impl as typeof fetch };
}

function admin(stub: { fetch: typeof fetch }): CouchAdmin {
	const a = new CouchAdmin("http://couch", "admin", "pw");
	(a as unknown as { fetchImpl: typeof fetch }).fetchImpl = stub.fetch;
	return a;
}

describe("provisionMember의 _security 실패 롤백 (S-3)", () => {
	it("이번에 새로 만든 DB(201)는 보안 설정 실패 시 삭제된다", async () => {
		const stub = stubFetch({ dbPutStatus: 201 });
		const r = await admin(stub).provisionMember({ username: "m1", password: "p", remoteDb: "mirror_m1" });
		expect(r.ok).toBe(false);
		const del = stub.calls.filter((c) => c.method === "DELETE" && c.url.endsWith("/mirror_m1"));
		expect(del).toHaveLength(1); // 무방비(_security 빈) DB가 남지 않는다
	});

	it("기존 DB(412)는 보안 설정이 실패해도 삭제하지 않는다(데이터 보존)", async () => {
		const stub = stubFetch({ dbPutStatus: 412 });
		const r = await admin(stub).provisionMember({ username: "m1", password: "p", remoteDb: "mirror_m1" });
		expect(r.ok).toBe(false);
		expect(stub.calls.some((c) => c.method === "DELETE")).toBe(false);
	});

	it("정상 경로: 생성 + 보안 설정 성공이면 삭제 없이 ok", async () => {
		const stub = stubFetch({ dbPutStatus: 201 });
		// 이 케이스만 _security 성공으로 교체
		const origFetch = stub.fetch;
		const okFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith("/_security"))
				return { status: 200, text: async () => JSON.stringify({ ok: true }) } as unknown as Response;
			return origFetch(input as never, init);
		}) as typeof fetch;
		const r = await admin({ fetch: okFetch }).provisionMember({ username: "m1", password: "p", remoteDb: "mirror_m1" });
		expect(r.ok).toBe(true);
		expect(stub.calls.some((c) => c.method === "DELETE")).toBe(false);
	});
});

describe("updateDoc CAS", () => {
	it("409 뒤 최신 원격 문서에 변환을 재적용해 동시 필드 변경을 보존", async () => {
		let current = { _id: "state:1", _rev: "1-a", a: 0, b: 0 };
		let puts = 0;
		const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
			if ((init?.method ?? "GET") === "GET") {
				return { status: 200, text: async () => JSON.stringify(current) } as unknown as Response;
			}
			puts++;
			const body = JSON.parse(String(init?.body));
			if (puts === 1) {
				current = { ...current, _rev: "2-b", b: 1 };
				return { status: 409, text: async () => JSON.stringify({ error: "conflict" }) } as unknown as Response;
			}
			current = { ...body, _rev: "3-c" };
			return { status: 201, text: async () => JSON.stringify({ ok: true, rev: "3-c" }) } as unknown as Response;
		}) as typeof fetch;
		const result = await admin({ fetch: fetchImpl }).updateDoc<typeof current>("mirror_m1", "state:1", (doc) => ({
			...doc!,
			a: doc!.a + 1,
		}));
		expect(result).toMatchObject({ ok: true, changed: true });
		expect(puts).toBe(2);
		expect(current).toMatchObject({ a: 1, b: 1, _rev: "3-c" });
	});
});
