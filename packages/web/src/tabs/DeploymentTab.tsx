import { useEffect, useState } from 'react';
import type { DiscoveredDevice, ExportFormat, ExportOptions } from '@rfutils/shared';
import { EXPORT_FORMATS } from '@rfutils/shared';
import { usePlanStore } from '../planStore.js';
import { getDevices, programFrequencies, exportModel, type ProgramTargetResult } from '../api.js';
import { ExportOptionsFields } from '../components/ExportOptionsFields.js';
import type { JSX } from 'react';

function download(text: string, filename: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

interface ChannelOption {
  id: string;
  label: string;
  programmable: boolean;
}

function channelOptions(devices: DiscoveredDevice[]): ChannelOption[] {
  const out: ChannelOption[] = [];
  for (const d of devices) {
    for (const ch of d.channels) {
      out.push({
        id: ch.id,
        label: `${d.name} · ${ch.name}`,
        programmable: ch.id.startsWith('shure:') || ch.id.startsWith('lectrosonics:'),
      });
    }
  }
  return out;
}

/**
 * Deployment: bind allocated frequencies to live device channels and program
 * them (Shure command strings, dry-run first), or export files for anything
 * else / offline programming.
 */
export function DeploymentTab(): JSX.Element {
  const allocations = usePlanStore((s) => s.allocations);
  const setAllocations = usePlanStore((s) => s.setAllocations);

  const [devices, setDevices] = useState<DiscoveredDevice[]>([]);
  const [results, setResults] = useState<ProgramTargetResult[] | null>(null);
  const [wasDryRun, setWasDryRun] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormat>('wwb-frequency-list');
  const [exportOptions, setExportOptions] = useState<ExportOptions>({});

  const refreshDevices = (): void => {
    getDevices()
      .then(setDevices)
      .catch(() => setDevices([]));
  };
  useEffect(refreshDevices, []);

  const options = channelOptions(devices);

  const bind = (idx: number, deviceChannelId: string): void => {
    setAllocations(
      allocations.map((a, i) => (i === idx ? { ...a, deviceChannelId: deviceChannelId || undefined } : a))
    );
  };

  const boundTargets = allocations
    .filter((a) => a.deviceChannelId)
    .map((a) => ({ channelId: a.deviceChannelId!, frequencyMhz: a.frequencyMhz }));

  const program = async (dryRun: boolean): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      if (boundTargets.length === 0) {
        setError('Bind at least one allocation to a device channel first.');
        return;
      }
      const res = await programFrequencies(boundTargets, dryRun);
      setResults(res.results);
      setWasDryRun(res.dryRun);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const doExport = async (): Promise<void> => {
    try {
      const list = {
        channels: allocations.map((a) => ({ name: a.name, frequencyMhz: a.frequencyMhz })),
        sourceFormat: 'deployment',
      };
      const info = EXPORT_FORMATS.find((f) => f.id === exportFormat)!;
      const blob = await exportModel(list, exportFormat, exportOptions);
      download(await blob.text(), `deployment.${info.extension}`, info.mimeType);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="tab-panel">
      <p className="tab-panel__intro">
        Program allocated frequencies into live receivers, or export files for offline programming.
      </p>

      {allocations.length === 0 ? (
        <p className="device-list__empty">
          Nothing to deploy yet — create allocations on the Allocation tab first.
        </p>
      ) : (
        <>
          <div className="export-bar">
            <label>
              Export files as
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
            <button className="btn" onClick={refreshDevices}>
              Refresh devices
            </button>
          </div>

          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Name</th>
                  <th>Frequency (MHz)</th>
                  <th>Program to device channel</th>
                </tr>
              </thead>
              <tbody>
                {allocations.map((a, i) => (
                  <tr key={i}>
                    <td>{i + 1}</td>
                    <td>{a.name}</td>
                    <td className="mono">{a.frequencyMhz.toFixed(3)}</td>
                    <td>
                      <select
                        className="cell"
                        value={a.deviceChannelId ?? ''}
                        onChange={(e) => bind(i, e.target.value)}
                      >
                        <option value="">— not programmed —</option>
                        {options.map((o) => (
                          <option key={o.id} value={o.id} disabled={!o.programmable}>
                            {o.label}
                            {o.programmable ? '' : ' (export only)'}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="export-bar">
            <button className="btn" onClick={() => program(true)} disabled={busy}>
              Dry-run ({boundTargets.length})
            </button>
            <button className="btn btn--warn" onClick={() => program(false)} disabled={busy}>
              Program devices
            </button>
          </div>
          <p className="export-note export-note--warn">
            ⚠ Live Shure programming is experimental and untested against hardware — dry-run shows the
            exact command strings; verify against your receiver's Command Strings PDF before sending.
          </p>
          {error && <p className="status status--error">{error}</p>}

          {results && (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Channel</th>
                    <th>Address</th>
                    <th>Command</th>
                    <th>{wasDryRun ? 'Dry run' : 'Result'}</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((r, i) => (
                    <tr key={i}>
                      <td className="mono">{r.channelId}</td>
                      <td className="mono">{r.address || '—'}</td>
                      <td className="mono">{r.command || '—'}</td>
                      <td>
                        {r.error ? (
                          <span className="status--error">{r.error}</span>
                        ) : wasDryRun ? (
                          'would send'
                        ) : r.ok ? (
                          `sent${r.reply ? ` · ${r.reply.slice(0, 40)}` : ''}`
                        ) : (
                          'failed'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
