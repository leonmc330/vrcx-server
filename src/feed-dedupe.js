/**
 *
 *  ## OVERVIEW
 *
 *  Suppresses duplicate feed rows caused by running two live copies of VRCX at
 *  once (your browser tab, and the always-on engine tab).
 *
 *  VRCX avoids duplicate feed entries by deciding client-side, from its own
 *  in-memory state, whether a pipeline event is new before writing it - there
 *  is no database constraint backing it (its feed tables have no UNIQUE
 *  index; `INSERT OR IGNORE` has nothing to ignore against). That works fine
 *  with one running copy. With two independent copies, each decides "this is
 *  new" on its own and both write - a few seconds apart, matching whatever
 *  skew exists between their two pipeline connections.
 *
 *  This adds the missing check at the one place both copies actually meet:
 *  the shared database. Before running an insert into one of VRCX's own feed
 *  tables, it looks for a row with the same content written within the last
 *  few seconds and skips the insert if one exists. It never touches VRCX's
 *  own SQL or schema - it reads the query VRCX already sent and decides
 *  whether to run it.
 *
 */

// created_at is `new Date().toJSON()` (ISO 8601, UTC, lexically sortable), so
// a plain string comparison in SQL is a correct time-range check.
const DEDUPE_WINDOW_MS = 20_000;

/**
 * suffix -> the columns that make two rows "the same event", matching the
 * @param names VRCX's own INSERT statements use (src/services/database/*.js).
 * Table names carry a per-account prefix, so tables are matched by suffix.
 */
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

/**
 * Decides whether an INSERT is a near-duplicate of a row already written by
 * the other live session, and should be skipped.
 * @param {Object} db A node:sqlite DatabaseSync
 * @param {string} sql The SQL VRCX is about to run
 * @param {Object|null} args Its named @parameters, already decoded to a plain object
 * @returns {boolean} Whether to skip running the insert
 */
function is_duplicate_feed_insert(db, sql, args) {
    if (!args || typeof sql !== "string") return false;

    const match = TABLE_PATTERN.exec(sql);
    if (!match) return false;

    const table = match[1];
    const suffix = match[2].toLowerCase();
    const keys = RULES.get(suffix);
    const createdAt = args["@created_at"];
    if (!keys || typeof createdAt !== "string") return false;

    const cutoff = new Date(new Date(createdAt).getTime() - DEDUPE_WINDOW_MS).toISOString();
    const conditions = [];
    const params = [cutoff];
    for (const key of keys) {
        const value = args[`@${key}`];
        if (value === undefined) continue;
        // IS rather than = so a column that is legitimately NULL still matches
        conditions.push(`${key} IS ?`);
        params.push(value);
    }
    if (conditions.length === 0) return false;

    const row = db
        .prepare(`SELECT 1 FROM ${table} WHERE created_at >= ? AND ${conditions.join(" AND ")} LIMIT 1`)
        .get(...params);
    return Boolean(row);
}

module.exports = { is_duplicate_feed_insert, DEDUPE_WINDOW_MS, RULES };
