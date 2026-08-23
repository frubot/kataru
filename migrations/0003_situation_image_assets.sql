CREATE TABLE IF NOT EXISTS situation_image_assets (
    situation_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    PRIMARY KEY(situation_id, asset_id),
    FOREIGN KEY(situation_id) REFERENCES situations(id) ON DELETE CASCADE,
    FOREIGN KEY(asset_id) REFERENCES image_assets(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS situation_image_assets_asset_idx
    ON situation_image_assets(asset_id);

PRAGMA user_version = 3;
