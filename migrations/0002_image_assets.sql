CREATE TABLE IF NOT EXISTS image_assets (
    id TEXT PRIMARY KEY NOT NULL,
    mime_type TEXT NOT NULL,
    data BLOB NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS character_image_assets (
    character_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    PRIMARY KEY(character_id, asset_id),
    FOREIGN KEY(character_id) REFERENCES characters(id) ON DELETE CASCADE,
    FOREIGN KEY(asset_id) REFERENCES image_assets(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS character_image_assets_asset_idx
    ON character_image_assets(asset_id);

PRAGMA user_version = 2;
