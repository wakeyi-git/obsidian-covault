import { describe, expect, it } from "vitest";
import { PouchService } from "./PouchService";
import { PouchDocBase } from "../model/types";

interface StateDoc extends PouchDocBase {
	type: "state";
	a: number;
	b: number;
}

function service(name: string): PouchService {
	return new PouchService("memory://", `remote-${name}`, "u", "p", `local-${name}`);
}

describe("PouchService CAS update", () => {
	it("충돌 뒤 최신 문서에 변환을 재적용해 서로 다른 필드 변경을 보존", async () => {
		const pouch = service(`cas-${Date.now()}-${Math.random()}`);
		await pouch.put<StateDoc>({ _id: "state:1", type: "state", a: 0, b: 0 });

		let release!: () => void;
		let firstRead!: () => void;
		const blocked = new Promise<void>((resolve) => (release = resolve));
		const read = new Promise<void>((resolve) => (firstRead = resolve));
		let calls = 0;
		const first = pouch.update<StateDoc>("state:1", async (current) => {
			calls++;
			if (calls === 1) {
				firstRead();
				await blocked;
			}
			return { ...current!, a: current!.a + 1 };
		});
		await read;
		await pouch.update<StateDoc>("state:1", (current) => ({ ...current!, b: current!.b + 1 }));
		release();
		await first;

		const doc = await pouch.get<StateDoc>("state:1");
		expect({ a: doc?.a, b: doc?.b }).toEqual({ a: 1, b: 1 });
		expect(calls).toBe(2);
		await pouch.destroyLocal();
		await pouch.close();
	});

	it("전체 교체 put은 오래된 _rev 충돌에서 자동 덮어쓰지 않는다", async () => {
		const pouch = service(`put-${Date.now()}-${Math.random()}`);
		const original = await pouch.put<StateDoc>({ _id: "state:1", type: "state", a: 0, b: 0 });
		await pouch.put<StateDoc>({ ...original, a: 1 });
		await expect(pouch.put<StateDoc>({ ...original, b: 1 })).rejects.toMatchObject({ status: 409 });
		const doc = await pouch.get<StateDoc>("state:1");
		expect({ a: doc?.a, b: doc?.b }).toEqual({ a: 1, b: 0 });
		await pouch.destroyLocal();
		await pouch.close();
	});
});
