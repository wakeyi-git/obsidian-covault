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
