import {
	__setKnowledgeUrlFetchImplForTests,
	ContentType,
	type IAgentRuntime,
	type Media,
	ServiceType,
} from "@elizaos/core";
import type { Message as DiscordMessage } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachmentManager } from "../attachments";
import { MessageManager } from "../messages";

function runtime(): IAgentRuntime {
	return {
		agentId: "11111111-1111-1111-1111-111111111111",
		getService: vi.fn((serviceType) =>
			serviceType === ServiceType.VIDEO ? null : null,
		),
		logger: {
			debug: vi.fn(),
			error: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
		},
	} as unknown as IAgentRuntime;
}

function discordMessage(content: string, hasAttachment = false): DiscordMessage {
	return {
		content,
		embeds: [],
		mentions: { users: new Map() },
		attachments: hasAttachment ? new Map([["att-1", { id: "att-1" }]]) : new Map(),
	} as unknown as DiscordMessage;
}

function managerFor(
	testRuntime: IAgentRuntime,
	processedAttachments: Media[] = [],
): MessageManager {
	const manager = Object.create(MessageManager.prototype) as MessageManager;
	Object.assign(
		manager as unknown as {
			runtime: IAgentRuntime;
			attachmentManager: {
				processAttachments: () => Promise<Media[]>;
			};
		},
		{
			runtime: testRuntime,
			attachmentManager: {
				processAttachments: vi.fn(async () => processedAttachments),
			},
		},
	);
	return manager;
}

afterEach(() => {
	__setKnowledgeUrlFetchImplForTests(null);
});

describe("MessageManager URL enrichment", () => {
	it("turns direct webpage URLs into readable link attachments without a browser service", async () => {
		const html =
			"<html><head><style>.hidden{display:none}</style><script>window.secret='wrong'</script></head><body><p>secret phrase: velvet-lantern-7419</p></body></html>";
		__setKnowledgeUrlFetchImplForTests(async () => {
			return new Response(html, {
				headers: { "content-type": "text/html; charset=utf-8" },
			});
		});

		const result = await managerFor(runtime()).processMessage(
			discordMessage(
				"fetch http://203.0.113.10/proof and reply with the secret phrase",
			),
		);

		expect(result.attachments).toHaveLength(1);
		expect(result.attachments[0]).toMatchObject({
			id: expect.stringMatching(/^webpage-[a-f0-9]{24}$/),
			url: "http://203.0.113.10/proof",
			source: "Web",
			contentType: ContentType.LINK,
			text: "secret phrase: velvet-lantern-7419",
		});
	});

	it("uses a stable attachment id for the same direct URL", async () => {
		__setKnowledgeUrlFetchImplForTests(async () => {
			return new Response("same page", {
				headers: { "content-type": "text/plain; charset=utf-8" },
			});
		});

		const manager = managerFor(runtime());
		const first = await manager.processMessage(
			discordMessage("read http://203.0.113.10/repeated"),
		);
		const second = await manager.processMessage(
			discordMessage("read http://203.0.113.10/repeated"),
		);

		expect(first.attachments[0]?.id).toBe(second.attachments[0]?.id);
	});

	it("inlines readable attachment text into the processed message", async () => {
		const result = await managerFor(runtime(), [
			{
				id: "att-1",
				url: "https://cdn.discordapp.com/attachments/1/message.txt",
				title: "message.txt",
				source: "Plaintext",
				contentType: ContentType.DOCUMENT,
				description: "architecture proposal",
				text: "Promote app-core/platforms/electrobun from shell to carrot host.",
			},
		]).processMessage(discordMessage("@Detour rate this", true));

		expect(result.processedContent).toContain("[Attachment: message.txt]");
		expect(result.processedContent).toContain(
			"Promote app-core/platforms/electrobun from shell to carrot host.",
		);
	});
});

describe("AttachmentManager plaintext attachments", () => {
	it("keeps fetched text when summarization fails", async () => {
		const text = `carrot host proposal\n${"sub-agent registry ".repeat(100)}`;
		const previousFetch = globalThis.fetch;
		globalThis.fetch = (async () => new Response(text)) as typeof fetch;

		try {
			const manager = new AttachmentManager(runtime());
			const media = await manager.processAttachment({
				id: "att-2",
				url: "https://cdn.discordapp.com/attachments/1/message.txt",
				name: "message.txt",
				contentType: "text/plain",
			} as never);

			expect(media?.title).toBe("message.txt");
			expect(media?.text).toBe(text);
			expect(media?.description).toContain("carrot host proposal");
		} finally {
			globalThis.fetch = previousFetch;
		}
	});
});
