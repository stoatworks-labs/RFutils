/** The choices an export format takes beyond "Export as", shown beside it in an export bar. */
import type { JSX } from 'react';
import type { ExportFormat, ExportOptions, WsmPriority } from '@rfutils/shared';
import { WSM_PRIORITIES } from '@rfutils/shared';

export function ExportOptionsFields({
  format,
  options,
  onChange,
}: {
  format: ExportFormat;
  options: ExportOptions;
  onChange: (options: ExportOptions) => void;
}): JSX.Element | null {
  if (format !== 'wsm-csv') return null;
  return (
    <label>
      Priority in WSM
      <select
        className="export-bar__narrow"
        value={options.wsmPriority ?? 'medium'}
        onChange={(e) => onChange({ ...options, wsmPriority: e.target.value as WsmPriority })}
      >
        {WSM_PRIORITIES.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
    </label>
  );
}
