const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const CHUNK_BYTES = 8 * 1024 * 1024;
const MIN_CHUNK_BYTES = 1024 * 1024;
const MAX_CHUNK_BYTES = 64 * 1024 * 1024;
const MAX_BYTES = 2 * 1024 * 1024 * 1024;

/** Temporary, bounded staging. No live chat is changed until accept returns a body. */
function createChatContentUploads({ root = os.tmpdir(), chunkBytes = CHUNK_BYTES,
    maxBytes = MAX_BYTES, ttlMs = 10 * 60 * 1000, now = Date.now } = {}) {
    const uploads = new Map();
    let reserved = 0;
    let queue = Promise.resolve();
    const serial = fn => {
        const result = queue.then(fn);
        queue = result.catch(() => {});
        return result;
    };
    const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
    async function remove(id) {
        const upload = uploads.get(id);
        if (!upload) return;
        await fs.rm(upload.dir, { recursive: true, force: true });
        uploads.delete(id);
        reserved -= upload.size;
    }
    async function sweep() {
        for (const [id, upload] of uploads) {
            if (now() - upload.touched >= ttlMs) await remove(id);
        }
    }
    const timer = setInterval(() => { serial(sweep).catch(() => {}); }, Math.min(ttlMs, 60_000));
    timer.unref();
    function identity(req) {
        const id = req.headers['x-upload-id'];
        const session = req.headers['x-session-id'];
        const chatId = req.headers['x-chat-id'];
        if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(id)
            || typeof session !== 'string' || !session || typeof chatId !== 'string' || !chatId) {
            fail(400, 'Upload ID, session ID and chat ID required');
        }
        return { id, owner: JSON.stringify([session, req.params.chaId, req.params.chatIndex, chatId]) };
    }
    return {
        accept(req) { return serial(async () => {
            await sweep();
            const { id, owner } = identity(req);
            const sizeHeader = req.headers['x-upload-size'];
            const indexHeader = req.headers['x-upload-index'];
            if (typeof sizeHeader !== 'string' || !/^\d+$/.test(sizeHeader)
                || typeof indexHeader !== 'string' || !/^\d+$/.test(indexHeader)) fail(400, 'Invalid upload metadata');
            const size = Number(sizeHeader), index = Number(indexHeader);
            // The app setting travels with the upload, so it also works before
            // the database settings patch is saved. Legacy clients default to 8 MiB.
            const chunkHeader = req.headers['x-upload-chunk-size'];
            let requestedChunkBytes = chunkBytes;
            if (chunkHeader !== undefined) {
                if (typeof chunkHeader !== 'string' || !/^\d+$/.test(chunkHeader)) fail(400, 'Invalid chunk size');
                requestedChunkBytes = Number(chunkHeader);
                if (!Number.isSafeInteger(requestedChunkBytes) || requestedChunkBytes < MIN_CHUNK_BYTES
                    || requestedChunkBytes > MAX_CHUNK_BYTES || requestedChunkBytes % MIN_CHUNK_BYTES !== 0) {
                    fail(400, 'Chunk size must be between 1 and 64 MiB in whole MiB');
                }
            }
            if (!Number.isSafeInteger(size) || size <= 0 || size > maxBytes) fail(413, 'Chat upload is too large');
            if (!Number.isSafeInteger(index) || index < 0 || index >= Math.ceil(size / requestedChunkBytes)) fail(400, 'Invalid chunk index');
            const expectedBytes = Math.min(requestedChunkBytes, size - index * requestedChunkBytes);
            if (!Buffer.isBuffer(req.body) || req.body.length !== expectedBytes) fail(400, 'Invalid chunk length');
            let upload = uploads.get(id);
            if (upload && (upload.owner !== owner || upload.size !== size || upload.chunkBytes !== requestedChunkBytes)) fail(409, 'Upload identity mismatch');
            if (!upload) {
                if (index !== 0) fail(409, 'Upload expired or missing; restart upload');
                if (uploads.size >= 8 || reserved + size > maxBytes) fail(429, 'Too many pending chat uploads');
                const dir = await fs.mkdtemp(path.join(root, 'risubard-chat-upload-'));
                upload = { owner, size, chunkBytes: requestedChunkBytes, dir, nextIndex: 0, touched: now() };
                uploads.set(id, upload);
                reserved += size;
            }
            if (index !== upload.nextIndex) fail(409, 'Unexpected chunk order');
            try {
                const file = path.join(upload.dir, 'body');
                await fs.appendFile(file, req.body);
                upload.nextIndex++;
                upload.touched = now();
                if ((index + 1) * requestedChunkBytes < size) return { uploadId: id, nextIndex: upload.nextIndex };
                const body = await fs.readFile(file);
                if (body.length !== size) fail(400, 'Incomplete chat upload');
                await remove(id);
                return { body };
            } catch (error) {
                await remove(id);
                throw error;
            }
        }); },
        abort(req) { return serial(async () => {
            const { id, owner } = identity(req);
            const upload = uploads.get(id);
            if (upload && upload.owner !== owner) fail(409, 'Upload identity mismatch');
            await remove(id);
        }); },
        close() { clearInterval(timer); return serial(async () => {
            for (const id of uploads.keys()) await remove(id);
        }); },
    };
}

module.exports = { createChatContentUploads, CHUNK_BYTES, MAX_CHUNK_BYTES };
