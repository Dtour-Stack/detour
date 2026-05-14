import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAgentProject,
	electrobunTemplatesDir,
	isElectrobunTemplate,
	listElectrobunTemplates,
	projectDir,
} from "./agent-projects-core";

let sandboxRoot: string;
let templatesRoot: string;
let prevSandbox: string | undefined;
let prevTemplatesDir: string | undefined;

beforeEach(() => {
	sandboxRoot = mkdtempSync(join(tmpdir(), "detour-projects-"));
	templatesRoot = mkdtempSync(join(tmpdir(), "electrobun-tpls-"));
	prevSandbox = process.env.DETOUR_AGENT_SANDBOX;
	prevTemplatesDir = process.env.DETOUR_ELECTROBUN_TEMPLATES_DIR;
	process.env.DETOUR_AGENT_SANDBOX = sandboxRoot;
	process.env.DETOUR_ELECTROBUN_TEMPLATES_DIR = templatesRoot;

	// Seed two fake templates so the test exercises listing + copying without
	// depending on a real ~/Electrobun checkout.
	mkdirSync(join(templatesRoot, "tray-app", "src"), { recursive: true });
	writeFileSync(
		join(templatesRoot, "tray-app", "electrobun.config.ts"),
		'export default { name: "tray-app" };\n',
	);
	writeFileSync(
		join(templatesRoot, "tray-app", "package.json"),
		'{ "name": "tray-app" }\n',
	);
	writeFileSync(
		join(templatesRoot, "tray-app", "src", "index.ts"),
		'console.log("hello tray");\n',
	);

	mkdirSync(join(templatesRoot, "react-tailwind-vite"), { recursive: true });
	writeFileSync(
		join(templatesRoot, "react-tailwind-vite", "package.json"),
		'{ "name": "react-tailwind-vite" }\n',
	);

	// Hidden + non-dir entries should be ignored by listElectrobunTemplates.
	mkdirSync(join(templatesRoot, ".cache"), { recursive: true });
	writeFileSync(join(templatesRoot, "README.md"), "not a template\n");
});

afterEach(() => {
	rmSync(sandboxRoot, { recursive: true, force: true });
	rmSync(templatesRoot, { recursive: true, force: true });
	if (prevSandbox === undefined) delete process.env.DETOUR_AGENT_SANDBOX;
	else process.env.DETOUR_AGENT_SANDBOX = prevSandbox;
	if (prevTemplatesDir === undefined) delete process.env.DETOUR_ELECTROBUN_TEMPLATES_DIR;
	else process.env.DETOUR_ELECTROBUN_TEMPLATES_DIR = prevTemplatesDir;
});

describe("electrobun template scaffolding", () => {
	test("electrobunTemplatesDir respects env override", () => {
		expect(electrobunTemplatesDir()).toBe(templatesRoot);
	});

	test("listElectrobunTemplates returns only directories, no hidden, no files", () => {
		const list = listElectrobunTemplates();
		expect(list).toContain("tray-app");
		expect(list).toContain("react-tailwind-vite");
		expect(list).not.toContain(".cache");
		expect(list).not.toContain("README.md");
		expect(list).toEqual([...list].sort());
	});

	test("isElectrobunTemplate guards the prefix correctly", () => {
		expect(isElectrobunTemplate("electrobun:tray-app")).toBe(true);
		expect(isElectrobunTemplate("electrobun:")).toBe(false);
		expect(isElectrobunTemplate("carrot")).toBe(false);
	});

	test("createAgentProject copies the electrobun template tree + overlays README", async () => {
		const meta = await createAgentProject({
			name: "My Tray App",
			description: "A tiny tray app for tests.",
			type: "app",
			template: "electrobun:tray-app",
		});
		expect(meta.template).toBe("electrobun:tray-app");
		const dir = projectDir(meta.slug);
		// Files from the template are present
		expect(existsSync(join(dir, "electrobun.config.ts"))).toBe(true);
		expect(existsSync(join(dir, "package.json"))).toBe(true);
		expect(existsSync(join(dir, "src", "index.ts"))).toBe(true);
		// README overlay names the project
		const readme = readFileSync(join(dir, "README.md"), "utf8");
		expect(readme).toContain("# My Tray App");
		expect(readme).toContain("electrobun:tray-app".replace("electrobun:", ""));
		// project.json metadata persisted
		const projectJson = JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
		expect(projectJson.template).toBe("electrobun:tray-app");
	});

	test("createAgentProject rejects unknown electrobun template", async () => {
		await expect(
			createAgentProject({
				name: "ghost",
				description: "won't scaffold",
				type: "app",
				template: "electrobun:does-not-exist",
			}),
		).rejects.toThrow(/electrobun template "does-not-exist" not found/);
	});

	test("createAgentProject rejects electrobun:* for type=page", async () => {
		await expect(
			createAgentProject({
				name: "bad-page",
				description: "page can't be electrobun",
				type: "page",
				template: "electrobun:tray-app",
			}),
		).rejects.toThrow(/not valid for type=page/);
	});

	test("built-in templates still work alongside the new path", async () => {
		const meta = await createAgentProject({
			name: "Tiny Page",
			description: "Static page.",
			type: "page",
		});
		expect(meta.template).toBe("static");
		const dir = projectDir(meta.slug);
		expect(existsSync(join(dir, "index.html"))).toBe(true);
	});
});
