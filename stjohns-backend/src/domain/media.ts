// Photos for the homepage slideshow, the gallery and before/after pairs. Uploads are re-encoded as WebP in up to
// three widths; re-encoding also drops EXIF metadata, including the GPS location phones add to photos taken at a
// customer's house. Images are stored in the database and served with year-long cache headers (their URLs never
// change, because a new upload gets a new id).
import sharp from 'sharp';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Deps } from '../deps.js';
import { withTx, type Queryable } from '../db/pool.js';
import { AppError } from '../lib/errors.js';
import { isUuid, optionalTrimmed, parse, trimmed } from '../lib/validate.js';
import { saveSettingsSections, slideshowSettingsSchema } from './site-settings.js';

export const IMAGE_WIDTHS = [640, 1280, 2400] as const;
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/avif'];
export const CATEGORIES = ['exterior', 'interior', 'wheels', 'detail'] as const;
export type Category = (typeof CATEGORIES)[number];
const MIN_WIDTH = 320;

export interface ProcessedImage {
  width: number;
  height: number;
  variants: { width: number; height: number; data: Buffer }[];
}

const unreadable = () => new AppError('VALIDATION_FAILED', "We couldn't read that file. Upload a JPG, PNG or WebP photo.");
const heic = () =>
  new AppError(
    'VALIDATION_FAILED',
    "iPhone HEIC photos can't be processed. On the iPhone choose Settings › Camera › Formats › Most Compatible, or share the photo as a JPG.",
  );

export async function processImage(input: Buffer): Promise<ProcessedImage> {
  const open = () => sharp(input, { failOn: 'error', limitInputPixels: 100_000_000 });
  const meta = await open()
    .metadata()
    .catch(() => null);
  if (!meta?.width || !meta.height || !['jpeg', 'png', 'webp', 'heif'].includes(meta.format ?? '')) throw unreadable();
  // Orientations 5–8 are rotated 90°, so the displayed width is the stored height.
  const width = (meta.orientation ?? 1) >= 5 ? meta.height : meta.width;
  if (width < MIN_WIDTH) {
    throw new AppError('VALIDATION_FAILED', `That photo is too small (${width}px wide). Use one at least ${MIN_WIDTH}px wide.`);
  }
  const largest = Math.min(width, IMAGE_WIDTHS[IMAGE_WIDTHS.length - 1]);
  const targets = [...new Set([...IMAGE_WIDTHS.filter((w) => w < largest), largest])].sort((a, b) => a - b);
  try {
    const variants: ProcessedImage['variants'] = [];
    for (const w of targets) {
      const { data, info } = await open()
        .rotate()
        .resize({ width: w, withoutEnlargement: true })
        .webp({ quality: 80, effort: 4 })
        .toBuffer({ resolveWithObject: true });
      variants.push({ width: info.width, height: info.height, data });
    }
    const top = variants[variants.length - 1];
    return { width: top.width, height: top.height, variants };
  } catch {
    throw meta.format === 'heif' ? heic() : unreadable();
  }
}

export interface ImageView {
  id: string;
  width: number;
  height: number;
  /** A sensible default (≤1280px wide). */
  src: string;
  srcset: string;
  sizes: { width: number; url: string }[];
}

export function imageUrl(config: Config, id: string, width: number): string {
  return `${config.PUBLIC_API_URL.replace(/\/$/, '')}/api/v1/images/${id}/${width}.webp`;
}

function imageView(config: Config, id: string, variants: { width: number; height: number }[]): ImageView {
  const sorted = [...variants].sort((a, b) => a.width - b.width);
  const top = sorted[sorted.length - 1] ?? { width: 0, height: 0 };
  const sizes = sorted.map((v) => ({ width: v.width, url: imageUrl(config, id, v.width) }));
  const preferred = [...sizes].reverse().find((s) => s.width <= 1280) ?? sizes[0];
  return {
    id,
    width: top.width,
    height: top.height,
    src: preferred?.url ?? '',
    srcset: sizes.map((s) => `${s.url} ${s.width}w`).join(', '),
    sizes,
  };
}

async function imageViews(deps: Deps, ids: string[]): Promise<Map<string, ImageView>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  const { rows } = await deps.db.query<{ image_id: string; width: number; height: number }>(
    'SELECT image_id, width, height FROM image_variants WHERE image_id = ANY($1::UUID[])',
    [unique],
  );
  const grouped = new Map<string, { width: number; height: number }[]>();
  for (const r of rows) grouped.set(r.image_id, [...(grouped.get(r.image_id) ?? []), { width: Number(r.width), height: Number(r.height) }]);
  return new Map(unique.map((id) => [id, imageView(deps.config, id, grouped.get(id) ?? [])]));
}

export async function saveImage(deps: Deps, upload: Buffer, userId: string): Promise<ImageView> {
  const processed = await processImage(upload);
  const id = await withTx(deps.db, async (c) => {
    const { rows } = await c.query<{ id: string }>('INSERT INTO images (width, height, created_by) VALUES ($1, $2, $3) RETURNING id', [
      processed.width,
      processed.height,
      userId,
    ]);
    for (const v of processed.variants) {
      await c.query('INSERT INTO image_variants (image_id, width, height, bytes) VALUES ($1, $2, $3, $4)', [rows[0].id, v.width, v.height, v.data]);
    }
    return rows[0].id;
  });
  return imageView(deps.config, id, processed.variants);
}

export async function imageBytes(db: Queryable, id: string, width: number): Promise<Buffer | null> {
  const { rows } = await db.query<{ bytes: Buffer }>('SELECT bytes FROM image_variants WHERE image_id = $1 AND width = $2', [id, width]);
  return rows[0]?.bytes ?? null;
}

const uuid = z.uuid('Unknown photo');

async function assertImages(c: Queryable, ids: string[]): Promise<void> {
  const unique = [...new Set(ids)];
  const { rows } = await c.query<{ n: number }>('SELECT count(*) AS n FROM images WHERE id = ANY($1::UUID[])', [unique]);
  if (Number(rows[0].n) !== unique.length) throw new AppError('VALIDATION_FAILED', 'One of the photos was not found. Upload it again.');
}

async function deleteImageIfUnused(c: Queryable, imageId: string): Promise<void> {
  await c.query(
    `DELETE FROM images WHERE id = $1
       AND NOT EXISTS (SELECT 1 FROM gallery_items WHERE image_id = $1)
       AND NOT EXISTS (SELECT 1 FROM before_after WHERE before_image_id = $1 OR after_image_id = $1)`,
    [imageId],
  );
}

function assertId(id: string, what: string): void {
  if (!isUuid(id)) throw new AppError('NOT_FOUND', `${what} not found.`);
}

// ---------- Homepage slideshow ----------

interface ItemRow {
  id: string;
  image_id: string;
  caption: string | null;
  alt: string | null;
  category: Category | null;
  featured: boolean;
  visible: boolean;
  sort: number;
  created_at: Date;
}

async function itemRows(deps: Deps, section: 'slide' | 'photo', order: string): Promise<ItemRow[]> {
  const { rows } = await deps.db.query<ItemRow>(
    `SELECT id, image_id, caption, alt, category, featured, visible, sort, created_at FROM gallery_items WHERE section = $1 ORDER BY ${order}`,
    [section],
  );
  return rows;
}

export async function listSlides(deps: Deps) {
  const [rows, settings] = await Promise.all([itemRows(deps, 'slide', 'sort, created_at'), deps.settings.get()]);
  const images = await imageViews(deps, rows.map((r) => r.image_id));
  return {
    seconds: settings.site.slideshow.seconds,
    slides: rows.map((r) => ({ id: r.id, caption: r.caption, alt: r.alt, visible: r.visible, image: images.get(r.image_id)! })),
  };
}

export const addSlideSchema = z.object({
  imageId: uuid,
  caption: optionalTrimmed(120, 'Caption'),
  alt: optionalTrimmed(200, 'Description'),
});

/** New slides start hidden, so a half-finished slide never appears on the homepage. */
export async function addSlide(deps: Deps, raw: unknown) {
  const input = parse(addSlideSchema, raw);
  await withTx(deps.db, async (c) => {
    await assertImages(c, [input.imageId]);
    await c.query(
      `INSERT INTO gallery_items (section, image_id, caption, alt, visible, sort)
       VALUES ('slide', $1, $2, $3, false, (SELECT COALESCE(max(sort), 0) + 1 FROM gallery_items WHERE section = 'slide'))`,
      [input.imageId, input.caption, input.alt],
    );
  });
  return listSlides(deps);
}

export const publishSlidesSchema = z.object({
  seconds: slideshowSettingsSchema.shape.seconds,
  slides: z
    .array(
      z.object({
        id: uuid,
        caption: optionalTrimmed(120, 'Caption'),
        alt: optionalTrimmed(200, 'Description'),
        visible: z.boolean(),
      }),
    )
    .max(30, 'At most 30 slides'),
});

/** "Publish slideshow": order (array order), captions, descriptions, visibility and timing in one save. */
export async function publishSlides(deps: Deps, raw: unknown, userId: string) {
  const input = parse(publishSlidesSchema, raw);
  const missingAlt: Record<string, string> = {};
  input.slides.forEach((s, i) => {
    if (s.visible && !s.alt) missingAlt[`slides.${i}.alt`] = 'Describe the photo for people using screen readers';
  });
  if (Object.keys(missingAlt).length) throw new AppError('VALIDATION_FAILED', 'Every slide that is showing needs a description.', missingAlt);
  if (input.slides.length && !input.slides.some((s) => s.visible)) {
    throw new AppError('VALIDATION_FAILED', 'Show at least one slide, or the homepage will have no picture.');
  }
  await withTx(deps.db, async (c) => {
    const { rows } = await c.query<{ id: string }>("SELECT id FROM gallery_items WHERE section = 'slide' FOR UPDATE");
    const existing = new Set(rows.map((r) => r.id));
    const sent = new Set(input.slides.map((s) => s.id));
    if (existing.size !== sent.size || [...sent].some((id) => !existing.has(id))) {
      throw new AppError('CONFLICT', 'The slideshow changed in another window. Reload the page and try again.');
    }
    for (const [i, s] of input.slides.entries()) {
      await c.query("UPDATE gallery_items SET caption = $2, alt = $3, visible = $4, sort = $5 WHERE id = $1 AND section = 'slide'", [
        s.id,
        s.caption,
        s.alt,
        s.visible,
        i + 1,
      ]);
    }
    await saveSettingsSections(c, { slideshow: { seconds: input.seconds } }, userId);
  });
  await deps.settings.reload();
  return listSlides(deps);
}

async function deleteItem(deps: Deps, section: 'slide' | 'photo', id: string): Promise<void> {
  assertId(id, section === 'slide' ? 'Slide' : 'Photo');
  await withTx(deps.db, async (c) => {
    const { rows } = await c.query<{ image_id: string }>('DELETE FROM gallery_items WHERE id = $1 AND section = $2 RETURNING image_id', [id, section]);
    if (!rows[0]) throw new AppError('NOT_FOUND', `${section === 'slide' ? 'Slide' : 'Photo'} not found.`);
    await deleteImageIfUnused(c, rows[0].image_id);
  });
}

export const deleteSlide = (deps: Deps, id: string) => deleteItem(deps, 'slide', id);

// ---------- Gallery photos ----------

export async function listPhotos(deps: Deps) {
  const rows = await itemRows(deps, 'photo', 'created_at DESC');
  const images = await imageViews(deps, rows.map((r) => r.image_id));
  const photos = rows.map((r) => ({
    id: r.id,
    caption: r.caption,
    category: r.category ?? 'exterior',
    featured: r.featured,
    createdAt: r.created_at.toISOString(),
    image: images.get(r.image_id)!,
  }));
  const counts = Object.fromEntries(CATEGORIES.map((c) => [c, photos.filter((p) => p.category === c).length])) as Record<Category, number>;
  return { photos, counts: { all: photos.length, ...counts } };
}

export const addPhotosSchema = z.object({
  items: z
    .array(z.object({ imageId: uuid, caption: optionalTrimmed(120, 'Caption'), category: z.enum(CATEGORIES, { error: 'Choose a category' }) }))
    .min(1, 'Add at least one photo')
    .max(50, 'Add at most 50 photos at a time'),
});

export async function addPhotos(deps: Deps, raw: unknown) {
  const input = parse(addPhotosSchema, raw);
  await withTx(deps.db, async (c) => {
    await assertImages(
      c,
      input.items.map((i) => i.imageId),
    );
    for (const item of input.items) {
      await c.query("INSERT INTO gallery_items (section, image_id, caption, category) VALUES ('photo', $1, $2, $3)", [
        item.imageId,
        item.caption,
        item.category,
      ]);
    }
  });
  return listPhotos(deps);
}

export const updatePhotoSchema = z
  .object({
    caption: optionalTrimmed(120, 'Caption').optional(),
    category: z.enum(CATEGORIES).optional(),
    featured: z.boolean().optional(),
  })
  .refine((v) => v.caption !== undefined || v.category !== undefined || v.featured !== undefined, { message: 'Nothing to update' });

export async function updatePhoto(deps: Deps, id: string, raw: unknown) {
  assertId(id, 'Photo');
  const input = parse(updatePhotoSchema, raw);
  const res = await deps.db.query(
    `UPDATE gallery_items SET
       caption = CASE WHEN $2 THEN $3 ELSE caption END,
       category = COALESCE($4, category),
       featured = COALESCE($5, featured)
     WHERE id = $1 AND section = 'photo'`,
    [id, input.caption !== undefined, input.caption ?? null, input.category ?? null, input.featured ?? null],
  );
  if (!res.rowCount) throw new AppError('NOT_FOUND', 'Photo not found.');
  return (await listPhotos(deps)).photos.find((p) => p.id === id)!;
}

export const deletePhoto = (deps: Deps, id: string) => deleteItem(deps, 'photo', id);

// ---------- Before & after ----------

export async function listPairs(deps: Deps) {
  const { rows } = await deps.db.query<{ id: string; title: string; before_image_id: string; after_image_id: string; published: boolean; created_at: Date }>(
    'SELECT id, title, before_image_id, after_image_id, published, created_at FROM before_after ORDER BY created_at DESC',
  );
  const images = await imageViews(deps, rows.flatMap((r) => [r.before_image_id, r.after_image_id]));
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    published: r.published,
    before: images.get(r.before_image_id)!,
    after: images.get(r.after_image_id)!,
    createdAt: r.created_at.toISOString(),
  }));
}

export const createPairSchema = z
  .object({ title: trimmed(2, 120, 'Title'), beforeImageId: uuid, afterImageId: uuid })
  .refine((v) => v.beforeImageId !== v.afterImageId, { path: ['afterImageId'], message: 'Choose two different photos' });

export async function createPair(deps: Deps, raw: unknown) {
  const input = parse(createPairSchema, raw);
  await withTx(deps.db, async (c) => {
    await assertImages(c, [input.beforeImageId, input.afterImageId]);
    await c.query('INSERT INTO before_after (title, before_image_id, after_image_id) VALUES ($1, $2, $3)', [
      input.title,
      input.beforeImageId,
      input.afterImageId,
    ]);
  });
  return listPairs(deps);
}

export const updatePairSchema = z
  .object({ title: trimmed(2, 120, 'Title').optional(), published: z.boolean().optional() })
  .refine((v) => v.title !== undefined || v.published !== undefined, { message: 'Nothing to update' });

/** Only one pair is on the homepage at a time: publishing one hides the others. */
export async function updatePair(deps: Deps, id: string, raw: unknown) {
  assertId(id, 'Before & after pair');
  const input = parse(updatePairSchema, raw);
  await withTx(deps.db, async (c) => {
    const { rows } = await c.query('SELECT 1 FROM before_after WHERE id = $1 FOR UPDATE', [id]);
    if (!rows[0]) throw new AppError('NOT_FOUND', 'Before & after pair not found.');
    if (input.published) await c.query('UPDATE before_after SET published = false WHERE id <> $1 AND published', [id]);
    await c.query('UPDATE before_after SET title = COALESCE($2, title), published = COALESCE($3, published) WHERE id = $1', [
      id,
      input.title ?? null,
      input.published ?? null,
    ]);
  });
  return listPairs(deps);
}

export async function deletePair(deps: Deps, id: string): Promise<void> {
  assertId(id, 'Before & after pair');
  await withTx(deps.db, async (c) => {
    const { rows } = await c.query<{ before_image_id: string; after_image_id: string }>(
      'DELETE FROM before_after WHERE id = $1 RETURNING before_image_id, after_image_id',
      [id],
    );
    if (!rows[0]) throw new AppError('NOT_FOUND', 'Before & after pair not found.');
    await deleteImageIfUnused(c, rows[0].before_image_id);
    await deleteImageIfUnused(c, rows[0].after_image_id);
  });
}

// ---------- Public ----------

/** Everything the homepage and gallery page show, in one request. */
export async function publicGallery(deps: Deps) {
  const [slides, photos, pairs] = await Promise.all([listSlides(deps), listPhotos(deps), listPairs(deps)]);
  const published = pairs.find((p) => p.published);
  return {
    slideshow: {
      seconds: slides.seconds,
      slides: slides.slides.filter((s) => s.visible).map((s) => ({ caption: s.caption, alt: s.alt ?? '', image: s.image })),
    },
    photos: photos.photos.map((p) => ({ id: p.id, caption: p.caption, category: p.category, featured: p.featured, image: p.image })),
    beforeAfter: published ? { title: published.title, before: published.before, after: published.after } : null,
  };
}
