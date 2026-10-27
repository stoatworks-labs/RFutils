/**
 * Tests for the sourced RF data and the radio-aware coordination path.
 *
 * These deliberately assert *specific vendor figures*, not just structural
 * sanity. The whole point of the rf/ module is that the numbers are real, so a
 * test that only checked "spacing > 0" would pass just as happily against the
 * placeholders it replaced.
 */

import { describe, it, expect } from 'vitest';
import {
  BUILTIN_PLUGINS,
  PRODUCT_RF_DATA,
  UNSOURCED_PRODUCTS,
  defaultCoordinationParams,
  findVariant,
  rfDataFor,
  variantContains,
  type CoordinationParams,
  type CoordinationRadio,
} from '@rfutils/shared';
import { coordinateRadios, analyze } from '@rfutils/shared/coordination';

describe('sourced RF data', () => {
  it('every band variant is well formed and cites a source', () => {
    for (const [id, rf] of Object.entries(PRODUCT_RF_DATA)) {
      const codes = new Set<string>();
      for (const v of rf.bandVariants) {
        expect(v.ranges.length, `${id} ${v.code} has no ranges`).toBeGreaterThan(0);
        for (const r of v.ranges) {
          expect(r.endMhz, `${id} ${v.code}`).toBeGreaterThan(r.startMhz);
        }
        // Segments must be disjoint and ascending, or "the gap" means nothing.
        for (let i = 1; i < v.ranges.length; i++) {
          expect(v.ranges[i]!.startMhz, `${id} ${v.code} segments overlap`).toBeGreaterThan(
            v.ranges[i - 1]!.endMhz
          );
        }
        expect(codes.has(v.code), `${id} has duplicate band code ${v.code}`).toBe(false);
        codes.add(v.code);
        expect(v.provenance.basis).toBeTruthy();
      }
    }
  });

  it('every mode declares a positive spacing with a provenance basis', () => {
    for (const [id, rf] of Object.entries(PRODUCT_RF_DATA)) {
      expect(rf.modes.length, `${id} has no modes`).toBeGreaterThan(0);
      for (const m of rf.modes) {
        expect(m.minSpacingKhz, `${id} ${m.id}`).toBeGreaterThan(0);
        expect(['vendor-doc', 'derived', 'assumed']).toContain(m.spacing.basis);
        // Anything not straight from the vendor must say why.
        if (m.spacing.basis !== 'vendor-doc') expect(m.spacing.note).toBeTruthy();
      }
    }
  });

  it('products with no research are listed rather than silently placeholdered', () => {
    for (const id of UNSOURCED_PRODUCTS) {
      expect(rfDataFor(id)).toBeUndefined();
      expect(BUILTIN_PLUGINS.find((p) => p.id === id)?.verified).toBe(false);
    }
  });

  // --- the actual vendor numbers -------------------------------------------

  it('Shure ULX-D G51 is 470-534, not the old blanket 470-608', () => {
    const v = findVariant(rfDataFor('shure-ulxd')?.bandVariants, 'G51');
    expect(v?.ranges).toEqual([{ startMhz: 470, endMhz: 534 }]);
  });

  it('Shure Axient Digital K54 carries both of its published gaps', () => {
    const v = findVariant(rfDataFor('shure-axient-digital')?.bandVariants, 'K54');
    expect(v).toBeDefined();
    expect(variantContains(v!, 607)).toBe(true);
    expect(variantContains(v!, 610), '608-614 MHz gap').toBe(false);
    expect(variantContains(v!, 615)).toBe(true);
    expect(variantContains(v!, 630), '616-653 MHz gap').toBe(false);
    expect(variantContains(v!, 660)).toBe(true);
  });

  it('Shure SLX-D JB tunes in 125 kHz steps while the rest of SLX-D is 25 kHz', () => {
    const bands = rfDataFor('shure-slxd')?.bandVariants;
    expect(findVariant(bands, 'JB')?.tuningStepKhz).toBe(125);
    expect(findVariant(bands, 'K59')?.tuningStepKhz).toBeUndefined();
    expect(rfDataFor('shure-slxd')?.tuningStepKhz).toBe(25);
  });

  it('Shure Axient Digital spacing is the vendor-stated 350 / 125 kHz', () => {
    const modes = rfDataFor('shure-axient-digital')!.modes;
    expect(modes.find((m) => m.id === 'standard')?.minSpacingKhz).toBe(350);
    expect(modes.find((m) => m.id === 'high-density')?.minSpacingKhz).toBe(125);
    expect(modes.every((m) => m.spacing.basis === 'vendor-doc')).toBe(true);
  });

  it('Sennheiser EW-DX is 600 kHz standard / 300 kHz LD on an equidistant grid', () => {
    const modes = rfDataFor('sennheiser-ewdx')!.modes;
    expect(modes.find((m) => m.id === 'standard')?.minSpacingKhz).toBe(600);
    expect(modes.find((m) => m.id === 'link-density')?.minSpacingKhz).toBe(300);
    expect(modes.every((m) => m.strategy === 'equidistant')).toBe(true);
  });

  it('Sennheiser Digital 6000 uses the published 400 kHz LR / 200 kHz LD grid', () => {
    const modes = rfDataFor('sennheiser-d6000')!.modes;
    expect(modes.find((m) => m.id === 'lr')?.minSpacingKhz).toBe(400);
    expect(modes.find((m) => m.id === 'ld')?.minSpacingKhz).toBe(200);
  });

  it('Wisycom tunes in 5 kHz steps, not 25', () => {
    expect(rfDataFor('wisycom-mcr54')?.tuningStepKhz).toBe(5);
    expect(BUILTIN_PLUGINS.find((p) => p.id === 'wisycom-mcr54')?.tuningStepKhz).toBe(5);
  });

  it('Wisycom narrowband is 200 kHz spacing at ~100 kHz occupied', () => {
    const nb = rfDataFor('wisycom-mcr54')!.modes.find((m) => m.id === 'narrowband')!;
    expect(nb.minSpacingKhz).toBe(200);
    expect(nb.occupiedBandwidthKhz).toBe(100);
    expect(nb.spacing.basis).toBe('vendor-doc');
  });

  it('AKG WMS470 IX skips 605.9-614.1 MHz, and the UK’s IX-U does not', () => {
    const bands = rfDataFor('akg-wms470')?.bandVariants;
    const ix = findVariant(bands, 'IX')!;
    const ixu = findVariant(bands, 'IX-U')!;
    expect(variantContains(ix, 605.9)).toBe(true);
    expect(variantContains(ix, 610), '605.9-614.1 MHz gap').toBe(false);
    expect(variantContains(ix, 614.1)).toBe(true);
    expect(variantContains(ixu, 610)).toBe(true);
    expect(ixu.regions).toEqual(['UK']);
  });

  it('AKG WMS470 V-B is 806.125-809.750 MHz', () => {
    const v = findVariant(rfDataFor('akg-wms470')?.bandVariants, 'V-B');
    expect(v?.ranges).toEqual([{ startMhz: 806.125, endMhz: 809.75 }]);
  });

  it('AKG WMS470 spacing is worked out from its channel groups, so it is not verified', () => {
    const mode = rfDataFor('akg-wms470')!.modes[0]!;
    expect(mode.minSpacingKhz).toBe(400);
    expect(mode.spacing.basis).toBe('derived');
    // The group chart is a dealer's copy, so it never makes the spacing vendor-doc.
    expect(mode.spacing.source).toContain('zajaruhaz.hu');
    expect(mode.bandwidth?.basis).toBe('assumed');
    expect(BUILTIN_PLUGINS.find((p) => p.id === 'akg-wms470')?.verified).toBe(false);
  });

  it('SLX-D needs far more room than the 400 kHz the catalog used to assume', () => {
    const slxd = BUILTIN_PLUGINS.find((p) => p.id === 'shure-slxd')!;
    const ulxd = BUILTIN_PLUGINS.find((p) => p.id === 'shure-ulxd')!;
    expect(slxd.recommendedSpacingMhz).toBeGreaterThan(0.4);
    expect(slxd.recommendedSpacingMhz).toBeGreaterThan(ulxd.recommendedSpacingMhz);
  });

  it('PSM 1000 shows occupied bandwidth and required spacing are different quantities', () => {
    const mode = rfDataFor('shure-psm1000')!.modes[0]!;
    expect(mode.occupiedBandwidthKhz).toBeLessThan(250);
    expect(mode.minSpacingKhz).toBeGreaterThan(1500);
  });

  it('every discontiguous variant really is discontiguous where the vendor says', () => {
    const multi = Object.values(PRODUCT_RF_DATA)
      .flatMap((rf) => rf.bandVariants)
      .filter((v) => v.ranges.length > 1);
    // If this ever drops to zero, the gaps have been flattened away.
    expect(multi.length).toBeGreaterThan(10);
  });
});

describe('coordinateRadios()', () => {
  const wide = (over: Partial<CoordinationParams> = {}): CoordinationParams => ({
    ...defaultCoordinationParams(),
    ranges: [{ startMhz: 470, endMhz: 620 }],
    ...over,
  });

  const radio = (over: Partial<CoordinationRadio> & { name: string }): CoordinationRadio => over;

  it('never places a carrier inside a band variant gap', () => {
    const k54 = findVariant(rfDataFor('shure-axient-digital')?.bandVariants, 'K54')!;
    const radios = Array.from({ length: 6 }, (_, i) =>
      radio({
        name: `AD ${i + 1}`,
        tuningRanges: k54.ranges,
        minSpacingMhz: 0.35,
        bandCode: 'K54',
      })
    );
    const r = coordinateRadios(radios, wide({ ranges: [{ startMhz: 600, endMhz: 700 }] }));
    expect(r.placed).toBe(6);
    for (const a of r.assigned) {
      expect(variantContains(k54, a.frequencyMhz), `${a.frequencyMhz} is in a gap`).toBe(true);
    }
  });

  it('applies the wider of two radios’ spacing requirements to the pair', () => {
    const radios = [
      radio({ name: 'ULXD', minSpacingMhz: 0.35 }),
      radio({ name: 'SLXD', minSpacingMhz: 0.667 }),
      radio({ name: 'ULXD 2', minSpacingMhz: 0.35 }),
    ];
    const r = coordinateRadios(radios, wide({ ranges: [{ startMhz: 470, endMhz: 480 }] }));
    expect(r.placed).toBe(3);
    const slxd = r.assigned.find((a) => a.name === 'SLXD')!;
    for (const other of r.assigned.filter((a) => a.name !== 'SLXD')) {
      // The SLX-D's requirement governs every pair it is part of.
      expect(Math.abs(other.frequencyMhz - slxd.frequencyMhz)).toBeGreaterThanOrEqual(
        0.667 - 1e-9
      );
    }
  });

  it('keeps occupied bandwidths from overlapping even when spacing is tiny', () => {
    const radios = Array.from({ length: 4 }, (_, i) =>
      radio({
        name: `Ch ${i + 1}`,
        minSpacingMhz: 0.01, // absurdly permissive
        occupiedBandwidthKhz: 200,
      })
    );
    const r = coordinateRadios(
      radios,
      wide({ ranges: [{ startMhz: 500, endMhz: 502 }], thirdOrder: false })
    );
    expect(r.placed).toBe(4);
    const f = r.assigned.map((a) => a.frequencyMhz).sort((a, b) => a - b);
    for (let i = 1; i < f.length; i++) {
      // (200 + 200) / 2 = 200 kHz floor from the footprints alone.
      expect(f[i]! - f[i - 1]!).toBeGreaterThanOrEqual(0.2 - 1e-9);
    }
  });

  it('honours each radio’s own tuning raster', () => {
    const radios = [
      radio({ name: 'Wisycom', tuningStepKhz: 5, minSpacingMhz: 0.2 }),
      radio({ name: 'Shure', tuningStepKhz: 25, minSpacingMhz: 0.35 }),
    ];
    const r = coordinateRadios(radios, wide({ ranges: [{ startMhz: 470, endMhz: 475 }] }));
    expect(r.placed).toBe(2);
    const shure = r.assigned.find((a) => a.name === 'Shure')!;
    expect(Math.round(shure.frequencyMhz * 1000) % 25).toBe(0);
  });

  it('places equidistant-strategy radios on a uniform grid', () => {
    const radios = Array.from({ length: 5 }, (_, i) =>
      radio({
        name: `EW-DX ${i + 1}`,
        minSpacingMhz: 0.6,
        strategy: 'equidistant',
        tuningRanges: [{ startMhz: 470.2, endMhz: 550 }],
      })
    );
    const r = coordinateRadios(radios, wide({ ranges: [{ startMhz: 470, endMhz: 550 }] }));
    expect(r.placed).toBe(5);
    const f = r.assigned.map((a) => a.frequencyMhz).sort((a, b) => a - b);
    const gaps = f.slice(1).map((x, i) => Math.round((x - f[i]!) * 1000));
    // Every gap is a whole number of 600 kHz steps.
    for (const g of gaps) expect(g % 600).toBe(0);
    expect(r.notes.join(' ')).toMatch(/equidistant grid/i);
  });

  it('says which radio has no tunable frequency rather than just failing', () => {
    const radios = [
      radio({ name: 'In band', tuningRanges: [{ startMhz: 470, endMhz: 480 }] }),
      radio({
        name: 'Wrong band',
        bandCode: 'K51',
        tuningRanges: [{ startMhz: 606, endMhz: 670 }],
      }),
    ];
    const r = coordinateRadios(radios, wide({ ranges: [{ startMhz: 470, endMhz: 480 }] }));
    expect(r.placed).toBe(1);
    expect(r.notes.join(' ')).toMatch(/Wrong band \(K51\)/);
    expect(r.notes.join(' ')).toMatch(/no tunable frequency/i);
  });

  it('reports the spacing each carrier was placed under', () => {
    const r = coordinateRadios(
      [radio({ name: 'A', minSpacingMhz: 0.667, bandCode: 'K59', modeId: 'standard' })],
      wide()
    );
    expect(r.assigned[0]).toMatchObject({
      name: 'A',
      bandCode: 'K59',
      modeId: 'standard',
      requiredSpacingMhz: 0.667,
    });
  });

  it('still produces an IM3-clean set with mixed equipment', () => {
    const params = wide({ thirdOrder: true, fifthOrder: true, minSpacingMhz: 0.35 });
    const radios = [
      ...Array.from({ length: 4 }, (_, i) => radio({ name: `ULXD ${i}`, minSpacingMhz: 0.35 })),
      ...Array.from({ length: 2 }, (_, i) => radio({ name: `SLXD ${i}`, minSpacingMhz: 0.667 })),
    ];
    const r = coordinateRadios(radios, params);
    expect(r.placed).toBe(6);
    const a = analyze(
      r.assigned.map((x) => x.frequencyMhz),
      params
    );
    expect(a.conflicts).toEqual([]);
  });
});
