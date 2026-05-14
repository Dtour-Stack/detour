import { describe, expect, test } from "bun:test";
import { mediaCategoryForMime } from "./x-client";

describe("mediaCategoryForMime", () => {
	test("image/png → tweet_image", () => {
		expect(mediaCategoryForMime("image/png")).toBe("tweet_image");
	});
	test("image/jpeg → tweet_image", () => {
		expect(mediaCategoryForMime("image/jpeg")).toBe("tweet_image");
	});
	test("image/gif → tweet_gif", () => {
		expect(mediaCategoryForMime("image/gif")).toBe("tweet_gif");
	});
	test("video/mp4 → tweet_video", () => {
		expect(mediaCategoryForMime("video/mp4")).toBe("tweet_video");
	});
	test("uppercase + parameters tolerated", () => {
		expect(mediaCategoryForMime("VIDEO/MP4")).toBe("tweet_video");
		expect(mediaCategoryForMime("image/png; charset=binary")).toBe("tweet_image");
	});
	test("unknown mime defaults to tweet_image (permissive)", () => {
		expect(mediaCategoryForMime("application/octet-stream")).toBe("tweet_image");
	});
});
