import type { PmseConversion } from '@rfutils/shared';
import type { JSX } from 'react';

/**
 * A parsed Ofcom PMSE licence: metadata, the three WWB downloads and the
 * assignment table. The Convert tab does the picking and parsing — this only
 * renders what came back.
 */
export function PmseResult({
  result,
  onDownload,
}: {
  result: PmseConversion;
  onDownload: (blob: Blob, filename: string) => void;
}): JSX.Element {
  return (
    <>
      {result.warnings.map((w, i) => (
        <p className="callout callout--warn" key={i}>
          {w}
        </p>
      ))}

      <dl className="meta">
        <dt>Licence No.</dt>
        <dd>{result.metadata.licenceNo || '—'}</dd>
        <dt>Licensee</dt>
        <dd>{result.metadata.licensee || '—'}</dd>
        <dt>Address</dt>
        <dd>{result.metadata.licenseeAddress || '—'}</dd>
        <dt>Period</dt>
        <dd>
          {result.metadata.licenceStart || '?'} – {result.metadata.licenceEnd || '?'}
        </dd>
        <dt>PMSE ref.</dt>
        <dd>{result.metadata.pmseRef || '—'}</dd>
      </dl>

      <div className="downloads">
        <button
          className="btn"
          onClick={() =>
            onDownload(
              new Blob([result.wwbFrequencyList], { type: 'text/plain' }),
              'wwb-frequency-list.txt'
            )
          }
        >
          WWB frequency list (.txt)
        </button>
        <button
          className="btn"
          onClick={() =>
            onDownload(
              new Blob([result.referenceCsv], { type: 'text/csv' }),
              'frequency-reference.csv'
            )
          }
        >
          Reference sheet (.csv)
        </button>
        <button
          className="btn btn--warn"
          onClick={() =>
            onDownload(
              new Blob([result.wwbShowFile], { type: 'application/xml' }),
              'wwb-import.shw'
            )
          }
        >
          WWB7 show file (.shw) — experimental
        </button>
      </div>
      <p className="export-note">
        The frequency list is the safe file to import directly into Wireless Workbench (Import ›
        frequencies from file). The reference sheet maps each frequency to a suggested name and
        its coordination group.
      </p>

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Freq (MHz)</th>
              <th>Equipment</th>
              <th>Model</th>
              <th>Group</th>
              <th>Site</th>
            </tr>
          </thead>
          <tbody>
            {result.assignments.slice(0, 200).map((a, i) => (
              <tr key={i}>
                <td className="mono">{a.frequencyMhz.toFixed(3)}</td>
                <td>{a.equipmentType}</td>
                <td>{a.model}</td>
                <td>{a.feeCategory}</td>
                <td>{a.site}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
