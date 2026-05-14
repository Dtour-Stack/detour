import { describe, expect, test } from "bun:test";
import {
	elizaCloudGenerateImageAction,
	elizaCloudGenerateVideoAction,
	generateVideoAction,
	mediaGenerationPlugin,
	mediaGenerationSettingKeys,
	openRouterGenerateVideoAction,
} from "./index";

describe("media-generation plugin", () => {
	test("exports image and video actions", () => {
		expect(mediaGenerationPlugin.actions?.map((action) => action.name)).toEqual([
			generateVideoAction.name,
			openRouterGenerateVideoAction.name,
			elizaCloudGenerateVideoAction.name,
			elizaCloudGenerateImageAction.name,
		]);
	});

	test("declares runtime setting keys", () => {
		expect(mediaGenerationSettingKeys()).toContain("OPENROUTER_MODEL_VIDEO");
		expect(mediaGenerationSettingKeys()).toContain("ELIZAOS_CLOUD_VIDEO_GENERATION_MODEL");
		expect(mediaGenerationSettingKeys()).toContain("ELIZAOS_CLOUD_IMAGE_GENERATION_MODEL");
	});
});
