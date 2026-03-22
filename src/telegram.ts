import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { type Logger } from "pino";

const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
const DEFAULT_TELEGRAM_API_BASE_URL = "https://api.telegram.org";

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function extractMessageId(responseBody: string): number | undefined {
    try {
        const parsedResponse = JSON.parse(responseBody);
        if (!isRecord(parsedResponse)) {
            return undefined;
        }

        const result = parsedResponse.result;
        if (!isRecord(result) || typeof result.message_id !== "number") {
            return undefined;
        }

        return result.message_id;
    } catch {
        return undefined;
    }
}

function serializeError(error: unknown): Record<string, unknown> {
    if (error instanceof Error) {
        return {
            name: error.name,
            message: error.message,
            stack: error.stack,
            cause: error.cause,
        };
    }

    return {
        value: error,
    };
}

type TelegramHttpResponse = {
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: string;
};

export type SendMessageOptions = {
    apiBaseUrl: string;
    chatId: number;
    topicId?: number;
    message: string;
    parseMode?: "HTML" | "MarkdownV2";
    disableLinkPreview: boolean;
    protectContent: boolean;
    logger: Logger;
};

export type EditMessageOptions = {
    apiBaseUrl: string;
    chatId: number;
    messageId: number;
    message: string;
    parseMode?: "HTML" | "MarkdownV2";
    disableLinkPreview: boolean;
    logger: Logger;
};

function splitMessage(message: string, maxLength: number): string[] {
    if (message.length <= maxLength) {
        return [message];
    }

    const chunks: string[] = [];
    let remaining = message;

    while (remaining.length > maxLength) {
        let splitIndex = remaining.lastIndexOf("\n", maxLength);

        if (splitIndex <= 0 || splitIndex < Math.floor(maxLength / 2)) {
            splitIndex = remaining.lastIndexOf(" ", maxLength);
        }

        if (splitIndex <= 0 || splitIndex < Math.floor(maxLength / 2)) {
            splitIndex = maxLength;
        } else {
            splitIndex += 1;
        }

        chunks.push(remaining.slice(0, splitIndex));
        remaining = remaining.slice(splitIndex);
    }

    if (remaining !== "") {
        chunks.push(remaining);
    }

    return chunks;
}

function buildTelegramRequestUrl(apiBaseUrl: string, botToken: string, method: string): URL {
    const requestUrl = new URL(apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`);
    requestUrl.pathname = `${requestUrl.pathname.replace(/\/+$/, "")}/bot${botToken}/${method}`;
    return requestUrl;
}

async function executeTelegramRequest(
    requestUrl: URL,
    requestBody: Record<string, unknown>,
    signal?: AbortSignal,
): Promise<TelegramHttpResponse> {
    const body = JSON.stringify(requestBody);

    return await new Promise<TelegramHttpResponse>((resolve, reject) => {
        const request = (requestUrl.protocol === "https:" ? httpsRequest : httpRequest)(
            requestUrl,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(body).toString(),
                },
                signal: signal ?? AbortSignal.timeout(3 * 60 * 1000),
            },
            (response) => {
                const chunks: Buffer[] = [];

                response.on("data", (chunk: string | Buffer) => {
                    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
                });
                response.on("end", () => {
                    resolve({
                        status: response.statusCode ?? 0,
                        headers: response.headers,
                        body: Buffer.concat(chunks).toString("utf8"),
                    });
                });
            },
        );

        request.on("error", reject);
        request.write(body);
        request.end();
    });
}

export async function sendMessage(
    botToken: string,
    options: SendMessageOptions,
    signal?: AbortSignal,
): Promise<number[]> {
    if (botToken === "" || options.message === "") {
        options.logger.error({ msg: "invalid bot token or message", botToken, options });
        return [];
    }

    const requestUrl = buildTelegramRequestUrl(
        options.apiBaseUrl || DEFAULT_TELEGRAM_API_BASE_URL,
        botToken,
        "sendMessage",
    );
    const messageChunks = splitMessage(options.message, TELEGRAM_MAX_MESSAGE_LENGTH);
    const messageIds: number[] = [];

    options.logger.trace({
        msg: "sending message to telegram",
        botToken,
        apiBaseUrl: options.apiBaseUrl,
        chatId: options.chatId,
        topicId: options.topicId,
        parseMode: options.parseMode ?? "MarkdownV2",
        chunks: messageChunks.length,
    });

    for (const [chunkIndex, messageChunk] of messageChunks.entries()) {
        const requestBody = {
            chat_id: options.chatId,
            message_thread_id: options.topicId,
            text: messageChunk,
            parse_mode: options.parseMode ?? "MarkdownV2",
            disable_web_page_preview: options.disableLinkPreview,
            protect_content: options.protectContent,
        };
        let response: TelegramHttpResponse;
        try {
            response = await executeTelegramRequest(requestUrl, requestBody, signal);
        } catch (error) {
            options.logger.error({
                msg: "telegram send request failed before response",
                error: serializeError(error),
                request_url: requestUrl.toString(),
                request_body: requestBody,
                chunk: chunkIndex + 1,
                total_chunks: messageChunks.length,
            });
            throw error;
        }

        if (response.status < 200 || response.status >= 300) {
            options.logger.warn({
                msg: "failed to send message to telegram",
                response_body: response.body,
                status: response.status,
                headers: response.headers,
                request_body: requestBody,
                chunk: chunkIndex + 1,
                total_chunks: messageChunks.length,
            });
            return messageIds;
        }

        const messageId = extractMessageId(response.body);
        if (messageId !== undefined) {
            messageIds.push(messageId);
        }

        options.logger.trace({
            msg: "sent message to telegram",
            response_body: response.body,
            message_id: messageId,
            chunk: chunkIndex + 1,
            total_chunks: messageChunks.length,
        });
    }

    return messageIds;
}

export async function editMessage(
    botToken: string,
    options: EditMessageOptions,
    signal?: AbortSignal,
): Promise<boolean> {
    if (botToken === "" || options.message === "") {
        options.logger.error({ msg: "invalid bot token or message", botToken, options });
        return false;
    }

    const requestUrl = buildTelegramRequestUrl(
        options.apiBaseUrl || DEFAULT_TELEGRAM_API_BASE_URL,
        botToken,
        "editMessageText",
    );
    const requestBody = {
        chat_id: options.chatId,
        message_id: options.messageId,
        text: options.message,
        parse_mode: options.parseMode ?? "MarkdownV2",
        disable_web_page_preview: options.disableLinkPreview,
    };
    let response: TelegramHttpResponse;
    try {
        response = await executeTelegramRequest(requestUrl, requestBody, signal);
    } catch (error) {
        options.logger.error({
            msg: "telegram edit request failed before response",
            error: serializeError(error),
            request_url: requestUrl.toString(),
            request_body: requestBody,
        });
        throw error;
    }

    if (response.status < 200 || response.status >= 300) {
        options.logger.warn({
            msg: "failed to edit message in telegram",
            response_body: response.body,
            status: response.status,
            headers: response.headers,
            request_body: requestBody,
        });
        return false;
    }

    options.logger.trace({
        msg: "edited message in telegram",
        response_body: response.body,
        message_id: options.messageId,
    });

    return true;
}
