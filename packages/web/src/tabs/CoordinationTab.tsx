import { useEffect, useState } from 'react';
import type {
  CoordinationParams,
  CoordinationRadio,
  CoordinationResult,
  AnalysisResult,
  FreqRange,
  ExportFormat,
  ExportOptions,
  ProfileCatalog,
  Provenance,
} from '@rfutils/shared';
import { defaultCoordinationParams, EXPORT_FORMATS } from '@rfutils/shared';
import {
  coordinateFrequencies,
  coordinateRadioSet,
  analyzeFrequencies,
  exportModel,
  getProfiles,
} from '../api.js';
import { usePlanStore } from '../planStore.js';
import { ExportOptionsFields } from '../components/ExportOptionsFields.js';
import type { JSX } from 'react';

function formatRanges(ranges: FreqRange[]): string {
  return ranges.map((r) => `${r.startMhz}-${r.endMhz}`).join(', ');
}

function parseRanges(text: string): FreqRange[] {
  return text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((seg) => {
      const [a, b] = seg.split('-').map((x) => Number(x.trim()));
      return { startMhz: a ?? 0, endMhz: b ?? a ?? 0 };
    })
    .filter((r) => r.startMhz > 0 && r.endMhz >= r.startMhz);
}

function parseFreqList(text: string): number[] {
  return text
    .split(/[,\s]+/)
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

function download(text: string, filename: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Say plainly where a number came from. The project's standing rule is that
 * users must be able to tell a manufacturer's figure from our arithmetic from a
 * guess — so the basis is spelled out rather than reduced to a tick.
 */
function Basis({ p, label }: { p?: Provenance; label: string }): JSX.Element | null {
  if (!p) return null;
  const text =
    p.basis === 'vendor-doc'
      ? `${label}: from the manufacturer's documentation`
      : p.basis === 'derived'
        ? `${label}: calculated from published figures`
        : `${label}: no source — assumed, verify before a show`;
  return (
    <li className={p.basis === 'assumed' ? 'status--error' : undefined}>
      {text}
      {p.note ? ` — ${p.note}` : ''}
      {p.source ? (
        <>
          {' '}
          <span className="mono">({p.source})</span>
        </>
      ) : null}
    </li>
  );
}

function ProfileSummary({
  profile,
  variant,
  mode,
}: {
  profile: NonNullable<ProfileCatalog['profiles'][number]>;
  variant?: NonNullable<ProfileCatalog['profiles'][number]['bandVariants']>[number];
  mode?: NonNullable<ProfileCatalog['profiles'][number]['modes']>[number];
}): JSX.Element {
  const control =
    profile.protocol === 'shure-command-strings'
      ? 'Programmable over the network.'
      : profile.protocol === 'sennheiser-ssc'
        ? 'Monitored over SSC.'
        : 'File export only.';
  return (
    <div className="field--wide export-note">
      <p>
        <strong>
          {profile.manufacturer} {profile.model}
          {variant ? ` · ${variant.code}` : ''}
          {mode ? ` · ${mode.name}` : ''}
        </strong>{' '}
        — needs <strong>{mode ? `${mode.minSpacingKhz} kHz` : `${profile.recommendedSpacingMhz * 1000} kHz`}</strong>{' '}
        between carriers
        {mode?.occupiedBandwidthKhz
          ? `, occupying about ${mode.occupiedBandwidthKhz} kHz each`
          : ''}
        , tuning in {variant?.tuningStepKhz ?? profile.tuningStepKhz} kHz steps.{' '}
        {mode?.strategy === 'equidistant'
          ? 'This equipment expects an equidistant grid rather than a searched IM-free set.'
          : ''}{' '}
        {control}
      </p>
      {variant && variant.ranges.length > 1 && (
        <p>
          {variant.code} is <strong>not continuous</strong> — it tunes{' '}
          {formatRanges(variant.ranges)} MHz. Nothing will be placed in the gaps.
        </p>
      )}
      {variant?.notes && <p>{variant.notes}</p>}
      {mode?.notes && <p>{mode.notes}</p>}
      <ul>
        <Basis p={mode?.spacing} label="Spacing" />
        <Basis p={mode?.bandwidth} label="Occupied bandwidth" />
        <Basis p={variant?.provenance} label={`${variant?.code ?? 'Band'} range`} />
      </ul>
      {!profile.modes?.length && (
        <p className="status--error">
          No researched data for this product yet — the spacing and bandwidth shown are
          placeholders. Verify against the datasheet.
        </p>
      )}
    </div>
  );
}

export function CoordinationTab(): JSX.Element {
  const d = defaultCoordinationParams();
  const [rangesText, setRangesText] = useState('606.5-614');
  const [exclusionsText, setExclusionsText] = useState('');
  const [lockedText, setLockedText] = useState('');
  const [count, setCount] = useState(8);
  const [spacing, setSpacing] = useState(d.minSpacingMhz);
  const [step, setStep] = useState(d.stepMhz);
  const [imGuard, setImGuard] = useState(d.imGuardMhz);
  const [exGuard, setExGuard] = useState(d.exclusionGuardMhz);
  const [thirdOrder, setThirdOrder] = useState(true);
  const [fifthOrder, setFifthOrder] = useState(false);

  const [result, setResult] = useState<CoordinationResult | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormat>('wwb-frequency-list');
  const [exportOptions, setExportOptions] = useState<ExportOptions>({});

  const [catalog, setCatalog] = useState<ProfileCatalog | null>(null);
  const [bandId, setBandId] = useState('');
  const [profileId, setProfileId] = useState('');
  const [variantCode, setVariantCode] = useState('');
  const [modeId, setModeId] = useState('');

  useEffect(() => {
    getProfiles().then(setCatalog).catch(() => setCatalog(null));
  }, []);

  const profile = catalog?.profiles.find((p) => p.id === profileId);
  const variant = profile?.bandVariants?.find((v) => v.code === variantCode);
  const mode = profile?.modes?.find((m) => m.id === modeId) ?? profile?.modes?.[0];

  const applyBand = (id: string): void => {
    setBandId(id);
    const preset = catalog?.bandPresets.find((b) => b.id === id);
    if (preset) setRangesText(formatRanges(preset.ranges));
  };

  /** Push a mode's real spacing (and the product's raster) into the form. */
  const applyMode = (p: typeof profile, m: typeof mode): void => {
    if (!p) return;
    if (m) setSpacing(m.minSpacingKhz / 1000);
    setStep(p.tuningStepKhz / 1000);
  };

  const applyProfile = (id: string): void => {
    setProfileId(id);
    setVariantCode('');
    const p = catalog?.profiles.find((x) => x.id === id);
    if (!p) {
      setModeId('');
      return;
    }
    const first = p.modes?.[0];
    setModeId(first?.id ?? '');
    applyMode(p, first);
    if (p.defaultBandPresetId) applyBand(p.defaultBandPresetId);
  };

  /**
   * Selecting a band variant replaces the free-text ranges with the radio's
   * real tunable spectrum — including its gaps, which is why this writes a
   * comma-separated list rather than one span.
   */
  const applyVariant = (code: string): void => {
    setVariantCode(code);
    const v = profile?.bandVariants?.find((x) => x.code === code);
    if (!v) return;
    setRangesText(formatRanges(v.ranges));
    setBandId('');
    if (v.tuningStepKhz) setStep(v.tuningStepKhz / 1000);
  };

  const buildParams = (): CoordinationParams => ({
    ranges: parseRanges(rangesText),
    stepMhz: step,
    minSpacingMhz: spacing,
    exclusionGuardMhz: exGuard,
    imGuardMhz: imGuard,
    thirdOrder,
    fifthOrder,
    exclusions: parseRanges(exclusionsText),
    locked: parseFreqList(lockedText),
    seed: 1,
  });

  /**
   * One radio per requested channel, carrying the selected product's real
   * numbers. Returns null when no equipment is selected, in which case the
   * older count-based call is used and the form's own spacing/step apply.
   */
  const buildRadios = (): CoordinationRadio[] | null => {
    if (!profile || !mode) return null;
    return Array.from({ length: count }, (_, i) => ({
      name: `${profile.model} ${i + 1}`,
      tuningRanges: variant?.ranges,
      tuningStepKhz: variant?.tuningStepKhz ?? profile.tuningStepKhz,
      minSpacingMhz: mode.minSpacingKhz / 1000,
      occupiedBandwidthKhz: mode.occupiedBandwidthKhz,
      strategy: mode.strategy,
      productId: profile.id,
      bandCode: variant?.code,
      modeId: mode.id,
    }));
  };

  const run = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setAnalysis(null);
    try {
      const radios = buildRadios();
      const res = radios
        ? await coordinateRadioSet(radios, buildParams())
        : await coordinateFrequencies(count, buildParams());
      setResult(res);
      usePlanStore.getState().setCoordination(res); // share with Allocation/Deployment
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setResult(null);
    } finally {
      setBusy(false);
    }
  };

  const runAnalyze = async (): Promise<void> => {
    if (!result) return;
    setBusy(true);
    setError(null);
    try {
      const a = await analyzeFrequencies(
        result.assigned.map((x) => x.frequencyMhz),
        buildParams()
      );
      setAnalysis(a);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const doExport = async (): Promise<void> => {
    if (!result) return;
    try {
      const list = {
        channels: result.assigned.map((a) => ({ name: a.name, frequencyMhz: a.frequencyMhz })),
        sourceFormat: 'coordination',
      };
      const info = EXPORT_FORMATS.find((f) => f.id === exportFormat)!;
      const blob = await exportModel(list, exportFormat, exportOptions);
      download(await blob.text(), `coordination.${info.extension}`, info.mimeType);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="tab-panel">
      <p className="tab-panel__intro">
        Compute a set of mutually-compatible frequencies — spaced, clear of excluded spectrum, and
        free of third/fifth-order intermodulation products.
      </p>

      <div className="coord-form">
        <label className="field">
          Equipment profile
          <select value={profileId} onChange={(e) => applyProfile(e.target.value)}>
            <option value="">— pick gear (prefills spacing/step) —</option>
            {catalog?.profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.manufacturer} {p.model}
              </option>
            ))}
          </select>
        </label>
        {profile?.bandVariants?.length ? (
          <label className="field">
            Frequency band (as printed on the unit)
            <select value={variantCode} onChange={(e) => applyVariant(e.target.value)}>
              <option value="">— pick the variant you own —</option>
              {profile.bandVariants.map((v) => (
                <option key={v.code} value={v.code}>
                  {v.code} · {formatRanges(v.ranges)} MHz
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {profile?.modes && profile.modes.length > 1 ? (
          <label className="field">
            Mode
            <select
              value={mode?.id ?? ''}
              onChange={(e) => {
                setModeId(e.target.value);
                applyMode(profile, profile.modes?.find((m) => m.id === e.target.value));
              }}
            >
              {profile.modes.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} · {m.minSpacingKhz} kHz spacing
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="field">
          Band preset (licence)
          <select value={bandId} onChange={(e) => applyBand(e.target.value)}>
            <option value="">— pick a band (prefills ranges) —</option>
            {catalog?.bandPresets.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name} · {b.region}
              </option>
            ))}
          </select>
        </label>
        {profile && <ProfileSummary profile={profile} variant={variant} mode={mode} />}
        <label className="field field--wide">
          <span>
            Tuning ranges — MHz, e.g. <code>606.5-614, 470-478</code>
          </span>
          <input value={rangesText} onChange={(e) => setRangesText(e.target.value)} />
        </label>
        <label className="field">
          How many
          <input type="number" min={1} value={count} onChange={(e) => setCount(Number(e.target.value))} />
        </label>
        <label className="field">
          Min spacing (MHz)
          <input type="number" step="0.025" value={spacing} onChange={(e) => setSpacing(Number(e.target.value))} />
        </label>
        <label className="field">
          Grid step (MHz)
          <input type="number" step="0.005" value={step} onChange={(e) => setStep(Number(e.target.value))} />
        </label>
        <label className="field">
          IM guard (MHz)
          <input type="number" step="0.005" value={imGuard} onChange={(e) => setImGuard(Number(e.target.value))} />
        </label>
        <label className="field">
          Exclusion guard (MHz)
          <input type="number" step="0.005" value={exGuard} onChange={(e) => setExGuard(Number(e.target.value))} />
        </label>
        <label className="field field--wide">
          <span>
            Exclusions — MHz ranges, e.g. <code>500-510, 520.5-521</code>
          </span>
          <input value={exclusionsText} onChange={(e) => setExclusionsText(e.target.value)} />
        </label>
        <label className="field field--wide">
          Locked / existing (MHz, comma-separated)
          <input value={lockedText} onChange={(e) => setLockedText(e.target.value)} />
        </label>
        <label className="field field--check">
          <input type="checkbox" checked={thirdOrder} onChange={(e) => setThirdOrder(e.target.checked)} />
          Avoid 3rd-order IM
        </label>
        <label className="field field--check">
          <input type="checkbox" checked={fifthOrder} onChange={(e) => setFifthOrder(e.target.checked)} />
          Avoid 5th-order IM
        </label>
      </div>

      <div className="export-bar">
        <button className="btn btn--primary" onClick={run} disabled={busy}>
          {busy ? 'Coordinating…' : 'Coordinate'}
        </button>
        {result && (
          <button className="btn" onClick={runAnalyze} disabled={busy}>
            Re-check conflicts
          </button>
        )}
      </div>
      {error && <p className="status status--error">{error}</p>}

      {result && (
        <>
          <p className="status">
            Placed <strong>{result.placed}</strong> of {result.requested} requested
            {result.unplaced > 0 && <span className="status--error"> ({result.unplaced} unplaced)</span>} ·{' '}
            {result.candidateCount} candidate grid points.
          </p>
          {result.notes.map((n, i) => (
            <p className="export-note" key={i}>
              {n}
            </p>
          ))}

          <div className="export-bar">
            <label>
              Export as
              <select value={exportFormat} onChange={(e) => setExportFormat(e.target.value as ExportFormat)}>
                {EXPORT_FORMATS.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                    {f.experimental ? ' — experimental' : ''}
                  </option>
                ))}
              </select>
            </label>
            <ExportOptionsFields format={exportFormat} options={exportOptions} onChange={setExportOptions} />
            <button className="btn" onClick={doExport}>
              Download
            </button>
          </div>

          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Name</th>
                  <th>Frequency (MHz)</th>
                  <th>Band</th>
                  <th>Spacing needed (MHz)</th>
                  <th>Type</th>
                </tr>
              </thead>
              <tbody>
                {result.assigned.map((a, i) => (
                  <tr key={i}>
                    <td>{i + 1}</td>
                    <td>{a.name}</td>
                    <td className="mono">{a.frequencyMhz.toFixed(3)}</td>
                    <td>{a.bandCode ?? '—'}</td>
                    <td className="mono">
                      {a.requiredSpacingMhz !== undefined ? a.requiredSpacingMhz.toFixed(3) : '—'}
                    </td>
                    <td>{a.locked ? 'locked' : 'coordinated'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {analysis && (
            <div className={`callout ${analysis.ok ? '' : 'callout--warn'}`}>
              {analysis.ok ? (
                <strong>✓ No conflicts — {analysis.frequencyCount} frequencies are compatible.</strong>
              ) : (
                <>
                  <strong>{analysis.conflicts.length} conflict(s):</strong>
                  <ul>
                    {analysis.conflicts.slice(0, 40).map((c, i) => (
                      <li key={i}>
                        <code>{c.kind}</code> — {c.message}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
