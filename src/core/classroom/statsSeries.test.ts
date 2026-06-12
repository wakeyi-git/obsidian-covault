import { describe, it, expect } from "vitest";
import { splitBuckets, computeSeries } from "./statsSeries";
import { StatsInput } from "./stats";
import { AssignmentStateDoc } from "../model/types";

const DAY = 86_400_000;
const start = new Date("2026-06-01T00:00").getTime(); // 월요일
const now = new Date("2026-06-30T12:00").getTime();

describe("splitBuckets", () => {
	it("짧은 기간(≤maxBuckets일)은 일 단위 버킷", () => {
		const end = new Date("2026-06-07T23:59:59").getTime();
		const b = splitBuckets(start, end, now);
		expect(b).toHaveLength(7);
		expect(b[0].label).toBe("6/1");
		expect(b[6].label).toBe("6/7");
		expect(b[6].endMs).toBe(end);
	});

	it("긴 기간은 주 단위(월요일 경계) 버킷", () => {
		const end = new Date("2026-06-30T23:59:59").getTime();
		const b = splitBuckets(start, end, now);
		expect(b).toHaveLength(5); // 6/1·6/8·6/15·6/22·6/29 시작 주
		expect(b[0].label).toBe("6/1~");
		expect(b[1].startMs).toBe(new Date("2026-06-08T00:00").getTime());
		// 마지막 주는 기간 끝(6/30)에서 잘린다
		expect(b[4].endMs).toBe(end);
	});

	it("아직 오지 않은 날은 버킷을 만들지 않는다", () => {
		const end = new Date("2026-06-07T23:59:59").getTime();
		const nowMid = new Date("2026-06-03T12:00").getTime();
		const b = splitBuckets(start, end, nowMid);
		expect(b).toHaveLength(3); // 6/1~6/3
	});

	it("기간 전체가 미래면 빈 배열", () => {
		const b = splitBuckets(start, start + 6 * DAY, start - DAY);
		expect(b).toEqual([]);
	});
});

describe("computeSeries", () => {
	function st(uid: string, assignedAtMs: number, submittedAtMs?: number): AssignmentStateDoc {
		return { _id: `assignment-state:${uid}:a`, type: "assignment-state", schemaVersion: 1, workspaceId: "ws", assignmentUid: uid, memberId: "a", title: uid, state: submittedAtMs != null ? "submitted" : "assigned", assignedAtMs, submittedAtMs } as AssignmentStateDoc;
	}

	it("버킷별 풀링 % — 데이터 없는 버킷은 null", () => {
		const end = new Date("2026-06-03T23:59:59").getTime();
		const input: StatsInput = {
			startMs: start,
			endMs: end,
			nowMs: now,
			members: [{ memberId: "a", memberName: "A" }],
			notices: [],
			reads: [],
			// 6/1 배정 2건 중 1건 제출, 6/3 배정 1건 제출
			states: [st("x", start, start), st("y", start), st("z", start + 2 * DAY, start + 2 * DAY)],
			maxByUid: new Map(),
			routines: [],
			routineStates: [],
		};
		const series = computeSeries(input, splitBuckets(start, end, now), (s) => s.progress);
		expect(series).toEqual([50, null, 100]);
	});
});
