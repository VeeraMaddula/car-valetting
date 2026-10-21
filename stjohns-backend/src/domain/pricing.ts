// Price rules shared by the booking flow, the public price list and the admin screens. Pure functions, all in
// integer cents, so they are unit-tested directly.

export type VehicleSize = 'small' | 'large' | 'suv';
export const VEHICLE_SIZES: readonly VehicleSize[] = ['small', 'large', 'suv'];
export const SIZE_LABELS: Record<VehicleSize, string> = { small: 'Small / medium', large: 'Large / estate', suv: 'SUV / van' };

export interface PricedService {
  priceCents: number | null;
  priceLargeCents: number | null;
  priceSuvCents: number | null;
  saleEnabled: boolean;
  salePriceCents: number | null;
  saleStartsOn: string | null;
  saleEndsOn: string | null;
}

export const toCents = (eur: number) => Math.round(eur * 100);
export const toEur = (cents: number | null) => (cents === null ? null : cents / 100);

/** '€90' or '€76.50'. */
export function euros(cents: number): string {
  return `€${cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2)}`;
}

/** The normal price for a vehicle size; sizes without their own price fall back to the base price. */
export function listPrice(s: PricedService, size: VehicleSize | null, bySize: boolean): number | null {
  if (!bySize || !size || size === 'small') return s.priceCents;
  return (size === 'large' ? s.priceLargeCents : s.priceSuvCents) ?? s.priceCents;
}

export function saleIsLive(s: PricedService, today: string): boolean {
  return (
    s.saleEnabled &&
    s.salePriceCents !== null &&
    s.priceCents !== null &&
    s.salePriceCents < s.priceCents &&
    (!s.saleStartsOn || s.saleStartsOn <= today) &&
    (!s.saleEndsOn || today <= s.saleEndsOn)
  );
}

export interface ServiceQuote {
  /** Normal price for this size, before any sale. */
  listCents: number | null;
  /** What the customer pays for the service before a discount code. */
  priceCents: number | null;
  onSale: boolean;
}

export function quoteService(s: PricedService, size: VehicleSize | null, bySize: boolean, today: string): ServiceQuote {
  const list = listPrice(s, size, bySize);
  if (list === null) return { listCents: null, priceCents: null, onSale: false };
  if (!saleIsLive(s, today)) return { listCents: list, priceCents: list, onSale: false };
  // The sale price is set against the base price; other sizes get the same percentage off.
  const price = list === s.priceCents ? s.salePriceCents! : Math.round((list * s.salePriceCents!) / s.priceCents!);
  return { listCents: list, priceCents: price, onSale: true };
}

// ---------- Discount codes ----------

export interface DiscountRule {
  kind: 'percent' | 'fixed';
  /** Percent (1–90) or cents. */
  value: number;
  startsOn: string;
  endsOn: string | null;
  maxUses: number | null;
  uses: number;
  paused: boolean;
}

export type DiscountState = 'active' | 'scheduled' | 'paused' | 'expired' | 'used_up';

export function discountState(d: DiscountRule, today: string): DiscountState {
  if (d.endsOn && today > d.endsOn) return 'expired';
  if (d.maxUses !== null && d.uses >= d.maxUses) return 'used_up';
  if (d.paused) return 'paused';
  if (today < d.startsOn) return 'scheduled';
  return 'active';
}

export function discountAmount(d: Pick<DiscountRule, 'kind' | 'value'>, priceCents: number): number {
  if (d.kind === 'percent') return Math.round((priceCents * d.value) / 100);
  return Math.min(d.value, priceCents);
}

/** '15% off' or '€10 off'. */
export function discountLabel(d: Pick<DiscountRule, 'kind' | 'value'>): string {
  return d.kind === 'percent' ? `${d.value}% off` : `${euros(d.value)} off`;
}

export function normalizeCode(input: string): string {
  return input.trim().toUpperCase().replace(/\s+/g, '');
}
