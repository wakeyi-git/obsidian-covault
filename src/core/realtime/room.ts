/**
 * 실시간 room/공간 매칭의 순수 로직(obsidian 비의존, 단위 테스트 가능). 기술문서 §19.
 *
 * 핵심: 교사(folder="학생A")와 학생(folder=""=vault 전체)이 같은 dbPath를 산출해 **같은 room**을 공유한다.
 * mirror 공간은 spaceId=`mirror-<memberId>`로, 공유 공간과 같은 `class_<c>/share/<s>/` 네임스페이스를 쓴다
 * (Yjs 서버 prefix 검증 무변경 통과).
 */

/** folder 기준 상대경로(dbPath). folder=""면 전체 경로. 경로가 folder 아래가 아니면 null. */
export function relUnder(localPath: string, folder: string): string | null {
	if (folder === "") return localPath;
	if (localPath === folder) return "";
	if (localPath.startsWith(folder + "/")) return localPath.slice(folder.length + 1);
	return null;
}

/** room 이름. 경로가 folder 아래가 아니면 null. */
export function roomName(workspaceId: string, spaceId: string, localPath: string, folder: string): string | null {
	const dbPath = relUnder(localPath, folder);
	if (dbPath === null) return null;
	return `ws_${workspaceId}/share/${spaceId}/${dbPath}`;
}

/**
 * 경로가 속한 공간 선택. 겹치면 **가장 구체적인(folder가 가장 긴)** 공간을 택해 mirror(folder="")가 하위
 * 공유 폴더를 가리지 않게 한다. 빈 folder는 mirror 공간만 허용(잘못 설정된 share가 vault 전체를 삼키는 것 방지).
 * 제외(보관/충돌/excludeFolders) 판정은 호출측이 isExcluded로 주입한다.
 */
export function pickSpace<T extends { folder: string; kind?: "share" | "mirror" }>(
	spaces: T[],
	localPath: string,
	isExcluded: (folder: string) => boolean,
): T | null {
	let best: T | null = null;
	for (const sp of spaces) {
		if (!sp.folder && sp.kind !== "mirror") continue;
		if (relUnder(localPath, sp.folder) === null) continue;
		if (isExcluded(sp.folder)) continue;
		if (!best || sp.folder.length > best.folder.length) best = sp;
	}
	return best;
}
