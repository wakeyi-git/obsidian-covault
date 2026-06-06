import { CoreServices } from "../CoreServices";
import { PouchService } from "../couch/PouchService";
import { PouchDocBase } from "../model/types";

/**
 * 학급 운영(대시보드) 공통 문서 저장소. 학급(homeroom) 공유 공간의 pouch에 알림장·시간표·응답·루틴 정의 등을
 * 읽고 쓴다(FeedbackStore와 같은 패턴). 동기화는 기존 replication이 처리하고, 원격 변경은 LocalApplier가
 * refresh로 알려 패널을 갱신한다. 학급 공간이 아직 배포/수신되지 않았으면 ready()=false.
 */
export class ClassroomStore {
	private listeners = new Set<() => void>();

	constructor(
		private core: CoreServices,
		/** 학급 공유 공간의 pouch(미프로비저닝/미수신이면 undefined). 모드의 동기화 링크에서 해석한다. */
		private homeroom: () => PouchService | undefined,
	) {}

	/** 현재 설정(문서 생성 시 workspaceId/userId/role 등). */
	get settings() {
		return this.core.settings;
	}

	onChange(cb: () => void): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}

	private notify(): void {
		for (const cb of this.listeners) cb();
	}

	/** 원격 변경 알림으로 패널 새로고침(main이 core.onClassroomChange에 연결). */
	refresh(): void {
		this.notify();
	}

	/** 학급 공유 공간이 준비됐는지(교사 배포 + 동기화 링크 존재). */
	ready(): boolean {
		return !!this.homeroom();
	}

	async put<T extends PouchDocBase>(doc: T): Promise<boolean> {
		const p = this.homeroom();
		if (!p) return false;
		await p.put(doc);
		this.notify();
		return true;
	}

	async get<T extends PouchDocBase>(id: string): Promise<T | null> {
		const p = this.homeroom();
		if (!p) return null;
		return (await p.get<T>(id)) as T | null;
	}

	async listByPrefix<T extends PouchDocBase>(prefix: string): Promise<T[]> {
		const p = this.homeroom();
		if (!p) return [];
		return p.allDocsByPrefix<T>(prefix);
	}

	/** soft delete(tombstone) — deleted=true로 표시해 동기화. */
	async softDelete<T extends PouchDocBase & { deleted?: boolean }>(doc: T): Promise<boolean> {
		return this.put({ ...doc, deleted: true });
	}
}
