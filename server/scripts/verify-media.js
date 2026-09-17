// Media Abstraction (Cloudinary) characterization — Provider Platform
// Migration, Phase 1.
//
// Freezes the OBSERVABLE behaviour of the media provider boundary so a future
// provider swap (R2 / S3) can prove parity:
//   - the Cloudinary raw-SDK-response -> NormalizedMedia mapping
//   - single-request vs chunked upload selection (the 10 MB threshold)
//   - `remove()` -> `destroy(providerId)`
//   - the not-configured guard
//   - the resolver (env.MEDIA_PROVIDER -> one cached provider instance)
//   - modules/media persistence: the `media` row records provider ownership
//     via `metadata.providerId`, never a raw Cloudinary field
//   - the raw SDK response never leaks past the mapper
//
// The Cloudinary SDK transport is stubbed for every deterministic test (no
// network). Set MEDIA_VERIFY_REAL=1 with real CLOUDINARY_* creds on staging to
// additionally run one real upload+destroy round-trip.
//
//   npm run verify:media
import assert from 'node:assert/strict';

// Force the provider "configured" so the stubbed-upload tests run regardless of
// whether this environment has real creds. `||=` keeps real creds if present
// (needed for the opt-in MEDIA_VERIFY_REAL path).
process.env.CLOUDINARY_CLOUD_NAME ||= 'verify-media-stub-cloud';
process.env.CLOUDINARY_API_KEY ||= 'verify-media-stub-key';
process.env.CLOUDINARY_API_SECRET ||= 'verify-media-stub-secret';
process.env.MEDIA_PROVIDER ||= 'cloudinary';

let externalCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input?.url || '';
  if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(url)) externalCalls += 1;
  return realFetch(input, init);
};

const { pool, query } = await import('../src/database/connection/pool.js');
const { toNormalizedMedia } = await import('../src/platform/media/providers/cloudinary/cloudinaryMapper.js');
const { CloudinaryProvider } = await import('../src/platform/media/providers/cloudinary/cloudinaryProvider.js');
const { cloudinary, isCloudinaryConfigured } = await import('../src/platform/media/providers/cloudinary/cloudinaryConfig.js');
const { resolveMediaProvider, uploadMedia: uploadViaProvider, removeMedia, isMediaConfigured } = await import('../src/platform/media/index.js');
const { providerRegistry, CAPABILITIES } = await import('../src/platform/shared/index.js');
const mediaModule = await import('../src/modules/media/service.js');
const { createApp } = await import('../src/app.js');

const results = {};
const pass = (name) => { results[name] = 'PASS'; console.log(`  PASS  ${name}`); };

// ---- SDK transport stub ----------------------------------------------------
const realUploader = { ...cloudinary.uploader };
let lastUpload = null;
const fakeRaw = (over = {}) => ({
  public_id: 'brand-folder/asset-xyz',
  secure_url: 'https://res.cloudinary.test/brand-folder/asset-xyz.jpg',
  width: 1200,
  height: 1600,
  bytes: 4096,
  format: 'jpg',
  resource_type: 'image',
  ...over,
});
function installUploadStub() {
  cloudinary.uploader.upload_stream = (opts, cb) => {
    lastUpload = { method: 'upload_stream', opts };
    return { end: (buffer) => cb(null, fakeRaw({
      bytes: buffer.length,
      resource_type: opts.resource_type === 'auto' ? 'image' : opts.resource_type,
    })) };
  };
  cloudinary.uploader.upload_chunked_stream = (opts, cb) => {
    lastUpload = { method: 'upload_chunked_stream', opts };
    return { end: (buffer) => cb(null, fakeRaw({
      bytes: buffer.length,
      resource_type: opts.resource_type === 'auto' ? 'video' : opts.resource_type,
    })) };
  };
  const destroyed = [];
  cloudinary.uploader.destroy = async (id) => { destroyed.push(id); return { result: 'ok' }; };
  return destroyed;
}
function restoreUploader() {
  Object.assign(cloudinary.uploader, realUploader);
}

const insertedMediaIds = [];

try {
  // ---- 1. mapper: image --------------------------------------------------
  {
    const raw = { public_id: 'p/1', secure_url: 'https://x/p/1.jpg', width: 800, height: 600, bytes: 123, format: 'jpg', resource_type: 'image' };
    assert.deepEqual(toNormalizedMedia(raw), {
      url: 'https://x/p/1.jpg',
      altText: null,
      width: 800,
      height: 600,
      mimeType: 'image/jpg',
      format: 'jpg',
      size: 123,
      mediaType: 'image',
      metadata: { provider: 'cloudinary', providerId: 'p/1' },
    });
    pass('MAPPER_NORMALIZES_IMAGE');
  }

  // ---- 2. mapper: video / raw -----------------------------------------
  {
    assert.equal(toNormalizedMedia({ public_id: 'v', secure_url: 'u', format: 'mp4', resource_type: 'video' }).mediaType, 'video');
    assert.equal(toNormalizedMedia({ public_id: 'r', secure_url: 'u', format: 'pdf', resource_type: 'raw' }).mediaType, 'raw');
    assert.equal(toNormalizedMedia({ public_id: 'x', secure_url: 'u', format: 'webp', resource_type: 'image' }).mimeType, 'image/webp');
    pass('MAPPER_NORMALIZES_VIDEO_AND_RAW');
  }

  // ---- 3. mapper: missing optional fields -> null (never undefined) -----
  {
    const n = toNormalizedMedia({ public_id: 'only-id', secure_url: 'https://x/only.png' });
    assert.equal(n.width, null);
    assert.equal(n.height, null);
    assert.equal(n.size, null);
    assert.equal(n.format, null);
    assert.equal(n.mimeType, null);
    assert.equal(n.mediaType, 'image');
    assert.equal(n.metadata.providerId, 'only-id');
    pass('MAPPER_TOLERATES_MISSING_FIELDS');
  }

  // ---- 4. resolver: single cached cloudinary instance ------------------
  {
    const a = resolveMediaProvider();
    const b = resolveMediaProvider();
    assert.ok(a instanceof CloudinaryProvider);
    assert.equal(a, b, 'provider instance is cached');
    assert.equal(a.isConfigured, isCloudinaryConfigured);
    pass('RESOLVER_RETURNS_CACHED_CLOUDINARY');
  }

  // ---- 4b. Phase 3: resolution goes through the shared registry -------
  {
    assert.ok(providerRegistry.has(CAPABILITIES.MEDIA, 'cloudinary'), 'cloudinary is registered in the shared provider registry');
    assert.equal(resolveMediaProvider(), providerRegistry.get(CAPABILITIES.MEDIA, 'cloudinary'), 'resolver returns the registered adapter');
    assert.equal(resolveMediaProvider().providerKey, 'cloudinary');
    pass('MEDIA_RESOLVES_VIA_SHARED_REGISTRY');
  }

  // ---- 5. not-configured guard ---------------------------------------
  {
    const p = new CloudinaryProvider();
    Object.defineProperty(p, 'isConfigured', { get: () => false });
    await assert.rejects(async () => p.upload(Buffer.from('x')), /not configured/i);
    await assert.rejects(async () => p.remove('some/id'), /not configured/i);
    pass('NOT_CONFIGURED_GUARD');
  }

  // ---- 6. small upload -> single request, normalized shape ------------
  const destroyed = installUploadStub();
  {
    lastUpload = null;
    const media = await new CloudinaryProvider().upload(Buffer.alloc(2048), { folder: 'brand-a' });
    assert.equal(lastUpload.method, 'upload_stream');
    assert.equal(lastUpload.opts.folder, 'brand-a');
    assert.equal(lastUpload.opts.resource_type, 'auto');
    assert.equal(media.url, 'https://res.cloudinary.test/brand-folder/asset-xyz.jpg');
    assert.equal(media.mediaType, 'image');
    assert.equal(media.size, 2048);
    assert.equal(media.metadata.providerId, 'brand-folder/asset-xyz');
    pass('UPLOAD_SMALL_USES_SINGLE_REQUEST');
  }

  // ---- 7. > 10 MB -> chunked, resource_type resolved off "auto" -------
  {
    lastUpload = null;
    const big = Buffer.alloc(11 * 1024 * 1024);
    const media = await new CloudinaryProvider().upload(big, { folder: 'brand-a' });
    assert.equal(lastUpload.method, 'upload_chunked_stream');
    assert.ok(lastUpload.opts.chunk_size > 0, 'chunk_size set');
    assert.equal(lastUpload.opts.resource_type, 'video', '"auto" becomes "video" for chunked');
    assert.equal(media.mediaType, 'video');
    pass('UPLOAD_LARGE_USES_CHUNKED');
  }

  // ---- 8. remove -> destroy(providerId) -----------------------------
  {
    await new CloudinaryProvider().remove('brand-folder/asset-xyz');
    assert.deepEqual(destroyed, ['brand-folder/asset-xyz']);
    pass('REMOVE_CALLS_DESTROY_WITH_PROVIDER_ID');
  }

  // ---- 9. mediaService facade delegates ----------------------------
  {
    assert.equal(isMediaConfigured(), true);
    const media = await uploadViaProvider(Buffer.alloc(64), { folder: 'facade' });
    assert.equal(media.metadata.provider, 'cloudinary');
    await removeMedia(media.metadata.providerId);
    assert.ok(destroyed.includes(media.metadata.providerId));
    pass('SERVICE_FACADE_DELEGATES');
  }

  // ---- 9b. Phase 3: an adapter error leaves the facade normalized ----
  {
    cloudinary.uploader.upload_stream = (_opts, cb) => ({ end: () => cb(new Error('cloudinary 500')) });
    await assert.rejects(
      () => uploadViaProvider(Buffer.alloc(16), { folder: 'err' }),
      (err) => err.name === 'ProviderError' && err.code === 'PROVIDER_ERROR' && err.capability === 'media',
    );
    installUploadStub(); // restore the happy stub for the remaining tests
    pass('SERVICE_FACADE_NORMALIZES_ADAPTER_ERROR');
  }

  // ---- 10. raw SDK fields never leak past the mapper ---------------
  {
    const media = await new CloudinaryProvider().upload(Buffer.alloc(32), { folder: 'leak-check' });
    const keys = Object.keys(media).sort();
    assert.deepEqual(keys, ['altText', 'format', 'height', 'mediaType', 'metadata', 'mimeType', 'size', 'url', 'width']);
    for (const forbidden of ['secure_url', 'public_id', 'resource_type', 'bytes']) {
      assert.ok(!(forbidden in media), `normalized model must not expose "${forbidden}"`);
    }
    pass('RAW_SDK_RESPONSE_NEVER_LEAKS');
  }

  // ---- 11. modules/media persists provider ownership -----------------
  // Wave 8D (migration 022): the registry row records provider ownership via
  // `provider_key` + `external_id` (the Cloudinary-specific column name is
  // gone). A future R2 migration never rewrites an existing row's provider.
  {
    const [brand] = await query("SELECT id FROM brands WHERE slug = 'corcotton' LIMIT 1");
    assert.ok(brand, 'corcotton brand present');
    const row = await mediaModule.uploadMedia(Buffer.alloc(128), { brandId: brand.id });
    insertedMediaIds.push(row.id);
    assert.equal(row.providerKey, 'cloudinary', 'DTO carries provider_key');
    assert.equal(row.externalId, 'brand-folder/asset-xyz', 'DTO externalId from metadata.providerId');
    const [persisted] = await query('SELECT * FROM media WHERE id = ? LIMIT 1', [row.id]);
    assert.equal(persisted.brand_id, brand.id);
    assert.equal(persisted.provider_key, 'cloudinary', 'provider ownership recorded');
    assert.equal(persisted.external_id, 'brand-folder/asset-xyz', 'stored id comes from metadata.providerId');
    assert.equal(persisted.url, 'https://res.cloudinary.test/brand-folder/asset-xyz.jpg');
    assert.equal(persisted.resource_type, 'image');
    assert.equal(persisted.status, 'ACTIVE');
    pass('MEDIA_MODULE_PERSISTS_PROVIDER_OWNERSHIP');
  }

  // ---- 12. HTTP: upload endpoint validates before provider work -----
  {
    const server = createApp().listen(0);
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(`${base}/api/v1/media/upload`, { method: 'POST', headers: { origin: 'http://localhost:5175' } });
    const json = await res.json().catch(() => null);
    assert.equal(res.status, 400);
    assert.equal(json.error.code, 'FILE_REQUIRED');
    server.close();
    pass('HTTP_UPLOAD_VALIDATES_INPUT');
  }

  // ---- 13. opt-in: one real Cloudinary round-trip (staging) --------
  {
    const realConfigured = isCloudinaryConfigured
      && !process.env.CLOUDINARY_API_KEY.startsWith('verify-media-stub');
    if (process.env.MEDIA_VERIFY_REAL === '1' && realConfigured) {
      restoreUploader();
      // 1x1 transparent PNG
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
      const media = await new CloudinaryProvider().upload(png, { folder: 'verify-media', resourceType: 'image' });
      assert.ok(media.url.startsWith('https://'));
      assert.equal(media.metadata.provider, 'cloudinary');
      await new CloudinaryProvider().remove(media.metadata.providerId);
      results.REAL_CLOUDINARY_ROUNDTRIP = 'PASS';
      console.log('  PASS  REAL_CLOUDINARY_ROUNDTRIP');
      installUploadStub();
    } else {
      results.REAL_CLOUDINARY_ROUNDTRIP = 'SKIPPED (set MEDIA_VERIFY_REAL=1 with real CLOUDINARY_* creds)';
      console.log(`  SKIP  REAL_CLOUDINARY_ROUNDTRIP — ${results.REAL_CLOUDINARY_ROUNDTRIP}`);
    }
  }

  // ---- 14. provider independence ---------------------------------
  {
    assert.equal(externalCalls, 0, 'stubbed run makes zero outbound calls');
    pass('NO_UNEXPECTED_EXTERNAL_CALLS');
  }

  console.log('\nMEDIA_ABSTRACTION_CHARACTERIZATION = PASS');
  console.log(JSON.stringify(results, null, 2));
} catch (err) {
  console.error('\nMEDIA_ABSTRACTION_CHARACTERIZATION = FAIL');
  console.error(err);
  process.exitCode = 1;
} finally {
  restoreUploader();
  if (insertedMediaIds.length) {
    await query(`DELETE FROM media WHERE id IN (${insertedMediaIds.map(() => '?').join(',')})`, insertedMediaIds);
  }
  await pool.end();
}
