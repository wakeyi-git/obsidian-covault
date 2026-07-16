import { App } from "obsidian";
import { Logger } from "../core/log/Logger";
import { CoVaultSettings } from "../settings/types";
import { ClassroomStore } from "../core/classroom/ClassroomStore";
import { PluginDeployDoc, PLUGINDEPLOY_ID_PREFIX, pluginDeployId } from "../core/model/types";
import { deployContentHash, shouldOfferInstall, SETTINGS_FILE, validatePluginDeployDoc } from "../core/plugindeploy/pluginPolicy";
import {
	listInstalledCommunityPlugins,
	readInstalledPlugin,
	installDeployedPlugin,
	deployRunnableHere,
	InstalledPlugin,
} from "../core/plugindeploy/configInstall";
import { errMessage } from "../core/util/err";
import { t } from "../i18n";

/** 구성원 설치 확인 결과(모달). */
export type InstallChoice = "enable" | "install" | "later";

export interface PluginDeployDeps {
	app: App;
	logger: Logger;
	settings(): CoVaultSettings;
	saveSettings(): Promise<void>;
	/** 학급 공유 DB 저장소(homeroom pouch — plugindeploy 문서 보관). */
	classroom: ClassroomStore;
	/** 구성원 설치 확인 모달. 닫기/나중에=later. UI라 main이 구현. */
	confirmInstall(doc: PluginDeployDoc): Promise<InstallChoice>;
}

/**
 * 함께 쓰는 플러그인 배포 컨트롤러(정책 엔진 P2). 운영자는 자기 기기에 설치된 플러그인을 학급 공유 DB로
 * 배포하고, 구성원은 수신 시 확인 후 `.obsidian`에 설치한다. 모든 `.obsidian` 접근은 configInstall에 격리.
 */
export class PluginDeployController {
	constructor(private d: PluginDeployDeps) {}

	// --- 운영자(배포) ---

	/** 운영자 기기에 설치된 커뮤니티 플러그인 목록(CoVault 제외). */
	listInstalled(): InstalledPlugin[] {
		return listInstalledCommunityPlugins(this.d.app);
	}

	/** 현재 배포된(학급에 올린) 플러그인 목록. */
	async listDeployed(): Promise<PluginDeployDoc[]> {
		const docs = await this.d.classroom.listByPrefix<PluginDeployDoc>(PLUGINDEPLOY_ID_PREFIX);
		return docs.filter((x) => !x.deleted);
	}

	/**
	 * 플러그인 배포(운영자). 자기 `.obsidian`에서 파일을 읽어 학급 공유 DB에 plugindeploy 문서로 올린다.
	 * 내용/정책이 그대로면 지문이 같아 멱등(구성원에 재안내 안 됨).
	 */
	async deploy(
		pluginId: string,
		opts: { shareSettings: boolean; managedSettings: boolean; targetMembers?: string[] },
	): Promise<boolean> {
		const s = this.d.settings();
		if (s.role !== "manager") return false;
		if (!this.d.classroom.ready()) {
			this.d.logger.warn(t("plugindeploy.needs_homeroom"), true);
			return false;
		}
		const installed = this.listInstalled().find((p) => p.id === pluginId);
		if (!installed) {
			this.d.logger.warn(t("plugindeploy.not_installed", { id: pluginId }), true);
			return false;
		}
		try {
			const files = await readInstalledPlugin(this.d.app, pluginId, opts.shareSettings);
			const contentHash = await deployContentHash(files, opts.shareSettings, opts.managedSettings);
			const existing = await this.d.classroom.get<PluginDeployDoc>(pluginDeployId(pluginId));
			const doc: PluginDeployDoc = {
				_id: pluginDeployId(pluginId),
				...(existing?._rev ? { _rev: existing._rev } : {}),
				type: "plugindeploy",
				schemaVersion: 1,
				workspaceId: s.workspaceId,
				pluginId,
				pluginName: installed.name,
				version: installed.version,
				files,
				shareSettings: opts.shareSettings,
				managedSettings: opts.managedSettings,
				contentHash,
				targetMembers: opts.targetMembers && opts.targetMembers.length > 0 ? opts.targetMembers : undefined,
				deployedBy: s.userId,
				deployedAt: new Date().toISOString(),
				deleted: false,
			};
			const ok = await this.d.classroom.put(doc);
			if (ok) this.d.logger.ok(t("plugindeploy.deployed", { name: installed.name }), true);
			return ok;
		} catch (e) {
			this.d.logger.error(t("plugindeploy.deploy_failed", { name: installed.name, err: errMessage(e) }), true);
			return false;
		}
	}

	/** 배포 회수(운영자) — 문서 soft-delete. 구성원의 이미 설치된 사본은 건드리지 않는다(제거는 구성원 몫). */
	async undeploy(pluginId: string): Promise<void> {
		const doc = await this.d.classroom.get<PluginDeployDoc>(pluginDeployId(pluginId));
		if (!doc || doc.deleted) return;
		await this.d.classroom.softDelete(doc);
		this.d.logger.info(t("plugindeploy.undeployed", { name: doc.pluginName }), true);
	}

	// --- 구성원(수신·설치) ---

	private handling = false;
	/** 이번 세션에 이미 안내한 pluginId(같은 세션 반복 안내 방지 — '나중에'는 다음 실행에 재안내). */
	private promptedThisSession = new Set<string>();
	/** 오염 문서는 세션당 한 번만 기록해 변경 피드 로그 폭주를 막는다. */
	private rejectedThisSession = new Set<string>();

	/**
	 * 학급에 올라온 새 배포를 수신 처리(구성원). onPluginDeployChange + 시작 시 호출.
	 * 미처리 지문 + 이번 세션 미안내 건만 확인 모달을 띄우고, 선택에 따라 설치한다.
	 */
	async handleIncoming(): Promise<void> {
		const s = this.d.settings();
		if (s.role !== "member" || this.handling || !this.d.classroom.ready()) return;
		this.handling = true;
		try {
			const handled = s.handledPluginDeploys ?? {};
			const docs = await this.d.classroom.listByPrefix<PluginDeployDoc>(PLUGINDEPLOY_ID_PREFIX);
			for (const doc of docs) {
				if (doc.deleted) continue;
				const invalid = await validatePluginDeployDoc(doc, s.workspaceId);
				if (invalid) {
					const key = typeof doc._id === "string" ? doc._id : invalid;
					if (!this.rejectedThisSession.has(key)) {
						this.rejectedThisSession.add(key);
						this.d.logger.warn(t("plugindeploy.invalid_payload", { err: invalid }), true);
					}
					continue;
				}
				if (!shouldOfferInstall(doc, s.userId, handled[doc.pluginId])) continue;
				if (this.promptedThisSession.has(doc.pluginId)) continue;
				this.promptedThisSession.add(doc.pluginId);
				if (!deployRunnableHere(doc)) {
					// 데스크톱 전용 플러그인은 이 모바일 기기에서 로드되지 않는다 — 건너뛰되 기록하지 않아
					// 데스크톱에서 다시 안내한다.
					this.d.logger.info(t("plugindeploy.member_desktop_only", { name: doc.pluginName }), true);
					continue;
				}
				const choice = await this.d.confirmInstall(doc);
				if (choice === "later") continue; // 다음 실행에 재안내(기록 안 함)
				try {
					await installDeployedPlugin(this.d.app, doc, {
						enable: choice === "enable",
						forceSettings: doc.managedSettings,
					});
					this.recordHandled(doc.pluginId, doc.contentHash);
					this.d.logger.ok(
						choice === "enable"
							? t("plugindeploy.installed_enabled", { name: doc.pluginName })
							: t("plugindeploy.installed", { name: doc.pluginName }),
						true,
					);
				} catch (e) {
					this.d.logger.error(t("plugindeploy.install_failed", { name: doc.pluginName, err: errMessage(e) }), true);
				}
			}
		} finally {
			this.handling = false;
		}
	}

	private recordHandled(pluginId: string, hash: string): void {
		const s = this.d.settings();
		s.handledPluginDeploys = { ...(s.handledPluginDeploys ?? {}), [pluginId]: hash };
		void this.d.saveSettings();
	}
}

/** UI 라벨용 — 설정 파일명 노출(re-export). */
export { SETTINGS_FILE };
