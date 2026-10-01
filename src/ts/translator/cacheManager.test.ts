import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => new Map<string, unknown>());
const storageEtag = vi.hoisted(() => (value: unknown) =>
    value === undefined ? null : JSON.stringify(value),
);
const removedKeys = vi.hoisted(() => [] as string[]);
const failures = vi.hoisted(() => ({
    writeKeys: new Set<string>(),
    removeKeys: new Set<string>(),
    clearAfter: null as number | null,
}));
const readStats = vi.hoisted(() => ({ active: 0, maxActive: 0 }));
const persistenceStats = vi.hoisted(() => ({ lists: 0, reads: 0 }));
const clearStats = vi.hoisted(() => ({ removes: 0 }));
const asyncControls = vi.hoisted(() => ({
    readGate: null as Promise<void> | null,
    gatedReadsRemaining: 0,
    writeGates: new Map<string, Promise<void>>(),
    startedWrites: new Set<string>(),
    removeGates: new Map<string, Promise<void>>(),
    startedRemoves: new Set<string>(),
    clearRemoveGates: new Map<string, Promise<void>>(),
    startedClearRemoves: new Set<string>(),
}));
const forageStorageMock = vi.hoisted(() => ({
    Init: vi.fn(async () => {}),
    keys: vi.fn(async (prefix = "") =>
        [...storage.keys()].filter((key) => key.startsWith(prefix)),
    ),
    removeItem: vi.fn(async (key: string) => {
        const removeNumber = ++clearStats.removes;
        asyncControls.startedClearRemoves.add(key);
        if (failures.clearAfter === removeNumber) throw new Error("clear failed");
        const gate = asyncControls.clearRemoveGates.get(key);
        if (gate) await gate;
        storage.delete(key);
    }),
}));
const requestChatDataMock = vi.hoisted(() => vi.fn());
const databaseMock = vi.hoisted(() => ({
    translatorType: "llm",
    characters: [],
}));

vi.mock("../storage/persistentKv", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../storage/persistentKv")>();
    return {
    clearPersistentPrefix: actual.clearPersistentPrefix,
    listPersistentKeys: vi.fn(async (prefix = "") => {
        persistenceStats.lists++;
        return [...storage.keys()].filter((key) => key.startsWith(prefix));
    }),
    makeHashedStorageKey: vi.fn(async (prefix: string, key: string) =>
        `${prefix}${encodeURIComponent(key)}.json`,
    ),
    readPersistentJson: vi.fn(async (key: string) => {
        persistenceStats.reads++;
        readStats.active++;
        readStats.maxActive = Math.max(readStats.maxActive, readStats.active);
        const value = storage.get(key);
        const readGate = asyncControls.gatedReadsRemaining > 0
            ? asyncControls.readGate
            : null;
        if (readGate) asyncControls.gatedReadsRemaining--;
        await Promise.resolve();
        if (readGate) await readGate;
        try {
            if (value instanceof Error) throw value;
            return value ?? null;
        } finally {
            readStats.active--;
        }
    }),
    readPersistentJsonWithVersion: vi.fn(async (key: string) => {
        persistenceStats.reads++;
        readStats.active++;
        readStats.maxActive = Math.max(readStats.maxActive, readStats.active);
        const value = storage.get(key);
        const readGate = asyncControls.gatedReadsRemaining > 0
            ? asyncControls.readGate
            : null;
        if (readGate) asyncControls.gatedReadsRemaining--;
        await Promise.resolve();
        if (readGate) await readGate;
        try {
            if (value instanceof Error) throw value;
            return { value: value ?? null, etag: storageEtag(value) };
        } finally {
            readStats.active--;
        }
    }),
    removePersistentKey: vi.fn(async (key: string) => {
        if (failures.removeKeys.has(key)) throw new Error("delete failed");
        asyncControls.startedRemoves.add(key);
        const gate = asyncControls.removeGates.get(key);
        if (gate) await gate;
        removedKeys.push(key);
        storage.delete(key);
    }),
    writePersistentJson: vi.fn(async (key: string, value: unknown) => {
        if (failures.writeKeys.has(key)) throw new Error("write failed");
        asyncControls.startedWrites.add(key);
        const gate = asyncControls.writeGates.get(key);
        if (gate) await gate;
        storage.set(key, value);
    }),
    writePersistentJsonConditional: vi.fn(async (
        key: string,
        value: unknown,
        expectedEtag: string,
    ) => {
        if (failures.writeKeys.has(key)) throw new Error("write failed");
        asyncControls.startedWrites.add(key);
        const gate = asyncControls.writeGates.get(key);
        if (gate) await gate;
        if (storageEtag(storage.get(key)) !== expectedEtag) {
            const error = new Error("ETag conflict");
            error.name = "ConflictError";
            throw error;
        }
        storage.set(key, value);
        return storageEtag(value);
    }),
    removePersistentKeyConditional: vi.fn(async (key: string, expectedEtag: string) => {
        if (failures.removeKeys.has(key)) throw new Error("delete failed");
        asyncControls.startedRemoves.add(key);
        const gate = asyncControls.removeGates.get(key);
        if (gate) await gate;
        if (storageEtag(storage.get(key)) !== expectedEtag) {
            const error = new Error("ETag conflict");
            error.name = "ConflictError";
            throw error;
        }
        removedKeys.push(key);
        storage.delete(key);
    }),
    };
});

vi.mock("svelte/store", () => ({ get: vi.fn(() => 0) }));
vi.mock("../parser/chatML", () => ({ parseChatML: vi.fn() }));
vi.mock("../storage/database.svelte", () => ({ getDatabase: vi.fn(() => databaseMock) }));
vi.mock("./presets", () => ({
    defaultTranslatorPrompt: "",
    getCurrentTranslatorPresetFromState: vi.fn(() => ({ prompt: "", maxResponse: 100 })),
}));
vi.mock("../globalApi.svelte", () => ({
    forageStorage: forageStorageMock,
    globalFetch: vi.fn(),
}));
vi.mock("../alert", () => ({ notifyError: vi.fn() }));
vi.mock("../process/request/request", () => ({ requestChatData: requestChatDataMock }));
vi.mock("../process/index.svelte", () => ({ doingChat: {} }));
vi.mock("../parser/parser.svelte", () => ({ applyMarkdownToNode: vi.fn() }));
vi.mock("../stores.svelte", () => ({ selectedCharID: {} }));
vi.mock("../process/modules", () => ({ getModuleRegexScripts: vi.fn() }));
vi.mock("../util", () => ({ getNodetextToSentence: vi.fn(), sleep: vi.fn() }));
vi.mock("../process/scripts", () => ({ processScriptFull: vi.fn() }));
vi.mock("../notificationSound", () => ({ playNotificationSound: vi.fn() }));

import {
    clearLLMCache,
    deleteLLMCache,
    exportLLMCacheAsJSON,
    getLLMCache,
    importLLMCacheFromJSON,
    listLLMCache,
    runTranslator,
    searchLLMCache,
    setLLMCache,
    updateLLMCacheValue,
} from "./translator";

const prefix = "cache/llm-translate/";

function seed(key: string, value: string, storageKey = `${prefix}${encodeURIComponent(key)}.json`) {
    storage.set(storageKey, { key, value });
    return storageKey;
}

function currentEtag(storageKey: string) {
    const etag = storageEtag(storage.get(storageKey));
    if (!etag) throw new Error(`Missing test ETag for ${storageKey}`);
    return etag;
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((next) => {
        resolve = next;
    });
    return { promise, resolve };
}

async function startDelayedTranslation(key: string) {
    const response = deferred<{ type: string, result: string }>();
    requestChatDataMock.mockImplementationOnce(() => response.promise);
    const result = runTranslator(key, false, "ko", "en");
    await vi.waitFor(() => expect(requestChatDataMock).toHaveBeenCalled());
    return { result, response };
}

describe("LLM translation cache manager", () => {
    beforeEach(async () => {
        storage.clear();
        removedKeys.length = 0;
        failures.writeKeys.clear();
        failures.removeKeys.clear();
        failures.clearAfter = null;
        readStats.active = 0;
        readStats.maxActive = 0;
        persistenceStats.lists = 0;
        persistenceStats.reads = 0;
        clearStats.removes = 0;
        asyncControls.readGate = null;
        asyncControls.gatedReadsRemaining = 0;
        asyncControls.writeGates.clear();
        asyncControls.startedWrites.clear();
        asyncControls.removeGates.clear();
        asyncControls.startedRemoves.clear();
        asyncControls.clearRemoveGates.clear();
        asyncControls.startedClearRemoves.clear();
        requestChatDataMock.mockReset();
        await clearLLMCache();
    });

    it("lists, searches, sorts, and paginates rows deterministically", async () => {
        seed("Zulu", "끝");
        seed("alpha", "FIRST");
        const bravoStorageKey = seed("Bravo", "Second result");
        seed("charlie", "third result");

        const firstPage = await listLLMCache({ page: 1, pageSize: 2 });
        expect(firstPage).toEqual({
            rows: [
                { key: "alpha", value: "FIRST", storageKey: `${prefix}alpha.json`, etag: currentEtag(`${prefix}alpha.json`) },
                { key: "Bravo", value: "Second result", storageKey: bravoStorageKey, etag: currentEtag(bravoStorageKey) },
            ],
            total: 4,
            page: 1,
            pageSize: 2,
            pageCount: 2,
        });

        const valueMatch = await listLLMCache({ search: "SECOND", page: 1 });
        expect(valueMatch.rows.map((row) => row.key)).toEqual(["Bravo"]);
        expect(valueMatch.pageSize).toBe(100);
    });

    it("updates the value while retaining the exact key and storage key", async () => {
        const storageKey = seed("Key With Spaces", "old");

        await updateLLMCacheValue("Key With Spaces", "new", storageKey, currentEtag(storageKey));

        expect(storage.get(storageKey)).toEqual({ key: "Key With Spaces", value: "new" });
        expect(await getLLMCache("Key With Spaces")).toBe("new");
        expect((await listLLMCache()).rows[0].storageKey).toBe(storageKey);
    });

    it("rejects an edit from a stale manager row instead of overwriting a newer value", async () => {
        const storageKey = seed("cross-window edit", "original");
        const [listed] = (await listLLMCache()).rows;
        expect(listed.etag).toBe(storageEtag(storage.get(storageKey)));
        storage.set(storageKey, { key: "cross-window edit", value: "newer value" });

        await expect(updateLLMCacheValue(
            listed.key,
            "stale edit",
            listed.storageKey,
            listed.etag,
        )).rejects.toThrow(/conflict|changed/i);

        expect(storage.get(storageKey)).toEqual({ key: "cross-window edit", value: "newer value" });
    });

    it("rejects a delete from a stale manager row instead of deleting a newer value", async () => {
        const storageKey = seed("cross-window delete", "original");
        const [listed] = (await listLLMCache()).rows;
        storage.set(storageKey, { key: "cross-window delete", value: "newer value" });

        await expect(deleteLLMCache(
            listed.key,
            listed.storageKey,
            listed.etag,
        )).rejects.toThrow(/conflict|changed/i);

        expect(storage.get(storageKey)).toEqual({ key: "cross-window delete", value: "newer value" });
    });

    it("updates and deletes through the exact listed persistent storage key", async () => {
        const storageKey = seed("legacy key", "old", `${prefix}legacy-storage.json`);

        await updateLLMCacheValue("legacy key", "new", storageKey, currentEtag(storageKey));
        expect(storage.get(storageKey)).toEqual({ key: "legacy key", value: "new" });
        expect(storage.has(`${prefix}legacy%20key.json`)).toBe(false);

        await deleteLLMCache("legacy key", storageKey, currentEtag(storageKey));
        expect(storage.has(storageKey)).toBe(false);
        expect(removedKeys).toContain(storageKey);
    });

    it("updates an existing legacy storage location without creating a canonical duplicate", async () => {
        const legacyStorageKey = seed("legacy direct", "old", `${prefix}legacy-direct.json`);

        await setLLMCache("legacy direct", "new");

        expect(storage.get(legacyStorageKey)).toEqual({ key: "legacy direct", value: "new" });
        expect(storage.has(`${prefix}legacy%20direct.json`)).toBe(false);
    });

    it("imports over an existing legacy storage location without duplicating it", async () => {
        const legacyStorageKey = seed("legacy import", "old", `${prefix}legacy-import.json`);

        await expect(importLLMCacheFromJSON({ "legacy import": "new" })).resolves.toEqual({ count: 1, failed: 0 });

        expect(storage.get(legacyStorageKey)).toEqual({ key: "legacy import", value: "new" });
        expect(storage.has(`${prefix}legacy%20import.json`)).toBe(false);
    });

    it("deletes every duplicate physical row so the logical key cannot reappear", async () => {
        seed("duplicate", "legacy", `${prefix}legacy-duplicate.json`);
        seed("duplicate", "canonical", `${prefix}duplicate.json`);
        const listed = await listLLMCache();

        await deleteLLMCache("duplicate", listed.rows[0].storageKey, listed.rows[0].etag);

        expect([...storage.values()].filter((value: any) => value?.key === "duplicate")).toEqual([]);
        expect((await listLLMCache()).rows).toEqual([]);
    });

    it("consistently prefers a canonical row over conflicting legacy duplicates", async () => {
        seed("conflict", "legacy", `${prefix}legacy-conflict.json`);
        const canonicalStorageKey = seed("conflict", "canonical");

        await expect(getLLMCache("conflict")).resolves.toBe("canonical");
        await expect(listLLMCache()).resolves.toMatchObject({
            rows: [{ key: "conflict", value: "canonical", storageKey: canonicalStorageKey }],
        });
        await expect(searchLLMCache("conflict")).resolves.toEqual([
            { key: "conflict", value: "canonical" },
        ]);
        await expect(exportLLMCacheAsJSON()).resolves.toMatchObject({ conflict: "canonical" });
    });

    it("indexes persistent rows once across repeated misses and writes", async () => {
        for (let index = 0; index < 20; index++) seed(`existing ${index}`, `value ${index}`);

        await expect(getLLMCache("missing one")).resolves.toBeNull();
        await expect(getLLMCache("missing two")).resolves.toBeNull();
        await setLLMCache("new one", "first");
        await setLLMCache("new two", "second");

        expect(persistenceStats.lists).toBe(1);
        expect(persistenceStats.reads).toBeLessThanOrEqual(26);
    });

    it("reuses one persistent snapshot for every item in an import", async () => {
        for (let index = 0; index < 20; index++) seed(`existing ${index}`, `value ${index}`);

        await expect(importLLMCacheFromJSON({ first: "one", second: "two", third: "three" }))
            .resolves.toEqual({ count: 3, failed: 0 });

        expect(persistenceStats.lists).toBe(1);
        expect(persistenceStats.reads).toBeLessThanOrEqual(26);
    });

    it("does not publish a set that entered before clear while awaiting the index", async () => {
        seed("index blocker", "old");
        const gate = deferred<void>();
        asyncControls.readGate = gate.promise;
        asyncControls.gatedReadsRemaining = 1;

        const setting = setLLMCache("pre-clear set", "new");
        await vi.waitFor(() => expect(readStats.active).toBeGreaterThan(0));
        asyncControls.readGate = null;
        await clearLLMCache();
        gate.resolve();

        await expect(setting).rejects.toThrow("superseded by clear");
        expect(storage.has(`${prefix}pre-clear%20set.json`)).toBe(false);
    });

    it("does not overwrite an indexed path externally reassigned to another key", async () => {
        const sharedStorageKey = seed("indexed A", "old A", `${prefix}shared-legacy.json`);
        await listLLMCache();
        storage.set(sharedStorageKey, { key: "external B", value: "external value" });

        await setLLMCache("indexed A", "new A");

        expect(storage.get(sharedStorageKey)).toEqual({ key: "external B", value: "external value" });
        expect(storage.get(`${prefix}indexed%20A.json`)).toEqual({ key: "indexed A", value: "new A" });
    });

    it("revalidates authority after awaited duplicate cleanup", async () => {
        const legacyStorageKey = seed("authority race", "old", `${prefix}legacy-authority-race.json`);
        const canonicalStorageKey = seed("authority race", "old");
        await listLLMCache();
        const duplicateWriteGate = deferred<void>();
        asyncControls.writeGates.set(canonicalStorageKey, duplicateWriteGate.promise);

        const updating = updateLLMCacheValue("authority race", "new", legacyStorageKey, currentEtag(legacyStorageKey));
        await vi.waitFor(() => expect(asyncControls.startedWrites.has(canonicalStorageKey)).toBe(true));
        storage.set(legacyStorageKey, { key: "external replacement", value: "preserve me" });
        duplicateWriteGate.resolve();

        await expect(updating).rejects.toThrow(/conflict|stale/i);
        expect(storage.get(legacyStorageKey)).toEqual({ key: "external replacement", value: "preserve me" });
        expect(storage.get(canonicalStorageKey)).toEqual({ key: "authority race", value: "old" });
    });

    it("does not overwrite a duplicate path reassigned during an update", async () => {
        const legacyStorageKey = seed("duplicate update race", "old", `${prefix}legacy-update-race.json`);
        const canonicalStorageKey = seed("duplicate update race", "old");
        await listLLMCache();
        const duplicateWriteGate = deferred<void>();
        asyncControls.writeGates.set(canonicalStorageKey, duplicateWriteGate.promise);

        const updating = updateLLMCacheValue("duplicate update race", "new", legacyStorageKey, currentEtag(legacyStorageKey));
        await vi.waitFor(() => expect(asyncControls.startedWrites.has(canonicalStorageKey)).toBe(true));
        storage.set(canonicalStorageKey, { key: "external duplicate owner", value: "preserve me" });
        duplicateWriteGate.resolve();

        await expect(updating).rejects.toThrow(/conflict|stale/i);
        expect(storage.get(canonicalStorageKey)).toEqual({
            key: "external duplicate owner",
            value: "preserve me",
        });
    });

    it("does not delete a duplicate path reassigned during deletion", async () => {
        const legacyStorageKey = seed("duplicate delete race", "old", `${prefix}legacy-delete-race.json`);
        const canonicalStorageKey = seed("duplicate delete race", "old");
        const listed = await listLLMCache();
        expect(listed.rows[0].storageKey).toBe(canonicalStorageKey);
        const duplicateRemoveGate = deferred<void>();
        asyncControls.removeGates.set(canonicalStorageKey, duplicateRemoveGate.promise);

        const deleting = deleteLLMCache("duplicate delete race", canonicalStorageKey, currentEtag(canonicalStorageKey));
        await vi.waitFor(() => expect(asyncControls.startedRemoves.has(canonicalStorageKey)).toBe(true));
        storage.set(canonicalStorageKey, { key: "external delete owner", value: "preserve me" });
        duplicateRemoveGate.resolve();

        await expect(deleting).rejects.toThrow(/conflict|stale/i);
        expect(storage.get(canonicalStorageKey)).toEqual({
            key: "external delete owner",
            value: "preserve me",
        });
        expect(storage.get(legacyStorageKey)).toEqual({ key: "duplicate delete race", value: "old" });
    });

    it("rebuilds a stale duplicate index before manager update", async () => {
        const legacyStorageKey = seed("manager stale update", "old", `${prefix}legacy-manager-update.json`);
        const canonicalStorageKey = seed("manager stale update", "old");
        await listLLMCache();
        storage.set(canonicalStorageKey, { key: "external update owner", value: "preserve" });

        await updateLLMCacheValue("manager stale update", "new", legacyStorageKey, currentEtag(legacyStorageKey));

        expect(storage.get(legacyStorageKey)).toEqual({ key: "manager stale update", value: "new" });
        expect(storage.get(canonicalStorageKey)).toEqual({ key: "external update owner", value: "preserve" });
    });

    it("rebuilds a stale duplicate index before manager delete", async () => {
        const legacyStorageKey = seed("manager stale delete", "old", `${prefix}legacy-manager-delete.json`);
        const canonicalStorageKey = seed("manager stale delete", "old");
        await listLLMCache();
        storage.set(canonicalStorageKey, { key: "external delete owner", value: "preserve" });

        await deleteLLMCache("manager stale delete", legacyStorageKey, currentEtag(legacyStorageKey));

        expect(storage.has(legacyStorageKey)).toBe(false);
        expect(storage.get(canonicalStorageKey)).toEqual({ key: "external delete owner", value: "preserve" });
    });

    it("discovers externally added legacy rows after an explicit list refresh", async () => {
        await expect(getLLMCache("external legacy")).resolves.toBeNull();
        const listCount = persistenceStats.lists;
        seed("external legacy", "external value", `${prefix}new-external-legacy.json`);

        await expect(getLLMCache("external legacy")).resolves.toBeNull();
        expect(persistenceStats.lists).toBe(listCount);
        await listLLMCache();
        await expect(getLLMCache("external legacy")).resolves.toBe("external value");
    });

    it("publishes an authoritative write before surfacing duplicate cleanup failure", async () => {
        const legacyStorageKey = seed("cleanup failure", "old", `${prefix}legacy-cleanup.json`);
        const canonicalStorageKey = seed("cleanup failure", "old");
        await listLLMCache();
        failures.removeKeys.add(legacyStorageKey);

        await expect(updateLLMCacheValue("cleanup failure", "new", canonicalStorageKey, currentEtag(canonicalStorageKey)))
            .rejects.toThrow("delete failed");

        expect(storage.get(canonicalStorageKey)).toEqual({ key: "cleanup failure", value: "new" });
        expect(await getLLMCache("cleanup failure")).toBe("new");
    });

    it("does not commit an authoritative edit when a stale duplicate cannot be updated or removed", async () => {
        const legacyStorageKey = seed("unsafe cleanup", "old", `${prefix}legacy-unsafe.json`);
        const canonicalStorageKey = seed("unsafe cleanup", "old");
        await listLLMCache();
        persistenceStats.lists = 0;
        failures.writeKeys.add(canonicalStorageKey);
        failures.removeKeys.add(canonicalStorageKey);

        await expect(updateLLMCacheValue("unsafe cleanup", "new", legacyStorageKey, currentEtag(legacyStorageKey)))
            .rejects.toThrow("write failed");

        expect(storage.get(legacyStorageKey)).toEqual({ key: "unsafe cleanup", value: "old" });
        expect(storage.get(canonicalStorageKey)).toEqual({ key: "unsafe cleanup", value: "old" });
        expect(await getLLMCache("unsafe cleanup")).toBe("old");
        expect(persistenceStats.lists).toBe(0);
        await expect(exportLLMCacheAsJSON()).resolves.toMatchObject({ "unsafe cleanup": "old" });
    });

    it("rolls back synchronized duplicates when the authoritative write fails", async () => {
        const legacyStorageKey = seed("authority failure", "old", `${prefix}legacy-authority.json`);
        const canonicalStorageKey = seed("authority failure", "old");
        await listLLMCache();
        failures.writeKeys.add(legacyStorageKey);
        failures.removeKeys.add(canonicalStorageKey);

        await expect(updateLLMCacheValue("authority failure", "new", legacyStorageKey, currentEtag(legacyStorageKey)))
            .rejects.toThrow("write failed");

        expect(storage.get(legacyStorageKey)).toEqual({ key: "authority failure", value: "old" });
        expect(storage.get(canonicalStorageKey)).toEqual({ key: "authority failure", value: "old" });
        expect(await getLLMCache("authority failure")).toBe("old");
    });

    it("uses the rebuilt index when a mutation registers behind a partial clear", async () => {
        seed("delete first", "gone");
        const legacyStorageKey = seed("partial survivor", "old", `${prefix}legacy-survivor.json`);
        await listLLMCache();
        failures.clearAfter = 2;

        const setting = setLLMCache("partial survivor", "new");
        const clearing = clearLLMCache();
        const clearingExpectation = expect(clearing).rejects.toThrow("clear failed");

        await clearingExpectation;
        await expect(setting).rejects.toThrow("superseded by clear");
        expect(storage.get(legacyStorageKey)).toEqual({ key: "partial survivor", value: "old" });
        expect(storage.has(`${prefix}partial%20survivor.json`)).toBe(false);
    });

    it("keeps the current index for mutations already queued before a partial clear", async () => {
        seed("delete first", "gone");
        const legacyStorageKey = seed("queued survivor", "old", `${prefix}legacy-queued-survivor.json`);
        await listLLMCache();
        const writeGate = deferred<void>();
        asyncControls.writeGates.set(legacyStorageKey, writeGate.promise);

        const firstWrite = setLLMCache("queued survivor", "first");
        await vi.waitFor(() => expect(asyncControls.startedWrites.has(legacyStorageKey)).toBe(true));
        const secondWrite = setLLMCache("queued survivor", "second");
        await Promise.resolve();
        failures.clearAfter = 2;
        const clearing = clearLLMCache();
        const clearingExpectation = expect(clearing).rejects.toThrow("clear failed");
        writeGate.resolve();

        await expect(firstWrite).resolves.toBeUndefined();
        await expect(secondWrite).rejects.toThrow("superseded by clear");
        await clearingExpectation;
        expect(storage.get(legacyStorageKey)).toEqual({ key: "queued survivor", value: "first" });
        expect(storage.has(`${prefix}queued%20survivor.json`)).toBe(false);
    });

    it("reads a valid legacy row when the canonical row is malformed", async () => {
        storage.set(`${prefix}legacy%20fallback.json`, { broken: true });
        seed("legacy fallback", "legacy value", `${prefix}valid-legacy-fallback.json`);

        await expect(getLLMCache("legacy fallback")).resolves.toBe("legacy value");
    });

    it("deletes one entry from memory and persistent storage", async () => {
        const storageKey = seed("remove me", "value");
        await setLLMCache("remove me", "value");

        await deleteLLMCache("remove me", storageKey, currentEtag(storageKey));

        expect(storage.has(storageKey)).toBe(false);
        expect(removedKeys).toContain(storageKey);
        expect(await getLLMCache("remove me")).toBeNull();
    });

    it("requires the exact listed storage key and validates its payload", async () => {
        const storageKey = seed("managed", "old", `${prefix}legacy-managed.json`);
        seed("different", "value", `${prefix}different.json`);

        await expect(
            (updateLLMCacheValue as unknown as (key: string, value: string) => Promise<void>)("managed", "new"),
        ).rejects.toThrow("version");
        await expect(deleteLLMCache("managed", `${prefix}different.json`, currentEtag(`${prefix}different.json`))).rejects.toThrow("does not match");

        expect(storage.get(storageKey)).toEqual({ key: "managed", value: "old" });
    });

    it("surfaces persistent write failure without changing the memory mirror", async () => {
        const storageKey = seed("write failure", "old");
        await listLLMCache();
        failures.writeKeys.add(storageKey);

        await expect(updateLLMCacheValue("write failure", "new", storageKey, currentEtag(storageKey))).rejects.toThrow("write failed");

        expect(storage.get(storageKey)).toEqual({ key: "write failure", value: "old" });
        expect(await getLLMCache("write failure")).toBe("old");
    });

    it("surfaces persistent delete failure without removing the memory mirror", async () => {
        const storageKey = seed("delete failure", "value");
        await listLLMCache();
        failures.removeKeys.add(storageKey);

        await expect(deleteLLMCache("delete failure", storageKey, currentEtag(storageKey))).rejects.toThrow("delete failed");

        expect(storage.has(storageKey)).toBe(true);
        expect(await getLLMCache("delete failure")).toBe("value");
    });

    it("clears all entries from memory and persistent storage", async () => {
        seed("one", "uno");
        await setLLMCache("two", "dos");

        await clearLLMCache();

        expect(storage.size).toBe(0);
        expect(await getLLMCache("two")).toBeNull();
        expect((await listLLMCache()).total).toBe(0);
    });

    it("returns an empty bounded page and clamps pages after filtering", async () => {
        expect(await listLLMCache({ page: 999 })).toEqual({
            rows: [],
            total: 0,
            page: 1,
            pageSize: 100,
            pageCount: 1,
        });

        seed("alpha", "one");
        seed("beta", "two");
        seed("gamma", "three");
        const result = await listLLMCache({ page: 99, pageSize: 2 });
        expect(result.page).toBe(2);
        expect(result.rows.map((row) => row.key)).toEqual(["gamma"]);
    });

    it("omits memory-only entries and evicts their stale mirrors", async () => {
        const storageKey = `${prefix}memory-only.json`;
        await setLLMCache("memory-only", "ghost");
        storage.delete(storageKey);

        expect((await listLLMCache()).rows).toEqual([]);
        expect(await getLLMCache("memory-only")).toBeNull();
    });

    it("uses persistent values and reconciles stale memory mirrors", async () => {
        const storageKey = `${prefix}stale.json`;
        await setLLMCache("stale", "old memory");
        storage.set(storageKey, { key: "stale", value: "fresh persistent" });

        expect((await listLLMCache()).rows).toEqual([
            { key: "stale", value: "fresh persistent", storageKey, etag: currentEtag(storageKey) },
        ]);
        expect(await getLLMCache("stale")).toBe("fresh persistent");
    });

    it("reads large persistent listings concurrently within a bounded limit", async () => {
        for (let index = 0; index < 40; index++) seed(`concurrent-${index}`, `value-${index}`);

        await listLLMCache();

        expect(readStats.maxActive).toBeGreaterThan(1);
        expect(readStats.maxActive).toBeLessThanOrEqual(16);
    });

    it("caps oversized pages at 100 rows", async () => {
        for (let index = 0; index < 101; index++) {
            seed(`key-${String(index).padStart(3, "0")}`, `value-${index}`);
        }

        const result = await listLLMCache({ page: 1, pageSize: 1000 });

        expect(result.pageSize).toBe(100);
        expect(result.rows).toHaveLength(100);
        expect(result.pageCount).toBe(2);
    });

    it("skips malformed and unreadable persistent entries", async () => {
        seed("valid", "works");
        storage.set(`${prefix}malformed.json`, { key: 42, value: "bad" });
        storage.set(`${prefix}unreadable.json`, new Error("broken JSON"));

        const result = await listLLMCache();

        expect(result.rows).toEqual([
            { key: "valid", value: "works", storageKey: `${prefix}valid.json`, etag: currentEtag(`${prefix}valid.json`) },
        ]);
        expect(result.total).toBe(1);
    });

    it("exports valid entries when malformed or unreadable entries exist", async () => {
        seed("valid", "works");
        storage.set(`${prefix}malformed.json`, { key: 42, value: "bad" });
        storage.set(`${prefix}unreadable.json`, new Error("broken JSON"));

        await expect(exportLLMCacheAsJSON()).resolves.toEqual({ valid: "works" });
    });

    it("exports only validated persistent values and supports prototype-like keys", async () => {
        await setLLMCache("stale", "memory value");
        storage.set(`${prefix}stale.json`, { key: "stale", value: "persistent value" });
        await setLLMCache("memory-only", "ghost");
        storage.delete(`${prefix}memory-only.json`);
        seed("constructor", "ctor");
        seed("toString", "stringer");
        seed("__proto__", "proto");

        const result = await exportLLMCacheAsJSON();

        expect(Object.getPrototypeOf(result)).toBeNull();
        expect(Object.keys(result).sort()).toEqual(["__proto__", "constructor", "stale", "toString"].sort());
        expect(result.stale).toBe("persistent value");
        expect(result.__proto__).toBe("proto");
    });

    it("reconciles memory after a partially failed persistent clear", async () => {
        const deletedStorageKey = seed("deleted first", "gone");
        seed("survivor", "kept");
        await listLLMCache();
        failures.clearAfter = 2;

        await expect(clearLLMCache()).rejects.toThrow("clear failed");

        expect(storage.has(deletedStorageKey)).toBe(false);
        expect(await getLLMCache("deleted first")).toBeNull();
        expect(await getLLMCache("survivor")).toBe("kept");
    });

    it("waits for delayed removals before recovering from a clear failure", async () => {
        const failedStorageKey = seed("failed clear row", "keep");
        const delayedStorageKey = seed("delayed clear row", "remove");
        await listLLMCache();
        failures.clearAfter = 1;
        const delayedRemoval = deferred<void>();
        asyncControls.clearRemoveGates.set(delayedStorageKey, delayedRemoval.promise);

        let settled = false;
        const clearing = clearLLMCache();
        void clearing.finally(() => { settled = true; }).catch(() => {});
        await vi.waitFor(() => {
            expect(asyncControls.startedClearRemoves.has(failedStorageKey)).toBe(true);
            expect(asyncControls.startedClearRemoves.has(delayedStorageKey)).toBe(true);
        });
        await Promise.resolve();
        await Promise.resolve();

        expect(settled).toBe(false);
        delayedRemoval.resolve();
        await expect(clearing).rejects.toThrow("clear failed");

        expect([...storage.entries()]).toEqual([
            [failedStorageKey, { key: "failed clear row", value: "keep" }],
        ]);
        expect(await getLLMCache("failed clear row")).toBe("keep");
        expect(await getLLMCache("delayed clear row")).toBeNull();
    });

    it("retries a listing that was reading while clear completed", async () => {
        seed("read race", "old value");
        const gate = deferred<void>();
        asyncControls.readGate = gate.promise;
        asyncControls.gatedReadsRemaining = 1;
        const listing = listLLMCache();
        await vi.waitFor(() => expect(readStats.active).toBeGreaterThan(0));

        await clearLLMCache();
        asyncControls.readGate = null;
        gate.resolve();

        await expect(listing).resolves.toMatchObject({ rows: [], total: 0 });
        expect(await getLLMCache("read race")).toBeNull();
    });

    it("retries a persistent snapshot when a key changes during the read", async () => {
        await setLLMCache("edit read race", "old value");
        const gate = deferred<void>();
        asyncControls.readGate = gate.promise;
        asyncControls.gatedReadsRemaining = 1;
        const listing = listLLMCache();
        await vi.waitFor(() => expect(readStats.active).toBeGreaterThan(0));

        await setLLMCache("edit read race", "new value");
        asyncControls.readGate = null;
        gate.resolve();

        await expect(listing).resolves.toMatchObject({
            rows: [{ key: "edit read race", value: "new value" }],
        });
        expect(await getLLMCache("edit read race")).toBe("new value");
    });

    it("does not let an older listing snapshot overwrite a completed translation", async () => {
        const pending = await startDelayedTranslation("translation read race");
        seed("translation read race", "old persistent");
        const gate = deferred<void>();
        asyncControls.readGate = gate.promise;
        asyncControls.gatedReadsRemaining = 1;
        const listing = listLLMCache();
        await vi.waitFor(() => expect(readStats.active).toBeGreaterThan(0));

        pending.response.resolve({ type: "success", result: "new translation" });
        await pending.result;
        asyncControls.readGate = null;
        gate.resolve();

        await expect(listing).resolves.toMatchObject({
            rows: [{ key: "translation read race", value: "new translation" }],
        });
        expect(await getLLMCache("translation read race")).toBe("new translation");
    });

    it("prevents an import started before clear from repopulating afterward", async () => {
        const firstStorageKey = `${prefix}first.json`;
        const gate = deferred<void>();
        asyncControls.writeGates.set(firstStorageKey, gate.promise);
        const importing = importLLMCacheFromJSON({ first: "one", second: "two" });
        await vi.waitFor(() => expect(asyncControls.startedWrites.has(firstStorageKey)).toBe(true));

        const clearing = clearLLMCache();
        gate.resolve();
        const [imported] = await Promise.all([importing, clearing]);

        expect(imported).toEqual({ count: 1, failed: 1 });
        expect(storage.size).toBe(0);
        expect((await listLLMCache()).total).toBe(0);
    });

    it("ignores an older translation result that completes after a manual edit", async () => {
        const pending = await startDelayedTranslation("late edit");
        await setLLMCache("late edit", "manual value");

        pending.response.resolve({ type: "success", result: "late result" });
        await pending.result;

        expect(await getLLMCache("late edit")).toBe("manual value");
        expect(storage.get(`${prefix}late%20edit.json`)).toEqual({ key: "late edit", value: "manual value" });
    });

    it("does not resurrect a key when an older translation completes after delete", async () => {
        const pending = await startDelayedTranslation("late delete");
        const storageKey = `${prefix}late%20delete.json`;
        await setLLMCache("late delete", "temporary");
        await deleteLLMCache("late delete", storageKey, currentEtag(storageKey));

        pending.response.resolve({ type: "success", result: "late result" });
        await pending.result;

        expect(storage.has(storageKey)).toBe(false);
        expect(await getLLMCache("late delete")).toBeNull();
    });

    it("does not repopulate cache when an older translation completes after clear", async () => {
        const pending = await startDelayedTranslation("late clear");
        await clearLLMCache();

        pending.response.resolve({ type: "success", result: "late result" });
        await pending.result;

        expect(storage.size).toBe(0);
        expect(await getLLMCache("late clear")).toBeNull();
    });

    it("awaits and publishes a current translation result", async () => {
        const pending = await startDelayedTranslation("current result");

        pending.response.resolve({ type: "success", result: "current value" });
        await expect(pending.result).resolves.toBe("current value");

        expect(storage.get(`${prefix}current%20result.json`)).toEqual({
            key: "current result",
            value: "current value",
        });
        expect(await getLLMCache("current result")).toBe("current value");
    });

    it("keeps direct reads and searches safe around damaged entries", async () => {
        storage.set(`${prefix}damaged.json`, new Error("broken JSON"));
        storage.set(`${prefix}bad.json`, { key: "bad", value: 42 });
        seed("valid", "works");

        await expect(getLLMCache("damaged")).resolves.toBeNull();
        await expect(getLLMCache("bad")).resolves.toBeNull();
        await expect(searchLLMCache("valid")).resolves.toEqual([
            { key: "valid", value: "works" },
        ]);
    });

    it("does not let a delayed direct get repopulate memory after clear", async () => {
        seed("get clear race", "old");
        const gate = deferred<void>();
        asyncControls.readGate = gate.promise;
        asyncControls.gatedReadsRemaining = 1;
        const reading = getLLMCache("get clear race");
        await vi.waitFor(() => expect(readStats.active).toBeGreaterThan(0));
        asyncControls.readGate = null;

        await clearLLMCache();
        gate.resolve();

        await expect(reading).resolves.toBeNull();
        expect(await getLLMCache("get clear race")).toBeNull();
    });

    it("does not let a delayed direct get overwrite a manual edit", async () => {
        seed("get edit race", "old");
        const gate = deferred<void>();
        asyncControls.readGate = gate.promise;
        asyncControls.gatedReadsRemaining = 1;
        const reading = getLLMCache("get edit race");
        await vi.waitFor(() => expect(readStats.active).toBeGreaterThan(0));
        asyncControls.readGate = null;

        await setLLMCache("get edit race", "new");
        gate.resolve();

        await expect(reading).resolves.toBe("new");
        expect(await getLLMCache("get edit race")).toBe("new");
    });

    it("does not let a delayed search repopulate memory after clear", async () => {
        seed("search clear race", "old");
        const gate = deferred<void>();
        asyncControls.readGate = gate.promise;
        asyncControls.gatedReadsRemaining = 1;
        const searching = searchLLMCache("search clear");
        await vi.waitFor(() => expect(readStats.active).toBeGreaterThan(0));
        asyncControls.readGate = null;

        await clearLLMCache();
        gate.resolve();

        await expect(searching).resolves.toEqual([]);
        expect(await getLLMCache("search clear race")).toBeNull();
    });

    it("does not let a delayed search overwrite a manual edit", async () => {
        seed("search edit race", "old");
        const gate = deferred<void>();
        asyncControls.readGate = gate.promise;
        asyncControls.gatedReadsRemaining = 1;
        const searching = searchLLMCache("search edit");
        await vi.waitFor(() => expect(readStats.active).toBeGreaterThan(0));
        asyncControls.readGate = null;

        await setLLMCache("search edit race", "new");
        gate.resolve();

        await expect(searching).resolves.toEqual([{ key: "search edit race", value: "new" }]);
        expect(await getLLMCache("search edit race")).toBe("new");
    });
});
