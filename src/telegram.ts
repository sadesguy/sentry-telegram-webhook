import { type Logger } from "pino";

const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

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

export type SendMessageOptions = {
    chatId: number;
    topicId?: number;
    message: string;
    parseMode?: "HTML" | "MarkdownV2";
    disableLinkPreview: boolean;
    protectContent: boolean;
    logger: Logger;
};

export type EditMessageOptions = {
    chatId: number;
    topicId?: number;
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

export async function sendMessage(
    botToken: string,
    options: SendMessageOptions,
    signal?: AbortSignal,
): Promise<number[]> {
    if (botToken === "" || options.message === "") {
        options.logger.error({ msg: "invalid bot token or message", botToken, options });
        return [];
    }

    const requestUrl = new URL(`https://api.telegram.org/bot${botToken}/sendMessage`);
    const messageChunks = splitMessage(options.message, TELEGRAM_MAX_MESSAGE_LENGTH);
    const messageIds: number[] = [];

    options.logger.trace({
        msg: "sending message to telegram",
        botToken,
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
        };

        const response = await fetch(requestUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify(requestBody),
            signal: signal ?? AbortSignal.timeout(3 * 60 * 1000),
        });

        if (!response.ok) {
            const responseBody = await response.text();
            const responseHeaders: Record<string, unknown> = {};
            for (const [key, value] of response.headers) {
                responseHeaders[key] = value;
            }
            options.logger.warn({
                msg: "failed to send message to telegram",
                response_body: responseBody,
                status: response.status,
                headers: responseHeaders,
                request_body: requestBody,
                chunk: chunkIndex + 1,
                total_chunks: messageChunks.length,
            });
            return messageIds;
        }

        const responseBody = await response.text();
        const messageId = extractMessageId(responseBody);
        if (messageId !== undefined) {
            messageIds.push(messageId);
        }

        options.logger.trace({
            msg: "sent message to telegram",
            response_body: responseBody,
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

    const requestUrl = new URL(`https://api.telegram.org/bot${botToken}/editMessageText`);
    const requestBody = {
        chat_id: options.chatId,
        message_thread_id: options.topicId,
        message_id: options.messageId,
        text: options.message,
        parse_mode: options.parseMode ?? "MarkdownV2",
        disable_web_page_preview: options.disableLinkPreview,
    };

    const response = await fetch(requestUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
        signal: signal ?? AbortSignal.timeout(3 * 60 * 1000),
    });

    const responseBody = await response.text();
    if (!response.ok) {
        const responseHeaders: Record<string, unknown> = {};
        for (const [key, value] of response.headers) {
            responseHeaders[key] = value;
        }

        options.logger.warn({
            msg: "failed to edit message in telegram",
            response_body: responseBody,
            status: response.status,
            headers: responseHeaders,
            request_body: requestBody,
        });
        return false;
    }

    options.logger.trace({
        msg: "edited message in telegram",
        response_body: responseBody,
        message_id: options.messageId,
    });

    return true;
}
