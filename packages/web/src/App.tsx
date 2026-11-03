import { useState } from 'react';
import { ConvertTab } from './tabs/ConvertTab.js';
import { MonitorTab } from './tabs/MonitorTab.js';
import { InventoryTab } from './tabs/InventoryTab.js';
import { CoordinationTab } from './tabs/CoordinationTab.js';
import { AllocationTab } from './tabs/AllocationTab.js';
import { DeploymentTab } from './tabs/DeploymentTab.js';
import { staticBuild } from './buildMode.js';
import { DiagnosticsPanel } from './components/DiagnosticsPanel.js';
import type { JSX } from 'react';

type TabId = 'convert' | 'monitor' | 'inventory' | 'coordination' | 'allocation' | 'deployment';

interface TabDef {
  id: TabId;
  label: string;
  planned?: boolean;
  /** Needs the local server: LAN discovery, live audio, or TCP programming. */
  needsServer?: boolean;
}

const TABS: TabDef[] = [
  { id: 'convert', label: 'Convert' },
  { id: 'monitor', label: 'Monitor', needsServer: true },
  { id: 'inventory', label: 'Inventory' },
  { id: 'coordination', label: 'Coordination' },
  { id: 'allocation', label: 'Allocation' },
  { id: 'deployment', label: 'Deployment', needsServer: true },
];

const VISIBLE_TABS = staticBuild ? TABS.filter((t) => !t.needsServer) : TABS;

export function App(): JSX.Element {
  const [tab, setTab] = useState<TabId>('convert');

  return (
    <div className="app">
      <header className="app__header">
        <div className="app__brand">
          <h1>RFutils</h1>
          <span className="app__tagline">RF coordination &amp; wireless-mic suite</span>
          {/* Opens the shared About dialog — see public/about.js, which delegates
              this attribute from the document, so nothing needs importing here. */}
          <button type="button" className="app__about" data-stoatworks-about>
            About
          </button>
        </div>
        <nav className="tabs" role="tablist">
          {VISIBLE_TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={`tabs__tab${tab === t.id ? ' tabs__tab--active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
              {t.planned && <span className="tabs__soon">soon</span>}
            </button>
          ))}
        </nav>
      </header>

      {staticBuild && (
        <p className="app__notice">
          This is the hosted build: everything runs in your browser and no file is uploaded
          anywhere. Live monitoring, device discovery and programming receivers need the
          RFutils server on your own network —{' '}
          <a href="https://github.com/stoatworks-labs/RFutils">download RFutils</a> for those.
        </p>
      )}

      <main>
        {tab === 'convert' && <ConvertTab />}
        {tab === 'monitor' && !staticBuild && <MonitorTab />}
        {tab === 'inventory' && <InventoryTab />}
        {tab === 'coordination' && <CoordinationTab />}
        {tab === 'allocation' && <AllocationTab />}
        {tab === 'deployment' && !staticBuild && <DeploymentTab />}
      </main>

      {/* Needs the server, which writes the bundle; the hosted build has none. */}
      {!staticBuild && <DiagnosticsPanel />}

      <footer className="app__footer">
        AI-assisted build · combines wsm-wwb-bridge, pmse-to-wwb and MicWizard · verify
        experimental exports before a live show.
        {/* Hosted build only: a local copy has no business pointing at the web tool. */}
        {staticBuild && (
          <>
            {' · '}
            <a href="https://stoatworks-labs.com/web-tools/rfutils/" target="_blank" rel="noopener">
              About this tool
            </a>
          </>
        )}
      </footer>
    </div>
  );
}
