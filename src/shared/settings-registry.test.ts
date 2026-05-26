import { expect, test } from "bun:test";
import {
	AUDIO_RUNTIME_SETTING_KEYS,
	AUDIO_SETTING_DEFINITIONS,
	EVAL_WRITABLE_SETTING_KEYS,
	MODEL_ROUTING_SETTING_KEYS,
	SETTING_DEFINITIONS,
} from "./settings-registry";

test("setting registry has no duplicate keys", () => {
	const keys = SETTING_DEFINITIONS.map((setting) => setting.key);
	expect(new Set(keys).size).toBe(keys.length);
});

test("audio runtime keys come from audio UI definitions", () => {
	expect(AUDIO_RUNTIME_SETTING_KEYS).toEqual(AUDIO_SETTING_DEFINITIONS.map((setting) => setting.key));
});

test("eval writable model settings follow routing keys", () => {
	expect(EVAL_WRITABLE_SETTING_KEYS).toEqual(MODEL_ROUTING_SETTING_KEYS);
});
