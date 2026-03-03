import { z } from "zod";

export const metricAlertSchema = z.object({
    action: z.string(),
    actor: z.object({ id: z.string(), name: z.string(), type: z.string() }),
    data: z.object({
        description_text: z.string(),
        description_title: z.string(),
        metric_alert: z
            .object({
                alert_rule: z
                    .object({
                        aggregate: z.string(),
                        created_by: z.string().nullish(),
                        dataset: z.string(),
                        date_created: z.string(),
                        date_modified: z.string(),
                        environment: z.string().nullish(),
                        id: z.string(),
                        include_all_projects: z.boolean(),
                        name: z.string(),
                        organization_id: z.string(),
                        projects: z.array(z.string()),
                        query: z.string(),
                        resolution: z.number(),
                        resolve_threshold: z.unknown(),
                        status: z.number(),
                        threshold_period: z.number(),
                        threshold_type: z.number(),
                        time_window: z.number(),
                        triggers: z.array(z.unknown()),
                    })
                    .partial()
                    .nullish(),
                date_closed: z.coerce.date().nullish(),
                date_created: z.coerce.date().nullish(),
                date_detected: z.coerce.date().nullish(),
                date_started: z.coerce.date().nullish(),
                id: z.string(),
                identifier: z.string().nullish(),
                organization_id: z.string(),
                projects: z.array(z.string()),
                status: z.number().nullish(),
                status_method: z.number().nullish(),
                title: z.string(),
                type: z.number(),
            })
            .partial(),
        web_url: z.string(),
    }),
    installation: z.object({ uuid: z.string() }),
});

export const issueAlertSchema = z.object({
    action: z.string(),
    actor: z.object({ id: z.string(), name: z.string(), type: z.string() }),
    data: z.object({
        event: z.object({
            _ref: z.number().nullish(),
            _ref_version: z.number().nullish(),
            contexts: z
                .object({
                    browser: z
                        .object({
                            name: z.string(),
                            type: z.string(),
                            version: z.string(),
                        })
                        .partial()
                        .nullish(),
                    os: z
                        .object({
                            name: z.string(),
                            type: z.string(),
                            version: z.string(),
                        })
                        .partial()
                        .nullish(),
                })
                .partial()
                .nullish(),
            culprit: z.string().nullish(),
            datetime: z.coerce.date(),
            dist: z.string().nullish(),
            event_id: z.string(),
            exception: z
                .object({
                    values: z.array(
                        z.object({
                            mechanism: z
                                .object({
                                    data: z
                                        .object({
                                            message: z.string(),
                                            mode: z.string(),
                                            name: z.string(),
                                        })
                                        .partial()
                                        .nullish(),
                                    description: z.string().nullish(),
                                    handled: z.boolean().nullish(),
                                    help_link: z.string().nullish(),
                                    meta: z.unknown().nullish(),
                                    synthetic: z.unknown().nullish(),
                                    type: z.string().nullish(),
                                })
                                .partial()
                                .nullish(),
                            type: z.string().nullish(),
                            value: z.string().nullish(),
                        }),
                    ),
                })
                .nullish(),
            fingerprint: z.array(z.string()).nullish(),
            grouping_config: z.object({ enhancements: z.string(), id: z.string() }).nullish(),
            hashes: z.array(z.string()).nullish(),
            issue_url: z.string(),
            issue_id: z.string(),
            key_id: z.string().nullish(),
            level: z.string(),
            location: z.string().nullish(),
            logger: z.string().nullish(),
            message: z.string(),
            metadata: z
                .object({
                    filename: z.string(),
                    type: z.string(),
                    value: z.string(),
                })
                .partial()
                .nullish(),
            platform: z.string(),
            project: z.number(),
            received: z.number(),
            release: z.string().nullish(),
            request: z
                .object({
                    cookies: z.union([z.array(z.unknown()), z.string()]).nullish(),
                    data: z.union([z.record(z.unknown()), z.string(), z.array(z.unknown())]).nullish(),
                    env: z.union([z.record(z.unknown()), z.string(), z.array(z.unknown())]).nullish(),
                    fragment: z.string().nullish(),
                    headers: z.array(z.union([z.array(z.string()), z.string()])).nullish(),
                    inferred_content_type: z.string().nullish(),
                    method: z.string().nullish(),
                    query_string: z.array(z.unknown()).nullish(),
                    url: z.string(),
                })
                .partial()
                .nullish(),
            sdk: z
                .object({
                    integrations: z.array(z.string()),
                    name: z.string(),
                    packages: z.array(z.object({ name: z.string(), version: z.string() })),
                    version: z.string(),
                })
                .partial()
                .nullish(),
            tags: z.array(z.array(z.string())).nullish(),
            time_spent: z.coerce.number().nullish(),
            timestamp: z.coerce.number().transform((value) => new Date(value * 1000)),
            title: z.string(),
            type: z.string(),
            url: z.string(),
            user: z.object({ ip_address: z.string() }).nullish(),
            version: z.string().nullish(),
            web_url: z.string(),
        }),
        triggered_rule: z.string(),
        issue_alert: z
            .object({
                title: z.string(),
                settings: z.array(z.object({ name: z.string(), value: z.string() })),
            })
            .nullish(),
    }),
    installation: z.object({ uuid: z.string() }),
});
