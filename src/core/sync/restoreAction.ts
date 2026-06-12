// 삭제 파일 복구의 순수 결정 로직(obsidian-free → 단위 테스트 가능).
// RestoreManager가 vault/DB I/O를 담당하고, 여기서는 "복구 가능 여부"와 "대상 경로 결정"만 계산한다.
import { insertLabelBeforeExt } from "../path/path";
import { t } from "../../i18n";

export type RestoreCollision = "skip" | "overwrite" | "keep-both";

/**
 * 복구 가능 여부.
 * - 노트: tombstone 문서가 content를 보존하므로 content가 있으면 복구 가능.
 * - 첨부: tombstone에서 바이너리가 제거되므로 archive(_삭제됨/) vault 사본이 있어야 복구 가능.
 */
export function isRecoverable(
	kind: "note" | "asset",
	opts: { hasContent: boolean; hasArchiveCopy: boolean },
): boolean {
	return kind === "note" ? opts.hasContent : opts.hasArchiveCopy;
}

/**
 * 복구 대상 로컬 경로 결정.
 * - 대상이 비어 있으면 원래 경로.
 * - 이미 있으면 정책에 따라: skip(null=건너뜀) · overwrite(원래 경로 덮어씀) · keep-both('(복구본)' 라벨).
 */
export function restoreTargetPath(
	localPath: string,
	targetExists: boolean,
	collision: RestoreCollision,
): string | null {
	if (!targetExists) return localPath;
	switch (collision) {
		case "skip":
			return null;
		case "overwrite":
			return localPath;
		case "keep-both":
			return insertLabelBeforeExt(localPath, t("recovery.restored_copy_label")); // 로케일 반영(평가 U-2)
	}
}
