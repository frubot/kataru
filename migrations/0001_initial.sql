PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY NOT NULL,
    value_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS characters (
    id TEXT PRIMARY KEY NOT NULL,
    updated_at INTEGER NOT NULL,
    data_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS characters_updated_at_idx ON characters(updated_at DESC);

CREATE TABLE IF NOT EXISTS situations (
    id TEXT PRIMARY KEY NOT NULL,
    updated_at INTEGER NOT NULL,
    data_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS situations_updated_at_idx ON situations(updated_at DESC);

CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY NOT NULL,
    character_id TEXT NOT NULL,
    situation_id TEXT,
    updated_at INTEGER NOT NULL,
    data_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS rooms_character_id_idx ON rooms(character_id);
CREATE INDEX IF NOT EXISTS rooms_situation_id_idx ON rooms(situation_id);
CREATE INDEX IF NOT EXISTS rooms_updated_at_idx ON rooms(updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY NOT NULL,
    room_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    data_json TEXT NOT NULL,
    FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS messages_room_timestamp_idx ON messages(room_id, timestamp);

CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY NOT NULL,
    character_id TEXT NOT NULL,
    room_id TEXT,
    source_room_id TEXT,
    scope TEXT NOT NULL,
    kind TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    data_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS memories_character_updated_idx
    ON memories(character_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS memories_room_idx ON memories(room_id);
CREATE INDEX IF NOT EXISTS memories_source_room_idx ON memories(source_room_id);

CREATE TABLE IF NOT EXISTS usage_records (
    id TEXT PRIMARY KEY NOT NULL,
    character_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    data_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_records_timestamp_idx ON usage_records(timestamp DESC);

PRAGMA user_version = 1;
