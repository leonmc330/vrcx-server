/**
 *
 *  Offline test for feed-dedupe.js, using the exact INSERT statements VRCX's
 *  own database layer writes (src/services/database/*.js in the VRCX repo),
 *  against a real in-memory node:sqlite database - not a simulation of one.
 *
 *      node tools/dedupe-test.js
 *
 */

const { DatabaseSync } = require("node:sqlite");
const { is_duplicate_feed_insert } = require("../src/feed-dedupe.js");

/**
 * Checks a condition
 * @param {boolean} condition What must hold
 * @param {string} label Description
 */
function assert(condition, label) {
    console.log(`${condition ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${label}`);
    if (!condition) process.exitCode = 1;
}

const PREFIX = "usrTESTUSER0000000000000000000000"; // same shape as dbVars.userPrefix

const db = new DatabaseSync(":memory:");
db.exec(
    `CREATE TABLE ${PREFIX}_feed_online_offline (id INTEGER PRIMARY KEY, created_at TEXT, user_id TEXT, display_name TEXT, type TEXT, location TEXT, world_name TEXT, time INTEGER, group_name TEXT)`
);
db.exec(
    `CREATE TABLE ${PREFIX}_feed_gps (id INTEGER PRIMARY KEY, created_at TEXT, user_id TEXT, display_name TEXT, location TEXT, world_name TEXT, previous_location TEXT, time INTEGER, group_name TEXT)`
);
db.exec(
    `CREATE TABLE ${PREFIX}_friend_log_history (id INTEGER PRIMARY KEY, created_at TEXT, type TEXT, user_id TEXT, display_name TEXT, previous_display_name TEXT, trust_level TEXT, previous_trust_level TEXT, friend_number INTEGER)`
);

// The exact statement VRCX writes for a friend coming online, verbatim
const ONLINE_SQL = `INSERT OR IGNORE INTO ${PREFIX}_feed_online_offline (created_at, user_id, display_name, type, location, world_name, time, group_name) VALUES (@created_at, @user_id, @display_name, @type, @location, @world_name, @time, @group_name)`;

/**
 * Runs an insert exactly as the interop layer does: check, then apply
 * @param {string} sql SQL text
 * @param {Object} args Named params
 * @returns {number} Rows changed, 0 if skipped as a duplicate
 */
function execute(sql, args) {
    if (is_duplicate_feed_insert(db, sql, args)) return 0;
    const result = db.prepare(sql).run(args);
    return Number(result.changes);
}

function test_two_tabs_same_event() {
    const base = {
        "@user_id": "usr_alice",
        "@display_name": "Alice",
        "@type": "Online",
        "@location": "wrld_x:12345~private",
        "@world_name": "Test World",
        "@time": 0,
        "@group_name": "",
    };

    // The real tab's copy of VRCX writes it first
    const first = execute(ONLINE_SQL, { ...base, "@created_at": "2026-09-07T13:00:00.000Z" });
    assert(first === 1, "the first tab's write goes through");

    // The engine's copy sees the same pipeline event 3 seconds later
    const second = execute(ONLINE_SQL, { ...base, "@created_at": "2026-09-07T13:00:03.000Z" });
    assert(second === 0, "the second tab's near-duplicate write is skipped");

    const rows = db.prepare(`SELECT COUNT(*) AS n FROM ${PREFIX}_feed_online_offline`).get();
    assert(rows.n === 1, `exactly one row exists in the database (${rows.n})`);
}

function test_real_repeat_transition_not_merged() {
    const base = {
        "@user_id": "usr_bob",
        "@display_name": "Bob",
        "@type": "Online",
        "@location": "wrld_y:1~public",
        "@world_name": "Another World",
        "@time": 0,
        "@group_name": "",
    };

    execute(ONLINE_SQL, { ...base, "@created_at": "2026-09-07T13:00:00.000Z" });
    // Bob goes offline and comes back online 5 minutes later - a real,
    // separate event with identical content to the first
    const later = execute(ONLINE_SQL, { ...base, "@created_at": "2026-09-07T13:05:00.000Z" });
    assert(later === 1, "a genuine repeat transition outside the window is not merged");
}

function test_different_people_not_confused() {
    const alice = {
        "@user_id": "usr_alice2",
        "@display_name": "Alice2",
        "@type": "Online",
        "@location": "wrld_z:1~public",
        "@world_name": "World",
        "@time": 0,
        "@group_name": "",
        "@created_at": "2026-09-07T14:00:00.000Z",
    };
    const carol = { ...alice, "@user_id": "usr_carol", "@display_name": "Carol", "@created_at": "2026-09-07T14:00:01.000Z" };

    const a = execute(ONLINE_SQL, alice);
    const c = execute(ONLINE_SQL, carol);
    assert(a === 1 && c === 1, "two different people with the same location are both recorded");
}

function test_location_change_not_deduped_against_online() {
    const GPS_SQL = `INSERT OR IGNORE INTO ${PREFIX}_feed_gps (created_at, user_id, display_name, location, world_name, previous_location, time, group_name) VALUES (@created_at, @user_id, @display_name, @location, @world_name, @previous_location, @time, @group_name)`;
    const args = {
        "@created_at": "2026-09-07T15:00:00.000Z",
        "@user_id": "usr_dave",
        "@display_name": "Dave",
        "@location": "wrld_a:1~public",
        "@world_name": "World A",
        "@previous_location": "",
        "@time": 0,
        "@group_name": "",
    };
    const result = execute(GPS_SQL, args);
    assert(result === 1, "a GPS insert is unaffected by an unrelated online_offline row");
}

function test_friend_log_history() {
    const SQL = `INSERT OR IGNORE INTO ${PREFIX}_friend_log_history (created_at, type, user_id, display_name, previous_display_name, trust_level, previous_trust_level, friend_number) VALUES (@created_at, @type, @user_id, @display_name, @previous_display_name, @trust_level, @previous_trust_level, @friend_number)`;
    const args = {
        "@created_at": "2026-09-07T16:00:00.000Z",
        "@type": "TrustLevel",
        "@user_id": "usr_erin",
        "@display_name": "Erin",
        "@previous_display_name": null,
        "@trust_level": "Trusted",
        "@previous_trust_level": "Known",
        "@friend_number": 42,
    };
    const first = execute(SQL, args);
    const dup = execute(SQL, { ...args, "@created_at": "2026-09-07T16:00:04.000Z" });
    assert(first === 1 && dup === 0, "friend_log_history dedupes the same trust-level change too");
}

function test_unrelated_sql_untouched() {
    const skipped = is_duplicate_feed_insert(db, "SELECT * FROM sqlite_master", {});
    assert(skipped === false, "a non-insert statement is never flagged");
    const noArgs = is_duplicate_feed_insert(db, ONLINE_SQL, null);
    assert(noArgs === false, "a call with no args is never flagged");
}

console.log("Feed dedupe tests (real node:sqlite, VRCX's own INSERT statements)\n");
test_two_tabs_same_event();
test_real_repeat_transition_not_merged();
test_different_people_not_confused();
test_location_change_not_deduped_against_online();
test_friend_log_history();
test_unrelated_sql_untouched();
console.log(process.exitCode ? "\nSome tests failed." : "\nAll tests passed.");
