/**
 * 첨부 단일 파일 **하드 천장**(MB) — 사용자 상한과 무관하게 항상 적용되는 절대 상한.
 *
 * CoVault는 첨부를 **base64 문자열**로 PouchDB에 저장한다. 그런데 V8 문자열 최대 길이는 약 2²⁸자(≈268M)라,
 * 원본이 ~200MB를 넘으면 base64(원본×4/3)가 그 한계를 넘어 `RangeError: Invalid string length`로 **시작 정합·
 * 동기화가 통째로 죽는다**(현장: _지도서의 268MB PDF가 시작 정합을 무너뜨림). 게다가 100MB+ 파일의 동기 base64
 * 인코딩(피크 ~4N 메모리)은 메인스레드를 멈춰 **하얀 화면**을 만든다. 그래서 천장을 V8 문자열 한계 **아래**로
 * 둔다 — 128MB면 base64 ≈ 179M자로 2²⁸ 한계에 안전한 여유가 있고 피크 메모리도 ~512MB로 억제된다.
 * (이전 1024MB는 문자열 한계를 못 본 값이었다 — 200MB 초과 첨부가 그대로 크래시를 일으켰다.)
 */
export const HARD_ATTACHMENT_CAP_MB = 128;

/**
 * 실효 첨부 상한(MB). 사용자 상한이 있으면 그것을, 0(무제한)이면 하드 천장을 쓰되, **항상 하드 천장으로 클램프**한다
 * — 사용자가 천장보다 큰 값을 지정해도 base64 문자열 한계를 넘는 첨부가 동기화에 진입하지 못하게 한다(크래시 방지).
 */
export function effectiveMaxAttachmentMB(maxMB: number): number {
	return Math.min(maxMB > 0 ? maxMB : HARD_ATTACHMENT_CAP_MB, HARD_ATTACHMENT_CAP_MB);
}

/** 단일 파일 base64 인코딩 시 피크 메모리는 원본의 약 4배(원본 ArrayBuffer + binary 문자열 ~2배 + btoa 결과 ~1.33배). */
export const ATTACHMENT_PEAK_MEMORY_FACTOR = 4;

/** 첨부 피크 메모리가 시스템 총 메모리의 이 비율을 넘으면 경고(보수적 안전 예산). */
export const ATTACHMENT_SAFE_MEMORY_FRACTION = 0.5;

/**
 * 첨부 상한이 시스템 메모리 대비 안전한지 판정(순수 함수). UI 경고용.
 * systemMemoryMB가 미상(null/0 이하)이면 판정 불가(null) — 경고를 띄우지 않는다.
 */
export function attachmentMemoryAdvisory(
	effMB: number,
	systemMemoryMB: number | null,
): { level: "ok" | "warn"; peakMB: number; systemMemoryMB: number } | null {
	if (systemMemoryMB == null || systemMemoryMB <= 0) return null;
	const peakMB = effMB * ATTACHMENT_PEAK_MEMORY_FACTOR;
	const level = peakMB > systemMemoryMB * ATTACHMENT_SAFE_MEMORY_FRACTION ? "warn" : "ok";
	return { level, peakMB, systemMemoryMB };
}

/** 사용자가 "무제한"을 골라 내부 안전 상한이 적용된 상태인가(경고 메시지 분기용). */
export function isInternalCap(maxMB: number): boolean {
	return !maxMB || maxMB <= 0;
}

/** 첨부 크기 제한 판정(순수 함수). maxMB<=0이면 무제한(항상 false). */
export function exceedsAttachmentLimit(sizeBytes: number, maxMB: number): boolean {
	if (!maxMB || maxMB <= 0) return false;
	return sizeBytes > maxMB * 1024 * 1024;
}

/**
 * 복제 제외 판정(순수 함수). 한도 초과 첨부(asset 문서)면 true → 복제에서 제외한다.
 * maxBytes<=0(무제한)이거나 asset이 아니거나 size 미상이면 false(복제 허용).
 * PouchDB replication filter에서 부정(!)해 사용 — 거대 첨부의 push/pull을 복제 진입 단계에서 차단.
 */
export function isOverLimitAsset(doc: { _id?: unknown; size?: unknown }, maxBytes: number): boolean {
	if (maxBytes <= 0) return false;
	return (
		typeof doc?._id === "string" &&
		doc._id.startsWith("asset:") &&
		typeof doc.size === "number" &&
		doc.size > maxBytes
	);
}
