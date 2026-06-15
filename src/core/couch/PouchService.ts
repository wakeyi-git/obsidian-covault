import PouchDB from "pouchdb-browser";
import { NoteDoc, AssetDoc, PouchDocBase } from "../model/types";
import { createObsidianFetch } from "./obsidianFetch";
import { isOverLimitAsset } from "../sync/attachment";

/**
 * PouchDB 기반 동기화 서비스. 기술문서 §23.4 CouchClient 역할을 대체한다.
 *
 * 오프라인 우선 구조:
 *  - 로컬 PouchDB(IndexedDB)에 읽고 쓴다.
 *  - 로컬 ↔ 원격은 live sync(retry:true)가 자동으로 맞춘다(오프라인 큐·재연결·충돌 리비전).
 *  - 따라서 네트워크가 끊겨도 로컬 쓰기는 큐에 쌓였다가 재연결 시 전파되고,
 *    동시 편집은 PouchDB의 _conflicts(리비전 충돌)로 정확히 감지된다.
 *
 * 연결/권한 테스트(ping/rawInfo)만 원격을 직접 본다. 모바일 CORS는 createObsidianFetch로 우회.
 */

export interface ChangeEvent<T = any> {
	id: string;
	deleted: boolean;
	doc?: T;
	seq: number | string;
}

export interface LiveHandle {
	cancel(): void;
}

export interface ReplicationHandlers {
	onChange?: (direction: "push" | "pull", docs: number) => void;
	onPaused?: (err?: unknown) => void;
	onActive?: () => void;
	onError?: (e: Error) => void;
	onDenied?: (e: unknown) => void;
}

export class PouchService {
	private remote: PouchDB.Database;
	private local: PouchDB.Database | null = null;
	private replication: PouchDB.Replication.Sync<{}> | null = null;
	private readonly fetchImpl: typeof fetch;
	/** 복제에서 제외할 첨부 크기 한도(바이트). 0이면 무제한(필터 없음). setMaxAttachmentBytes로 주입. */
	private maxAttachmentBytes = 0;

	constructor(
		private baseUrl: string,
		private dbName: string,
		username: string,
		password: string,
		private localDbName: string,
	) {
		this.fetchImpl = createObsidianFetch(username, password);
		this.remote = this.openRemote();
	}

	private remoteUrl(): string {
		const base = this.baseUrl.replace(/\/+$/, "");
		return `${base}/${encodeURIComponent(this.dbName)}`;
	}

	private openRemote(): PouchDB.Database {
		return new PouchDB(this.remoteUrl(), {
			fetch: (url: string | Request, opts?: RequestInit) => this.fetchImpl(url as RequestInfo, opts),
			skip_setup: true,
		} as PouchDB.Configuration.RemoteDatabaseConfiguration);
	}

	/** 로컬 PouchDB(지연 생성). vault별로 이름이 달라 같은 기기 다중 vault에서도 충돌하지 않는다. */
	private localDb(): PouchDB.Database {
		if (!this.local) this.local = new PouchDB(this.localDbName);
		return this.local;
	}

	// --- 연결/권한 테스트 (원격 직접) ---

	async ping(): Promise<{ ok: boolean; info?: PouchDB.Core.DatabaseInfo; error?: string }> {
		try {
			const info = await this.remote.info();
			return { ok: true, info };
		} catch (e: any) {
			return { ok: false, error: describeError(e) };
		}
	}

	async rawInfo(): Promise<{ status: number; length: number; snippet: string }> {
		const resp = await this.fetchImpl(this.remoteUrl(), { method: "GET" });
		const text = await resp.text();
		return { status: resp.status, length: text.length, snippet: text.slice(0, 200) };
	}

	/**
	 * 원격 쓰기 권한 프로브. _local 문서를 잠깐 PUT 후 remove(영구 데이터·replication에 영향 없음).
	 * 401/403이면 쓰기 권한 없음. 진단용. 기술문서 §22.3.
	 */
	async probeWrite(): Promise<{ ok: boolean; status?: number; error?: string }> {
		const id = "_local/covault_probe";
		try {
			const existing = (await this.remote.get(id).catch(() => null)) as { _rev?: string } | null;
			const res = await this.remote.put({ _id: id, _rev: existing?._rev, t: Date.now() } as any);
			await this.remote.remove(id, res.rev).catch(() => undefined);
			return { ok: true };
		} catch (e: any) {
			return { ok: false, status: e?.status, error: describeError(e) };
		}
	}

	// --- 로컬 DB 읽기/쓰기 ---

	async get<T extends PouchDocBase>(id: string): Promise<(T & PouchDB.Core.IdMeta & PouchDB.Core.GetMeta) | null> {
		try {
			return (await this.localDb().get(id)) as unknown as T & PouchDB.Core.IdMeta & PouchDB.Core.GetMeta;
		} catch (e: any) {
			if (e?.status === 404) return null;
			throw e;
		}
	}

	/** _conflicts 포함 조회(충돌 감지용). */
	async getWithConflicts<T extends PouchDocBase>(
		id: string,
	): Promise<(T & PouchDB.Core.IdMeta & PouchDB.Core.GetMeta & { _conflicts?: string[] }) | null> {
		try {
			return (await this.localDb().get(id, { conflicts: true })) as any;
		} catch (e: any) {
			if (e?.status === 404) return null;
			throw e;
		}
	}

	/** 특정 리비전 조회(충돌 사본 비교용). */
	async getRev<T extends PouchDocBase>(id: string, rev: string): Promise<T | null> {
		return (await this.localDb().get(id, { rev }).catch(() => null)) as unknown as T | null;
	}

	/** 로컬 upsert. 기존 _rev를 붙여 갱신, 409 시 1회 재시도. */
	async put<T extends PouchDocBase>(doc: T): Promise<T & { _rev: string }> {
		const db = this.localDb();
		const existing = await this.get<T>(doc._id);
		const toPut = existing ? { ...doc, _rev: existing._rev } : { ...doc };
		try {
			const res = await db.put(toPut as any);
			return { ...doc, _rev: res.rev };
		} catch (e: any) {
			if (e?.status === 409) {
				const current = await this.get<T>(doc._id);
				const res = await db.put({ ...doc, _rev: current?._rev } as any);
				return { ...doc, _rev: res.rev };
			}
			throw e;
		}
	}

	/**
	 * rev 검증 upsert(평가 L-1·L-3). put()의 409 재시도는 최신 rev 위에 무조건 덮어쓰는 LWW라,
	 * 읽기→쓰기 사이에 끼어든 원격 변경(특히 tombstone)을 검증 없이 덮을 수 있다. 이 변형은
	 * 호출측이 읽었던 rev(생성이면 undefined)로만 put하고, 그 사이 문서가 바뀌었으면 "conflict"를
	 * 반환한다 — 호출측이 전제조건(부활 규칙·해시 동일 등)을 재검증하고 재시도한다.
	 */
	async putWithRev<T extends PouchDocBase>(doc: T, expectedRev: string | undefined): Promise<"ok" | "conflict"> {
		const toPut = expectedRev ? { ...doc, _rev: expectedRev } : { ...doc, _rev: undefined };
		try {
			await this.localDb().put(toPut as any);
			return "ok";
		} catch (e: any) {
			if (e?.status === 409) return "conflict";
			throw e;
		}
	}

	/** putAsset의 rev 검증 변형(첨부 포함). putWithRev와 동일 계약. */
	async putAssetWithRev(doc: AssetDoc, data: ArrayBuffer, expectedRev: string | undefined): Promise<"ok" | "conflict"> {
		const full: any = {
			...doc,
			...(expectedRev ? { _rev: expectedRev } : {}),
			_attachments: { data: { content_type: doc.mime, data: abToBase64(data) } },
		};
		try {
			await this.localDb().put(full);
			return "ok";
		} catch (e: any) {
			if (e?.status === 409) return "conflict";
			throw e;
		}
	}

	/** 특정 리비전 제거(충돌 해소용). */
	async removeRev(id: string, rev: string): Promise<void> { await this.localDb().remove(id, rev); }

	/** 로컬 note 문서 전체. */
	async allNotes(): Promise<NoteDoc[]> {
		const res = await this.localDb().allDocs<NoteDoc>({
			include_docs: true,
			startkey: "note:",
			endkey: "note:￿",
		});
		return res.rows.map((r) => r.doc).filter((d): d is NoteDoc & PouchDB.Core.IdMeta & PouchDB.Core.RevisionIdMeta => !!d);
	}

	/** _conflicts(리비전 충돌)가 있는 note 문서 목록. 충돌 해소 UI용. 기술문서 §14. */
	async listConflicts(): Promise<Array<{ doc: NoteDoc; winnerRev: string; conflictRevs: string[] }>> {
		const res = await this.localDb().allDocs<NoteDoc>({
			include_docs: true,
			conflicts: true,
			startkey: "note:",
			endkey: "note:￿",
		});
		const out: Array<{ doc: NoteDoc; winnerRev: string; conflictRevs: string[] }> = [];
		for (const row of res.rows) {
			const doc = row.doc as (NoteDoc & { _rev?: string; _conflicts?: string[] }) | undefined;
			if (doc && Array.isArray(doc._conflicts) && doc._conflicts.length > 0) {
				out.push({ doc, winnerRev: doc._rev ?? "", conflictRevs: doc._conflicts });
			}
		}
		return out;
	}

	/** _conflicts(리비전 충돌)가 있는 asset(첨부) 문서 목록. 첨부 충돌 해소 UI용. */
	async listAssetConflicts(): Promise<Array<{ doc: AssetDoc; winnerRev: string; conflictRevs: string[] }>> {
		const res = await this.localDb().allDocs<AssetDoc>({
			include_docs: true,
			conflicts: true,
			startkey: "asset:",
			endkey: "asset:￿",
		});
		const out: Array<{ doc: AssetDoc; winnerRev: string; conflictRevs: string[] }> = [];
		for (const row of res.rows) {
			const doc = row.doc as (AssetDoc & { _rev?: string; _conflicts?: string[] }) | undefined;
			if (doc && Array.isArray(doc._conflicts) && doc._conflicts.length > 0) {
				out.push({ doc, winnerRev: doc._rev ?? "", conflictRevs: doc._conflicts });
			}
		}
		return out;
	}

	/**
	 * prefix 문서 중 **id 내림차순 최근 limit건**(deleted 제외, 반환은 오래된→최신) — 채팅 최근 N건(평가 P-2).
	 * 메시지 id는 base36 타임스탬프 prefix라 id 순서 = 시간 순서. deleted(tombstone)를 건너뛰며
	 * limit을 채울 때까지 페이지를 내려간다 — 채널 전체를 적재하지 않는다.
	 */
	async recentDocsByPrefix<T extends PouchDocBase & { deleted?: boolean }>(prefix: string, limit: number): Promise<T[]> {
		const out: T[] = [];
		let startkey = `${prefix}￿`;
		let skip = 0;
		while (out.length < limit) {
			const page = Math.max(limit - out.length + 10, 30);
			const res = await this.localDb().allDocs<T>({
				include_docs: true,
				descending: true,
				startkey,
				endkey: prefix,
				limit: page,
				skip, // 두 번째 페이지부터 경계 키 자신 제외
			});
			if (res.rows.length === 0) break;
			for (const row of res.rows) {
				const d = row.doc as T | undefined;
				if (d && !d.deleted) {
					out.push(d);
					if (out.length >= limit) break;
				}
			}
			if (res.rows.length < page) break; // 더 없음
			startkey = res.rows[res.rows.length - 1].key;
			skip = 1;
		}
		return out.reverse();
	}

	/** prefix로 시작하는 로컬 문서 전체(예: 피드백 feedback:<dbPath>:). */
	async allDocsByPrefix<T extends PouchDocBase>(prefix: string): Promise<T[]> {
		const res = await this.localDb().allDocs<T>({
			include_docs: true,
			startkey: prefix,
			endkey: `${prefix}￿`,
		});
		const out: T[] = [];
		for (const row of res.rows) {
			const d = (row as any).doc;
			if (d) out.push(d as T);
		}
		return out;
	}

	/** 로컬 변경 구독(라이브). conflicts:true로 충돌 정보를 함께 받는다. */
	localChanges<T = any>(
		onChange: (change: ChangeEvent<T>) => void,
		opts: { since?: number | string; onError?: (e: Error) => void } = {},
	): LiveHandle {
		const feed = this.localDb()
			.changes({
				live: true,
				since: opts.since ?? 0,
				include_docs: true,
				conflicts: true,
				return_docs: false,
			})
			.on("change", (change: any) => {
				onChange({ id: change.id, deleted: !!change.deleted, doc: change.doc as T, seq: change.seq });
			})
			.on("error", (e: any) => {
				opts.onError?.(e instanceof Error ? e : new Error(describeError(e)));
			});
		return { cancel: () => feed.cancel() };
	}

	/** 로컬 changes 체크포인트(재시작 시 증분 적용용). */
	async currentLocalSeq(): Promise<string> {
		const info = await this.localDb().info();
		return String(info.update_seq ?? "0");
	}

	// --- 첨부파일(asset) ---

	/** asset 문서 + 바이너리 첨부 upsert. 기술문서 §8.2. */
	async putAsset(doc: AssetDoc, data: ArrayBuffer): Promise<void> {
		const db = this.localDb();
		const existing = await this.get<AssetDoc>(doc._id);
		const full: any = {
			...doc,
			...(existing?._rev ? { _rev: existing._rev } : {}),
			_attachments: { data: { content_type: doc.mime, data: abToBase64(data) } },
		};
		try {
			await db.put(full);
		} catch (e: any) {
			if (e?.status === 409) {
				const cur = await this.get<AssetDoc>(doc._id);
				await db.put({ ...full, _rev: cur?._rev });
			} else throw e;
		}
	}

	/** asset 첨부 바이너리 조회. */
	async getAssetBinary(id: string): Promise<ArrayBuffer | null> {
		try {
			const blob: any = await this.localDb().getAttachment(id, "data");
			if (!blob) return null;
			if (typeof blob.arrayBuffer === "function") return await blob.arrayBuffer(); // Blob
			return blob as ArrayBuffer;
		} catch (e: any) {
			if (e?.status === 404) return null;
			throw e;
		}
	}

	/** 특정 리비전의 asset 첨부 바이너리 조회(충돌 leaf 비교용 — 실제 원격본 선택). */
	async getAssetBinaryRev(id: string, rev: string): Promise<ArrayBuffer | null> {
		try {
			const blob: any = await this.localDb().getAttachment(id, "data", { rev } as any);
			if (!blob) return null;
			if (typeof blob.arrayBuffer === "function") return await blob.arrayBuffer();
			return blob as ArrayBuffer;
		} catch (e: any) {
			if (e?.status === 404) return null;
			throw e;
		}
	}

	/** asset 문서 전체(메타데이터). */
	async allAssets(): Promise<AssetDoc[]> {
		const res = await this.localDb().allDocs({
			include_docs: true,
			startkey: "asset:",
			endkey: "asset:￿",
		});
		const out: AssetDoc[] = [];
		for (const row of res.rows) {
			const d = (row as any).doc;
			if (d) out.push(d as AssetDoc);
		}
		return out;
	}

	// --- 로컬 ↔ 원격 live replication ---

	/** 복제 단계에서 한도 초과 첨부를 제외하기 위한 크기 한도(MB) 주입. 0/음수면 무제한. */
	setMaxAttachmentBytes(maxMB: number): void { this.maxAttachmentBytes = maxMB > 0 ? maxMB * 1024 * 1024 : 0; }

	/**
	 * 복제 옵션(필터). 한도 초과 첨부(asset 문서)는 push/pull 어느 방향으로도 복제하지 않는다.
	 *
	 * 이미 DB에 박힌 대용량 첨부를 push할 때 PouchDB가 바이너리를 통째 메모리에 버퍼링해 앱이
	 * 멈추고(0.125.x 현장 하드 프리즈) CouchDB도 질식해 502를 낸다. applyAsset 수신 게이트는
	 * 본문을 받은 뒤라 늦으므로, 복제 진입 자체를 막는다. size는 asset 문서의 메타데이터.
	 * (한도 미설정 시 빈 옵션 → 거동 불변.)
	 */
	private replicateOpts(): { filter?: (doc: any) => boolean } {
		const maxBytes = this.maxAttachmentBytes;
		if (maxBytes <= 0) return {};
		return { filter: (doc: any) => !isOverLimitAsset(doc, maxBytes) };
	}

	/** 1회성 push만(로컬→원격). 수동 "업로드만"에서 원격 변경을 끌어오지 않기 위해 사용. */
	async replicatePushOnce(): Promise<number> {
		return (await this.localDb().replicate.to(this.remote, this.replicateOpts()))?.docs_written ?? 0;
	}

	/** 1회성 pull만(원격→로컬). 수동 "다운로드만"에서 로컬 변경을 밀어올리지 않기 위해 사용. */
	async replicatePullOnce(): Promise<number> {
		return (await this.localDb().replicate.from(this.remote, this.replicateOpts()))?.docs_written ?? 0;
	}

	/** 원격에 **살아있는**(tombstone 제외) 모든 문서 id. 정합 복구가 원격을 직접 보고 고아를 찾을 때 사용
	 *  — 로컬 체크포인트가 뒤처져도 원격 실제 상태를 본다. allDocs는 deleted를 제외하므로 곧 live 목록. */
	async remoteLiveDocIds(): Promise<string[]> {
		// soft-delete(deleted=true 필드)는 allDocs에 남으므로 include_docs로 받아 제외(복구 반복 검출 방지).
		const res = await this.remote.allDocs<{ deleted?: boolean }>({ include_docs: true });
		return res.rows.filter((r) => r.doc && !r.doc.deleted).map((r) => r.id);
	}

	/** 원격 문서를 현재 원격 rev 위에 직접 tombstone(정합 복구용) — 로컬 분기 충돌·누락이 있어도 원격 live를
	 *  확실히 덮어 재생을 막는다. patch=deleted 외 메타. 이미 없음/삭제/거부 시 false(관리자 admin이라 통과). */
	async tombstoneRemoteDoc(id: string, patch: Record<string, unknown>): Promise<boolean> {
		const cur = (await this.remote.get(id).catch(() => null)) as (Record<string, unknown> & { deleted?: boolean; version?: number }) | null;
		if (!cur || cur.deleted) return false;
		const doc: Record<string, unknown> = { ...cur, deleted: true, version: (cur.version ?? 0) + 1, ...patch };
		delete doc._attachments;
		try {
			await this.remote.put(doc as PouchDB.Core.PutDocument<Record<string, unknown>>);
			return true;
		} catch {
			return false;
		}
	}

	/** 1회성 양방향 동기화(push 후 pull). 자동 동기화가 꺼진 상태의 수동 전체 동기화에 사용. */
	async replicateOnce(): Promise<{ pushed: number; pulled: number }> {
		return { pushed: await this.replicatePushOnce(), pulled: await this.replicatePullOnce() };
	}

	/** 양방향 live 동기화 시작. retry:true로 오프라인/재연결을 자동 처리. */
	startReplication(handlers: ReplicationHandlers = {}): void {
		if (this.replication) return;
		this.replication = this.localDb()
			.sync(this.remote, { live: true, retry: true, ...this.replicateOpts() })
			.on("change", (info: any) => handlers.onChange?.(info.direction, info.change?.docs_written ?? 0))
			.on("paused", (err: any) => handlers.onPaused?.(err))
			.on("active", () => handlers.onActive?.())
			.on("denied", (e: any) => handlers.onDenied?.(e))
			.on("error", (e: any) => handlers.onError?.(e instanceof Error ? e : new Error(describeError(e)))) as any;
	}

	/** 로컬 PouchDB(IndexedDB)를 완전 삭제. 원격을 비운 뒤 깨끗이 다시 받기 위함. */
	async destroyLocal(): Promise<void> {
		this.stopReplication();
		const db = this.localDb();
		await db.destroy(); // IndexedDB 제거 + 닫힘
		this.local = null;
	}

	/** live replication만 중지(로컬/원격 DB는 유지). 인증 실패 시 재시도 폭주를 막는 데 사용. */
	stopReplication(): void {
		if (this.replication) {
			try {
				this.replication.cancel();
			} catch {
				/* noop */
			}
			this.replication = null;
		}
	}

	async close(): Promise<void> {
		this.stopReplication();
		try {
			await this.remote.close();
		} catch {
			/* noop */
		}
		if (this.local) {
			try {
				await this.local.close();
			} catch {
				/* noop */
			}
			this.local = null;
		}
	}
}

/** ArrayBuffer → base64 (청크 처리로 대용량 스택오버플로 방지). */
function abToBase64(buf: ArrayBuffer): string {
	const bytes = new Uint8Array(buf);
	const chunk = 0x8000;
	let binary = "";
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
	}
	return btoa(binary);
}

function describeError(e: any): string {
	if (!e) return "unknown error";
	const status = e.status ? `${e.status} ` : "";
	const name = e.name ? `${e.name}: ` : "";
	return `${status}${name}${e.message ?? e.reason ?? String(e)}`;
}
