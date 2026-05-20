import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonRecord = { [key: string]: Json };

type Check = {
	name: string;
	ok: boolean;
	detail?: string;
};

const args = new Set(process.argv.slice(2));
const repoRoot = resolve(import.meta.dir, "..");
const swiftunDir = join(repoRoot, "build-assets", "swiftun-shell");
const expectedProducts = ["Swiftun", "MLXImageVerify", "MLXOmniVerify"];
const expectedBridgeDirs = [
	"activity-bridge",
	"applescript-bridge",
	"browser-bridge",
	"chat-bridge",
	"gallery-bridge",
	"pensieve-bridge",
	"settings-bridge",
	"tray-bridge",
	"workspace-bridge",
];

function isRecord(value: Json): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function run(command: string, params: string[], cwd = repoRoot): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync(command, params, {
		cwd,
		encoding: "utf8",
		env: process.env,
	});
	return {
		status: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

function checkCommand(command: string, params: string[], name: string): Check {
	const result = run(command, params);
	const output = `${result.stdout}${result.stderr}`.trim().split("\n")[0] ?? "";
	return {
		name,
		ok: result.status === 0,
		detail: output || `status=${result.status}`,
	};
}

function checkFile(path: string): Check {
	return { name: `${path} exists`, ok: existsSync(join(repoRoot, path)) };
}

function checkExecutable(path: string): Check {
	try {
		const mode = statSync(join(repoRoot, path)).mode;
		return { name: `${path} executable`, ok: (mode & 0o111) !== 0 };
	} catch (err) {
		return { name: `${path} executable`, ok: false, detail: err instanceof Error ? err.message : String(err) };
	}
}

function readPackageScripts(): JsonRecord | null {
	try {
		const json = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as Json;
		if (!isRecord(json)) return null;
		const scripts = json.scripts;
		return isRecord(scripts) ? scripts : null;
	} catch {
		return null;
	}
}

function checkPackageScript(name: string, expected: string): Check {
	const scripts = readPackageScripts();
	const value = scripts?.[name];
	return {
		name: `package script ${name}`,
		ok: value === expected,
		detail: typeof value === "string" ? value : "missing",
	};
}

function describeSwiftPackage(): { check: Check; products: string[]; platforms: Array<{ name?: string; version?: string }> } {
	const result = run("swift", ["package", "describe", "--type", "json"], swiftunDir);
	if (result.status !== 0) {
		return {
			check: { name: "Swiftun package describe", ok: false, detail: result.stderr.trim() || `status=${result.status}` },
			products: [],
			platforms: [],
		};
	}
	try {
		const json = JSON.parse(result.stdout) as Json;
		if (!isRecord(json)) throw new Error("description was not an object");
		const productValues = Array.isArray(json.products) ? json.products : [];
		const products = productValues
			.filter(isRecord)
			.map((product) => product.name)
			.filter((name): name is string => typeof name === "string");
		const platformValues = Array.isArray(json.platforms) ? json.platforms : [];
		const platforms = platformValues
			.filter(isRecord)
			.map((platform) => ({
				name: typeof platform.name === "string" ? platform.name : undefined,
				version: typeof platform.version === "string" ? platform.version : undefined,
			}));
		return {
			check: { name: "Swiftun package describe", ok: true },
			products,
			platforms,
		};
	} catch (err) {
		return {
			check: { name: "Swiftun package describe", ok: false, detail: err instanceof Error ? err.message : String(err) },
			products: [],
			platforms: [],
		};
	}
}

function checkProducts(products: string[]): Check {
	const missing = expectedProducts.filter((product) => !products.includes(product));
	return {
		name: "Swiftun products",
		ok: missing.length === 0,
		detail: missing.length === 0 ? expectedProducts.join(", ") : `missing: ${missing.join(", ")}`,
	};
}

function checkMacPlatform(platforms: Array<{ name?: string; version?: string }>): Check {
	const mac = platforms.find((platform) => platform.name === "macos");
	return {
		name: "Swiftun macOS platform",
		ok: mac?.version === "26.0",
		detail: mac ? `macos ${mac.version}` : "missing macos platform",
	};
}

function runSwiftBuild(): Check[] {
	const clean = run("swift", ["package", "clean"], swiftunDir);
	if (clean.status !== 0) {
		return [{ name: "SwiftPM clean", ok: false, detail: clean.stderr.trim() || `status=${clean.status}` }];
	}
	const build = run("swift", ["build", "-c", "release"], swiftunDir);
	const checks: Check[] = [{
		name: "SwiftPM release build",
		ok: build.status === 0,
		detail: build.status === 0 ? undefined : build.stderr.trim() || `status=${build.status}`,
	}];
	if (build.status !== 0) return checks;
	for (const product of expectedProducts) {
		checks.push(checkExecutable(`build-assets/swiftun-shell/.build/release/${product}`));
	}
	return checks;
}

const describe = describeSwiftPackage();
const checks: Check[] = [
	checkCommand("swift", ["--version"], "swift toolchain"),
	checkCommand("swiftc", ["--version"], "swiftc toolchain"),
	checkCommand("xcode-select", ["-p"], "Xcode developer directory"),
	checkFile("build-assets/swiftun-shell/Package.swift"),
	describe.check,
	checkProducts(describe.products),
	checkMacPlatform(describe.platforms),
	checkPackageScript("build:mac", "bun run scripts/build-mac-app.ts"),
	checkPackageScript("build:swiftun", "bun run scripts/build-mac-app.ts"),
	...expectedBridgeDirs.map((dir) => checkExecutable(`build-assets/${dir}/build.sh`)),
];

if (args.has("--build")) {
	checks.push(...runSwiftBuild());
}

const failed = checks.filter((check) => !check.ok);

for (const check of checks) {
	const prefix = check.ok ? "ok" : "fail";
	const detail = check.detail ? ` (${check.detail})` : "";
	console.log(`${prefix} ${check.name}${detail}`);
}

if (failed.length > 0) {
	process.exit(1);
}

console.log(args.has("--build") ? "Detour Swift setup and build OK" : "Detour Swift setup OK");
