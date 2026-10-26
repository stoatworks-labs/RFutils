import { describe, it, expect } from 'vitest';
import {
  builtinCatalog,
  channelsNeeded,
  channelNames,
  deriveCoordDefaults,
  defaultCoordinationParams,
  findVariant,
  inventoryCoordination,
  variantContains,
  type Inventory,
  type InventoryItem,
} from '@rfutils/shared';
import { coordinate, coordinateRadios } from '@rfutils/shared/coordination';

function item(over: Partial<InventoryItem>): InventoryItem {
  return {
    id: 'x',
    label: 'Ch',
    vendor: '',
    model: '',
    band: '',
    role: 'mic',
    quantity: 1,
    coordinate: true,
    source: 'manual',
    ...over,
  };
}

describe('inventory helpers', () => {
  it('counts only channels flagged for coordination', () => {
    const inv: Inventory = {
      items: [
        item({ id: 'a', quantity: 2 }),
        item({ id: 'b', quantity: 3, coordinate: false }),
        item({ id: 'c', quantity: 1 }),
      ],
    };
    expect(channelsNeeded(inv)).toBe(3);
  });

  it('expands quantities into per-channel names', () => {
    const inv: Inventory = {
      items: [
        item({ id: 'a', label: 'Vocal', quantity: 1 }),
        item({ id: 'b', label: 'Band', quantity: 3 }),
        item({ id: 'c', label: 'Spare', quantity: 1, coordinate: false }),
      ],
    };
    expect(channelNames(inv)).toEqual(['Vocal', 'Band 1', 'Band 2', 'Band 3']);
  });

  it('ignores zero/negative quantities', () => {
    const inv: Inventory = { items: [item({ quantity: 0 }), item({ id: 'y', quantity: -2 })] };
    expect(channelsNeeded(inv)).toBe(0);
    expect(channelNames(inv)).toEqual([]);
  });
});

describe('inventoryCoordination()', () => {
  const catalog = builtinCatalog();
  const bandOf = (profileId: string, code: string) =>
    findVariant(catalog.profiles.find((p) => p.id === profileId)?.bandVariants, code)!;
  const run = (items: InventoryItem[]) => {
    const { radios, params } = inventoryCoordination({ items }, catalog);
    return { radios, params, result: coordinateRadios(radios, params) };
  };
  const placed = (result: ReturnType<typeof coordinateRadios>, name: RegExp): number[] =>
    result.assigned.filter((a) => name.test(a.name)).map((a) => a.frequencyMhz);

  it('keeps every channel inside the band variant picked for it', () => {
    // PR #89's case: the count-based path put all twelve at 470.1-539 MHz,
    // because the band preset (470-608) never reaches Band I (650.1-680).
    const band1 = bandOf('akg-wms470', 'I');
    const { radios, result } = run([
      item({ label: 'AKG', profileId: 'akg-wms470', band: 'I', quantity: 12 }),
    ]);
    expect(radios.every((r) => r.bandCode === 'I' && r.minSpacingMhz === 0.4)).toBe(true);
    expect(result.placed).toBe(12);
    for (const f of placed(result, /AKG/)) {
      expect(variantContains(band1, f), `${f} MHz is outside Band I`).toBe(true);
    }
  });

  it('holds a mix of bands to their own, gaps included', () => {
    const band1 = bandOf('akg-wms470', 'I');
    const band9 = bandOf('akg-wms470', 'IX'); // 600.1-605.9 and 614.1-630.5
    const { result } = run([
      item({ label: 'One', profileId: 'akg-wms470', band: 'I', quantity: 6 }),
      item({ label: 'Nine', profileId: 'akg-wms470', band: 'IX', quantity: 6 }),
    ]);
    expect(result.placed).toBe(12);
    for (const f of placed(result, /^One/)) expect(variantContains(band1, f), `${f}`).toBe(true);
    for (const f of placed(result, /^Nine/)) expect(variantContains(band9, f), `${f}`).toBe(true);
  });

  it('gives mixed makers their own raster, spacing and band', () => {
    const g51 = bandOf('shure-ulxd', 'G51');
    const s110 = bandOf('sennheiser-ewdx', 'S1-10');
    const { radios, result } = run([
      item({ label: 'ULXD', profileId: 'shure-ulxd', band: 'G51', quantity: 4 }),
      item({ label: 'EWDX', profileId: 'sennheiser-ewdx', band: 'S1-10', quantity: 4 }),
    ]);
    expect(radios.find((r) => r.name === 'ULXD 1')).toMatchObject({ minSpacingMhz: 0.35, strategy: 'im-search' });
    expect(radios.find((r) => r.name === 'EWDX 1')).toMatchObject({ minSpacingMhz: 0.6, strategy: 'equidistant' });
    expect(result.placed).toBe(8);
    for (const f of placed(result, /ULXD/)) expect(variantContains(g51, f), `${f}`).toBe(true);
    for (const f of placed(result, /EWDX/)) expect(variantContains(s110, f), `${f}`).toBe(true);
  });

  it("does not put channels with no band into another item's band", () => {
    const { params, result } = run([
      item({ label: 'AKG', profileId: 'akg-wms470', band: 'I', quantity: 6 }),
      item({ label: 'DWX', profileId: 'sony-dwx', band: '470-542', quantity: 2 }), // unresearched
      item({ label: 'Unpicked', profileId: 'shure-ulxd', band: '', quantity: 2 }),
      item({ label: 'Bare', quantity: 1 }), // no profile at all
    ]);
    // The gear's preset (470-608) for those, Band I for the AKGs.
    expect(params.ranges).toEqual([
      { startMhz: 470, endMhz: 608 },
      { startMhz: 650.1, endMhz: 680 },
    ]);
    expect(result.placed).toBe(11);
    for (const f of placed(result, /DWX|Unpicked|Bare/)) {
      expect(f, `${f} MHz left the preset`).toBeLessThanOrEqual(608);
    }
  });

  it('matches a band code whatever its case', () => {
    const { radios } = run([item({ label: 'AKG', profileId: 'akg-wms470', band: ' i ' })]);
    expect(radios[0]).toMatchObject({ bandCode: 'I', tuningRanges: [{ startMhz: 650.1, endMhz: 680 }] });
  });

  it('places an inventory with no band variants exactly where the count-based path did', () => {
    const items = [
      item({ label: 'DWX', profileId: 'sony-dwx', band: '470-542', quantity: 4 }),
      item({ label: 'A20', profileId: 'sounddevices-a20', quantity: 3 }),
      item({ label: 'ULXD', profileId: 'shure-ulxd', band: '470-534', quantity: 2 }), // free text, no match
      item({ label: 'Bare', quantity: 2 }),
    ];
    const derived = deriveCoordDefaults(items.map((i) => i.profileId), catalog);
    const before = coordinate(11, {
      ...defaultCoordinationParams(),
      minSpacingMhz: derived.minSpacingMhz,
      stepMhz: derived.stepMhz,
      ranges: catalog.bandPresets.find((b) => b.id === derived.bandPresetId)!.ranges,
    }, channelNames({ items }));
    const after = run(items).result;
    const freqs = (r: typeof after) => r.assigned.map((a) => a.frequencyMhz);
    expect(freqs(after)).toEqual(freqs(before));
  });
});
