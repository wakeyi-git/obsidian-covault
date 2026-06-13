import { App, Modal, Setting } from "obsidian";
import { PluginDeployDoc } from "../core/model/types";
import { InstallChoice } from "../modes/PluginDeployController";
import { SETTINGS_FILE } from "../core/plugindeploy/pluginPolicy";
import { t } from "../i18n";

/**
 * 구성원 플러그인 설치 확인 모달(정책 엔진 P2). 운영자가 배포한 학급 플러그인을 `.obsidian`에 설치하기 전,
 * 무엇이(임의 코드 실행) 설치되는지 명확히 알리고 동의를 받는다. 닫기/나중에=later(다음 실행에 재안내).
 */
export function confirmPluginInstall(app: App, doc: PluginDeployDoc): Promise<InstallChoice> {
	return new Promise((resolve) => {
		new PluginInstallModal(app, doc, resolve).open();
	});
}

class PluginInstallModal extends Modal {
	private decided = false;

	constructor(
		app: App,
		// 필드명을 `doc`로 쓰지 않는다 — Obsidian 런타임이 객체에 getter 전용 `doc`(소속 Document)를
		// 주입해, 파라미터 프로퍼티 `this.doc = …` 할당이 "Cannot set property doc … only a getter"로 깨진다.
		private deployDoc: PluginDeployDoc,
		private onChoice: (c: InstallChoice) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const c = this.contentEl;
		c.createEl("h3", { text: t("plugindeploy.install_title") });
		c.createEl("p", {
			cls: "setting-item-description",
			text: t("plugindeploy.install_body", { name: this.deployDoc.pluginName, version: this.deployDoc.version }),
		});
		// 신뢰 고지 — 배포된 코드가 이 기기에서 실행된다.
		c.createEl("p", { cls: "covault-issue is-warn", text: t("plugindeploy.install_trust_warning") });
		const hasSettings = this.deployDoc.files.some((f) => f.name === SETTINGS_FILE);
		if (hasSettings) {
			c.createEl("p", {
				cls: "setting-item-description",
				text: this.deployDoc.managedSettings ? t("plugindeploy.settings_managed") : t("plugindeploy.settings_seed"),
			});
		}

		new Setting(c)
			.addButton((b) => b.setButtonText(t("plugindeploy.later")).onClick(() => this.pick("later")))
			.addButton((b) => b.setButtonText(t("plugindeploy.install_only")).onClick(() => this.pick("install")))
			.addButton((b) =>
				b
					.setButtonText(t("plugindeploy.install_and_enable"))
					.setCta()
					.onClick(() => this.pick("enable")),
			);
	}

	private pick(choice: InstallChoice): void {
		this.decided = true;
		this.onChoice(choice);
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.decided) this.onChoice("later"); // 닫기 = 나중에
	}
}
