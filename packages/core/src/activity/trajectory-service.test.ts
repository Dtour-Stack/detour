import { describe, expect, test } from "bun:test";
import { ActivityTrajectoryService } from "./trajectory-service";

function runtimeWithTrajectory(detail: Record<string, unknown>) {
	const trajectories = {
		getTrajectoryDetail: async () => detail,
	};
	return {
		getService: (type: string) => type === "trajectories" ? trajectories : null,
		getServicesByType: () => [],
	};
}

describe("ActivityTrajectoryService", () => {
	test("ignores pending action placeholders and keeps completed actions", async () => {
		const svc = new ActivityTrajectoryService(() =>
			runtimeWithTrajectory({
				trajectoryId: "t1",
				source: "chat",
				metrics: { finalStatus: "completed" },
				steps: [
					{
						stepNumber: 0,
						timestamp: 1,
						llmCalls: [],
						providerAccesses: [],
						action: {
							attemptId: "",
							timestamp: 1,
							actionType: "pending",
							actionName: "pending",
							parameters: {},
							success: false,
						},
					},
					{
						stepNumber: 1,
						timestamp: 2,
						llmCalls: [],
						providerAccesses: [],
						action: {
							attemptId: "a1",
							timestamp: 2,
							actionType: "GENERATE_IMAGE",
							actionName: "GENERATE_IMAGE",
							parameters: { prompt: "cozy badge" },
							success: true,
							result: { text: "Generated image." },
						},
					},
				],
			}) as never,
		);

		const detail = await svc.get("t1");

		expect(detail.totals.actionCount).toBe(1);
		expect(detail.actions[0]?.actionName).toBe("GENERATE_IMAGE");
		expect(detail.steps[0]?.hasAction).toBe(false);
		expect(detail.steps[1]?.hasAction).toBe(true);
	});
});
