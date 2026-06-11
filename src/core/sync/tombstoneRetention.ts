import { MirrorContext } from "./MirrorContext";
import { NoteDoc, noteId } from "../model/types";
import { DAY_MS } from "./versionRetention";

/**
 * tombstone 내용 보존 기간 정리(평가 I-3). 노트 tombstone은 "삭제 복구"를 위해 삭제 직전
 * content를 보존하는데, 한도가 없어 DB가 삭제량만큼 무한히 자란다. 버전 히스토리 보존 정책
 * (versionMaxAgeDays)과 정렬해, 기간이 지난 tombstone의 content만 비운다(스트립).
 *
 * 스트립해도 동기화 정합성은 불변 — 부활 판정(Uploader.modifiedAfterTombstone)이 쓰는
 * contentHash·mtime은 유지한다. 복구는 같은 기간의 버전 스냅샷과 함께 만료된다(정책 일관).
 */

/** 스트립 대상 dbPath 선별(순수). deletedAt 미상은 보존(안전 방향). */
export function selectTombstonesToStrip(
	docs: Array<Pick<NoteDoc, "path" | "deleted" | "content" | "deletedAt" | "contentStripped">>,
	nowMs: number,
	maxAgeDays: number,
): string[] {
	if (!(maxAgeDays > 0)) return [];
	const cutoff = nowMs - maxAgeDays * DAY_MS;
	const out: string[] = [];
	for (const d of docs) {
		if (!d.deleted || d.contentStripped || !d.content) continue;
		const at = d.deletedAt ? Date.parse(d.deletedAt) : NaN;
		if (!Number.isFinite(at) || at > cutoff) continue;
		out.push(d.path);
	}
	return out;
}

/**
 * 한 링크의 보존 기간 경과 tombstone을 스트립하고, 같은 정책으로 그 경로의 버전 스냅샷도 정리.
 * (삭제 시점 버전 스냅샷은 이후 snapshot()이 없어 prune이 돌지 않아 영구 잔존하던 것을 함께 해소.)
 * 스트립 수를 반환. 멱등 — contentStripped 플래그로 재처리하지 않는다.
 */
export async function sweepTombstones(ctx: MirrorContext, maxAgeDays: number): Promise<number> {
	const notes = await ctx.pouch.allNotes();
	const targets = selectTombstonesToStrip(notes, Date.now(), maxAgeDays);
	let stripped = 0;
	for (const dbPath of targets) {
		const doc = await ctx.pouch.get<NoteDoc>(noteId(dbPath));
		if (!doc?.deleted || doc.contentStripped || !doc.content) continue; // 그 사이 변경 — 건너뜀
		// version·mtime·contentHash·lastModified*는 유지(부활 판정·에코 차단 보존). content만 비운다.
		await ctx.pouch.put({ ...doc, content: "", contentStripped: true });
		await ctx.versions.prune(dbPath);
		stripped++;
	}
	return stripped;
}
