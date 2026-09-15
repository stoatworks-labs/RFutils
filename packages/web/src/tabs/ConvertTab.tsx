import { useState } from 'react';
import type {
  ChannelField,
  ExportFormat,
  ExportFormatInfo,
  FieldMapping,
  PmseConversion,
} from '@rfutils/shared';
import { EXPORT_FORMATS } from '@rfutils/shared';
import {
  convertFile,
  convertPmsePdf,
  exportModel,
  isPdfFile,
  type ConvertResponse,
} from '../api.js';
import { FileDrop } from '../components/FileDrop.js';
import { PmseResult } from './PmseResult.js';
import type { JSX } from 'react';

const FORMAT_LABELS: Record<string, string> = {
  'wwb-xml': 'Shure WWB (.shw / .cws)',
  'wsm-xml': 'Sennheiser WSM project (.wsm)',
  'wsm-html': 'WSM Coordination Report (HTML)',
  wsm: 'WSM Frequencies/Bands (CSV)',
  'wwb-report': 'WWB Coordination Report (CSV)',
  'wwb-frequency-list': 'WWB frequency list',
  'pmse-pdf': 'Ofcom PMSE licence (PDF)',
  generic: 'Generic CSV (needs column mapping)',
};

const MAPPING_FIELDS: ChannelField[] = [
  'name',
  'frequencyMhz',
  'group',
  'channel',
  'deviceType',
  'manufacturer',
  'notes',
  'zone',
];

const ACCEPT = [
  '.shw',
  '.cws',
  '.wsm',
  '.csv',
  '.html',
  '.htm',
  '.txt',
  '.pdf',
  'text/csv',
  'text/html',
  'text/plain',
  'application/xml',
  'application/pdf',
].join(',');

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** What the last drop parsed into; the tab shows the panel for its kind. */
type Loaded =
  | { kind: 'coordination'; file: File; result: ConvertResponse; mapping: FieldMapping }
  | { kind: 'pmse'; result: PmseConversion };

function describe(loaded: Loaded): string {
  if (loaded.kind === 'pmse') {
    const n = loaded.result.assignmentCount;
    return `Detected ${FORMAT_LABELS['pmse-pdf']} — ${n} frequency assignment(s).`;
  }
  const { format, channelCount } = loaded.result;
  return `Detected ${FORMAT_LABELS[format] ?? format} — ${channelCount} channel(s).`;
}

/**
 * One drop zone for everything. The file's own bytes decide whether it goes
 * to the Ofcom PMSE licence parser or the coordination-file detector, so the
 * user never has to say which kind of file it is.
 */
export function ConvertTab(): JSX.Element {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * Run one parse, reporting into the shared status/error lines. A failed
   * first read clears the panel; a failed re-read (a column mapping the
   * parser rejects) keeps the last good result so the mapping dialog stays.
   */
  const run = async (
    label: string,
    work: () => Promise<Loaded>,
    { keepOnError = false } = {}
  ): Promise<void> => {
    setBusy(true);
    setError(null);
    setStatus(label);
    try {
      const next = await work();
      setLoaded(next);
      setStatus(describe(next));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      if (!keepOnError) setLoaded(null);
      setStatus('');
    } finally {
      setBusy(false);
    }
  };

  const readCoordination = async (file: File, mapping?: FieldMapping): Promise<Loaded> => {
    const result = await convertFile(file, mapping);
    return {
      kind: 'coordination',
      file,
      result,
      mapping: mapping ?? result.suggestedMapping ?? {},
    };
  };

  const onPick = (file: File | undefined): void => {
    if (!file) return;
    void run(`Reading ${file.name}…`, async () => {
      if (await isPdfFile(file)) return { kind: 'pmse', result: await convertPmsePdf(file) };
      return readCoordination(file);
    });
  };

  const onRemap = (field: ChannelField, colIndex: number | null): void => {
    if (loaded?.kind !== 'coordination') return;
    const mapping = { ...loaded.mapping, [field]: colIndex };
    void run(
      `Re-reading ${loaded.file.name}…`,
      () => readCoordination(loaded.file, mapping),
      { keepOnError: true }
    );
  };

  return (
    <div className="tab-panel">
      <FileDrop
        accept={ACCEPT}
        label="Drop a WWB / WSM export, a CSV or an Ofcom PMSE licence PDF here, or click to choose"
        hint="Shure .shw / .cws · Sennheiser .wsm · WSM coordination report (HTML) · WSM or WWB CSV · bare frequency list · any other CSV, with column mapping · Ofcom PMSE licence schedule PDF — the format is detected from the file itself"
        onPick={onPick}
      />
      {status && <p className="status">{status}</p>}
      {error && <p className="status status--error">{error}</p>}

      {loaded?.kind === 'coordination' && (
        <CoordinationResult loaded={loaded} busy={busy} onRemap={onRemap} onError={setError} />
      )}
      {loaded?.kind === 'pmse' && <PmseResult result={loaded.result} onDownload={download} />}
    </div>
  );
}

/** A parsed coordination file: the column-map dialog (generic CSV only), the export bar and the channel table. */
function CoordinationResult({
  loaded,
  busy,
  onRemap,
  onError,
}: {
  loaded: Extract<Loaded, { kind: 'coordination' }>;
  busy: boolean;
  onRemap: (field: ChannelField, colIndex: number | null) => void;
  onError: (message: string) => void;
}): JSX.Element {
  const { result, mapping } = loaded;
  const [exportFormat, setExportFormat] = useState<ExportFormat>('wwb-frequency-list');

  const doExport = async (): Promise<void> => {
    try {
      const info = EXPORT_FORMATS.find((x) => x.id === exportFormat)!;
      const blob = await exportModel(result.list, exportFormat);
      download(blob, `rfutils-export.${info.extension}`);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  const selectedInfo: ExportFormatInfo | undefined = EXPORT_FORMATS.find((x) => x.id === exportFormat);

  return (
    <>
      {result.format === 'generic' && result.header && (
        <div className="mapping">
          <h3>Map columns</h3>
          <p className="mapping__hint">
            This file wasn't a recognised vendor format, so tell RFutils which column is which.
          </p>
          <div className="mapping__grid">
            {MAPPING_FIELDS.map((field) => (
              <label key={field} className="mapping__field">
                {field}
                <select
                  value={mapping[field] ?? ''}
                  onChange={(e) =>
                    onRemap(field, e.target.value === '' ? null : Number(e.target.value))
                  }
                >
                  <option value="">—</option>
                  {result.header!.map((h, i) => (
                    <option key={i} value={i}>
                      {h || `column ${i + 1}`}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        </div>
      )}

      {result.channelCount > 0 && (
        <>
          <div className="export-bar">
            <label>
              Export as
              <select
                value={exportFormat}
                onChange={(e) => setExportFormat(e.target.value as ExportFormat)}
              >
                {EXPORT_FORMATS.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                    {f.experimental ? ' — experimental' : ''}
                  </option>
                ))}
              </select>
            </label>
            <button className="btn btn--primary" onClick={doExport} disabled={busy}>
              Download
            </button>
          </div>
          {selectedInfo?.note && (
            <p className={`export-note${selectedInfo.experimental ? ' export-note--warn' : ''}`}>
              {selectedInfo.experimental ? '⚠ ' : ''}
              {selectedInfo.note}
            </p>
          )}
          <ChannelTable list={result.list} />
        </>
      )}
    </>
  );
}

function ChannelTable({ list }: { list: ConvertResponse['list'] }): JSX.Element {
  const rows = list.channels.slice(0, 200);
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Freq (MHz)</th>
            <th>Zone</th>
            <th>Group</th>
            <th>Ch</th>
            <th>Type</th>
            <th>Manufacturer</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c, i) => (
            <tr key={i}>
              <td>{c.name}</td>
              <td className="mono">{c.frequencyMhz.toFixed(3)}</td>
              <td>{c.zone ?? ''}</td>
              <td>{c.group ?? ''}</td>
              <td>{c.channel ?? ''}</td>
              <td>{c.deviceType ?? ''}</td>
              <td>{c.manufacturer ?? ''}</td>
              <td>{c.notes ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {list.channels.length > rows.length && (
        <p className="table-more">…and {list.channels.length - rows.length} more</p>
      )}
    </div>
  );
}
