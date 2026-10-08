import { hasher } from "../parser/parser.svelte";
import { forageStorage } from "../globalApi.svelte";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let initPromise: Promise<void> | null = null;

async function ensureStorageReady() {
    if (!initPromise) {
        initPromise = forageStorage.Init();
    }
    await initPromise;
}

function encodeKeyComponent(value: string) {
    return Buffer.from(value, "utf-8")
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
}

function decodeKeyComponent(value: string) {
    const padded = value
        .replace(/-/g, "+")
        .replace(/_/g, "/")
        .padEnd(Math.ceil(value.length / 4) * 4, "=");
    return Buffer.from(padded, "base64").toString("utf-8");
}

export async function readPersistentJson<T>(storageKey: string): Promise<T | null> {
    await ensureStorageReady();
    const data = await forageStorage.getItem(storageKey);
    if (!data) {
        return null;
    }
    return JSON.parse(decoder.decode(data)) as T;
}

export type VersionedPersistentJson<T> = {
    value: T | null;
    etag: string | null;
};

/** Batched raw read for rebuildable `cache/` keys; missing entries are null. */
export async function readPersistentCacheBytesMany(storageKeys: readonly string[]): Promise<(Uint8Array | null)[]> {
    await ensureStorageReady();
    return forageStorage.getCacheItems(storageKeys);
}

/** Batched raw write for rebuildable `cache/` keys. */
export async function writePersistentCacheBytesMany(
    entries: readonly { key: string; value: Uint8Array }[]
): Promise<void> {
    if (entries.length === 0) return;
    await ensureStorageReady();
    await forageStorage.setCacheItems(entries);
}

export async function readPersistentJsonWithVersion<T>(storageKey: string): Promise<VersionedPersistentJson<T>> {
    await ensureStorageReady();
    const { value: data, etag } = await forageStorage.getItemWithEtag(storageKey);
    if (!data) {
        return { value: null, etag: null };
    }
    return {
        value: JSON.parse(decoder.decode(data)) as T,
        etag,
    };
}

export async function writePersistentJson<T>(storageKey: string, value: T): Promise<void> {
    await ensureStorageReady();
    await forageStorage.setItem(storageKey, encoder.encode(JSON.stringify(value)));
}

export async function writePersistentJsonConditional<T>(
    storageKey: string,
    value: T,
    expectedEtag: string,
): Promise<string | null> {
    await ensureStorageReady();
    return await forageStorage.setItemConditional(
        storageKey,
        encoder.encode(JSON.stringify(value)),
        expectedEtag,
    );
}

export async function removePersistentKey(storageKey: string): Promise<void> {
    await ensureStorageReady();
    await forageStorage.removeItem(storageKey);
}

export async function removePersistentKeyConditional(
    storageKey: string,
    expectedEtag: string,
): Promise<void> {
    await ensureStorageReady();
    await forageStorage.removeItem(storageKey, expectedEtag);
}

export async function listPersistentKeys(prefix = ""): Promise<string[]> {
    await ensureStorageReady();
    return await forageStorage.keys(prefix);
}

export async function clearPersistentPrefix(prefix: string): Promise<void> {
    const keys = await listPersistentKeys(prefix);
    const results = await Promise.allSettled(keys.map((key) => removePersistentKey(key)));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
}

export async function makeHashedStorageKey(prefix: string, rawKey: string): Promise<string> {
    const hash = await hasher(encoder.encode(rawKey));
    return `${prefix}${hash}.json`;
}

export function makeEncodedStorageKey(prefix: string, rawKey: string): string {
    return `${prefix}${encodeKeyComponent(rawKey)}.json`;
}

export function decodeStorageKeyComponent(encodedKey: string): string {
    return decodeKeyComponent(encodedKey);
}
