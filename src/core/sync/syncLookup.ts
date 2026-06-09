import { MirrorSync } from "./MirrorSync";

/** 동기화 링크 목록에서 remoteDb로 찾기(없으면 undefined). 복구·DM·스냅샷 등에서 반복되던 조회를 일원화. */
export function pickSyncByDb(syncs: MirrorSync[], db: string): MirrorSync | undefined {
	return syncs.find((s) => s.remoteDb === db);
}

/** 로컬 경로를 담당(owns)하는 동기화 링크 찾기(없으면 undefined). */
export function pickSyncOwning(syncs: MirrorSync[], localPath: string): MirrorSync | undefined {
	return syncs.find((s) => s.owns(localPath));
}
