import { App } from "obsidian";

/**
 * 폴더 경로의 모든 조상을 위에서부터 순서대로 생성한다(재귀). `Vault.createFolder`가 재귀 생성을
 * 보장하지 않는 환경에서도 깊은 경로(`a/b/c`)를 안전하게 만든다 — `a` → `a/b` → `a/b/c`.
 * 이미 있는 단계는 건너뛰고, 경합으로 인한 생성 오류는 무시한다.
 */
export async function ensureFolderRecursive(app: App, folderPath: string): Promise<void> {
	if (!folderPath) return;
	const parts = folderPath.split("/").filter(Boolean);
	let cur = "";
	for (const part of parts) {
		cur = cur ? `${cur}/${part}` : part;
		if (!app.vault.getAbstractFileByPath(cur)) {
			await app.vault.createFolder(cur).catch(() => {
				/* 이미 존재/경합 등 무시 */
			});
		}
	}
}

/** localPath의 부모 폴더(및 그 조상)를 모두 보장한다. 파일 쓰기 전에 호출. */
export async function ensureParentFolders(app: App, localPath: string): Promise<void> {
	const idx = localPath.lastIndexOf("/");
	if (idx <= 0) return;
	await ensureFolderRecursive(app, localPath.slice(0, idx));
}
