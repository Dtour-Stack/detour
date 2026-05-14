import { expect, test } from "bun:test";
import {
	audioGenerationPlugin,
	audioSettingKeys,
	extensionForOutputFormat,
	normalizeAudioBaseUrl,
} from "./index";

test("audio-generation plugin exposes agent actions", () => {
	const names = new Set((audioGenerationPlugin.actions ?? []).map((action) => action.name));
	for (const expected of [
		"ELEVENLABS_TEXT_TO_SPEECH",
		"ELEVENLABS_VOICE_CHANGE",
		"ELEVENLABS_TRANSCRIBE",
		"ELEVENLABS_VOICES_SEARCH",
		"ELEVENLABS_TEXT_TO_DIALOGUE",
		"ELEVENLABS_VOICE_DESIGN",
		"ELEVENLABS_VOICE_CREATE",
		"ELEVENLABS_VOICE_ISOLATE",
		"ELEVENLABS_SOUND_EFFECT",
		"ELEVENLABS_MUSIC",
		"ELEVENLABS_DUB_CREATE",
		"ELEVENLABS_DUB_STATUS",
		"ELEVENLABS_DUB_DOWNLOAD",
	]) {
		expect(names.has(expected)).toBe(true);
	}
});

test("audio setting keys include the ElevenLabs credential", () => {
	expect(audioSettingKeys()).toContain("ELEVENLABS_API_KEY");
});

test("normalizes provider base URLs", () => {
	expect(normalizeAudioBaseUrl("https://api.elevenlabs.io/v1/", "fallback")).toBe("https://api.elevenlabs.io/v1");
	expect(normalizeAudioBaseUrl("not-a-url", "https://fallback.example")).toBe("https://fallback.example");
});

test("maps output formats to file extensions", () => {
	expect(extensionForOutputFormat("mp3_44100_128")).toBe("mp3");
	expect(extensionForOutputFormat("pcm_16000")).toBe("pcm");
	expect(extensionForOutputFormat(undefined, "audio/wav")).toBe("wav");
});
