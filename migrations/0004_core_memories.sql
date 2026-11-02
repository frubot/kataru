-- 常駐記憶。キャラクターごとに1行。
CREATE TABLE IF NOT EXISTS core_memories (
    character_id TEXT PRIMARY KEY NOT NULL,
    updated_at INTEGER NOT NULL,
    data_json TEXT NOT NULL
);

PRAGMA user_version = 4;
