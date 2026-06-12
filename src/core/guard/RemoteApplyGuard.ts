/**
 * Remote Apply Guard. 기술문서 §16.2.
 *
 * 원격 변경을 로컬 파일에 쓰면 Obsidian의 modify 이벤트가 발생한다.
 * 그 이벤트를 다시 업로드하면 무한 루프가 생긴다.
 * 원격 반영 직전 (path, hash)를 등록해 두고, 동일한 변경으로 발생한
 * 파일 이벤트는 무시한다.
 */
export class RemoteApplyGuard {
	private marks = new Map<string, string>();
	private timers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly releaseDelayMs: number;

	constructor(releaseDelayMs = 1500) {
		this.releaseDelayMs = releaseDelayMs;
	}

	/** 원격 반영 직전 호출: 이 path/hash로 들어올 파일 이벤트를 무시 대상으로 등록. */
	mark(localPath: string, contentHash: string): void {
		this.marks.set(localPath, contentHash);
	}

	/** 파일 이벤트 처리 시 호출: 등록된 원격 적용분이면 true (=> 업로드 건너뜀). */
	shouldIgnore(localPath: string, contentHash: string): boolean {
		return this.marks.get(localPath) === contentHash;
	}

	/**
	 * 이 경로에 mark가 살아 있는가(해시 무관 — 평가 P-3). watcher가 "최근 applier 쓰기가 없던 경로"의
	 * 이벤트에서 해시 계산을 통째로 건너뛰는 빠른 사전 판정용 — echo 판별(해시 비교)은 mark가 있을 때만 필요하다.
	 */
	isMarked(localPath: string): boolean {
		return this.marks.has(localPath);
	}

	/** 일정 시간 후 mark 해제 (이벤트가 비동기로 도착하는 점 대비). */
	releaseAfterDelay(localPath: string): void {
		const existing = this.timers.get(localPath);
		if (existing) clearTimeout(existing);
		const timer = setTimeout(() => {
			this.marks.delete(localPath);
			this.timers.delete(localPath);
		}, this.releaseDelayMs);
		this.timers.set(localPath, timer);
	}

	/** 즉시 해제. */
	release(localPath: string): void {
		const existing = this.timers.get(localPath);
		if (existing) clearTimeout(existing);
		this.timers.delete(localPath);
		this.marks.delete(localPath);
	}

	/** plugin unload 시 정리. */
	dispose(): void {
		for (const t of this.timers.values()) clearTimeout(t);
		this.timers.clear();
		this.marks.clear();
	}
}
