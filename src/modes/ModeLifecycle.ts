/** 역할 모드 교체를 직렬화하고, 시작 실패 시 반쯤 열린 인스턴스까지 정리한다. */
export class ModeLifecycle<T extends { stop(): Promise<void> }> {
	current: T | null = null;
	private chain: Promise<void> = Promise.resolve();

	replace(create: () => T, start: (mode: T) => Promise<void>): Promise<void> {
		return this.run(async () => {
			const previous = this.current;
			this.current = null;
			await previous?.stop();
			const next = create();
			this.current = next;
			try {
				await start(next);
			} catch (error) {
				if (this.current === next) this.current = null;
				await next.stop().catch(() => undefined);
				throw error;
			}
		});
	}

	stop(): Promise<void> {
		return this.run(async () => {
			const current = this.current;
			this.current = null;
			await current?.stop();
		});
	}

	private run(task: () => Promise<void>): Promise<void> {
		const result = this.chain.then(task, task);
		this.chain = result.catch(() => undefined);
		return result;
	}
}
