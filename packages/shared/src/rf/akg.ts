/**
 * AKG band variants and RF modes.
 *
 * The WMS470 is analog FM, tuning in 25 kHz steps across a 30.5 MHz switching
 * bandwidth. AKG does not publish a minimum channel spacing; instead the
 * receiver picks carriers from precalculated IM-safe channel groups. The
 * 400 kHz spacing used here is the conservative floor: 120 of the 131 groups
 * in the WMS 470 group chart keep every carrier ≥400 kHz apart, with
 * 375/350/300 kHz appearing only in the narrow 11.8 MHz bands (III-K, V-D)
 * and the Japan-B groups of V-B. Because it is worked out from the groups
 * rather than stated by AKG, and that chart comes from a dealer's website
 * rather than AKG's, it is `derived`, and the product is not `verified`.
 *
 * Band codes are the Roman numerals printed on the device, as AKG's frequency
 * chart and service documentation write them. The manual and cutsheet write
 * the same bands as Band 1, 3-K, 5-A and so on; each variant's notes give that
 * form. Suffixes (−A, −B, −D, −K, −U, −ISM) denote regional/regulatory
 * variants of the same hardware family and are carried as separate band
 * variants.
 *
 * Ranges from AKG's WMS470 frequency chart, cutsheet and user manual, and the
 * WMS400/450/470 service documentation, read 2026-10-25. Channel groups from
 * the dealer-hosted WMS 470 group chart, read 2026-10-27.
 */

import type { BandVariant, Provenance, RfMode } from './types.js';

const RETRIEVED = '2026-10-25';

const FREQ_CHART =
  'AKG WMS470 frequency chart (manual supplement for CSCHTX/CSCPTX/CSCSRX) — https://au.akg.com/on/demandware.static/-/Sites-masterCatalog_Harman/default/dw99912afa/pdfs/Frequency%20chart%20WMS470.pdf';
const CUTSHEET =
  'AKG WMS 470 cutsheet — https://www.akg.com/on/demandware.static/-/Sites-masterCatalog_Harman/default/dw5b5096e6/pdfs/AKG_WMS470_Cutsheet.pdf';
const SERVICE_DOC =
  'AKG Service Info WMS400/450/470 — https://www.akg.com/on/demandware.static/-/Sites-masterCatalog_Harman/default/dwd24fcf75/pdfs/AKG_WMS470_WMS450_WMS400_Service_Documentation.pdf';
/** Third-party: AKG's branding, but hosted by a Hungarian dealer, not published by AKG. */
const GROUP_CHART =
  'WMS 470 Frequency Chart 2.0 (channel groups, 2011), dealer-hosted copy — https://zajaruhaz.hu/public/old_pdf/wms470_fre4da567bf4a7fc.pdf';

const doc = (source: string, note?: string): Provenance => ({
  basis: 'vendor-doc',
  source,
  retrieved: RETRIEVED,
  note,
});

/** Build variants from a compact [code, segments, notes?, regions?] table. */
function variants(
  rows: [string, number[][], string?, string[]?][],
  provenance: Provenance
): BandVariant[] {
  return rows.map(([code, ranges, notes, regions]) => ({
    code,
    ranges: ranges.map(([startMhz, endMhz]) => ({ startMhz: startMhz!, endMhz: endMhz! })),
    regions,
    notes,
    provenance,
  }));
}

// ---------------------------------------------------------------------------
// WMS470
// ---------------------------------------------------------------------------

export const AKG_WMS470_MODES: RfMode[] = [
  {
    id: 'standard',
    name: 'Standard',
    minSpacingKhz: 400,
    occupiedBandwidthKhz: 136,
    strategy: 'im-search',
    spacing: {
      basis: 'derived',
      source: GROUP_CHART,
      retrieved: '2026-10-27',
      note:
        'AKG publishes no minimum channel spacing. The receiver "shall select ' +
        'intermodulation-free frequencies automatically from an integrated frequency database ' +
        'arranged by local frequency allocations" (AKG cutsheet), and this is the smallest ' +
        'separation those groups use outside the narrow bands. The groups are in a WMS 470 ' +
        "frequency chart that carries AKG's logo and document numbers (9100 U 13440 B to " +
        '13540 C) but is hosted by a Hungarian dealer, not by AKG, so it is a third-party copy; ' +
        'the contributor who added this entry spot-checked groups against hardware (RFutils ' +
        '#87, #89). Counted from it on 2026-10-27: 131 groups in 11 bands, 120 of them ' +
        '≥400 kHz apart throughout; 375 kHz in the six Japan-B groups of Band V-B, 350 kHz in ' +
        'III-K 3.C and V-D 5.C, and 300 kHz in the 11.8 MHz bands III-K (3.D, 3.2) and V-D ' +
        '(5.D). It has no groups for Bands II, IV, V, VI, X, M or D. 400 kHz is also the ' +
        'working figure used for Sennheiser G4.',
    },
    bandwidth: {
      basis: 'assumed',
      source: 'J.P. Leisure WMS470 listing — https://www.jpleisure.co.uk/info-JP94602.html',
      retrieved: '2026-10-24',
      note:
        "Carson's rule: 2 × (48 + 20) = 136 kHz, on AKG's published 35–20,000 Hz audio " +
        'bandwidth and a 48 kHz peak deviation from a dealer listing. AKG\'s manual and ' +
        'cutsheet give the modulation only as FM / Wideband FM, so the deviation is not a ' +
        'vendor figure. VERIFY.',
    },
  },
];

/** The frequency chart's Start/Stop table: the bands sold in R&TTE countries. */
const CHART_BANDS = variants(
  [
    ['VII', [[500.1, 530.5]], 'Band 7 in the manual and cutsheet.'],
    ['VIII', [[570.1, 600.5]], 'Band 8 in the manual and cutsheet.'],
    [
      'IX',
      [[600.1, 605.9], [614.1, 630.5]],
      'Band 9 in the manual and cutsheet. Gap at 605.9–614.1 MHz.',
    ],
    [
      'IX-U',
      [[600.1, 630.5]],
      'Band 9-U in the manual and cutsheet. Same span as IX without the gap.',
      ['UK'],
    ],
    ['I', [[650.1, 680]], 'Band 1 in the manual and cutsheet.'],
    ['III', [[720, 750]], 'Band 3 in the manual and cutsheet.'],
    [
      'III-K',
      [[740.1, 751.9]],
      'Band 3-K in the manual and cutsheet. 10 mW. Extends 1.9 MHz beyond Band III.',
    ],
    ['V-D', [[794.1, 805.9]], 'Band 5-D in the manual and cutsheet. 10 mW.'],
    [
      'X',
      [[823.1, 831.9]],
      'Listed in the frequency chart only, not the manual or cutsheet.',
      ['DE'],
    ],
    ['M', [[826.3, 831.9]], 'Subset of Band X. Limited to 831 MHz in Denmark.'],
    ['D', [[863.1, 864.9]], '10 mW. Subset of Band VI.'],
  ],
  doc(FREQ_CHART, 'Start/Stop table, with power and the R&TTE countries each band is ticked for.')
);

/** Bands the cutsheet and manual list that the frequency chart does not. */
const CUTSHEET_BANDS = variants(
  [
    [
      'V-A',
      [[790.1, 819.9]],
      'Band 5-A in the manual and cutsheet. The cutsheet gives 790.1–819.9 MHz and the ' +
        "manual's specifications 790–821.5 MHz; the narrower range is used. The dealer-hosted " +
        'group chart also gives 790.0–821.5 MHz, and its group 5.3 uses 820.100 MHz.',
    ],
    ['V-B', [[806.125, 809.75]], 'Band 5-B in the manual and cutsheet.'],
    [
      'VI-A-ISM',
      [[835.1, 861.9], [863.1, 864.9]],
      'Band 6-A-ISM in the manual and cutsheet. Gap at 861.9–863.1 MHz.',
    ],
  ],
  doc(CUTSHEET, 'SR 470, PT 470 and HT 470 "Carrier frequency range".')
);

/**
 * Bands found only in the service documentation's frequency table, which covers
 * the whole WMS400/450/470 family in whole MHz. No WMS470 spec sheet lists them.
 */
const FAMILY_BANDS = variants(
  [
    ['II', [[680, 710]], 'WMS400/450/470 family range; not in any WMS470 spec sheet.'],
    ['IV', [[760, 790]], 'WMS400/450/470 family range; not in any WMS470 spec sheet.'],
    ['V', [[790, 829]], 'WMS400/450/470 family range; not in any WMS470 spec sheet.'],
    ['VI', [[835, 865]], 'WMS400/450/470 family range; not in any WMS470 spec sheet.'],
  ],
  doc(SERVICE_DOC, '"The complete WMS400/450/470 - Family" frequency range table, page 3.')
);

export const AKG_WMS470_BANDS: BandVariant[] = [
  ...CHART_BANDS,
  ...CUTSHEET_BANDS,
  ...FAMILY_BANDS,
].sort((a, b) => a.ranges[0]!.startMhz - b.ranges[0]!.startMhz);
