import type { FastifyInstance } from 'fastify';
import type { Deps } from '../deps.js';
import { getPricing, getSales, savePricing, saveSales } from '../domain/catalog.js';
import { createDiscount, listDiscounts, setDiscountPaused, updateDiscount } from '../domain/discounts.js';
import { requireAdmin } from '../plugins/auth.js';

const admin = { preHandler: async (req: Parameters<typeof requireAdmin>[0]) => void requireAdmin(req) };

/** Admin › Services & prices, Sale prices and Discount codes. */
export async function catalogRoutes(app: FastifyInstance, { deps }: { deps: Deps }): Promise<void> {
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    return payload;
  });

  app.get('/admin/pricing', admin, async () => getPricing(deps));

  /** One save for services (in display order), size prices, extras, "price by vehicle size" and the deposit. */
  app.put('/admin/pricing', admin, async (req) => savePricing(deps, req.body, req.user!.id));

  app.get('/admin/sales', admin, async () => getSales(deps));

  app.put('/admin/sales', admin, async (req) => saveSales(deps, req.body));

  app.get('/admin/discounts', admin, async () => listDiscounts(deps));

  app.post('/admin/discounts', admin, async (req, reply) => {
    reply.status(201);
    return { discount: await createDiscount(deps, req.body) };
  });

  app.put('/admin/discounts/:id', admin, async (req) => ({ discount: await updateDiscount(deps, (req.params as { id: string }).id, req.body) }));

  app.post('/admin/discounts/:id/pause', admin, async (req) => ({ discount: await setDiscountPaused(deps, (req.params as { id: string }).id, true) }));

  app.post('/admin/discounts/:id/resume', admin, async (req) => ({ discount: await setDiscountPaused(deps, (req.params as { id: string }).id, false) }));
}
