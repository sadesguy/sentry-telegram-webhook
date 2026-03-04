import { createHmac } from "node:crypto";
import * as process from "node:process";
import { serve } from "@hono/node-server";
import * as SentryNode from "@sentry/node";
import { Hono } from "hono";
import { pinoLogger } from "hono-pino";
import { type Logger, pino } from "pino";
import { ZodError } from "zod";
import { issueAlertSchema, metricAlertSchema } from "./schemas.js";
import { resolveProjectName } from "./sentry.js";
import { editMessage, sendMessage } from "./telegram.js";

const DEFAULT_TIME_ZONE = "Asia/Jakarta";
const APP_LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal", "silent"] as const;
const SENTRY_EVENT_LEVELS = ["fatal", "error", "warning", "log", "info", "debug"] as const;
const ERROR_CREATED_COUNTER_ENTRY_TTL_MS = 24 * 60 * 60 * 1000;

const logger = pino({
    level: process.env.LOG_LEVEL ?? "info",
});

type ErrorCreatedCounterEntry = {
    title: string;
    project?: string;
    detailUrl?: string;
    environment?: string;
    serverName?: string;
    observedAt: unknown;
    count: number;
    messageId?: number;
    updatedAt: number;
};

const errorCreatedCounterEntries = new Map<string, ErrorCreatedCounterEntry>();
const errorCreatedCounterUpdateQueue = new Map<string, Promise<void>>();

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return isRecord(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
    if (typeof value !== "string") {
        return undefined;
    }

    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
}

function asNumber(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }

    if (typeof value === "string") {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }

    return undefined;
}

function asDate(value: unknown): Date | undefined {
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? undefined : value;
    }

    const maybeNumber = asNumber(value);
    if (maybeNumber !== undefined) {
        const normalizedMillis = maybeNumber > 1_000_000_000_000 ? maybeNumber : maybeNumber * 1000;
        const dateFromNumber = new Date(normalizedMillis);
        if (!Number.isNaN(dateFromNumber.getTime())) {
            return dateFromNumber;
        }
    }

    if (typeof value === "string") {
        const dateFromString = new Date(value);
        if (!Number.isNaN(dateFromString.getTime())) {
            return dateFromString;
        }
    }

    return undefined;
}

function formatDate(value: unknown, timeZone: string): string {
    const date = asDate(value);
    if (date === undefined) {
        return "no data";
    }

    return date.toLocaleString("en-US", {
        dateStyle: "long",
        timeStyle: "long",
        hour12: false,
        timeZone,
    });
}

function escapeHtml(value: string): string {
    return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function asBoolean(value: unknown): boolean | undefined {
    if (typeof value === "boolean") {
        return value;
    }

    const normalized = asString(value)?.toLowerCase();
    if (normalized === undefined) {
        return undefined;
    }

    if (normalized === "true" || normalized === "1" || normalized === "yes") {
        return true;
    }
    if (normalized === "false" || normalized === "0" || normalized === "no") {
        return false;
    }

    return undefined;
}

function isArchivedIssueStatus(value: unknown): boolean {
    const normalized = asString(value)?.toLowerCase();
    return normalized === "archived" || normalized === "ignored";
}

function resolveTimeZone(configuredTimeZone: string | undefined, appLogger: Logger): string {
    const sanitizedConfiguredTimeZone = asString(configuredTimeZone);
    if (sanitizedConfiguredTimeZone === undefined) {
        return DEFAULT_TIME_ZONE;
    }

    try {
        new Intl.DateTimeFormat("en-US", { timeZone: sanitizedConfiguredTimeZone });
        return sanitizedConfiguredTimeZone;
    } catch (error) {
        appLogger.warn({
            msg: "invalid timezone provided, falling back to default",
            configuredTimeZone: sanitizedConfiguredTimeZone,
            fallbackTimeZone: DEFAULT_TIME_ZONE,
            error,
        });
        return DEFAULT_TIME_ZONE;
    }
}

function resolveSentryTraceSampleRate(configuredSampleRate: string | undefined, appLogger: Logger): number | undefined {
    if (configuredSampleRate === undefined || configuredSampleRate.trim() === "") {
        return undefined;
    }

    const sampleRate = Number.parseFloat(configuredSampleRate);
    if (Number.isNaN(sampleRate) || sampleRate < 0 || sampleRate > 1) {
        appLogger.warn({
            msg: "invalid self sentry traces sample rate, value should be between 0 and 1",
            configuredSampleRate,
        });
        return undefined;
    }

    return sampleRate;
}

function extractEnvironment(tags: unknown): string | undefined {
    if (Array.isArray(tags)) {
        for (const tag of tags) {
            if (Array.isArray(tag) && tag.length >= 2 && tag.at(0) === "environment") {
                const environment = tag
                    .slice(1)
                    .filter((value): value is string => typeof value === "string")
                    .join(" ")
                    .trim();
                if (environment !== "") {
                    return environment;
                }
            }

            if (isRecord(tag) && asString(tag.key) === "environment") {
                const value = asString(tag.value);
                if (value !== undefined) {
                    return value;
                }
            }
        }
    }

    if (isRecord(tags)) {
        const environment = asString(tags.environment);
        if (environment !== undefined) {
            return environment;
        }
    }

    return undefined;
}

function extractTagValue(tags: unknown, tagKeys: string[]): string | undefined {
    const normalizedTagKeys = new Set(tagKeys.map((tagKey) => tagKey.toLowerCase()));

    if (Array.isArray(tags)) {
        for (const tag of tags) {
            if (Array.isArray(tag) && tag.length >= 2) {
                const key = asString(tag.at(0))?.toLowerCase();
                if (key !== undefined && normalizedTagKeys.has(key)) {
                    const value = tag
                        .slice(1)
                        .map((part) => asString(part))
                        .filter((part): part is string => part !== undefined)
                        .join(" ")
                        .trim();
                    if (value !== "") {
                        return value;
                    }
                }
            }

            if (isRecord(tag)) {
                const key = asString(tag.key)?.toLowerCase();
                if (key !== undefined && normalizedTagKeys.has(key)) {
                    const value = asString(tag.value);
                    if (value !== undefined) {
                        return value;
                    }
                }
            }
        }
    }

    if (isRecord(tags)) {
        for (const tagKey of tagKeys) {
            const value = asString(tags[tagKey]);
            if (value !== undefined) {
                return value;
            }
        }
    }

    return undefined;
}

function buildConfiguredSentryDetailUrl(
    detailUrl: string | undefined,
    configuredSentryUrl: string | undefined,
): string | undefined {
    const sanitizedDetailUrl = asString(detailUrl);
    const sanitizedConfiguredSentryUrl = asString(configuredSentryUrl);
    if (sanitizedDetailUrl === undefined || sanitizedConfiguredSentryUrl === undefined) {
        return undefined;
    }

    try {
        const detail = new URL(sanitizedDetailUrl);
        const configured = new URL(sanitizedConfiguredSentryUrl);
        configured.pathname = detail.pathname;
        configured.search = detail.search;
        configured.hash = detail.hash;

        const rewrittenUrl = configured.toString();
        if (rewrittenUrl === detail.toString()) {
            return undefined;
        }
        return rewrittenUrl;
    } catch {
        return undefined;
    }
}

function inferSentryHookResource(requestBody: unknown): string | undefined {
    const root = asRecord(requestBody);
    const data = asRecord(root?.data);
    if (data === undefined) {
        return undefined;
    }

    if (isRecord(data.event)) {
        return "event_alert";
    }
    if (isRecord(data.metric_alert)) {
        return "metric_alert";
    }
    if (isRecord(data.issue)) {
        return "issue";
    }
    if (data.comment !== undefined) {
        return "comment";
    }
    if (data.error !== undefined) {
        return "error";
    }
    if (data.installation !== undefined) {
        return "installation";
    }

    return undefined;
}

function createFallbackHookMessage(resource: string, action: string, requestBody: unknown, timeZone: string): string {
    const root = asRecord(requestBody);
    const data = asRecord(root?.data);
    const issue = asRecord(data?.issue);
    const event = asRecord(data?.event);

    const title =
        asString(data?.description_title) ??
        asString(issue?.title) ??
        asString(event?.title) ??
        asString(data?.title) ??
        "Sentry webhook received";

    const detailUrl =
        asString(data?.web_url) ??
        asString(issue?.web_url) ??
        asString(issue?.permalink) ??
        asString(event?.web_url) ??
        asString(event?.url);

    const fallbackDate =
        data?.date_detected ?? data?.date_created ?? issue?.last_seen ?? event?.timestamp ?? root?.timestamp;

    let message = `<b>${escapeHtml(resource)} (${escapeHtml(action)})</b>\n`;
    message += `\n${escapeHtml(title)}`;
    message += `\n<b>Date:</b> ${escapeHtml(formatDate(fallbackDate, timeZone))}`;
    if (detailUrl !== undefined) {
        message += "\n<b>Detail:</b> " + escapeHtml(detailUrl);
    }

    return message;
}

function shouldIgnoreArchivedIssueWebhook(requestBody: unknown, action: string, sentryHookResource: string): boolean {
    if (!["issue", "comment", "error", "event", "event_alert"].includes(sentryHookResource)) {
        return false;
    }

    const normalizedAction = action.toLowerCase();
    if (normalizedAction === "archive" || normalizedAction === "archived") {
        return true;
    }

    const root = asRecord(requestBody);
    const data = asRecord(root?.data);
    const issuePayload = asRecord(data?.issue) ?? asRecord(asRecord(data?.error)?.issue);
    const statusDetails = asRecord(issuePayload?.status_details) ?? asRecord(issuePayload?.statusDetails);
    const errorPayload = asRecord(data?.error);

    const issueStatusCandidates = [
        issuePayload?.status,
        issuePayload?.substatus,
        statusDetails?.status,
        data?.issue_status,
        errorPayload?.issue_status,
    ];
    if (issueStatusCandidates.some((candidate) => isArchivedIssueStatus(candidate))) {
        return true;
    }

    const issueArchivedFlags = [
        issuePayload?.is_archived,
        issuePayload?.isArchived,
        statusDetails?.is_archived,
        statusDetails?.isArchived,
        errorPayload?.is_archived,
        errorPayload?.isArchived,
    ];
    return issueArchivedFlags.some((candidate) => asBoolean(candidate) === true);
}

const configuration = {
    shouldValidateSignature: process.env.SHOULD_VALIDATE_SIGNATURE === "true",
    webhookSecret: process.env.WEBHOOK_SECRET ?? "",
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
    telegramGroupId: Number.parseInt(process.env.TELEGRAM_GROUP_ID ?? ""),
    telegramTopicId: process.env.TELEGRAM_TOPIC_ID ? Number.parseInt(process.env.TELEGRAM_TOPIC_ID) : undefined,
    protectMessageContent: process.env.PROTECT_MESSAGE_CONTENT === "true",
    logger,
    sentryUrl: process.env.SENTRY_URL,
    sentryOrganizationSlug: process.env.SENTRY_ORGANIZATION_SLUG,
    sentryIntegrationToken: process.env.SENTRY_INTEGRATION_TOKEN,
    timeZone: resolveTimeZone(
        process.env.MESSAGE_TIME_ZONE ?? process.env.TIME_ZONE ?? process.env.TIMEZONE ?? process.env.TZ,
        logger,
    ),
    selfSentryDsn: process.env.SELF_SENTRY_DSN ?? "",
    selfSentryEnvironment: process.env.SELF_SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? "production",
    selfSentryRelease: process.env.SELF_SENTRY_RELEASE,
    selfSentryTracesSampleRate: resolveSentryTraceSampleRate(process.env.SELF_SENTRY_TRACES_SAMPLE_RATE, logger),
    selfSentryDebug: process.env.SELF_SENTRY_DEBUG === "true",
};

function sendWebhookMessage(message: string, sentryHookResource: string, requestId: string | undefined): void {
    sendMessage(configuration.telegramBotToken, {
        chatId: configuration.telegramGroupId,
        topicId: configuration.telegramTopicId,
        message,
        parseMode: "HTML",
        disableLinkPreview: true,
        protectContent: configuration.protectMessageContent,
        logger,
    }).catch((error) => {
        SentryNode.captureException(error, {
            tags: {
                source: "telegram.sendMessage",
                sentryHookResource,
                requestId: requestId ?? "unknown",
            },
        });
        logger.error({
            msg: "failed to send webhook message to telegram",
            error,
            sentryHookResource,
            requestId,
        });
    });
}

function buildErrorCreatedCounterEntryKey(title: string, project: string | undefined): string {
    return `${(project ?? "unknown").toLowerCase()}|${title.toLowerCase()}`;
}

function buildErrorCreatedCounterMessage(
    title: string,
    project: string | undefined,
    detailUrl: string | undefined,
    environment: string | undefined,
    serverName: string | undefined,
    observedAt: unknown,
    count: number,
): string {
    let message = `<b>Error created: ${escapeHtml(title)}</b>\n`;

    if (project !== undefined) {
        message += `\nProject: ${escapeHtml(project)}`;
    }
    if (environment !== undefined) {
        message += `\nEnvironment: ${escapeHtml(environment)}`;
    }
    if (serverName !== undefined) {
        message += `\nServer: ${escapeHtml(serverName)}`;
    }

    message += `\n\nDate: ${escapeHtml(formatDate(observedAt, configuration.timeZone))}`;
    if (detailUrl !== undefined) {
        message += `\nDetail: ${escapeHtml(detailUrl)}`;
    }
    const configuredDetailUrl = buildConfiguredSentryDetailUrl(detailUrl, configuration.sentryUrl);
    if (configuredDetailUrl !== undefined) {
        message += `\nDetail (Configured URL): ${escapeHtml(configuredDetailUrl)}`;
    }
    message += `\nCount: ${count}`;

    return message;
}

function clearExpiredErrorCreatedCounterEntries(now = Date.now()): void {
    for (const [entryKey, entry] of errorCreatedCounterEntries.entries()) {
        if (now - entry.updatedAt > ERROR_CREATED_COUNTER_ENTRY_TTL_MS) {
            errorCreatedCounterEntries.delete(entryKey);
        }
    }
}

async function upsertErrorCreatedMessage(
    title: string,
    project: string | undefined,
    detailUrl: string | undefined,
    environment: string | undefined,
    serverName: string | undefined,
    observedAt: unknown,
): Promise<void> {
    const now = Date.now();
    clearExpiredErrorCreatedCounterEntries(now);

    const entryKey = buildErrorCreatedCounterEntryKey(title, project);
    const existingEntry = errorCreatedCounterEntries.get(entryKey);
    const nextEntry: ErrorCreatedCounterEntry = {
        title,
        project,
        detailUrl: detailUrl ?? existingEntry?.detailUrl,
        environment: environment ?? existingEntry?.environment,
        serverName: serverName ?? existingEntry?.serverName,
        observedAt,
        count: (existingEntry?.count ?? 0) + 1,
        messageId: existingEntry?.messageId,
        updatedAt: now,
    };
    errorCreatedCounterEntries.set(entryKey, nextEntry);

    const message = buildErrorCreatedCounterMessage(
        nextEntry.title,
        nextEntry.project,
        nextEntry.detailUrl,
        nextEntry.environment,
        nextEntry.serverName,
        nextEntry.observedAt,
        nextEntry.count,
    );

    try {
        if (nextEntry.messageId !== undefined) {
            const edited = await editMessage(configuration.telegramBotToken, {
                chatId: configuration.telegramGroupId,
                messageId: nextEntry.messageId,
                message,
                parseMode: "HTML",
                disableLinkPreview: true,
                logger,
            });

            if (edited) {
                return;
            }

            logger.warn({
                msg: "failed to edit existing error counter message, skipping resend to avoid duplicate alerts",
                title,
                project,
                messageId: nextEntry.messageId,
            });
            return;
        }

        const sentMessageIds = await sendMessage(configuration.telegramBotToken, {
            chatId: configuration.telegramGroupId,
            topicId: configuration.telegramTopicId,
            message,
            parseMode: "HTML",
            disableLinkPreview: true,
            protectContent: configuration.protectMessageContent,
            logger,
        });

        const firstMessageId = sentMessageIds.at(0);
        if (firstMessageId !== undefined) {
            nextEntry.messageId = firstMessageId;
            errorCreatedCounterEntries.set(entryKey, nextEntry);
        }
    } catch (error) {
        SentryNode.captureException(error, {
            tags: {
                source: "telegram.upsertErrorCreatedMessage",
            },
        });
        logger.error({
            msg: "failed to upsert error created counter message in telegram",
            error,
            title,
            project,
        });
    }
}

function scheduleErrorCreatedMessageUpdate(
    title: string,
    project: string | undefined,
    detailUrl: string | undefined,
    environment: string | undefined,
    serverName: string | undefined,
    observedAt: unknown,
): void {
    const entryKey = buildErrorCreatedCounterEntryKey(title, project);
    const previousTask = errorCreatedCounterUpdateQueue.get(entryKey) ?? Promise.resolve();

    const nextTask = previousTask
        .catch(() => undefined)
        .then(() => upsertErrorCreatedMessage(title, project, detailUrl, environment, serverName, observedAt))
        .finally(() => {
            if (errorCreatedCounterUpdateQueue.get(entryKey) === nextTask) {
                errorCreatedCounterUpdateQueue.delete(entryKey);
            }
        });

    errorCreatedCounterUpdateQueue.set(entryKey, nextTask);
}

if (configuration.selfSentryDsn !== "") {
    SentryNode.init({
        dsn: configuration.selfSentryDsn,
        environment: configuration.selfSentryEnvironment,
        release: configuration.selfSentryRelease,
        tracesSampleRate: configuration.selfSentryTracesSampleRate,
        debug: configuration.selfSentryDebug,
    });

    logger.info({
        msg: "self sentry sdk enabled",
        environment: configuration.selfSentryEnvironment,
        release: configuration.selfSentryRelease,
        tracesSampleRate: configuration.selfSentryTracesSampleRate,
        debug: configuration.selfSentryDebug,
    });
}

const app = new Hono();

app.onError((error, c) => {
    SentryNode.captureException(error, {
        tags: {
            source: "hono.onError",
        },
    });

    if (error instanceof ZodError) {
        logger.warn({ msg: "invalid request body", error: error.issues });
        return c.json({ message: "invalid request body", error: error.issues }, 400);
    }

    if (error instanceof TypeError) {
        logger.warn({
            msg: "invalid request body",
            error: { cause: error.cause, stack: error.stack, name: error.name, message: error.message },
        });
        return c.json({ message: "unhandled error", error: error.message }, 400);
    }

    if (error instanceof Error) {
        logger.error({ msg: "unhandled error", error: error.message });
        return c.json({ message: "unhandled error", error: error.message }, 500);
    }

    logger.error({ msg: "unhandled error", error });
    return c.json({ message: "unhandled error", error }, 500);
});

app.get("/", (c) => {
    return c.text(".", 200);
});

app.get("/debug/levels", (c) => {
    return c.json(
        {
            currentLogLevel: logger.level,
            appLogLevels: APP_LOG_LEVELS,
            sentryEventLevels: SENTRY_EVENT_LEVELS,
        },
        200,
    );
});

app.post("/sentry/webhook", pinoLogger({ pino: logger }), async (c) => {
    if (configuration.shouldValidateSignature) {
        if (configuration.webhookSecret === "") {
            c.get("logger").warn("webhookSecret is empty, signature validation is disabled");
        } else {
            const rawRequestBody = await c.req.raw.clone().text();
            const sentryHookSignature = c.req.header("sentry-hook-signature");

            if (sentryHookSignature === undefined) {
                c.get("logger").warn("sentry-hook-signature header is missing");
                return c.json({ message: "sentry-hook-signature header is missing" }, 400);
            }

            const hmac = createHmac("sha256", configuration.webhookSecret);
            hmac.update(rawRequestBody, "utf8");
            const digest = hmac.digest("hex");
            const signatureValidated = digest === sentryHookSignature;

            if (!signatureValidated) {
                c.get("logger").warn("signature is invalid");
                return c.json({ message: "signature is invalid" }, 400);
            }
        }
    }

    const requestBody: unknown = await c.req.json();
    const requestId = c.req.header("request-id");
    const requestBodyRecord = asRecord(requestBody);
    const action = asString(requestBodyRecord?.action) ?? "triggered";

    const sentryHookResource =
        asString(c.req.header("sentry-hook-resource"))?.toLowerCase() ??
        inferSentryHookResource(requestBody) ??
        "unknown";

    if (shouldIgnoreArchivedIssueWebhook(requestBody, action, sentryHookResource)) {
        c.get("logger").info({
            msg: "ignoring archived issue related webhook",
            sentryHookResource,
            action,
            requestId,
        });
        return c.json({ message: "ignored archived issue related webhook" }, 200);
    }

    let message: string | null = null;
    let errorCreatedMessageHandled = false;

    switch (sentryHookResource) {
        case "event_alert":
        case "event": {
            const parsedIssueAlert = issueAlertSchema.safeParse(requestBody);

            if (parsedIssueAlert.success) {
                const event = parsedIssueAlert.data.data.event;
                let eventAlertMessage = `<b>${escapeHtml(event.title)} (${escapeHtml(event.type)})</b>\n`;

                const resolvedProject = await resolveProjectName(event.project, configuration, c.req.raw.signal);
                if (resolvedProject !== null) {
                    eventAlertMessage += `\n${escapeHtml(resolvedProject.name)}-${event.project} (${escapeHtml(resolvedProject.platform)})`;
                } else {
                    eventAlertMessage += `\n${event.project} (${escapeHtml(event.platform)})`;
                }

                const environment = extractEnvironment(event.tags);
                if (environment !== undefined) {
                    eventAlertMessage += "\n<b>Environment:</b> " + escapeHtml(environment);
                }

                eventAlertMessage += `\n<b>Date:</b> ${escapeHtml(formatDate(event.timestamp, configuration.timeZone))}`;
                eventAlertMessage += "\n<b>Detail:</b> " + escapeHtml(event.web_url);

                message = eventAlertMessage;
            } else {
                const eventPayload = asRecord(asRecord(requestBodyRecord?.data)?.event);
                if (eventPayload !== undefined) {
                    const title =
                        asString(eventPayload.title) ?? asString(eventPayload.message) ?? "Sentry Event Alert";
                    const eventType = asString(eventPayload.type) ?? action;
                    let eventAlertMessage = `<b>${escapeHtml(title)} (${escapeHtml(eventType)})</b>\n`;

                    const projectId = asNumber(eventPayload.project);
                    const projectSlug =
                        asString(eventPayload.project_slug) ??
                        (projectId !== undefined ? String(projectId) : asString(eventPayload.project_name));
                    const projectPlatform = asString(eventPayload.platform);

                    if (projectId !== undefined) {
                        const resolvedProject = await resolveProjectName(projectId, configuration, c.req.raw.signal);
                        if (resolvedProject !== null) {
                            eventAlertMessage += `\n${escapeHtml(resolvedProject.name)}-${projectId} (${escapeHtml(resolvedProject.platform)})`;
                        } else if (projectSlug !== undefined) {
                            eventAlertMessage += `\n${escapeHtml(projectSlug)}${projectPlatform ? ` (${escapeHtml(projectPlatform)})` : ""}`;
                        }
                    } else if (projectSlug !== undefined) {
                        eventAlertMessage += `\n${escapeHtml(projectSlug)}${projectPlatform ? ` (${escapeHtml(projectPlatform)})` : ""}`;
                    }

                    const environment = extractEnvironment(eventPayload.tags);
                    if (environment !== undefined) {
                        eventAlertMessage += "\n<b>Environment:</b> " + escapeHtml(environment);
                    }

                    const eventDate =
                        eventPayload.timestamp ??
                        eventPayload.datetime ??
                        eventPayload.received ??
                        asRecord(requestBodyRecord?.data)?.date_detected;
                    eventAlertMessage += `\n<b>Date:</b> ${escapeHtml(formatDate(eventDate, configuration.timeZone))}`;

                    const detailUrl =
                        asString(eventPayload.web_url) ??
                        asString(eventPayload.issue_url) ??
                        asString(eventPayload.url) ??
                        asString(asRecord(requestBodyRecord?.data)?.web_url);
                    if (detailUrl !== undefined) {
                        eventAlertMessage += "\n<b>Detail:</b> " + escapeHtml(detailUrl);
                    }

                    message = eventAlertMessage;
                }
            }
            break;
        }
        case "metric_alert":
        case "metric": {
            const parsedMetricAlert = metricAlertSchema.safeParse(requestBody);

            if (parsedMetricAlert.success) {
                const metricPayload = parsedMetricAlert.data.data;
                const descriptionTitle = escapeHtml(metricPayload.description_title);
                const descriptionText = escapeHtml(metricPayload.description_text);
                let metricMessage = `<b>${descriptionTitle} (${descriptionText})</b>\n`;
                metricMessage += `\nProject: ${escapeHtml(metricPayload.metric_alert.projects?.join(", ") ?? "Unknown")}`;
                metricMessage += `\n<b>Date:</b> ${escapeHtml(formatDate(metricPayload.metric_alert.date_detected, configuration.timeZone))}`;
                metricMessage += "\n<b>Detail:</b> " + escapeHtml(metricPayload.web_url);
                message = metricMessage;
            } else {
                const metricPayload = asRecord(asRecord(requestBodyRecord?.data)?.metric_alert);
                const rootMetricPayload = asRecord(requestBodyRecord?.data);
                if (rootMetricPayload !== undefined) {
                    const descriptionTitle = asString(rootMetricPayload.description_title) ?? "Metric Alert";
                    const descriptionText = asString(rootMetricPayload.description_text);
                    let metricMessage = `<b>${escapeHtml(descriptionTitle)}`;
                    if (descriptionText !== undefined) {
                        metricMessage += ` (${escapeHtml(descriptionText)})`;
                    }
                    metricMessage += "</b>\n";

                    let projectLabel = "Unknown";
                    if (Array.isArray(metricPayload?.projects)) {
                        const projects = metricPayload.projects
                            .map((project): string | undefined => asString(project))
                            .filter((project): project is string => project !== undefined);
                        if (projects.length > 0) {
                            projectLabel = projects.join(", ");
                        }
                    }
                    metricMessage += `\nProject: ${escapeHtml(projectLabel)}`;
                    metricMessage += `\n<b>Date:</b> ${escapeHtml(formatDate(metricPayload?.date_detected ?? rootMetricPayload.date_detected, configuration.timeZone))}`;

                    const detailUrl = asString(rootMetricPayload.web_url) ?? asString(metricPayload?.web_url);
                    if (detailUrl !== undefined) {
                        metricMessage += "\n<b>Detail:</b> " + escapeHtml(detailUrl);
                    }

                    message = metricMessage;
                }
            }
            break;
        }
        case "issue": {
            const data = asRecord(requestBodyRecord?.data);
            const issuePayload = asRecord(data?.issue);
            if (issuePayload !== undefined) {
                const title = asString(issuePayload.title) ?? "Sentry Issue";
                const project =
                    asString(data?.project_slug) ??
                    asString(issuePayload.project_slug) ??
                    asString(asRecord(issuePayload.project)?.slug) ??
                    asString(asRecord(issuePayload.project)?.name);
                const level = asString(issuePayload.level);
                const status = asString(issuePayload.status);
                const environment = asString(issuePayload.environment) ?? extractEnvironment(issuePayload.tags);
                const detailUrl =
                    asString(issuePayload.web_url) ??
                    asString(issuePayload.permalink) ??
                    asString(data?.web_url) ??
                    asString(data?.url);
                const observedAt =
                    issuePayload.last_seen ??
                    issuePayload.first_seen ??
                    issuePayload.date_created ??
                    issuePayload.date_detected ??
                    data?.date_created;

                let issueMessage = `<b>Issue ${escapeHtml(action)}: ${escapeHtml(title)}</b>\n`;
                if (project !== undefined) {
                    issueMessage += `\nProject: ${escapeHtml(project)}`;
                }
                if (level !== undefined) {
                    issueMessage += `\nLevel: ${escapeHtml(level)}`;
                }
                if (status !== undefined) {
                    issueMessage += `\nStatus: ${escapeHtml(status)}`;
                }
                if (environment !== undefined) {
                    issueMessage += `\n<b>Environment:</b> ${escapeHtml(environment)}`;
                }
                issueMessage += `\n<b>Date:</b> ${escapeHtml(formatDate(observedAt, configuration.timeZone))}`;
                if (detailUrl !== undefined) {
                    issueMessage += `\n<b>Detail:</b> ${escapeHtml(detailUrl)}`;
                }

                message = issueMessage;
            }
            break;
        }
        case "comment": {
            const data = asRecord(requestBodyRecord?.data);
            const commentPayload = asRecord(data?.comment);
            const issuePayload = asRecord(data?.issue);

            if (commentPayload !== undefined || issuePayload !== undefined) {
                const issueTitle = asString(issuePayload?.title) ?? "Unknown issue";
                const commentBody =
                    asString(commentPayload?.text) ??
                    asString(commentPayload?.body) ??
                    asString(commentPayload?.comment);
                const detailUrl =
                    asString(commentPayload?.web_url) ??
                    asString(issuePayload?.web_url) ??
                    asString(data?.web_url) ??
                    asString(data?.url);
                const observedAt =
                    commentPayload?.date_created ??
                    commentPayload?.date_updated ??
                    issuePayload?.last_seen ??
                    data?.date_created ??
                    requestBodyRecord?.timestamp;

                let commentMessage = `<b>Comment ${escapeHtml(action)}</b>\n`;
                commentMessage += `\nIssue: ${escapeHtml(issueTitle)}`;
                if (commentBody !== undefined) {
                    commentMessage += `\nComment: ${escapeHtml(commentBody)}`;
                }
                commentMessage += `\n<b>Date:</b> ${escapeHtml(formatDate(observedAt, configuration.timeZone))}`;
                if (detailUrl !== undefined) {
                    commentMessage += `\n<b>Detail:</b> ${escapeHtml(detailUrl)}`;
                }

                message = commentMessage;
            }
            break;
        }
        case "error": {
            const data = asRecord(requestBodyRecord?.data);
            const errorPayload = asRecord(data?.error) ?? data;
            const issuePayload = asRecord(data?.issue) ?? asRecord(errorPayload?.issue);

            if (errorPayload !== undefined) {
                const title =
                    asString(errorPayload.title) ??
                    asString(errorPayload.message) ??
                    asString(errorPayload.error) ??
                    "Sentry Integration Error";
                const project =
                    asString(errorPayload.project_slug) ??
                    asString(asRecord(errorPayload.project)?.slug) ??
                    asString(asRecord(errorPayload.project)?.name);
                const detailUrl =
                    asString(errorPayload.web_url) ??
                    asString(errorPayload.url) ??
                    asString(data?.web_url) ??
                    asString(data?.url);
                const environment =
                    asString(errorPayload.environment) ??
                    asString(issuePayload?.environment) ??
                    extractEnvironment(errorPayload.tags ?? issuePayload?.tags ?? data?.tags);
                const serverName =
                    asString(errorPayload.server_name) ??
                    asString(errorPayload.serverName) ??
                    asString(issuePayload?.culprit) ??
                    extractTagValue(errorPayload.tags ?? issuePayload?.tags ?? data?.tags, [
                        "server_name",
                        "server",
                        "host",
                        "hostname",
                    ]);
                const configuredDetailUrl = buildConfiguredSentryDetailUrl(detailUrl, configuration.sentryUrl);
                const observedAt =
                    errorPayload.timestamp ??
                    errorPayload.date_created ??
                    errorPayload.date_detected ??
                    data?.date_created ??
                    requestBodyRecord?.timestamp;

                let errorMessage = `<b>Error ${escapeHtml(action)}: ${escapeHtml(title)}</b>\n`;
                if (project !== undefined) {
                    errorMessage += `\nProject: ${escapeHtml(project)}`;
                }
                if (environment !== undefined) {
                    errorMessage += `\nEnvironment: ${escapeHtml(environment)}`;
                }
                if (serverName !== undefined) {
                    errorMessage += `\nServer: ${escapeHtml(serverName)}`;
                }
                errorMessage += `\n<b>Date:</b> ${escapeHtml(formatDate(observedAt, configuration.timeZone))}`;
                if (detailUrl !== undefined) {
                    errorMessage += `\n<b>Detail:</b> ${escapeHtml(detailUrl)}`;
                }
                if (configuredDetailUrl !== undefined) {
                    errorMessage += `\n<b>Detail (Configured URL):</b> ${escapeHtml(configuredDetailUrl)}`;
                }

                if (action.toLowerCase() === "created") {
                    scheduleErrorCreatedMessageUpdate(title, project, detailUrl, environment, serverName, observedAt);
                    errorCreatedMessageHandled = true;
                } else {
                    message = errorMessage;
                }
            }
            break;
        }
        case "installation": {
            const data = asRecord(requestBodyRecord?.data);
            const installation = asRecord(data?.installation) ?? asRecord(requestBodyRecord?.installation);
            const installationName =
                asString(installation?.name) ?? asString(installation?.slug) ?? asString(installation?.uuid);

            let installationMessage = `<b>Installation ${escapeHtml(action)}</b>\n`;
            if (installationName !== undefined) {
                installationMessage += `\nName: ${escapeHtml(installationName)}`;
            }
            installationMessage += `\n<b>Date:</b> ${escapeHtml(formatDate(requestBodyRecord?.timestamp, configuration.timeZone))}`;

            const detailUrl =
                asString(asRecord(requestBodyRecord?.data)?.web_url) ??
                asString(asRecord(requestBodyRecord?.data)?.url);
            if (detailUrl !== undefined) {
                installationMessage += `\n<b>Detail:</b> ${escapeHtml(detailUrl)}`;
            }

            message = installationMessage;
            break;
        }
        default: {
            c.get("logger").info({
                msg: "received unrecognized sentry-hook-resource, sending fallback notification",
                sentryHookResource,
                requestId,
            });
        }
    }

    if (errorCreatedMessageHandled) {
        c.get("logger").debug({
            msg: "updated error created counter message",
            sentryHookResource,
            requestId,
        });
        return c.json({ message: "ok" }, 200);
    }

    const finalMessage =
        message ?? createFallbackHookMessage(sentryHookResource, action, requestBody, configuration.timeZone);

    sendWebhookMessage(finalMessage, sentryHookResource, requestId);

    return c.json({ message: "ok" }, 200);
});

serve(
    {
        fetch: app.fetch,
        port: Number.parseInt(process.env.HTTP_PORT ?? "6500"),
        hostname: process.env.HTTP_HOSTNAME ?? "0.0.0.0",
    },
    (info) => {
        logger.info({ msg: "server started", info });
    },
);
