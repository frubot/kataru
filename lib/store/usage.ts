import * as db from '../db';
import { generateId } from '../id';
import { fire } from './persistence';
import type { AppState, StoreGet, StoreSet, UsageRecord } from './types';

type UsageSlice = Pick<
    AppState,
    'usageRecords' | 'addUsageRecord' | 'cleanOldUsageRecords' | 'getUsageRecords'
>;

export function createUsageSlice(set: StoreSet, get: StoreGet): UsageSlice {
    return {
        usageRecords: [],

        addUsageRecord: (characterId, promptTokens, completionTokens, totalTokens, cost) => {
            const record: UsageRecord = {
                id: generateId(),
                characterId,
                timestamp: Date.now(),
                promptTokens,
                completionTokens,
                totalTokens,
                cost,
            };
            set((state) => ({ usageRecords: [...state.usageRecords, record] }));
            fire(db.putUsageRecord(record));
        },

        cleanOldUsageRecords: () => {
            const oneYearAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;
            set((state) => ({
                usageRecords: state.usageRecords.filter((record) => record.timestamp >= oneYearAgo),
            }));
            fire(db.deleteUsageRecordsOlderThan(oneYearAgo));
        },

        getUsageRecords: (characterId, startDate, endDate) => {
            let records = get().usageRecords;
            if (characterId) records = records.filter((record) => record.characterId === characterId);
            if (startDate) records = records.filter((record) => record.timestamp >= startDate);
            if (endDate) records = records.filter((record) => record.timestamp <= endDate);
            return records;
        },
    };
}
