/**
 * System inventory — the user's wireless equipment, offline or live.
 *
 * An offline inventory is built by hand (what gear you own / are bringing to a
 * show) and drives how many frequencies coordination must place and how they
 * get allocated. Live-discovered devices (from the Monitor tab) can be
 * imported into it, so the same list spans planned and present equipment.
 */

import {
  defaultCoordinationParams,
  type CoordinationParams,
  type CoordinationRadio,
  type FreqRange,
} from './coordination.js';
import { deriveCoordDefaults, type ProfileCatalog } from './profiles.js';
import { findMode, findVariant } from './rf/types.js';

export type InventoryRole = 'mic' | 'iem' | 'other';

export interface InventoryItem {
  id: string;
  /** Human label / talent / role, e.g. "Lead Vocal", "Presenter IEM". */
  label: string;
  vendor: string;
  model: string;
  /**
   * Band label. When the item's profile has researched band variants this is
   * the variant code as printed on the unit (e.g. "G56"), which pins the item
   * to that variant's real frequency range; otherwise a free label, e.g.
   * "470-534".
   */
  band: string;
  role: InventoryRole;
  /** Number of RF channels this item needs coordinated (default 1). */
  quantity: number;
  /** Include in coordination/allocation counts. */
  coordinate: boolean;
  /** Links to an EquipmentProfile id (fills vendor/model + coord defaults). */
  profileId?: string;
  /** Where it came from. */
  source: 'manual' | 'discovered';
  /** Links to a live DiscoveredDevice id when source === 'discovered'. */
  deviceId?: string;
  notes?: string;
}

export interface Inventory {
  items: InventoryItem[];
  /** ISO timestamp of the last save, set by the server. */
  updatedAt?: string;
}

export function emptyInventory(): Inventory {
  return { items: [] };
}

/** Total RF channels needing coordination across the inventory. */
export function channelsNeeded(inv: Inventory): number {
  return inv.items
    .filter((i) => i.coordinate)
    .reduce((sum, i) => sum + Math.max(0, Math.floor(i.quantity) || 0), 0);
}

/** Name of channel `i` (0-based) of an item that needs `q` channels. */
function channelName(item: InventoryItem, i: number, q: number): string {
  return q > 1 ? `${item.label} ${i + 1}` : item.label;
}

/** Expand items into one name per needed channel (for coordination naming). */
export function channelNames(inv: Inventory): string[] {
  const names: string[] = [];
  for (const item of inv.items) {
    if (!item.coordinate) continue;
    const q = Math.max(0, Math.floor(item.quantity) || 0);
    for (let i = 0; i < q; i++) {
      names.push(channelName(item, i, q));
    }
  }
  return names;
}

/** Sort ranges and join any that overlap or touch. */
function mergeRanges(ranges: FreqRange[]): FreqRange[] {
  const sorted = ranges.slice().sort((a, b) => a.startMhz - b.startMhz);
  const out: FreqRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.startMhz <= last.endMhz) last.endMhz = Math.max(last.endMhz, r.endMhz);
    else out.push({ startMhz: r.startMhz, endMhz: r.endMhz });
  }
  return out;
}

/**
 * The radios and settings "Coordinate from inventory" hands the engine: one
 * radio per channel, named as {@link channelNames} names them.
 *
 * A channel whose item names one of its model's band variants carries that
 * variant's tunable ranges (gaps included), raster, and the model's first mode
 * for spacing, bandwidth and strategy. Any other channel (no profile, a model
 * with no researched bands, or no band picked yet) is held to the gear mix's
 * most common band preset (or the default ranges if there is none), as every
 * channel was before, rather than to whatever bands the rest of the inventory
 * uses. The working ranges are all of those merged, so each radio is limited
 * by its own.
 */
export function inventoryCoordination(
  inv: Inventory,
  catalog: ProfileCatalog
): { radios: CoordinationRadio[]; params: CoordinationParams } {
  const coordinated = inv.items.filter((i) => i.coordinate);
  const derived = deriveCoordDefaults(
    coordinated.map((i) => i.profileId),
    catalog
  );
  const params = defaultCoordinationParams();
  params.minSpacingMhz = derived.minSpacingMhz;
  params.stepMhz = derived.stepMhz;
  const fallback =
    (derived.bandPresetId
      ? catalog.bandPresets.find((b) => b.id === derived.bandPresetId)?.ranges
      : undefined) ?? params.ranges;

  const radios: CoordinationRadio[] = [];
  for (const item of coordinated) {
    const q = Math.max(0, Math.floor(item.quantity) || 0);
    const profile = catalog.profiles.find((p) => p.id === item.profileId);
    const variant = findVariant(profile?.bandVariants, item.band);
    const mode = findMode(profile?.modes);
    for (let i = 0; i < q; i++) {
      radios.push({
        name: channelName(item, i, q),
        tuningRanges: variant?.ranges ?? fallback,
        tuningStepKhz: variant?.tuningStepKhz ?? profile?.tuningStepKhz,
        minSpacingMhz: mode ? mode.minSpacingKhz / 1000 : undefined,
        occupiedBandwidthKhz: mode?.occupiedBandwidthKhz,
        strategy: mode?.strategy,
        productId: profile?.id,
        bandCode: variant?.code,
        modeId: mode?.id,
      });
    }
  }

  if (radios.length) params.ranges = mergeRanges(radios.flatMap((r) => r.tuningRanges ?? []));
  return { radios, params };
}
