import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../../config/index.js';
import { AppError } from '../../utils/errors.js';

// Provider-neutral private document artefact storage. Business/domain code
// never imports an S3/R2/Cloudinary SDK — it talks to this boundary only.
// A `storage_key` is an opaque logical id ("<year>/<uuid>.<ext>"), never a URL
// or a filesystem path.
const KEY_RE = /^[0-9]{4}\/[0-9a-f-]{36}\.(pdf|png|jpg|jpeg|zpl|json)$/;

class LocalDocumentStorage {
  constructor(root) {
    // Resolved once; every key is validated against it to block traversal.
    this.root = path.resolve(process.cwd(), root);
  }

  #resolve(key) {
    if (!KEY_RE.test(key)) throw new AppError('DOCUMENT_STORAGE_KEY_INVALID', 'Invalid storage key.', 400);
    const full = path.resolve(this.root, key);
    if (full !== this.root && !full.startsWith(this.root + path.sep)) {
      throw new AppError('DOCUMENT_STORAGE_KEY_INVALID', 'Storage key escapes the storage root.', 400);
    }
    return full;
  }

  newKey(ext) {
    return `${new Date().getFullYear()}/${randomUUID()}.${String(ext || 'pdf').toLowerCase()}`;
  }

  async put(key, bytes) {
    const full = this.#resolve(key);
    await mkdir(path.dirname(full), { recursive: true });
    const tmp = `${full}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, bytes);
      const { rename } = await import('node:fs/promises');
      await rename(tmp, full);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw new AppError('DOCUMENT_STORAGE_FAILED', 'Could not persist the document artefact.', 502, { cause: err });
    }
    return { key, sha256: createHash('sha256').update(bytes).digest('hex'), byteSize: bytes.length };
  }

  async get(key) {
    const full = this.#resolve(key);
    try {
      return await readFile(full);
    } catch {
      throw new AppError('DOCUMENT_NOT_READY', 'The document artefact is missing from storage.', 404);
    }
  }

  async remove(key) {
    await unlink(this.#resolve(key)).catch(() => {});
  }
}

function build() {
  if (env.DOCUMENT_STORAGE_DRIVER === 'LOCAL') return new LocalDocumentStorage(env.DOCUMENT_STORAGE_LOCAL_PATH);
  throw new AppError('DOCUMENT_STORAGE_DRIVER_UNSUPPORTED', `Unsupported storage driver ${env.DOCUMENT_STORAGE_DRIVER}.`, 500);
}

export const documentStorage = build();
