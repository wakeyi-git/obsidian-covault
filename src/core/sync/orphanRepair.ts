import { MirrorContext } from "./MirrorContext";
import { Uploader } from "./Uploader";

/**
 * 공유 공간 정합 복구(관리자). "로컬 DB엔 살아있지만 vault엔 없는" 파일 경로를 찾는다 — 관리자가 vault에서
 * 폴더째 삭제했으나 tombstone이 만들어지지 않아(폴더 삭제 이벤트 누락 버그) 전파되지 못한 잔존 문서가 대상.
 * 매니페스트 기준선에 의존하지 않으므로, 기준선이 이미 지나쳐 reconcileDeletions가 못 잡는 상태도 정리한다.
 *
 * ⚠️ **vault가 최신(다운로드 완료)** 이라는 전제 — 아직 안 받은 파일을 고아로 오인해 지우지 않도록,
 *    호출측이 관리자(자기 vault가 정본)·공유 공간 링크로 한정하고 사용자 확인을 받는다.
 */
export interface OrphanScan {
	/** vault엔 없는데 DB엔 살아있는 파일(전파할 삭제). */
	orphans: string[];
	/** 스캔한 살아있는(non-tombstone) 문서 총수 — 진단용(0이면 로컬 DB가 비었거나 뒤처진 것). */
	liveCount: number;
}

export async function scanVaultOrphans(ctx: MirrorContext): Promise<OrphanScan> {
	const notes = await ctx.pouch.allNotes();
	const assets = ctx.settings.syncAssets ? await ctx.pouch.allAssets() : [];
	const orphans: string[] = [];
	let liveCount = 0;
	for (const doc of [...notes, ...assets]) {
		if (doc.deleted) continue; // 이미 tombstone
		liveCount++;
		const localPath = ctx.toLocalPath(doc.path);
		if (ctx.isExcluded(localPath)) continue; // 보관/충돌/제외 폴더는 대상 아님
		if (ctx.fileExists(localPath)) continue; // vault에 있음 → 정상(고아 아님)
		orphans.push(doc.path);
	}
	return { orphans, liveCount };
}

/** 고아 경로만 반환(scanVaultOrphans 래퍼 — 테스트·단순 호출용). */
export async function listVaultOrphans(ctx: MirrorContext): Promise<string[]> {
	return (await scanVaultOrphans(ctx)).orphans;
}

/** 원격 고아 스캔 결과 — orphans는 **문서 id**(note:/asset:)다(원격에 직접 tombstone하려면 id가 필요). */
export interface RemoteOrphanScan {
	ids: string[];
	liveCount: number;
}

/**
 * 원격 문서 id 목록(remoteLiveDocIds 결과)으로 고아를 판정 — 로컬 DB가 아니라 **원격 실제 상태** 기준이라
 * 체크포인트가 뒤처져도 옛 삭제 파일/유령 문서를 잡는다. note:/asset: id 중 vault에 없는(+제외 아님) 것.
 */
export function remoteOrphanIds(ctx: MirrorContext, allIds: string[]): RemoteOrphanScan {
	const ids: string[] = [];
	let liveCount = 0;
	for (const id of allIds) {
		const dbPath = id.startsWith("note:") ? id.slice(5) : id.startsWith("asset:") ? id.slice(6) : null;
		if (dbPath == null) continue; // note/asset 외 문서(manifest·rtconfig 등)는 대상 아님
		liveCount++;
		const localPath = ctx.toLocalPath(dbPath);
		if (ctx.isExcluded(localPath)) continue;
		if (ctx.fileExists(localPath)) continue;
		ids.push(id);
	}
	return { ids, liveCount };
}

/** id에서 표시용 dbPath 추출(note:/asset: 접두 제거). */
export function dbPathOfId(id: string): string {
	return id.startsWith("note:") ? id.slice(5) : id.startsWith("asset:") ? id.slice(6) : id;
}

/**
 * 고아 문서들을 **원격에 직접** tombstone한다 — 원격 현재 rev 위에 얹어 live 분기를 확실히 덮으므로
 * 로컬 분기 충돌/스테일/누락이 있어도 다시 살아나지 않는다. 실제로 처리한 수를 반환.
 */
export async function tombstoneRemoteOrphans(ctx: MirrorContext, ids: string[]): Promise<number> {
	const s = ctx.settings;
	let n = 0;
	for (const id of ids) {
		const now = Date.now();
		const ok = await ctx.pouch.tombstoneRemoteDoc(id, {
			deletedAt: new Date(now).toISOString(),
			deletedBy: s.userId,
			deletedByRole: s.role,
			deleteMode: s.deletePolicy,
			mtime: now,
			lastModifiedBy: s.userId,
			lastModifiedRole: s.role,
			lastModifiedDeviceId: s.deviceId,
			updatedAt: new Date(now).toISOString(),
		});
		if (ok) n++;
	}
	return n;
}

/** 주어진 경로들을 tombstone(삭제 전파)한다. 실제로 만든 tombstone 수를 반환. (로컬 경유 — 테스트·일반 경로용.) */
export async function tombstoneVaultOrphans(ctx: MirrorContext, uploader: Uploader, dbPaths: string[]): Promise<number> {
	let n = 0;
	for (const dbPath of dbPaths) {
		if ((await uploader.tombstonePath(dbPath)) === "tombstoned") n++;
	}
	if (n > 0) await ctx.pouch.replicatePushOnce().catch(() => undefined); // 즉시 전파 시도(live가 없거나 느릴 때)
	return n;
}
