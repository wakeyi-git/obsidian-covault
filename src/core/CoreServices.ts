import { App } from "obsidian";
import { CoVaultSettings } from "../settings/types";
import { Logger } from "./log/Logger";
import { RemoteApplyGuard } from "./guard/RemoteApplyGuard";
import { PouchService } from "./couch/PouchService";
import { getSecretValue, COUCH_PASSWORD_ID } from "./secret";

/**
 * 역할 공통 core 서비스. 기술문서 §3 / §23.2.
 * mode들이 공유하는 logger, guard, 그리고 현재 설정으로 PouchService를 만드는 팩토리를 제공한다.
 * 동기화 엔진의 체크포인트(lastSeq)를 data.json에 throttle 저장하는 통로도 제공한다.
 */
export class CoreServices {
	/** 원격 적용 가드. release 지연은 업로드 debounce보다 길어야 에코를 확실히 무시한다. */
	readonly guard: RemoteApplyGuard;

	/** 실제 영속 함수. main이 주입한다(this.saveData(this.settings)). */
	save: () => Promise<void> = async () => {};

	/** 실시간 세션 중인 파일 판단(RealtimeManager 주입). 공존: 라이브 에디터를 덮지 않게. */
	isRealtimeActive: (localPath: string) => boolean = () => false;

	/** 현재 사용자의 공유 공간(교사=설정, 학생=shares 문서). 모드가 런타임에 채운다. RealtimeManager가 참조.
	 * kind="mirror"는 학생 개인 mirror의 1:1 실시간 공간(folder=""=학생 vault 전체일 수 있음). */
	sharedSpaces: Array<{ id: string; folder: string; token?: string; kind?: "share" | "homeroom" | "mirror" }> = [];

	/**
	 * 학급 공동 공간(homeroom)으로 지정된 공유 공간의 DB·폴더. 모드가 런타임에 채운다(교사=설정, 학생=shares).
	 * 알림장·수업안내·과제(공유) 등 학급 운영 기능이 이 폴더/DB를 기준으로 동작한다. 미지정이면 null.
	 */
	homeroom: { remoteDb: string; folder: string } | null = null;

	/** 피드백 문서(§19.5) 변경 알림. main이 FeedbackStore에 연결. 링크의 LocalApplier가 호출. */
	onFeedbackChange: () => void = () => {};

	/** 학급 운영(대시보드) 문서 변경 알림. main이 ClassroomStore에 연결. */
	onClassroomChange: () => void = () => {};

	private persistTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly persistDelayMs = 1500;

	constructor(
		public readonly app: App,
		public settings: CoVaultSettings,
		public readonly logger: Logger,
	) {
		this.guard = new RemoteApplyGuard(Math.max(5000, settings.debounceMs + 3000));
	}

	/** 현재 설정 기준으로 mirror DB(PouchService)를 생성. */
	createPouch(dbName?: string): PouchService {
		const s = this.settings;
		const db = dbName ?? s.remoteDb;
		// 비밀번호는 Secret Storage 우선, 미지원 환경은 평문 폴백.
		const password = getSecretValue(this.app, COUCH_PASSWORD_ID, s.password);
		return new PouchService(s.couchdbUrl, db, s.username, password, this.localDbName(db));
	}

	/**
	 * 로컬 PouchDB 이름. 같은 origin(app://obsidian.md)에서 IndexedDB가 vault 간 공유될 수 있으므로
	 * vault 식별자를 포함해 충돌을 막는다(같은 기기에서 학생/교사 vault를 동시에 띄우는 경우 등).
	 */
	private localDbName(db: string): string {
		const vaultKey = (this.app as any).appId ?? this.app.vault.getName();
		return `covault_${vaultKey}_${db}`;
	}

	/** 잦은 체크포인트 갱신을 모아 저장(과도한 디스크 쓰기 방지). */
	requestPersist(): void {
		if (this.persistTimer) return;
		this.persistTimer = setTimeout(() => {
			this.persistTimer = null;
			void this.save();
		}, this.persistDelayMs);
	}

	/** 대기 중인 저장을 즉시 반영(stop/unload 시). */
	async flushPersist(): Promise<void> {
		if (this.persistTimer) {
			clearTimeout(this.persistTimer);
			this.persistTimer = null;
		}
		await this.save();
	}

	dispose(): void {
		if (this.persistTimer) {
			clearTimeout(this.persistTimer);
			this.persistTimer = null;
		}
		this.guard.dispose();
	}
}
