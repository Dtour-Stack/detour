/*
 * Wire types shared by every Swift companion (DetourSettings,
 * DetourActivity, DetourPensieve, DetourTray, …). Mirror the
 * `src/shared/index.ts` shapes 1:1 — break the mirror and decoding
 * silently fails.
 *
 * Add new fields here as the bun side adds them. Keep all properties
 * optional where the bun side declares them optional to avoid hard
 * decode failures across version drift.
 */

import Foundation

// MARK: - Tray snapshot

struct TrayProviderWire: Decodable, Identifiable {
    let id: String
    let label: String
    let active: Bool
    let configured: Bool
}

struct TrayEmbedWire: Decodable {
    let running: Bool
    let downloadPercent: Int?
    let downloadedBytes: Int?
    let totalBytes: Int?
    let lastError: String?
}

struct TrayPresetWire: Decodable, Identifiable {
    let id: String
    let label: String
    let approxLiveRamGB: Double
    let approxDiskGB: Double
    let downloaded: Bool
}

struct TrayLocalChatWire: Decodable {
    let enabled: Bool
    let running: Bool
    let preset: String?
    let downloadPercent: Int?
    let downloadedBytes: Int?
    let totalBytes: Int?
    let lastArbiterRefusal: String?
    let presets: [TrayPresetWire]
}

struct TrayCompanionWire: Decodable {
    let enabled: Bool
    let running: Bool
    let preset: String?
    let sharedWithLocalChat: Bool
    let downloadPercent: Int?
    let downloadedBytes: Int?
    let totalBytes: Int?
    let lastArbiterRefusal: String?
    let presets: [TrayPresetWire]
}

struct TrayMemoryWire: Decodable {
    let totalGB: Double
    let headroomGB: Double
    let budgetGB: Double
    let usedGB: Double
}

struct TrayMlxImagePresetWire: Decodable, Identifiable {
    let id: String
    let label: String
    let modelID: String
    let ramGB: Double
    let diskGB: Double
    let defaultSteps: Int
    let downloaded: Bool
    let available: Bool
    let fitsBudget: Bool
    let licenseNote: String?
}

struct TrayMlxVideoPresetWire: Decodable, Identifiable {
    let id: String
    let label: String
    let modelID: String
    let ramGB: Double
    let diskGB: Double
    let defaultDurationSeconds: Double
    let defaultFps: Int
    let approxSecondsPerSecond: Double
    let downloaded: Bool
    let available: Bool
    let fitsBudget: Bool
    let licenseNote: String?
}

struct TrayLocalMlxImageWire: Decodable {
    let enabled: Bool
    let available: Bool
    let preset: String?
    let presets: [TrayMlxImagePresetWire]
}

struct TrayLocalMlxVideoWire: Decodable {
    let enabled: Bool
    let available: Bool
    let preset: String?
    let presets: [TrayMlxVideoPresetWire]
}

/// Shared shape for the STT/TTS/Vision preset catalog — these don't
/// have the same RAM/disk dynamics as Image/Video so we use a lean
/// preset wire type. Apple-framework presets report ramGB=0.3 and
/// diskGB=0; MLX-vendored presets carry the model footprint.
struct TrayMlxOmniPresetWire: Decodable, Identifiable {
    let id: String
    let label: String
    let modelID: String
    let ramGB: Double
    let diskGB: Double
    let downloaded: Bool
    let available: Bool
    let fitsBudget: Bool
}

struct TrayLocalMlxOmniWire: Decodable {
    let enabled: Bool
    let available: Bool
    let preset: String?
    let presets: [TrayMlxOmniPresetWire]
}

// MARK: - Unified model routing

struct ModelRoutingOptionWire: Decodable, Identifiable {
    let id: String
    let label: String
    let kind: String     // "local" | "cloud"
    let available: Bool
}

struct ModelRoutingEntryWire: Decodable, Identifiable {
    let type: String     // routed model type e.g. "IMAGE", "TRANSCRIPTION"
    let label: String
    let selected: String
    let options: [ModelRoutingOptionWire]
    var id: String { type }
}

struct TrayTrajectoryWire: Decodable, Identifiable {
    let id: String
    let source: String?
    let startTime: Double?
    let status: String?
}

struct TraySnapshotWire: Decodable {
    let activeProviderId: String?
    let providers: [TrayProviderWire]
    let embed: TrayEmbedWire
    let localChat: TrayLocalChatWire
    let companion: TrayCompanionWire
    let memory: TrayMemoryWire?
    let recentTrajectories: [TrayTrajectoryWire]
    let localMlxImage: TrayLocalMlxImageWire?
    let localMlxVideo: TrayLocalMlxVideoWire?
    let localMlxStt: TrayLocalMlxOmniWire?
    let localMlxTts: TrayLocalMlxOmniWire?
    let localMlxVision: TrayLocalMlxOmniWire?
    let modelRouting: [ModelRoutingEntryWire]?
}

// MARK: - Activity trajectories (full detail)

struct ActivityTrajectoryListItemWire: Decodable, Identifiable {
    let id: String
    let source: String?
    let status: String?
    let startTime: Double?
    let endTime: Double?
    let durationMs: Double?
    let llmCallCount: Int?
    let totalPromptTokens: Int?
    let totalCompletionTokens: Int?
}

struct ActivityTrajectoryListResultWire: Decodable {
    let trajectories: [ActivityTrajectoryListItemWire]
    let total: Int
    let limit: Int
    let offset: Int
}

struct ActivityLlmCallWire: Decodable, Identifiable {
    let callId: String
    let stepNumber: Int
    let timestamp: Double
    let model: String
    let systemPrompt: String?
    let userPrompt: String?
    let response: String?
    let reasoning: String?
    let promptTokens: Int?
    let completionTokens: Int?
    let latencyMs: Double?
    let purpose: String?
    var id: String { callId }
}

struct ActivityActionAttemptWire: Decodable, Identifiable {
    let attemptId: String
    let stepNumber: Int
    let timestamp: Double
    let actionName: String?
    let success: Bool?
    let error: String?
    let reasoning: String?
    var id: String { attemptId }
}

struct ActivityTrajectoryDetailWire: Decodable {
    let trajectory: ActivityTrajectoryListItemWire?
    let llmCalls: [ActivityLlmCallWire]
    let actions: [ActivityActionAttemptWire]
}

// MARK: - Activity logs

struct ActivityLogEntryWire: Decodable, Identifiable {
    let time: Double
    let level: Int
    let levelName: String
    let msg: String
    let source: String?
    var id: String { "\(time)-\(source ?? "")-\(msg.prefix(40))" }
}

// MARK: - Pensieve

struct PensieveMemorySummaryWire: Decodable, Identifiable {
    let id: String
    let type: String?
    let createdAt: Double?
    let path: String
    let tableName: String?
    let preview: String
}

struct PensieveEntitySummaryWire: Decodable, Identifiable {
    let id: String
    let name: String?
    let relationshipCount: Int
    let memoryCount: Int
    let lastSeen: Double?
}
