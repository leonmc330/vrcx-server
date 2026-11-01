const DEDUPE_WINDOW_MS = 20_000;

const RULES = new Map([
    ["_feed_gps", ["user_id", "location", "world_name", "previous_location", "group_name"]],
    ["_feed_status", ["user_id", "status", "status_description", "previous_status", "previous_status_description"]],
    ["_feed_bio", ["user_id", "bio", "previous_bio"]],
    ["_feed_avatar", ["user_id", "owner_id", "current_avatar_image_url"]],
    ["_feed_online_offline", ["user_id", "type", "location", "world_name", "group_name"]],
    ["_friend_log_history", ["type", "user_id", "display_name", "previous_display_name", "trust_level", "previous_trust_level", "friend_number"]],
]);

const TABLE_PATTERN = new RegExp(
    `INSERT(?:\\s+OR\\s+IGNORE)?\\s+INTO\\s+([A-Za-z0-9_]*(${[...RULES.keys()].join("|")}))\\b`,
    "i"
);

function argsGet(args, key) {
    if (args instanceof Map) return args.get(key);
    if (args && typeof args === "object") {
        if (Object.prototype.hasOwnProperty.call(args, key)) return args[key];
        if (Object.prototype.hasOwnProperty.call(args, key.replace(/^@/, ""))) return args[key.replace(/^@/, "")];
    }
    return undefined;
}

function inner(db, sql, args) {
    if (!args || typeof sql !== "string") return false;

    const match = TABLE_PATTERN.exec(sql);
    if (!match) return false;

    const table = match[1];
    const suffix = match[2].toLowerCase();
    const keys = RULES.get(suffix);
    const createdAt = argsGet(args, "@created_at") !== undefined ? argsGet(args, "@created_at") : argsGet(args, "created_at");
    if (!keys || typeof createdAt !== "string") return false;

    const cutoff = new Date(new Date(createdAt).getTime() - DEDUPE_WINDOW_MS).toISOString();
    const conditions = [];
    const params = [cutoff];
    for (const key of keys) {
        const value = argsGet(args, `@${key}`) !== undefined ? argsGet(args, `@${key}`) : argsGet(args, key);
        if (value === undefined) continue;
        conditions.push(`${key} IS ?`);
        params.push(value);
    }
    if (conditions.length === 0) return false;

    const query = `SELECT 1 FROM ${table} WHERE created_at >= ? AND ${conditions.join(" AND ")} LIMIT 1`;
    if (typeof db.prepare === "function") {
        try {
            return Boolean(db.prepare(query).get(...params));
        } catch (e) {
            return false;
        }
    }
    if (typeof db.all === "function") {
        return db.all(query, params).then((rows) => Array.isArray(rows) && rows.length > 0).catch(() => false);
    }
    return false;
}

function is_duplicate_feed_insert(db, sql, args) {
    const result = inner(db, sql, args);
    return result;
}

module.exports = { is_duplicate_feed_insert, DEDUPE_WINDOW_MS, RULES };
