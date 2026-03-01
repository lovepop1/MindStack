import {
    BedrockRuntimeClient,
    InvokeModelCommand,
    InvokeModelWithResponseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";

// ---------------------------------------------------------------------------
// Shared Bedrock client
// ---------------------------------------------------------------------------
const bedrock = new BedrockRuntimeClient({
    region: process.env.NEXT_PUBLIC_AWS_REGION!,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
});

// ---------------------------------------------------------------------------
// invokeClaudeHaiku — lightweight text generation for summaries & translations
// ---------------------------------------------------------------------------
export async function invokeClaudeHaiku(prompt: string): Promise<string> {
    const body = JSON.stringify({
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 2048,
        messages: [{ role: "user", content: prompt }],
    });

    try {
        const response = await bedrock.send(
            new InvokeModelCommand({
                modelId: "anthropic.claude-haiku-3-5",
                contentType: "application/json",
                accept: "application/json",
                body,
            })
        );

        const decoded = JSON.parse(new TextDecoder().decode(response.body));
        return (decoded.content?.[0]?.text as string) ?? "";
    } catch (err) {
        console.error("[Bedrock] Haiku invocation failed:", err);
        throw err;
    }
}

// ---------------------------------------------------------------------------
// invokeTitanEmbedding — Amazon Titan Text Embeddings v2 (1024-dim)
// ---------------------------------------------------------------------------
export async function invokeTitanEmbedding(text: string): Promise<number[]> {
    // Titan v2 supports up to ~8192 tokens; truncate defensively
    const truncated = text.slice(0, 25000);

    const body = JSON.stringify({
        inputText: truncated,
        dimensions: 1024,
        normalize: true,
    });

    try {
        const response = await bedrock.send(
            new InvokeModelCommand({
                modelId: "amazon.titan-embed-text-v2:0",
                contentType: "application/json",
                accept: "application/json",
                body,
            })
        );

        const decoded = JSON.parse(new TextDecoder().decode(response.body));
        return decoded.embedding as number[];
    } catch (err) {
        console.error("[Bedrock] Titan embedding failed:", err);
        throw err;
    }
}

// ---------------------------------------------------------------------------
// ClaudeMessage type for multimodal chat payloads
// ---------------------------------------------------------------------------
export type ClaudeContentBlock =
    | { type: "text"; text: string }
    | {
        type: "image";
        source: {
            type: "base64";
            media_type: string;
            data: string;
        };
    }
    | {
        type: "document";
        source: {
            type: "base64";
            media_type: string;
            data: string;
        };
    };

export interface ClaudeMessage {
    role: "user" | "assistant";
    content: string | ClaudeContentBlock[];
}

// ---------------------------------------------------------------------------
// streamClaudeSonnet — Claude 3.7 Sonnet streaming for the chat endpoint.
// Yields raw text delta strings as they arrive.
// ---------------------------------------------------------------------------
export async function* streamClaudeSonnet(
    messages: ClaudeMessage[],
    systemPrompt?: string
): AsyncGenerator<string> {
    const body: Record<string, unknown> = {
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 4096,
        messages,
    };

    if (systemPrompt) {
        body.system = systemPrompt;
    }

    try {
        const response = await bedrock.send(
            new InvokeModelWithResponseStreamCommand({
                modelId: "us.anthropic.claude-3-7-sonnet-20250219-v1:0",
                contentType: "application/json",
                accept: "application/json",
                body: JSON.stringify(body),
            })
        );

        if (!response.body) {
            throw new Error("[Bedrock] Empty streaming response body");
        }

        for await (const event of response.body) {
            if (event.chunk?.bytes) {
                const chunk = JSON.parse(
                    new TextDecoder().decode(event.chunk.bytes)
                ) as {
                    type: string;
                    delta?: { type: string; text?: string };
                };
                if (
                    chunk.type === "content_block_delta" &&
                    chunk.delta?.type === "text_delta" &&
                    chunk.delta?.text
                ) {
                    yield chunk.delta.text;
                }
            }
        }
    } catch (err) {
        console.error("[Bedrock] Sonnet stream failed:", err);
        throw err;
    }
}
