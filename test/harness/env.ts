// 통합 테스트용 "디바이스" 배선. 실제 동기화 엔진을 인메모리 vault + 인메모리 PouchDB로 구동한다.
// 같은 namespace(ns) + remoteDb를 공유하는 디바이스들은 같은 "원격"을 통해 replication한다.
import { CoreServices } from "../../src/core/CoreServices";
import { MirrorContext } from "../../src/core/sync/MirrorContext";
import { MirrorApplier } from "../../src/core/sync/MirrorApplier";
import { ConflictManager } from "../../src/core/sync/ConflictManager";
import { Uploader } from "../../src/core/sync/Uploader";
import { FullSync } from "../../src/core/sync/FullSync";
import { DEFAULT_SETTINGS, CoVaultSettings, Role } from "../../src/settings/types";
import { noteId, assetId, NoteDoc, AssetDoc } from "../../src/core/model/types";
import { makeApp, InMemoryVault } from "./vault";

export interface LogEntry {
	level: "info" | "ok" | "warn" | "error";
	message: string;
}

function makeLogger(log: LogEntry[]) {
	const push = (level: LogEntry["level"]) => (message: string) => {
		log.push({ level, message });
	};
	return {
		info: push("info"),
		ok: push("ok"),
		warn: push("warn"),
		error: push("error"),
		log: () => {},
		subscribe: () => () => {},
		clear: () => {},
	} as any;
}

export interface DeviceOpts {
	deviceId: string;
	role?: Role;
	userId?: string;
	remoteDb?: string;
	memberId?: string;
	localRoot?: string;
	childRoots?: string[];
	settings?: Partial<CoVaultSettings>;
}

export class Device {
	readonly settings: CoVaultSettings;
	readonly vault: InMemoryVault;
	readonly core: CoreServices;
	readonly ctx: MirrorContext;
	readonly conflicts: ConflictManager;
	readonly applier: MirrorApplier;
	readonly uploader: Uploader;
	readonly fullSync: FullSync;
	readonly log: LogEntry[] = [];

	constructor(ns: string, opts: DeviceOpts) {
		const remoteDb = opts.remoteDb ?? "mirror_test";
		const localRoot = opts.localRoot ?? "";
		this.settings = {
			...DEFAULT_SETTINGS,
			role: opts.role ?? "manager",
			workspaceId: "class_test",
			userId: opts.userId ?? opts.deviceId,
			deviceId: opts.deviceId,
			couchdbUrl: `mem://${ns}`,
			username: "u",
			password: "p",
			remoteDb,
			lastSeqByDb: {},
			...opts.settings,
		};
		const { app, vault } = makeApp(`${ns}-${opts.deviceId}`, `vault-${opts.deviceId}`);
		this.vault = vault;
		this.core = new CoreServices(app as any, this.settings, makeLogger(this.log));
		const pouch = this.core.createPouch(remoteDb);
		this.ctx = new MirrorContext(
			this.core,
			opts.memberId ?? "member_a",
			"학생A",
			localRoot,
			remoteDb,
			pouch,
			opts.childRoots ?? [],
		);
		this.conflicts = new ConflictManager(this.ctx);
		this.applier = new MirrorApplier(this.ctx, this.conflicts);
		this.uploader = new Uploader(this.ctx);
		this.fullSync = new FullSync(this.ctx, this.applier, this.uploader);
	}

	// --- 전체 동기화 단축 ---
	sync(direction: "both" | "up" | "down" = "both"): Promise<void> {
		return this.fullSync.run(direction);
	}

	// --- replication 단축 ---
	push(): Promise<number> {
		return this.ctx.pouch.replicatePushOnce();
	}
	pull(): Promise<number> {
		return this.ctx.pouch.replicatePullOnce();
	}

	// --- 로컬 DB 조회(원격 상태는 observer 디바이스로 pull 후 확인) ---
	note(dbPath: string): Promise<(NoteDoc & { _rev?: string }) | null> {
		return this.ctx.pouch.get<NoteDoc>(noteId(dbPath));
	}
	asset(dbPath: string): Promise<(AssetDoc & { _rev?: string }) | null> {
		return this.ctx.pouch.get<AssetDoc>(assetId(dbPath));
	}

	async dispose(): Promise<void> {
		this.core.dispose();
		try {
			await this.ctx.pouch.close();
		} catch {
			/* noop */
		}
	}

	warnings(): string[] {
		return this.log.filter((l) => l.level === "warn").map((l) => l.message);
	}
}

/** 한 vault 안에서 여러 링크(개인 mirror + 공유 공간)를 구성할 때 쓰는 저수준 헬퍼. */
export function createCore(
	ns: string,
	deviceId: string,
	settingsOverride: Partial<CoVaultSettings> = {},
): { core: CoreServices; vault: InMemoryVault; log: LogEntry[] } {
	const log: LogEntry[] = [];
	const settings: CoVaultSettings = {
		...DEFAULT_SETTINGS,
		role: "manager",
		workspaceId: "class_test",
		userId: deviceId,
		deviceId,
		couchdbUrl: `mem://${ns}`,
		username: "u",
		password: "p",
		lastSeqByDb: {},
		...settingsOverride,
	};
	const { app, vault } = makeApp(`${ns}-${deviceId}`, `vault-${deviceId}`);
	const core = new CoreServices(app as any, settings, makeLogger(log));
	return { core, vault, log };
}

export interface Link {
	ctx: MirrorContext;
	conflicts: ConflictManager;
	applier: MirrorApplier;
	uploader: Uploader;
	fullSync: FullSync;
}

/** 주어진 core(=vault) 위에 하나의 동기화 링크를 구성한다. */
export function buildLink(
	core: CoreServices,
	opts: { memberId?: string; localRoot: string; remoteDb: string; childRoots?: string[] },
): Link {
	const pouch = core.createPouch(opts.remoteDb);
	const ctx = new MirrorContext(
		core,
		opts.memberId ?? "member_a",
		"학생A",
		opts.localRoot,
		opts.remoteDb,
		pouch,
		opts.childRoots ?? [],
	);
	const conflicts = new ConflictManager(ctx);
	const applier = new MirrorApplier(ctx, conflicts);
	const uploader = new Uploader(ctx);
	const fullSync = new FullSync(ctx, applier, uploader);
	return { ctx, conflicts, applier, uploader, fullSync };
}

let nsCounter = 0;

/** 같은 원격을 공유하는 디바이스 묶음. 테스트마다 새 namespace로 격리한다. */
export class Cluster {
	readonly ns: string;
	private devices: Device[] = [];
	constructor() {
		this.ns = `ns${nsCounter++}`;
	}
	device(opts: DeviceOpts): Device {
		const d = new Device(this.ns, opts);
		this.devices.push(d);
		return d;
	}
	async dispose(): Promise<void> {
		await Promise.all(this.devices.map((d) => d.dispose()));
	}
}
