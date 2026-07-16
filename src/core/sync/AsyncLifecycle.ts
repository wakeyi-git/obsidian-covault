/** 겹친 start는 공유하고, stop은 현재 세대를 무효화해 지연된 시작 부수효과를 차단한다. */
export class AsyncLifecycle {
	active = false;
	private generation = 0;
	private starting: Promise<void> | null = null;

	start(run: (generation: number) => Promise<void>): Promise<void> {
		if (this.starting) return this.starting;
		if (this.active) return Promise.resolve();
		this.active = true;
		const generation = ++this.generation;
		const task = run(generation);
		this.starting = task;
		const clear = () => { if (this.starting === task) this.starting = null; };
		void task.then(clear, clear);
		return task;
	}

	isCurrent(generation: number): boolean {
		return this.active && this.generation === generation;
	}

	stop(): Promise<void> | null {
		if (!this.active && !this.starting) return null;
		this.active = false;
		this.generation++;
		return this.starting ?? Promise.resolve();
	}
}
