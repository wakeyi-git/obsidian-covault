/** 복사 동작 결정(obsidian 비의존, 순수 — 단위 테스트 가능). */

export type ExistingPolicy = "skip" | "overwrite" | "rename";
export type CopyAction = "create" | "overwrite" | "skip" | "rename";

/** 기존 파일 존재 + 정책 → 동작. */
export function decideAction(existing: boolean, policy: ExistingPolicy): CopyAction {
	if (!existing) return "create";
	return policy === "skip" ? "skip" : policy === "overwrite" ? "overwrite" : "rename";
}
