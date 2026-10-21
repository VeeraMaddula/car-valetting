import type { FastifyInstance } from 'fastify';
import type { Deps } from '../deps.js';
import {
  customerQuerySchema,
  customersCsv,
  customerStats,
  eraseCustomer,
  filterCustomers,
  getCustomer,
  loadCustomers,
  sendCustomerPasswordReset,
  setCustomerNote,
} from '../domain/customers.js';
import { todayInZone } from '../lib/time.js';
import { parse } from '../lib/validate.js';
import { requireAdmin } from '../plugins/auth.js';

const admin = { preHandler: async (req: Parameters<typeof requireAdmin>[0]) => void requireAdmin(req) };
const keyOf = (req: { params: unknown }) => (req.params as { key: string }).key;

/** Admin › Customers. A customer key is 'user:<uuid>' or 'guest:<E.164 phone>' (URL-encode it in paths). */
export async function customerRoutes(app: FastifyInstance, { deps }: { deps: Deps }): Promise<void> {
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    return payload;
  });

  app.get('/admin/customers', admin, async (req) => {
    const query = parse(customerQuerySchema, req.query);
    const all = await loadCustomers(deps);
    const customers = filterCustomers(all, query);
    return { customers, shown: customers.length, total: all.length, stats: customerStats(all) };
  });

  /** "Export CSV" of the customers currently shown (same search, filter and sort as the list). */
  app.get('/admin/customers.csv', admin, async (req, reply) => {
    const query = parse(customerQuerySchema, req.query);
    const csv = customersCsv(filterCustomers(await loadCustomers(deps), query));
    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="customers-${todayInZone(deps.config.TIMEZONE)}.csv"`);
    return csv;
  });

  app.get('/admin/customers/:key', admin, async (req) => getCustomer(deps, keyOf(req)));

  /** Private notes ("Only you can see this"). An empty note deletes it. */
  app.put('/admin/customers/:key/note', admin, async (req) => ({ note: await setCustomerNote(deps, keyOf(req), req.body) }));

  app.post('/admin/customers/:key/password-reset', admin, async (req, reply) => {
    await sendCustomerPasswordReset(deps, keyOf(req));
    reply.status(202);
    return { ok: true };
  });

  /** "Delete personal data (GDPR)": anonymises their bookings and deletes any account. Cannot be undone. */
  app.delete('/admin/customers/:key', admin, async (req) => ({ ok: true, ...(await eraseCustomer(deps, keyOf(req))) }));
}
