import { MirrorContext } from "./MirrorContext";
import { VersionDoc, VersionKind, NoteDoc, noteId, versionId, versionPrefix } from "../model/types";
import { sha256 } from "../hash/hash";
import { selectVersionsToPrune, DAY_MS } from "./versionRetention";
import { t } from "../../i18n";

/**
 * 사용자용 버전 히스토리(마크다운 전용). 보고서 §1 P1.
 *
 * 내부 정합용 note.version과 별개로, 사용자가 과거 내용을 보고 복원할 수 있는 스냅샷을
 * 링크 DB에 `version:<dbPath>:<ms>` 문서로 저장한다(복제됨 → 교사·타 기기 공유).
 * 보존 한도(최근 N개 또는 N일)를 넘으면 자동 정리한다.
 */
export class VersionStore {
	constructor(private ctx: MirrorContext) {}

	// 빠른 연속 스냅샷이 같은 ms를 받아 id가 충돌하지 않도록 단조 증가 타임스탬프를 쓴다.
	private static lastMs = 0;
	private nextMs(): number {
		VersionStore.lastMs = Math.max(Date.now(), VersionStore.lastMs + 1);
		return VersionStore.lastMs;
	}

	private get enabled(): boolean {
		return this.ctx.settings.versionHistory !== false;
	}

	/** 마크다운 내용 스냅샷을 기록(비활성·비-md면 무시). 기록 후 보존 한도 정리. */
	async snapshot(dbPath: string, content: string, kind: VersionKind, versionOf: number): Promise<void> {
		const ctx = this.ctx;
		if (!this.enabled || !ctx.isMarkdown(dbPath) || content == null) return;
		const now = this.nextMs();
		const s = ctx.settings;
		const doc: VersionDoc = {
			_id: versionId(dbPath, now),
			type: "version",
			schemaVersion: 1,
			workspaceId: s.workspaceId,
			memberId: ctx.memberId,
			path: dbPath,
			versionOf,
			content,
			contentHash: await sha256(content),
			kind,
			createdAt: new Date(now).toISOString(),
			createdAtMs: now,
			createdBy: s.userId,
			role: s.role,
			deviceId: s.deviceId,
		};
		try {
			// 동일 ms 충돌은 드물지만, 직전 스냅샷과 내용이 같으면 중복 기록하지 않는다.
			const recent = await this.list(dbPath);
			if (recent[0]?.contentHash === doc.contentHash && recent[0]?.kind === kind) return;
			await ctx.pouch.put(doc);
			await this.prune(dbPath);
		} catch (e) {
			ctx.logger.warn(
				t("version.failed_to_record_version_snapshot", { path: dbPath, err: e instanceof Error ? e.message : String(e) }),
			);
		}
	}

	/** 한 파일의 버전 목록(최신순). */
	async list(dbPath: string): Promise<VersionDoc[]> {
		const docs = await this.ctx.pouch.allDocsByPrefix<VersionDoc>(versionPrefix(dbPath));
		return docs.sort((a, b) => b.createdAtMs - a.createdAtMs);
	}

	/** 보존 한도(최근 N개 또는 N일)를 넘는 버전 정리. */
	async prune(dbPath: string): Promise<void> {
		const ctx = this.ctx;
		const s = ctx.settings;
		const entries = (await this.list(dbPath)).map((d) => ({ id: d._id, createdAtMs: d.createdAtMs, rev: d._rev }));
		const remove = selectVersionsToPrune(entries, {
			maxCount: s.versionMaxCount ?? 10,
			maxAgeMs: (s.versionMaxAgeDays ?? 30) * DAY_MS,
			now: Date.now(),
		});
		for (const id of remove) {
			const rev = entries.find((e) => e.id === id)?.rev;
			if (rev) await ctx.pouch.removeRev(id, rev).catch(() => undefined);
		}
	}

	/** 특정 버전 내용을 현재 파일로 복원(deleted=false, note.version+1). */
	async restoreVersion(versionDocId: string, opts: { backupCurrent?: boolean } = {}): Promise<"restored" | "missing"> {
		const ctx = this.ctx;
		const v = await ctx.pouch.get<VersionDoc>(versionDocId);
		if (!v) return "missing";
		const dbPath = v.path;
		const localPath = ctx.toLocalPath(dbPath);

		// 현재 내용을 백업 스냅샷으로 남긴 뒤 복원(잘못 복원해도 되돌릴 수 있게).
		if (opts.backupCurrent) {
			const cur = await ctx.readVaultFile(localPath);
			if (cur != null) {
				const note = await ctx.pouch.get<NoteDoc>(noteId(dbPath));
				await this.snapshot(dbPath, cur, "restore", note?.version ?? 0);
			}
		}

		const prev = (await ctx.pouch.get<NoteDoc>(noteId(dbPath)))?.version ?? 0;
		const fresh = await ctx.buildNoteDoc(dbPath, v.content, prev);
		ctx.guard.mark(localPath, fresh.contentHash);
		await ctx.writeVaultFile(localPath, v.content);
		ctx.guard.releaseAfterDelay(localPath);
		await ctx.pouch.put(fresh);
		ctx.logger.ok(t("version.version_restored", { path: dbPath }), true);
		return "restored";
	}
}
