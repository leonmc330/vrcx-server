const fs = require("fs");
const path = require("path");

let mysql = null;
try {
    mysql = require("mysql2/promise");
} catch (e) {
    mysql = null;
}

let nodeSqlite = null;
try {
    nodeSqlite = require("node:sqlite");
} catch (e) {
    nodeSqlite = null;
}

const CONFIG_FILE = "db.json";

function defaultConfig(dataDir) {
    return {
        engine: (process.env.DB_ENGINE || "mariadb").toLowerCase(),
        mariadb: {
            host: process.env.MARIADB_HOST || process.env.DB_HOST || "mariadb",
            port: Number(process.env.MARIADB_PORT || process.env.DB_PORT || 3306),
            user: process.env.MARIADB_USER || process.env.DB_USER || "vrcx",
            password: process.env.MARIADB_PASSWORD || process.env.DB_PASSWORD || "vrcx",
            database: process.env.MARIADB_DATABASE || process.env.DB_NAME || "vrcx",
        },
        sqlitePath: process.env.VRCX_SQLITE || path.join(dataDir, "VRCX.sqlite3"),
    };
}

function loadConfig(dataDir) {
    const cfg = defaultConfig(dataDir);
    try {
        const file = path.join(dataDir, CONFIG_FILE);
        if (fs.existsSync(file)) {
            const saved = JSON.parse(fs.readFileSync(file, "utf8"));
            if (saved && typeof saved === "object") {
                if (saved.engine) cfg.engine = String(saved.engine).toLowerCase();
                if (saved.mariadb && typeof saved.mariadb === "object") Object.assign(cfg.mariadb, saved.mariadb);
                if (saved.sqlitePath) cfg.sqlitePath = saved.sqlitePath;
            }
        }
    } catch (e) {
        console.error(`Could not read db config: ${e.message}`);
    }
    return cfg;
}

function saveConfig(dataDir, config) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, CONFIG_FILE), JSON.stringify(config, null, 2), { mode: 0o600 });
}

function sanitizeTableName(name) {
    return String(name || "").replace(/[^A-Za-z0-9_]/g, "");
}

function translateSqlForMariaDB(sql) {
    if (typeof sql !== "string") return { sql, isNoOp: false };
    let s = sql;
    let isNoOp = false;
    if (/^\s*(PRAGMA|VACUUM)\b/i.test(s)) isNoOp = true;
    s = s.replace(/INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT/gi, "INT PRIMARY KEY AUTO_INCREMENT");
    s = s.replace(/\bINTEGER\s+PRIMARY\s+KEY\b/gi, "INT PRIMARY KEY AUTO_INCREMENT");
    // TEXT columns (quoted or unquoted) become VARCHAR(255), LONGTEXT for long content
    s = s.replace(/`([A-Za-z_]\w*)`\s+TEXT\b/gi, (match, col) => {
        const c = col.toLowerCase();
        if (c.includes("description") || c.includes("memo") || c.includes("bio") ||
            c.includes("message") || c.includes("json") || c.includes("url") ||
            c.includes("data") || c === "note" || c.includes("title") || c.includes("content")) {
            return "`" + col + "` LONGTEXT";
        }
        return "`" + col + "` VARCHAR(255)";
    });
    s = s.replace(/\b([A-Za-z_]\w*)\s+TEXT\b/gi, (match, col) => {
        const c = col.toLowerCase();
        if (c.includes("description") || c.includes("memo") || c.includes("bio") ||
            c.includes("message") || c.includes("json") || c.includes("url") ||
            c.includes("data") || c === "note" || c.includes("title") || c.includes("content")) {
            return col + " LONGTEXT";
        }
        return col + " VARCHAR(255)";
    });
    s = s.replace(/PRIMARY KEY \(user_id, target_user_id, range_days, view_kind, exclude_key\)/gi,
        "PRIMARY KEY (user_id(64), target_user_id(64), range_days, view_kind(64), exclude_key(64))");
    // quote reserved-ish identifiers used by VRCX's config store
    s = s.replace(/(?<!PRIMARY )(?<!FOREIGN )(?<!UNIQUE )(?<!`)(?<!@)\bkey\b(?!`)/gi, "`key`");
    s = s.replace(/(?<!`)(?<!@)\bvalue\b(?!`)/gi, "`value`");
    s = s.replace(/IN\s*\(\s*\)/gi, "IN (NULL)");
    s = s.replace(/INSERT\s+OR\s+IGNORE/gi, "INSERT IGNORE");
    s = s.replace(/INSERT\s+OR\s+REPLACE/gi, "REPLACE");
    s = s.replace(/datetime\s*\(\s*'now'\s*,\s*([^)]+)\)/gi, "vrcx_datetime_now($1)");
    s = s.replace(/strftime\s*\(\s*'%s'\s*,\s*([^)]+)\)/gi, "UNIX_TIMESTAMP($1)");
    return { sql: s, isNoOp };
}

function namedToPositional(sql, args) {
    const order = [];
    const text = sql.replace(/@([A-Za-z_]\w*)/g, (match, name) => {
        order.push(name);
        return "?";
    });
    let values = [];
    const source = args instanceof Map ? Object.fromEntries(args) : args || {};
    if (Array.isArray(source)) {
        values = source;
    } else {
        values = order.map((name) => {
            const direct = source[name];
            if (direct !== undefined) return direct;
            const at = source["@" + name];
            if (at !== undefined) return at;
            return source[name];
        });
    }
    return { text, values };
}

class SqliteClient {
    constructor(filePath) {
        if (!nodeSqlite) throw new Error("node:sqlite is unavailable (requires Node 22+)");
        this.type = "sqlite";
        this.filePath = filePath;
        this.db = new nodeSqlite.DatabaseSync(filePath);
        try { this.db.exec("PRAGMA journal_mode = WAL"); } catch (e) { /* ignore */ }
    }
    all(sql, args) {
        const statement = this.db.prepare(sql);
        const params = args instanceof Map ? Object.fromEntries(args) : (args || {});
        try { statement.setAllowBareNamedParameters(true); } catch (e) { /* ignore */ }
        if (params && Object.keys(params).length > 0) {
            return statement.all(params).map((row) => Object.values(row));
        }
        return statement.all().map((row) => Object.values(row));
    }
    run(sql, args) {
        const statement = this.db.prepare(sql);
        const params = args instanceof Map ? Object.fromEntries(args) : (args || {});
        try { statement.setAllowBareNamedParameters(true); } catch (e) { /* ignore */ }
        const result = (params && Object.keys(params).length > 0)
            ? statement.run(params)
            : statement.run();
        return Number(result.changes);
    }
    exec(sql) {
        if (typeof sql !== "string" || sql.trim() === "") return;
        this.db.exec(sql);
    }
    close() {
        try { this.db.close(); } catch (e) { /* ignore */ }
    }
}

class MariaDBClient {
    constructor(config) {
        this.type = "mariadb";
        this.config = config;
        if (!mysql) throw new Error("mysql2 module is unavailable");
        this.pool = mysql.createPool({
            host: config.host,
            port: config.port,
            user: config.user,
            password: config.password,
            database: config.database,
            connectionLimit: 10,
            waitForConnections: true,
            supportBigNumbers: true,
            bigNumberStrings: false,
        });
        this.ready = this.init();
    }
    async init() {
        // ensure database exists (connect without database first)
        try {
            const bootstrap = await mysql.createConnection({
                host: this.config.host,
                port: this.config.port,
                user: this.config.user,
                password: this.config.password,
            });
            await bootstrap.query(`CREATE DATABASE IF NOT EXISTS \`${this.config.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
            await bootstrap.end();
        } catch (e) {
            console.error(`MariaDB bootstrap failed: ${e.message}`);
        }
        const conn = await this.pool.getConnection();
        try {
            await conn.query("SET SESSION sql_mode = CONCAT(@@sql_mode, ',PIPES_AS_CONCAT')");
            try {
                await conn.query("CREATE OR REPLACE VIEW sqlite_schema AS " +
                    "SELECT 'table' AS type, TABLE_NAME AS name, TABLE_NAME AS tbl_name, " +
                    "0 AS rootpage, NULL AS `sql` " +
                    "FROM information_schema.tables " +
                    "WHERE TABLE_SCHEMA = DATABASE()");
            } catch (e) {
                console.error(`MariaDB view warning: ${e.message}`);
            }
            await conn.query(`
                CREATE FUNCTION IF NOT EXISTS vrcx_datetime_now(offset_text TEXT) RETURNS TEXT DETERMINISTIC
                BEGIN
                    DECLARE n INT DEFAULT 0;
                    DECLARE unit VARCHAR(64) DEFAULT '';
                    IF offset_text IS NOT NULL THEN
                        SET n = CAST(TRIM(SUBSTRING_INDEX(offset_text, ' ', 1)) AS SIGNED);
                        SET unit = LOWER(TRIM(SUBSTRING(offset_text, LOCATE(' ', offset_text) + 1)));
                    END IF;
                    IF unit LIKE '%day%' THEN
                        RETURN DATE_FORMAT(DATE_ADD(NOW(), INTERVAL n DAY), '%Y-%m-%dT%H:%i:%s.000Z');
                    ELSEIF unit LIKE '%hour%' THEN
                        RETURN DATE_FORMAT(DATE_ADD(NOW(), INTERVAL n HOUR), '%Y-%m-%dT%H:%i:%s.000Z');
                    ELSEIF unit LIKE '%minute%' THEN
                        RETURN DATE_FORMAT(DATE_ADD(NOW(), INTERVAL n MINUTE), '%Y-%m-%dT%H:%i:%s.000Z');
                    ELSEIF unit LIKE '%second%' THEN
                        RETURN DATE_FORMAT(DATE_ADD(NOW(), INTERVAL n SECOND), '%Y-%m-%dT%H:%i:%s.000Z');
                    ELSEIF unit = '' THEN
                        RETURN DATE_FORMAT(NOW(), '%Y-%m-%dT%H:%i:%s.000Z');
                    ELSE
                        RETURN DATE_FORMAT(DATE_ADD(NOW(), INTERVAL n DAY), '%Y-%m-%dT%H:%i:%s.000Z');
                    END IF;
                END
            `);
        } catch (e) {
            // function may already exist or syntax differences; log only
            console.error(`MariaDB init warning: ${e.message}`);
        } finally {
            conn.release();
        }
    }
    async all(sql, args) {
        await this.ready;
        const { sql: baseSql, isNoOp } = translateSqlForMariaDB(sql);
        if (isNoOp) return [];
        const { text, values } = namedToPositional(baseSql, args);
        const conn = await this.pool.getConnection();
        try {
            await conn.query("SET SESSION sql_mode = CONCAT(@@sql_mode, ',PIPES_AS_CONCAT')");
            try {
                await conn.query("CREATE OR REPLACE VIEW sqlite_schema AS " +
                    "SELECT 'table' AS type, TABLE_NAME AS name, TABLE_NAME AS tbl_name, " +
                    "0 AS rootpage, NULL AS `sql` " +
                    "FROM information_schema.tables " +
                    "WHERE TABLE_SCHEMA = DATABASE()");
            } catch (e) {
                console.error(`MariaDB view warning: ${e.message}`);
            }
            const [rows] = await conn.execute(text, values);
            return (rows || []).map((row) => Object.values(row));
        } catch (e) {
            console.error(`MariaDB all failed: ${e.message}\nSQL: ${text}`);
            throw e;
        } finally {
            conn.release();
        }
    }
    async run(sql, args) {
        await this.ready;
        const { sql: baseSql, isNoOp } = translateSqlForMariaDB(sql);
        if (isNoOp) return 0;
        const { text, values } = namedToPositional(baseSql, args);
        const conn = await this.pool.getConnection();
        try {
            await conn.query("SET SESSION sql_mode = CONCAT(@@sql_mode, ',PIPES_AS_CONCAT')");
            try {
                await conn.query("CREATE OR REPLACE VIEW sqlite_schema AS " +
                    "SELECT 'table' AS type, TABLE_NAME AS name, TABLE_NAME AS tbl_name, " +
                    "0 AS rootpage, NULL AS `sql` " +
                    "FROM information_schema.tables " +
                    "WHERE TABLE_SCHEMA = DATABASE()");
            } catch (e) {
                console.error(`MariaDB view warning: ${e.message}`);
            }
            const [result] = await conn.execute(text, values);
            return Number((result && result.affectedRows) || 0);
        } catch (e) {
            const msg = String(e.message || e);
            if (/ALTER\s+TABLE/i.test(text) && /\bADD\b/i.test(text) && /duplicate/i.test(msg)) return 0;
            if (/ALTER\s+TABLE/i.test(text) && /\bDROP\b/i.test(text) &&
                (/doesn.t exist/i.test(msg) || /unknown column/i.test(msg) || /no such column/i.test(msg) || /exists/i.test(msg))) return 0;
            console.error(`MariaDB run failed: ${msg}\nSQL: ${text}`);
            throw e;
        } finally {
            conn.release();
        }
    }
    exec(sql) {
        return this.run(sql, {}).then(() => {}).catch(() => {});
    }
    close() {
        try { this.pool.end(); } catch (e) { /* ignore */ }
    }
}

function createClient(config, dataDir) {
    const cfg = config || loadConfig(dataDir);
    if (cfg.engine === "mariadb" || cfg.engine === "mysql") {
        return new MariaDBClient(cfg.mariadb);
    }
    return new SqliteClient(cfg.sqlitePath);
}

function importSqliteToClient(sourcePath, client) {
    return new Promise((resolve, reject) => {
        if (!nodeSqlite) return reject(new Error("node:sqlite unavailable"));
        const src = new nodeSqlite.DatabaseSync(sourcePath, { readOnly: true });
        try {
            const tables = src.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN ('table','index')").all();
            let rowsCopied = 0;
            let tablesCopied = 0;
            const tableSqls = src.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
            (async () => {
                for (const t of tableSqls) {
                    const name = t.name;
                    let createSql = t.sql;
                    if (!createSql) continue;
                    const safe = sanitizeTableName(name);
                    if (safe !== name) continue;
                    if (client.type === "mariadb") {
                        const tr = translateSqlForMariaDB(createSql);
                        createSql = tr.sql;
                    }
                    try {
                        if (client.type === "mariadb") await client.run(createSql, {});
                        else client.exec(createSql);
                    } catch (e) {
                        // table might exist
                    }
                    const cols = src.prepare(`PRAGMA table_info("${name}")`).all();
                    const colNames = cols.map((c) => c.name);
                    if (colNames.length === 0) continue;
                    const select = src.prepare(`SELECT ${colNames.map((c) => `"${c}"`).join(",")} FROM "${name}"`);
                    const rows = select.all();
                    const placeholders = colNames.map(() => "?").join(",");
                    const insertBase = `INSERT INTO ${safe} (${colNames.map((c) => `\`${c}\``).join(",")}) VALUES (${placeholders})`;
                    const targetInsert = client.type === "mariadb" ? insertBase.replace(/`/g, "") : insertBase;
                    // use unquoted for sqlite, backticks for mariadb ok
                    const finalInsert = client.type === "mariadb"
                        ? `INSERT INTO ${safe} (${colNames.join(",")}) VALUES (${placeholders})`
                        : `INSERT INTO ${safe} (${colNames.map((c)=>`"${c}"`).join(",")}) VALUES (${placeholders})`;
                    for (const row of rows) {
                        const values = colNames.map((c) => row[c]);
                        try {
                            if (client.type === "mariadb") await client.run(finalInsert, values);
                            else {
                                const stmt = client.db.prepare(finalInsert);
                                stmt.run(...values);
                            }
                            rowsCopied++;
                        } catch (e) {
                            // ignore duplicates
                        }
                    }
                    tablesCopied++;
                }
                // indexes
                for (const idx of tables.filter((t) => t.type === "index" && t.sql)) {
                    try {
                        let createIndexSql = idx.sql;
                        if (client.type === "mariadb") createIndexSql = translateSqlForMariaDB(createIndexSql).sql;
                        if (client.type === "mariadb") await client.run(createIndexSql, {});
                        else client.exec(createIndexSql);
                    } catch (e) { /* ignore */ }
                }
                src.close();
                resolve({ tables: tablesCopied, rows: rowsCopied });
            })().catch((e) => { try { src.close(); } catch(_){} reject(e); });
        } catch (e) {
            try { src.close(); } catch(_){}
            reject(e);
        }
    });
}

module.exports = {
    loadConfig,
    saveConfig,
    createClient,
    translateSqlForMariaDB,
    namedToPositional,
    importSqliteToClient,
    SqliteClient,
    MariaDBClient,
};
