import { describe, it, expect } from "vitest";
import { decideAction } from "./copyAction";

describe("decideAction", () => {
	it("없으면 항상 create", () => {
		expect(decideAction(false, "skip")).toBe("create");
		expect(decideAction(false, "overwrite")).toBe("create");
		expect(decideAction(false, "rename")).toBe("create");
	});

	it("있으면 정책대로", () => {
		expect(decideAction(true, "skip")).toBe("skip");
		expect(decideAction(true, "overwrite")).toBe("overwrite");
		expect(decideAction(true, "rename")).toBe("rename");
	});
});
