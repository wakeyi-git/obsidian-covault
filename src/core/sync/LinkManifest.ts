import type { PouchService } from "../couch/PouchService";

/**
 * 링크별 로컬 manifest — "직전 동기화 종료 시점에 이 vault가 가지고 있던 파일" 스냅샷. 기술문서 §17.3.
 *
 * 오프라인/비활성 중 삭제된 파일을 tombstone으로 보정할 때, "과거 여기 있었다"는 근거로 쓴다.
 * 링크의 localDb에 `_local/manifest`로 저장하므로 **원격에 복제되지 않고**(CouchDB `_local/` 규칙),
 * 재시작 후에도 유지되며, 캐시 초기화(destroyLocal) 시 함께 사라져 삭제 정합이 자동 비활성화된다.
 */

export const MANIFEST_ID = "_local/manifest";

/** 대량 삭제(= localRoot 오설정 등) 추정 임계치. */
export const ORPHAN_BULK_FLOOR = 5;
export const ORPHAN_BULK_RATIO = 0.5;

export interface ManifestEntry {
	/** 기준선 시점의 로컬 DB 문서 rev. 이후 다른 기기가 바꾸면 rev가 달라진다. */
	rev: string;
	/** 기준선 시점의 DB 문서 contentHash. 기록 시 로컬 파일 내용과 일치함이 검증된 값. */
	hash: string;
	/** 기준선 시점의 로컬 파일 stat.mtime/size. 둘 다 그대로면 파일을 읽지 않고 "변경 없음"으로
	 *  판정하는 증분 스캔에 쓴다(구버전 기준선엔 없음 → 전체 검사로 폴백). */
	mtime?: number;
	size?: number;
}

/** 현재 DB 문서의 식별 정보(미삭제). selectManifestOrphans 비교용. */
export interface DocState {
	rev: string;
	hash: string;
}

export interface LinkManifestDoc {
	_id: string;
	_rev?: string;
	/** 기준선 localRoot. 현재 localRoot와 다르면 기준선이 무효(폴더 재설정 등) → 삭제 정합 비활성. */
	localRoot: string;
	/** dbPath → 기준선 항목. */
	paths: Record<string, ManifestEntry>;
	updatedAt: number;
}

export async function loadManifest(pouch: PouchService): Promise<LinkManifestDoc | null> {
	return pouch.get<LinkManifestDoc>(MANIFEST_ID);
}

export async function saveManifest(
	pouch: PouchService,
	data: { localRoot: string; paths: Record<string, ManifestEntry>; updatedAt: number },
): Promise<void> {
	await pouch.put<LinkManifestDoc>({ _id: MANIFEST_ID, ...data });
}

/**
 * manifest 기준선과 현재 상태를 비교해 tombstone 대상 dbPath를 고른다(순수 함수).
 *
 * 대상 조건: manifest에 있고(과거 보유) · 현재 vault에 없고(사라짐) · 현재 DB에 미삭제로 존재하며
 * **rev·hash가 기준선과 같다**(그 사이 다른 기기가 바꾸지 않음). 하나라도 다르거나 DB에 없으면 제외.
 */
export function selectManifestOrphans(
	manifestPaths: Record<string, ManifestEntry>,
	existingDbPaths: Set<string>,
	currentByPath: Map<string, DocState>,
): string[] {
	const out: string[] = [];
	for (const [path, entry] of Object.entries(manifestPaths)) {
		if (existingDbPaths.has(path)) continue; // 아직 vault에 있음
		const cur = currentByPath.get(path);
		if (cur == null) continue; // DB에 없음/이미 tombstone → 처리 불필요
		if (cur.rev !== entry.rev || cur.hash !== entry.hash) continue; // 기준선 이후 변경됨 → 보존
		out.push(path);
	}
	return out;
}

/**
 * 삭제/수정 충돌 후보: manifest에 있고(과거 보유) · 현재 vault에 없고(로컬 삭제) · 현재 DB에 존재하지만
 * **rev·hash가 기준선과 다른**(= 기준선 이후 다른 기기가 수정) dbPath. 즉 selectManifestOrphans가
 * 안전을 위해 보존(제외)한 항목들. 사용자에게 "삭제할지/수정 유지할지" 선택을 제시하기 위해 식별한다.
 */
export function selectDeleteModifyConflicts(
	manifestPaths: Record<string, ManifestEntry>,
	existingDbPaths: Set<string>,
	currentByPath: Map<string, DocState>,
): string[] {
	const out: string[] = [];
	for (const [path, entry] of Object.entries(manifestPaths)) {
		if (existingDbPaths.has(path)) continue; // 아직 vault에 있음
		const cur = currentByPath.get(path);
		if (cur == null) continue; // DB에 없음/이미 tombstone
		if (cur.rev !== entry.rev || cur.hash !== entry.hash) out.push(path); // 기준선 이후 변경됨
	}
	return out;
}

/**
 * 후보 수가 임계치를 넘으면(대량 삭제 추정) true → tombstone을 중단해야 한다.
 * configuredMax>0이면 그 절대값을 임계로 쓰고, 아니면 자동(max(floor, 50%)).
 */
export function exceedsBulkThreshold(candidateCount: number, manifestSize: number, configuredMax?: number): boolean {
	if (configuredMax && configuredMax > 0) return candidateCount > configuredMax;
	const threshold = Math.max(ORPHAN_BULK_FLOOR, Math.floor(manifestSize * ORPHAN_BULK_RATIO));
	return candidateCount > threshold;
}
