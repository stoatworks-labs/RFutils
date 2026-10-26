import { useEffect, useState } from 'react';
import type { InventoryItem, InventoryRole, EquipmentProfile, RfRange } from '@rfutils/shared';
import { channelsNeeded, findVariant } from '@rfutils/shared';
import { usePlanStore } from '../planStore.js';
import { getProfiles } from '../api.js';
import type { JSX } from 'react';

const ROLES: InventoryRole[] = ['mic', 'iem', 'other'];

function formatRanges(ranges: RfRange[]): string {
  return ranges.map((r) => `${r.startMhz}-${r.endMhz}`).join(', ');
}

export function InventoryTab(): JSX.Element {
  const items = usePlanStore((s) => s.items);
  const loaded = usePlanStore((s) => s.loaded);
  const saving = usePlanStore((s) => s.saving);
  const load = usePlanStore((s) => s.load);
  const addItem = usePlanStore((s) => s.addItem);
  const updateItem = usePlanStore((s) => s.updateItem);
  const removeItem = usePlanStore((s) => s.removeItem);
  const importFromLive = usePlanStore((s) => s.importFromLive);

  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<EquipmentProfile[]>([]);

  useEffect(() => {
    getProfiles()
      .then((c) => setProfiles(c.profiles))
      .catch(() => setProfiles([]));
  }, []);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  const needed = channelsNeeded({ items });

  const doImport = async (): Promise<void> => {
    try {
      const n = await importFromLive();
      setImportMsg(n > 0 ? `Imported ${n} channel(s) from live devices.` : 'No new live channels found.');
    } catch (e) {
      setImportMsg(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <div className="tab-panel">
      <div className="tab-panel__intro">
        <p>
          Your wireless equipment — built by hand or imported from live devices. It drives how many
          frequencies coordination places and how they're allocated.
        </p>
        <span className="conn-pill conn-pill--ok">{saving ? 'saving…' : 'saved'}</span>
      </div>

      <div className="export-bar">
        <button className="btn btn--primary" onClick={() => addItem()}>
          + Add item
        </button>
        <button className="btn" onClick={doImport}>
          Import from live devices
        </button>
        <span className="status">
          <strong>{needed}</strong> channel(s) to coordinate · {items.length} item(s)
        </span>
      </div>
      {importMsg && <p className="export-note">{importMsg}</p>}

      {items.length === 0 ? (
        <p className="device-list__empty">
          No equipment yet. Add items, or import what's currently on the network.
        </p>
      ) : (
        <div className="table-wrap">
          <table className="data-table inventory-table">
            <thead>
              <tr>
                <th>Label / talent</th>
                <th>Profile</th>
                <th>Vendor</th>
                <th>Model</th>
                <th>Band</th>
                <th>Role</th>
                <th>Qty</th>
                <th>Coord.</th>
                <th>Source</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <InventoryRow
                  key={item.id}
                  item={item}
                  profiles={profiles}
                  onChange={(patch) => updateItem(item.id, patch)}
                  onRemove={() => removeItem(item.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function InventoryRow({
  item,
  profiles,
  onChange,
  onRemove,
}: {
  item: InventoryItem;
  profiles: EquipmentProfile[];
  onChange: (patch: Partial<InventoryItem>) => void;
  onRemove: () => void;
}): JSX.Element {
  const pickProfile = (id: string): void => {
    const p = profiles.find((x) => x.id === id);
    if (!p) {
      onChange({ profileId: undefined });
      return;
    }
    const patch: Partial<InventoryItem> = {
      profileId: p.id,
      vendor: p.manufacturer,
      model: p.model,
      role: p.category === 'iem' ? 'iem' : p.category === 'mic' ? 'mic' : 'other',
    };
    // Keep a band that is one of the new model's, else make the user pick.
    if (p.bandVariants?.length) patch.band = findVariant(p.bandVariants, item.band)?.code ?? '';
    onChange(patch);
  };
  const variants = profiles.find((p) => p.id === item.profileId)?.bandVariants ?? [];
  // Coordination matches band codes ignoring case, so show "g56" as G56 too.
  const picked = findVariant(variants, item.band);
  const bandCell = variants.length > 0 ? (
    <select
      className="cell cell--sm"
      value={picked?.code ?? item.band}
      onChange={(e) => onChange({ band: e.target.value })}
      title="Bands this model is sold in — pick the one you own"
    >
      <option value="">— pick the band you own —</option>
      {item.band && !picked && (
        <option value={item.band}>{item.band} (as entered)</option>
      )}
      {variants.map((v) => (
        <option key={v.code} value={v.code}>
          {v.code} · {formatRanges(v.ranges)} MHz
        </option>
      ))}
    </select>
  ) : (
    <input className="cell cell--sm" value={item.band} onChange={(e) => onChange({ band: e.target.value })} />
  );
  return (
    <tr>
      <td>
        <input className="cell" value={item.label} onChange={(e) => onChange({ label: e.target.value })} />
      </td>
      <td>
        <select className="cell cell--sm" value={item.profileId ?? ''} onChange={(e) => pickProfile(e.target.value)}>
          <option value="">— custom —</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.manufacturer} {p.model}
            </option>
          ))}
        </select>
      </td>
      <td>
        <input className="cell cell--sm" value={item.vendor} onChange={(e) => onChange({ vendor: e.target.value })} />
      </td>
      <td>
        <input className="cell cell--sm" value={item.model} onChange={(e) => onChange({ model: e.target.value })} />
      </td>
      <td>{bandCell}</td>
      <td>
        <select className="cell cell--sm" value={item.role} onChange={(e) => onChange({ role: e.target.value as InventoryRole })}>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </td>
      <td>
        <input
          className="cell cell--xs"
          type="number"
          min={0}
          value={item.quantity}
          onChange={(e) => onChange({ quantity: Number(e.target.value) })}
        />
      </td>
      <td style={{ textAlign: 'center' }}>
        <input type="checkbox" checked={item.coordinate} onChange={(e) => onChange({ coordinate: e.target.checked })} />
      </td>
      <td>
        <span className={`tag tag--${item.source}`}>{item.source}</span>
      </td>
      <td>
        <button className="cue-btn" title="Remove" onClick={onRemove}>
          ✕
        </button>
      </td>
    </tr>
  );
}
