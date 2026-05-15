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
