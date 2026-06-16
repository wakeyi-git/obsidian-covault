/**
 * 사용자가 "무제한(maxAttachmentMB=0)"을 골라도 적용되는 내부 안전 상한(단일 파일 MB).
 * 0을 진짜 무제한으로 두면 단일 거대 파일의 동기 base64 인코딩이 메인스레드를 멈추고(원본 N +
 * binary 문자열 ~2N + btoa ~1.33N ≈ 순간 4N), 라이브 복제가 모든 첨부를 한꺼번에 적재해 앱이 멈춘다.
 * 1GB 상한은 base64 ~4배 스파이크 시 피크 ~4GB까지 갈 수 있어 저사양/모바일에는 부담될 수 있다 — 튜닝 지점.
 */
export const HARD_ATTACHMENT_CAP_MB = 1024;

/** 실효 첨부 상한(MB). 사용자 상한이 있으면 그것을, 0(무제한)이면 내부 안전 상한을 쓴다. */
export function effectiveMaxAttachmentMB(maxMB: number): number {
	return maxMB > 0 ? maxMB : HARD_ATTACHMENT_CAP_MB;
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
