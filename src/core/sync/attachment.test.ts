import { describe, it, expect } from "vitest";
import { exceedsAttachmentLimit, isOverLimitAsset, effectiveMaxAttachmentMB, HARD_ATTACHMENT_CAP_MB } from "./attachment";

describe("effectiveMaxAttachmentMB (하드 천장)", () => {
	it("하드 천장은 V8 문자열 한계(base64 ≈ 2²⁸자, 원본 ~200MB) 아래여야 한다", () => {
		// base64 길이 = ceil(N/3)*4. 천장 N(MB)의 base64가 2²⁸자(268,435,456) 미만이어야 Invalid string length를 피함.
		const base64Chars = Math.ceil((HARD_ATTACHMENT_CAP_MB * 1024 * 1024) / 3) * 4;
		expect(base64Chars).toBeLessThan(2 ** 28);
	});

	it("무제한(0)이면 하드 천장을 쓴다", () => {
		expect(effectiveMaxAttachmentMB(0)).toBe(HARD_ATTACHMENT_CAP_MB);
		expect(effectiveMaxAttachmentMB(-1)).toBe(HARD_ATTACHMENT_CAP_MB);
	});

	it("천장 이하 사용자 값은 그대로", () => {
		expect(effectiveMaxAttachmentMB(50)).toBe(50);
	});

	it("천장보다 큰 사용자 값도 천장으로 클램프(크래시 방지)", () => {
		expect(effectiveMaxAttachmentMB(1024)).toBe(HARD_ATTACHMENT_CAP_MB);
		expect(effectiveMaxAttachmentMB(HARD_ATTACHMENT_CAP_MB + 100)).toBe(HARD_ATTACHMENT_CAP_MB);
	});
});

describe("exceedsAttachmentLimit", () => {
	it("maxMB<=0이면 무제한(항상 false)", () => {
		expect(exceedsAttachmentLimit(999 * 1024 * 1024, 0)).toBe(false);
		expect(exceedsAttachmentLimit(10, -1)).toBe(false);
	});

	it("한도 초과면 true, 이하면 false", () => {
		const mb = 1024 * 1024;
		expect(exceedsAttachmentLimit(5 * mb, 10)).toBe(false);
		expect(exceedsAttachmentLimit(10 * mb, 10)).toBe(false); // 정확히 한도는 허용
		expect(exceedsAttachmentLimit(10 * mb + 1, 10)).toBe(true);
	});
});

describe("isOverLimitAsset (복제 제외 판정)", () => {
	const mb = 1024 * 1024;
	const max = 50 * mb;

	it("한도 초과 asset 문서면 true(복제 제외)", () => {
		expect(isOverLimitAsset({ _id: "asset:_지도서/체육.pdf", size: 664 * mb }, max)).toBe(true);
	});

	it("한도 이하 asset은 false(복제 허용)", () => {
		expect(isOverLimitAsset({ _id: "asset:img.png", size: 3 * mb }, max)).toBe(false);
		expect(isOverLimitAsset({ _id: "asset:exact.bin", size: 50 * mb }, max)).toBe(false); // 정확히 한도는 허용
	});

	it("asset이 아니면(노트 등) 크기 무관 false", () => {
		expect(isOverLimitAsset({ _id: "note:big.md", size: 999 * mb }, max)).toBe(false);
		expect(isOverLimitAsset({ _id: "rtpart:foo", size: 999 * mb }, max)).toBe(false);
	});

	it("size 미상/비숫자면 false(판정 불가 → 복제 허용)", () => {
		expect(isOverLimitAsset({ _id: "asset:nosize.pdf" }, max)).toBe(false);
		expect(isOverLimitAsset({ _id: "asset:x.pdf", size: undefined }, max)).toBe(false);
	});

	it("maxBytes<=0(무제한)이면 항상 false", () => {
		expect(isOverLimitAsset({ _id: "asset:huge.pdf", size: 999 * mb }, 0)).toBe(false);
	});

	it("_id 미상/비문자열이면 false", () => {
		expect(isOverLimitAsset({ size: 999 * mb }, max)).toBe(false);
	});
});
