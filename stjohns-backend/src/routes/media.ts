import type { FastifyInstance } from 'fastify';
import type { Deps } from '../deps.js';
import {
  addPhotos,
  addSlide,
  createPair,
  deletePair,
  deletePhoto,
  deleteSlide,
  imageBytes,
  listPairs,
  listPhotos,
  listSlides,
  MAX_UPLOAD_BYTES,
  publicGallery,
  publishSlides,
  saveImage,
  updatePair,
  updatePhoto,
  UPLOAD_TYPES,
} from '../domain/media.js';
import { AppError } from '../lib/errors.js';
import { isUuid } from '../lib/validate.js';
import { requireAdmin } from '../plugins/auth.js';

const admin = { preHandler: async (req: Parameters<typeof requireAdmin>[0]) => void requireAdmin(req) };
const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;
const YEAR = 'public, max-age=31536000, immutable';
// Photos are public: let the website show them even if it is served from a different site than the API.
const CORP = 'cross-origin';

/**
 * Photos: upload (the raw file as the request body, one per request), the public gallery feed, image files,
 * and the admin slideshow / gallery / before & after screens. Own plugin scope so the image body parser
 * doesn't affect other routes.
 */
export async function mediaRoutes(app: FastifyInstance, { deps }: { deps: Deps }): Promise<void> {
  // GIF and TIFF are accepted here only so the owner gets a clear "use JPG, PNG or WebP" message.
  app.addContentTypeParser([...UPLOAD_TYPES, 'image/gif', 'image/tiff'], { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES }, (_req, body, done) =>
    done(null, body),
  );

  app.addHook('onSend', async (req, reply, payload) => {
    if (req.url.includes('/admin/')) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  // ---------- Public ----------

  /** Slideshow, gallery photos and the before & after pair for the homepage and gallery page. */
  app.get('/gallery', async (_req, reply) => {
    reply.header('Cache-Control', 'public, max-age=60');
    return publicGallery(deps);
  });

  /** Image files. A new upload always gets a new id, so they can be cached for a year. */
  app.get('/images/:id/:file', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { id, file } = req.params as { id: string; file: string };
    const width = /^(\d{2,4})\.webp$/.exec(file)?.[1];
    if (!isUuid(id) || !width) throw new AppError('NOT_FOUND', 'Image not found.');
    const etag = `"${id}-${width}"`;
    reply.header('Cross-Origin-Resource-Policy', CORP);
    if (req.headers['if-none-match'] === etag) return reply.status(304).header('ETag', etag).header('Cache-Control', YEAR).send();
    const bytes = await imageBytes(deps.db, id, Number(width));
    if (!bytes) throw new AppError('NOT_FOUND', 'Image not found.');
    return reply.header('Content-Type', 'image/webp').header('Cache-Control', YEAR).header('ETag', etag).send(bytes);
  });

  // ---------- Upload ----------

  /**
   * Send the photo itself as the body (Content-Type image/jpeg, image/png or image/webp). Returns the stored image.
   * Signed-in access is checked in onRequest, before up to 20 MB is read, so strangers can't fill the server's memory.
   */
  app.post(
    '/admin/images',
    {
      onRequest: async (req) => void requireAdmin(req),
      bodyLimit: MAX_UPLOAD_BYTES,
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        throw new AppError('VALIDATION_FAILED', 'Choose a photo to upload (JPG, PNG or WebP).');
      }
      const image = await saveImage(deps, req.body, req.user!.id);
      reply.status(201);
      return { image };
    },
  );

  // ---------- Homepage slideshow ----------

  app.get('/admin/slides', admin, async () => listSlides(deps));

  app.post('/admin/slides', admin, async (req, reply) => {
    reply.status(201);
    return addSlide(deps, req.body);
  });

  /** "Publish slideshow": every slide in display order, with captions, descriptions, visibility and seconds per slide. */
  app.put('/admin/slides', admin, async (req) => publishSlides(deps, req.body, req.user!.id));

  app.delete('/admin/slides/:id', admin, async (req) => {
    await deleteSlide(deps, idOf(req));
    return listSlides(deps);
  });

  // ---------- Gallery ----------

  app.get('/admin/photos', admin, async () => listPhotos(deps));

  app.post('/admin/photos', admin, async (req, reply) => {
    reply.status(201);
    return addPhotos(deps, req.body);
  });

  app.patch('/admin/photos/:id', admin, async (req) => ({ photo: await updatePhoto(deps, idOf(req), req.body) }));

  app.delete('/admin/photos/:id', admin, async (req) => {
    await deletePhoto(deps, idOf(req));
    return { ok: true };
  });

  // ---------- Before & after ----------

  app.get('/admin/before-after', admin, async () => ({ pairs: await listPairs(deps) }));

  app.post('/admin/before-after', admin, async (req, reply) => {
    reply.status(201);
    return { pairs: await createPair(deps, req.body) };
  });

  app.patch('/admin/before-after/:id', admin, async (req) => ({ pairs: await updatePair(deps, idOf(req), req.body) }));

  app.delete('/admin/before-after/:id', admin, async (req) => {
    await deletePair(deps, idOf(req));
    return { pairs: await listPairs(deps) };
  });
}
