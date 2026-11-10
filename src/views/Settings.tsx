import { Activity, FolderOpen, Languages, Radio, ShieldCheck, Palette } from 'lucide-react';
import type { ServerState } from '../types';
import { useLanguage, languages, type Locale } from '../locales/i18n';
import { useOfficePreferences } from '../scene/OfficePreferencesContext';
import { DEFAULT_OFFICE_PREFERENCES, type ActivityRate, type OfficeTheme, type OfficeSpacing, type OfficeMotion, type PerformanceMode } from '../scene/officePreferences';
import { DEPARTMENTS } from '../agents';

export function Settings({ workspace, setWorkspace, demo, setDemo, server, online, publicPreview = false }: {
  workspace: string;
  setWorkspace: (v: string) => void;
  demo: boolean;
  setDemo: (v: boolean) => void;
  server: ServerState | null;
  online: boolean;
  publicPreview?: boolean;
}) {
  const { locale, setLocale, t: tr } = useLanguage();
  const { preferences, updatePreferences } = useOfficePreferences();
  return <>
    <div className="sub-intro">
      <span className="eyebrow"><span /> {tr('YOUR ENVIRONMENT')}</span>
      <h1>{tr('Workspace settings')}</h1>
      <p>{tr('Choose where your agents work and which data you want to see.')}</p>
    </div>
    <div className="settings-content">
      <section className="setting-card office-customization">
        <div className="setting-heading"><Palette size={22}/><div><h2>{tr('Office appearance')}</h2><p>{tr('Customize the virtual workspace. Saved only in this browser.')}</p></div></div>
        <div className="office-options">
          <div><label htmlFor="office-theme">{tr('Visual style')}</label><select id="office-theme" value={preferences.theme} onChange={e => updatePreferences({ theme: e.target.value as OfficeTheme })}>
            <option value="daylight">{tr('Bright modern')}</option><option value="midnight">{tr('Midnight')}</option><option value="warm">{tr('Warm studio')}</option>
          </select></div>
          <div><label htmlFor="office-spacing">{tr('Room spacing')}</label><select id="office-spacing" value={preferences.spacing} onChange={e => updatePreferences({ spacing: e.target.value as OfficeSpacing })}>
            <option value="compact">{tr('Compact')}</option><option value="regular">{tr('Balanced')}</option><option value="spacious">{tr('Spacious')}</option>
          </select></div>
          <div><label htmlFor="office-motion">{tr('Agent movement')}</label><select id="office-motion" value={preferences.motion} onChange={e => updatePreferences({ motion: e.target.value as OfficeMotion })}>
            <option value="off">{tr('Off')}</option><option value="subtle">{tr('Subtle')}</option><option value="lively">{tr('Lively')}</option>
          </select></div>
          <div><label htmlFor="office-accent">{tr('Office accent color')}</label><input id="office-accent" type="color" value={preferences.accent} onChange={e => updatePreferences({ accent: e.target.value })}/></div>
        </div>
        <div className="office-sector-colors" aria-label={tr('Department')}>
          {DEPARTMENTS.map(department => <label key={department.id} htmlFor={`office-sector-${department.id}`}>
            <span>{tr(department.name)}</span><input id={`office-sector-${department.id}`} type="color"
              value={preferences.sectorColors[department.id] || department.color}
              onChange={e => updatePreferences({ sectorColors: { ...preferences.sectorColors, [department.id]: e.target.value } })}/>
          </label>)}
        </div>
        <button className="office-reset" type="button" onClick={() => updatePreferences(DEFAULT_OFFICE_PREFERENCES)}>{tr('Restore office defaults')}</button>
      </section>
      <section className="setting-card office-behavior">
        <div className="setting-heading"><Activity size={22}/><div><h2>{tr('Agent behavior')}</h2><p>{tr('How agents move, rest and think in the office. Saved only in this browser.')}</p></div></div>
        <div className="office-options">
          <div><label htmlFor="office-activity-rate">{tr('Activity rate')}</label><select id="office-activity-rate" value={preferences.activityRate} onChange={e => updatePreferences({ activityRate: e.target.value as ActivityRate })}>
            <option value="low">{tr('Low')}</option><option value="normal">{tr('Normal')}</option><option value="high">{tr('High')}</option>
          </select></div>
          <div><label htmlFor="office-performance">{tr('Performance mode')}</label><select id="office-performance" value={preferences.performanceMode} onChange={e => updatePreferences({ performanceMode: e.target.value as PerformanceMode })}>
            <option value="auto">{tr('Auto')}</option><option value="balanced">{tr('Balanced')}</option><option value="quality">{tr('Quality')}</option>
          </select></div>
        </div>
        <div className="setting-row"><div><strong>{tr('Break animations')}</strong><span>{tr('Coffee, rest and whiteboard visits while idle')}</span></div>
          <button className={`switch ${preferences.breaksEnabled ? 'enabled' : ''}`} onClick={() => updatePreferences({ breaksEnabled: !preferences.breaksEnabled })} aria-pressed={preferences.breaksEnabled} aria-label={tr('Break animations')}><span /></button>
        </div>
        <div className="setting-row"><div><strong>{tr('Random movement')}</strong><span>{tr('Idle wandering between desks and break spots')}</span></div>
          <button className={`switch ${preferences.wanderEnabled ? 'enabled' : ''}`} onClick={() => updatePreferences({ wanderEnabled: !preferences.wanderEnabled })} aria-pressed={preferences.wanderEnabled} aria-label={tr('Random movement')}><span /></button>
        </div>
        <div className="setting-row"><div><strong>{tr('Ambient animation')}</strong><span>{tr('Natural light drift, thinking lightbulb, office cat')}</span></div>
          <button className={`switch ${preferences.ambientEnabled ? 'enabled' : ''}`} onClick={() => updatePreferences({ ambientEnabled: !preferences.ambientEnabled })} aria-pressed={preferences.ambientEnabled} aria-label={tr('Ambient animation')}><span /></button>
        </div>
        <div className="setting-row"><div><strong>{tr('Window thinking')}</strong><span>{tr('Let planning agents think at the window')}</span></div>
          <button className={`switch ${preferences.windowThinkingEnabled ? 'enabled' : ''}`} onClick={() => updatePreferences({ windowThinkingEnabled: !preferences.windowThinkingEnabled })} aria-pressed={preferences.windowThinkingEnabled} aria-label={tr('Window thinking')}><span /></button>
        </div>
        <p>{tr('Turning off breaks, wandering, ambient animation and window thinking only hides decoration. Real tasks keep running.')}</p>
      </section>
      <section className="setting-card">
        <div className="setting-heading"><Languages size={22}/><div><h2>{tr('Language')}</h2><p>{tr('Select your preferred interface language.')}</p></div></div>
        <label htmlFor="interface-language">{tr('INTERFACE LANGUAGE')}</label>
        <select id="interface-language" className="language-picker" value={locale} onChange={event => setLocale(event.target.value as Locale)}>
          {languages.map(item => <option key={item.code} value={item.code}>{item.name}</option>)}
        </select>
        <p>{tr('Changes take effect immediately and are saved on this device.')}</p>
      </section>
      {!publicPreview && <section className="setting-card">
        <div className="setting-heading"><FolderOpen size={22}/><div><h2>{tr('Project directory')}</h2><p>{tr('Choose where your agents work and which data you want to see.')}</p></div></div>
        <label htmlFor="path">{tr('WORKSPACE PATH')}</label>
        <input id="path" maxLength={1000} value={workspace} onChange={event => setWorkspace(event.target.value)} placeholder="C:\\path\\to\\project"/>
        <p>{tr('One task per project folder')}</p>
      </section>}
      {!publicPreview && <section className="setting-card">
        <div className="setting-heading"><Radio size={22}/><div><h2>{tr('Data source')}</h2><p>{tr('Choose the CLI used for each task.')}</p></div></div>
        <div className="setting-row"><div><strong>{tr('Demo environment')}</strong><span>{tr('Sample events for exploring the office')}</span></div>
          <button className={`switch ${demo ? 'enabled' : ''}`} onClick={() => setDemo(!demo)} aria-pressed={demo} aria-label={tr('Demo mode')}><span /></button>
        </div>
        <p>{tr('Choose the CLI used for each task.')}</p>
        {!online && <p role="status">{tr('API OFFLINE')}</p>}
        {(server?.providers || []).map(item => <div className="setting-row" key={item.id}>
          <div><strong>{item.name}</strong><span>{tr(!online ? 'API OFFLINE' : item.available ? 'Detected on this computer' : 'Start API and install an AI CLI')}</span></div>
          <span className={`setting-ready ${online && item.available ? 'yes' : ''}`}>{tr(!online ? 'API OFFLINE' : item.available ? 'READY' : 'NOT FOUND')}</span>
        </div>)}
      </section>}
      <section className="setting-card">
        <div className="setting-heading"><ShieldCheck size={22}/><div><h2>{tr('Privacy & safety')}</h2><p>{tr(publicPreview ? 'Preview only · no real execution' : 'Your office runs locally.')}</p></div></div>
        {publicPreview ? <><p>{tr('Demo environment')} · {tr('Sample activity only')}</p><p>{tr('Preview only · no real execution')}. {tr('Changes take effect immediately and are saved on this device.')}</p></> : <><p>{tr('One task per project folder')}</p><p>{tr('The API runs on your computer. Tasks use your installed AI CLI. Recent activity stays in .local/tasks.json.')}</p></>}
      </section>
    </div>
  </>;
}
