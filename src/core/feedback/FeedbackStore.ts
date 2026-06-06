import { CoreServices } from "../CoreServices";
import { MirrorSync } from "../sync/MirrorSync";
import { FeedbackDoc, FeedbackAnchor, feedbackId, FEEDBACK_ID_PREFIX } from "../model/types";

/** 전체 미해결 피드백함 항목(노트 경로·학생 포함). */
export interface FeedbackItem {
	doc: FeedbackDoc;
	localPath: string;
	memberName: string;
}

/**
 * 피드백 레이어(§19.5) 저장소. 대상 노트가 사는 DB(mirror_<id> 또는 share_<id>)에 feedback 문서를 읽고 쓴다.
 * 노트 경로 → 담당 MirrorSync 해석은 main이 주입한 resolver에 위임한다(현재 mode 기준).
 * 동기화는 기존 replication이 처리하고, 원격 변경은 LocalApplier가 onChange로 알려 패널을 갱신한다.
 */
export class FeedbackStore {
	private counter = 0;
	private listeners = new Set<() => void>();

	constructor(
		private core: CoreServices,
		/** 로컬 경로 → 담당 동기화 링크. 없으면(동기화 대상 밖) undefined. */
		private resolve: (localPath: string) => MirrorSync | undefined,
		/** 현재 모든 동기화 링크(전체 미해결 피드백함 집계용). */
		private allSyncs: () => MirrorSync[] = () => [],
	) {}

	/** 패널 새로고침 구독(LocalApplier의 원격 변경 + 로컬 쓰기 모두 알림). */
	onChange(cb: () => void): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}

	private notify(): void {
		for (const cb of this.listeners) cb();
	}

	/** 외부(원격 변경 알림)에서 패널 새로고침을 트리거. main이 core.onFeedbackChange에 연결. */
	refresh(): void {
		this.notify();
	}

	/** 동기화 대상 노트인가(피드백 추가 가능 여부). */
	canAnnotate(localPath: string): boolean {
		const sync = this.resolve(localPath);
		return !!sync && sync.ctx.toDbPath(localPath) != null;
	}

	/** 해당 노트의 피드백 목록(삭제 제외, 작성 시각순). */
	async listFor(localPath: string): Promise<FeedbackDoc[]> {
		const sync = this.resolve(localPath);
		if (!sync) return [];
		const dbPath = sync.ctx.toDbPath(localPath);
		if (dbPath == null) return [];
		const prefix = `${FEEDBACK_ID_PREFIX}${dbPath}:`;
		const docs = await sync.ctx.pouch.allDocsByPrefix<FeedbackDoc>(prefix);
		return docs.filter((d) => !d.deleted).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}

	/** 전체 링크의 **미해결** 피드백(노트 경로 포함, 최근 먼저). 교사가 흩어진 피드백을 한 번에 본다. */
	async listAllUnresolved(): Promise<FeedbackItem[]> {
		const out: FeedbackItem[] = [];
		for (const sync of this.allSyncs()) {
			let docs: FeedbackDoc[] = [];
			try {
				docs = await sync.ctx.pouch.allDocsByPrefix<FeedbackDoc>(FEEDBACK_ID_PREFIX);
			} catch {
				continue;
			}
			for (const d of docs) {
				if (d.deleted || d.resolved) continue;
				out.push({
					doc: d,
					localPath: sync.ctx.toLocalPath(d.targetPath),
					memberName: sync.memberName || sync.memberId,
				});
			}
		}
		out.sort((a, b) => b.doc.createdAt.localeCompare(a.doc.createdAt));
		return out;
	}

	/** 피드백 추가. 동기화 대상이 아니면 false. */
	async add(localPath: string, anchor: FeedbackAnchor, content: string): Promise<boolean> {
		const sync = this.resolve(localPath);
		if (!sync) return false;
		const dbPath = sync.ctx.toDbPath(localPath);
		if (dbPath == null) return false;
		const s = this.core.settings;
		const now = new Date().toISOString();
		const uid = `${Date.now().toString(36)}-${this.counter++}`;
		const doc: FeedbackDoc = {
			_id: feedbackId(dbPath, uid),
			type: "feedback",
			schemaVersion: 1,
			workspaceId: s.workspaceId,
			memberId: sync.memberId,
			targetPath: dbPath,
			content,
			anchor,
			createdBy: s.userId,
			createdByRole: s.role,
			createdAt: now,
			updatedAt: now,
			resolved: false,
		};
		await sync.ctx.pouch.put(doc);
		this.notify();
		return true;
	}

	/** 해결됨 토글. */
	async setResolved(localPath: string, doc: FeedbackDoc, resolved: boolean): Promise<void> {
		const sync = this.resolve(localPath);
		if (!sync) return;
		await sync.ctx.pouch.put({ ...doc, resolved, updatedAt: new Date().toISOString() });
		this.notify();
	}

	/** 삭제(tombstone). */
	async remove(localPath: string, doc: FeedbackDoc): Promise<void> {
		const sync = this.resolve(localPath);
		if (!sync) return;
		await sync.ctx.pouch.put({ ...doc, deleted: true, updatedAt: new Date().toISOString() });
		this.notify();
	}
}
