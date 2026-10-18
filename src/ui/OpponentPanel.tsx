import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  createConnectionProfile,
  createFirstRequestDisclosure,
  createManualModelReference,
  getConnectionEndpoints,
  hasCurrentDisclosureConsent,
  reviseConnectionProfile,
} from '../providers/connections/index.js';
import type { ConnectionAuth, ConnectionProfile, ConnectionProvider, ConnectionProtocol, ConnectionStore, CreateConnectionProfileInput } from '../providers/connections/index.js';
import type { CompatibilityEvidenceV1, DiagnosticResultV1, OpponentIdentityV1, OpponentService } from '../opponents/index.js';
import type { ModelSelection } from '../controller/index.js';
import type { ConnectionNamespace } from '../providers/connections/index.js';
import { controllerRevisionForConfig } from './opponent-selection.js';
import { OpponentLogo } from './OpponentBadge.js';

interface OpponentPanelProps {
  readonly service: Promise<OpponentService>;
  readonly connectionStore: Promise<ConnectionStore>;
  readonly onSelect: (selection: ModelSelection, identity: OpponentIdentityV1) => void;
  readonly selected: ModelSelection | null;
  readonly idPrefix?: string;
  readonly selectLabel?: string;
  readonly namespace?: ConnectionNamespace;
  readonly onClose?: () => void;
  readonly onSelectionInvalidated?: () => void;
}

const protocolLabels: Record<ConnectionProtocol, string> = {
  'chat-completions': 'Chat Completions', responses: 'Responses', messages: 'Anthropic Messages',
};
const providerLabels: Record<ConnectionProvider, string> = {
  cliproxy: 'CLIProxyAPI', openai: 'OpenAI', openrouter: 'OpenRouter', anthropic: 'Anthropic', custom: 'Custom endpoint',
};

async function draftConnection(current: ConnectionProfile | null | undefined, input: CreateConnectionProfileInput) {
  return current
    ? reviseConnectionProfile(current, { ...input, catalogUrl: input.catalogUrl ?? null })
    : createConnectionProfile(input);
}

export function OpponentPanel({ service, connectionStore, onSelect, selected, idPrefix = 'opponent', selectLabel = 'Use this model for a match', namespace = { kind: 'guest' }, onClose, onSelectionInvalidated }: OpponentPanelProps) {
  const [opponents, setOpponents] = useState<OpponentService | null>(null);
  const [profiles, setProfiles] = useState<readonly ConnectionProfile[]>([]);
  const [profileId, setProfileId] = useState('');
  const [provider, setProvider] = useState<ConnectionProvider>('cliproxy');
  const [protocol, setProtocol] = useState<ConnectionProtocol>('chat-completions');
  const [name, setName] = useState('CLIProxyAPI');
  const [baseUrl, setBaseUrl] = useState('http://127.0.0.1:8317/v1');
  const [catalogUrl, setCatalogUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [authMode, setAuthMode] = useState<'bearer' | 'api-key-header' | 'none'>('bearer');
  const [modelId, setModelId] = useState('');
  const [catalog, setCatalog] = useState<Awaited<ReturnType<OpponentService['getCatalog']>> | null>(null);
  const [disclosureOpen, setDisclosureOpen] = useState(false);
  const [evidence, setEvidence] = useState<CompatibilityEvidenceV1 | null>(null);
  const [consented, setConsented] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingQuickSelection, setPendingQuickSelection] = useState<{ profile: ConnectionProfile; modelId: string } | null>(null);
  const [credentialBinding, setCredentialBinding] = useState<{ draftKey: string; bound: boolean } | null>(null);
  const consentLoadRevision = useRef(0);
  const mounted = useRef(true);
  const selectedModel = selected?.kind === 'model' ? selected : null;

  useEffect(() => {
    mounted.current = true;
    let current = true;
    void service.then(async (item) => {
      if (!current) return;
      setOpponents(item);
    });
    void connectionStore.then(async (store) => {
      const saved = await store.listProfiles(namespace);
      if (current) {
        setProfiles(saved);
        const selectedProfile = selectedModel
          ? saved.find((item) => item.id === selectedModel.connectionId) : undefined;
        if (selectedProfile) {
          setProfileId(selectedProfile.id);
          setProvider(selectedProfile.provider);
          setProtocol(selectedProfile.protocol);
          setName(selectedProfile.name);
          setBaseUrl(selectedProfile.baseUrl);
          setCatalogUrl(selectedProfile.catalogUrl ?? '');
          setAuthMode(selectedProfile.auth.kind);
          setModelId(selectedModel?.modelRoutingId ?? '');
        }
      }
    });
    return () => { current = false; mounted.current = false; };
  }, [connectionStore, namespace, selectedModel, service]);

  const profile = profiles.find((item) => item.id === profileId) ?? null;
  const endpoints = profile ? getConnectionEndpoints(profile) : null;
  const draftKey = JSON.stringify([profileId, provider, protocol, baseUrl, catalogUrl, authMode]);
  const savedKeyUsable = credentialBinding?.draftKey === draftKey && credentialBinding.bound;

  useEffect(() => {
    let current = true;
    if (!profile) return;
    const auth: ConnectionAuth = authMode === 'api-key-header'
      ? { kind: 'api-key-header', headerName: 'x-api-key' } : { kind: authMode };
    const fields = { id: profile.id, name: profile.name, protocol, baseUrl, auth,
      ...(catalogUrl.trim() ? { catalogUrl: catalogUrl.trim() } : {}) };
    const input: CreateConnectionProfileInput = provider === 'custom'
      ? { ...fields, provider } : { ...fields, provider };
    void connectionStore.then(async (store) => {
      const draft = await draftConnection(profile, input);
      const resolution = await store.resolveCredentials(namespace, draft);
      if (current) setCredentialBinding({ draftKey, bound: resolution.status === 'bound' });
    }).catch(() => { if (current) setCredentialBinding({ draftKey, bound: false }); });
    return () => { current = false; };
  }, [connectionStore, namespace, profile, draftKey, provider, protocol, baseUrl, catalogUrl, authMode]);

  useEffect(() => {
    let current = true;
    if (!profile) return undefined;
    const revision = ++consentLoadRevision.current;
    void connectionStore.then(async (store) => {
      const choice = await store.getDisclosureChoice(namespace, profile);
      if (current && revision === consentLoadRevision.current) setConsented(hasCurrentDisclosureConsent(profile, choice));
    }).catch(() => { if (current && revision === consentLoadRevision.current) setConsented(false); });
    return () => { current = false; };
  }, [connectionStore, namespace, profile]);

  const chooseProfile = (item: ConnectionProfile) => {
    onSelectionInvalidated?.();
    setProfileId(item.id);
    setProvider(item.provider);
    setProtocol(item.protocol);
    setName(item.name);
    setBaseUrl(item.baseUrl);
    setCatalogUrl(item.catalogUrl ?? '');
    setAuthMode(item.auth.kind);
    setApiKey('');
    setCatalog(null);
    setEvidence(null);
    setConsented(false);
    setModelId('');
    const revision = ++consentLoadRevision.current;
    void connectionStore.then(async (store) => {
      const choice = await store.getDisclosureChoice(namespace, item);
      return hasCurrentDisclosureConsent(item, choice);
    }).then((isConsented) => {
      if (revision === consentLoadRevision.current) setConsented(isConsented);
    }).catch(() => {
      if (revision === consentLoadRevision.current) setConsented(false);
    });
  };

  const persistProfile = async (): Promise<ConnectionProfile> => {
      if (!opponents) throw new Error('Connection setup is still loading.');
      const connections = await connectionStore;
      const id = profileId || crypto.randomUUID();
      const auth: ConnectionAuth = authMode === 'api-key-header'
        ? { kind: 'api-key-header', headerName: 'x-api-key' } : { kind: authMode };
      const fields = {
        id, name, protocol, baseUrl, auth,
        ...(catalogUrl.trim() ? { catalogUrl: catalogUrl.trim() } : {}),
      };
      const input: CreateConnectionProfileInput = provider === 'custom'
        ? { ...fields, provider } : { ...fields, provider };
      const current = await connections.getProfile(namespace, id);
      const next = await draftConnection(current, input);
      const resolution = await connections.resolveCredentials(namespace, next);
      if (next.auth.kind !== 'none' && !apiKey.trim() && resolution.status !== 'bound') {
        throw new Error('Enter the API key again for this connection URL and authentication settings.');
      }
      await connections.saveProfile(namespace, next);
      if (next.auth.kind !== 'none' && apiKey.trim()) await connections.assignCredential(namespace, id, { apiKey: apiKey.trim() });
      else if (next.auth.kind === 'none' && resolution.status !== 'bound') await connections.assignCredential(namespace, id, {});
      setProfileId(id);
      setApiKey('');
      setProfiles(await connections.listProfiles(namespace));
      setMessage(`Saved locally. Generation: ${getConnectionEndpoints(next).generationUrl}`);
      setEvidence(null);
      setCatalog(null);
      setConsented(false);
      return next;
  };

  const saveProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      await persistProfile();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The connection could not be saved.');
    } finally { setBusy(false); }
  };

  const acceptDisclosure = async (recordedAtMs: number) => {
    if (!profile) return;
    const connections = await connectionStore;
    setBusy(true);
    try {
      const destination = pendingQuickSelection?.profile ?? profile;
      await connections.recordDisclosureChoice(namespace, destination, { decision: 'accepted', recordedAtMs });
      setDisclosureOpen(false);
      setConsented(true);
      setMessage('Consent saved for this connection destination and configuration.');
      const pending = pendingQuickSelection;
      setPendingQuickSelection(null);
      if (pending) await checkAndUseProxy(pending.profile, pending.modelId);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Consent could not be saved.'); }
    finally { setBusy(false); }
  };

  const refreshCatalog = async () => {
    if (!profile || !opponents) return;
    setBusy(true);
    try {
      const next = await opponents.refreshCatalog(profile.id);
      setCatalog(next);
      setMessage(next.error?.message ?? `Catalog ${next.state}: ${next.entries.length} model IDs available.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Catalog check failed.'); }
    finally { setBusy(false); }
  };

  const runDiagnostic = async () => {
    if (!profile || !opponents) return;
    setBusy(true);
    try {
      await opponents.addManualModel(profile.id, modelId);
      const result: DiagnosticResultV1 = await opponents.runCompatibilityDiagnostic({ profileId: profile.id, modelId });
      setEvidence(result.evidence);
      if (result.evidence.state === 'passed-current-session') setConsented(true);
      setMessage(result.evidence.detail);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Compatibility check failed.'); }
    finally { setBusy(false); }
  };

  const selectOpponent = async () => {
    if (!profile || !opponents || evidence?.state !== 'passed-current-session') return;
    setBusy(true);
    try {
      await applyCheckedSelection(profile, modelId, evidence);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Opponent selection could not be prepared.'); }
    finally { setBusy(false); }
  };

  const applyCheckedSelection = async (checkedProfile: ConnectionProfile, checkedModelId: string, checkedEvidence: CompatibilityEvidenceV1) => {
      if (!opponents) throw new Error('Connection setup is still loading.');
      const identity = await opponents.prepareSelection({ profileId: checkedProfile.id, modelId: checkedModelId });
      const prepared = identity.queued?.identity ?? identity.committed;
      if (!mounted.current) return;
      // Rechecking an already committed model preserves its original diagnostic attribution.
      if (!prepared || prepared.profileId !== checkedProfile.id || prepared.modelId !== checkedModelId ||
        prepared.configRevision !== checkedEvidence.configRevision || prepared.credentialRevision !== checkedEvidence.credentialRevision ||
        prepared.protocol !== checkedEvidence.protocol) {
        throw new Error('The current-session diagnostic does not match the committed or queued model identity.');
      }
      onSelect({
        kind: 'model', providerId: checkedProfile.provider, connectionId: checkedProfile.id,
        configurationRevision: controllerRevisionForConfig(checkedProfile.configRevision), modelRoutingId: checkedModelId,
        protocol: checkedProfile.protocol, diagnostic: 'passed-current-session',
      }, prepared);
      setMessage(`Compatibility passed for ${checkedEvidence.requestedModelId}; reported ID: ${checkedEvidence.reportedModelId ?? 'not reported'}. Model ready to play.`);
  };

  const checkAndUseProxy = async (savedProfile: ConnectionProfile, routingId: string) => {
    if (!opponents) throw new Error('Connection setup is still loading.');
    setMessage('Checking your CLIProxyAPI model. This sends one diagnostic request.');
    await opponents.addManualModel(savedProfile.id, routingId);
    const result = await opponents.runCompatibilityDiagnostic({ profileId: savedProfile.id, modelId: routingId });
    setEvidence(result.evidence);
    setMessage(result.evidence.detail);
    if (result.evidence.state === 'passed-current-session') await applyCheckedSelection(savedProfile, routingId, result.evidence);
  };

  const connectProxy = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setEvidence(null);
    onSelectionInvalidated?.();
    try {
      if (!modelId || modelId !== modelId.trim()) throw new Error('Enter the exact model ID without leading or trailing spaces.');
      const savedProfile = await persistProfile();
      const routingId = createManualModelReference(savedProfile, modelId).requestedModelId;
      const store = await connectionStore;
      if (hasCurrentDisclosureConsent(savedProfile, await store.getDisclosureChoice(namespace, savedProfile))) {
        setConsented(true);
        await checkAndUseProxy(savedProfile, routingId);
      } else {
        setPendingQuickSelection({ profile: savedProfile, modelId: routingId });
        setDisclosureOpen(true);
        setMessage('Review the destination below. Accepting will send one compatibility check and prepare this model for play.');
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : 'CLIProxyAPI could not connect. Check the address, API key, and model ID, then try again.'); }
    finally { setBusy(false); }
  };

  const invalidateSelection = () => {
    setEvidence(null);
    setMessage('');
    onSelectionInvalidated?.();
  };

  const checkConsent = async () => {
    if (!profile) { setConsented(false); return; }
    const store = await connectionStore;
    setConsented(hasCurrentDisclosureConsent(profile, await store.getDisclosureChoice(namespace, profile)));
  };

  return <section className="detail-section opponent-panel" aria-labelledby={`${idPrefix}-setup-title`}>
    <div className="panel-heading"><h2 id={`${idPrefix}-setup-title`}>AI connection and model</h2>
      {onClose && <button className="button quiet" type="button" onClick={onClose}>Close</button>}</div>
    <p>Configure a direct browser connection. Saving sends no request. Catalog checks are separate from generation diagnostics.</p>
    <fieldset className="opponent-fields" disabled={busy || pendingQuickSelection !== null}>
    <legend className="sr-only">Connection setup</legend>
    <div className="connection-picker">
      <label>Saved connection<select value={profileId} onChange={(event) => {
        const next = profiles.find((item) => item.id === event.target.value);
        if (next) chooseProfile(next); else { setProfileId(''); setApiKey(''); setModelId(''); setConsented(false); invalidateSelection(); }
      }}>
        <option value="">New connection</option>
        {profiles.map((item) => <option key={item.id} value={item.id}>{item.name} · {providerLabels[item.provider]}</option>)}
      </select></label>
    </div>
      <label>Provider<select value={provider} onChange={(event) => {
        const next = event.target.value as ConnectionProvider; setProvider(next);
        setProfileId('');
        invalidateSelection();
        setApiKey('');
        setCatalogUrl('');
        if (next === 'cliproxy') { setName('CLIProxyAPI'); setProtocol('chat-completions'); setBaseUrl('http://127.0.0.1:8317/v1'); setAuthMode('bearer'); }
        if (next === 'openai') { setProtocol('responses'); setBaseUrl('https://api.openai.com/v1'); setAuthMode('bearer'); }
        if (next === 'openrouter') { setProtocol('chat-completions'); setBaseUrl('https://openrouter.ai/api/v1'); setAuthMode('bearer'); }
        if (next === 'anthropic') { setProtocol('messages'); setBaseUrl('https://api.anthropic.com/v1'); setAuthMode('api-key-header'); }
      }}>
        {Object.entries(providerLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
    {provider === 'cliproxy' ? <form className="connection-form proxy-quick-form" onSubmit={(event) => void connectProxy(event)}>
      <p>Connect to your CLIProxyAPI server, then choose a model. Your proxy API key stays in this browser.</p>
      <label>Proxy URL<input type="url" value={baseUrl} onChange={(event) => { setBaseUrl(event.target.value); invalidateSelection(); }} placeholder="http://127.0.0.1:8317/v1" required /></label>
      {authMode !== 'none' && <label>Proxy API key<input type="password" value={apiKey} onChange={(event) => { setApiKey(event.target.value); invalidateSelection(); }} autoComplete="new-password" placeholder={savedKeyUsable ? 'Leave blank to keep saved key' : profile ? 'Re-enter key for this connection' : 'Your proxy API key'} required={!savedKeyUsable} /></label>}
      <label>Model ID<input value={modelId} onChange={(event) => { setModelId(event.target.value); invalidateSelection(); }} placeholder="Exact model ID from your proxy" spellCheck={false} required /></label>
      <details className="proxy-advanced"><summary>Advanced connection settings</summary>
        <div className="connection-form">
          <label>Connection name<input value={name} onChange={(event) => setName(event.target.value)} required /></label>
          <label>Protocol<select value={protocol} onChange={(event) => { setProtocol(event.target.value as ConnectionProtocol); invalidateSelection(); }}>
            {Object.entries(protocolLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></label>
          <label>Authentication<select value={authMode} onChange={(event) => { setAuthMode(event.target.value as typeof authMode); setApiKey(''); invalidateSelection(); }}>
            <option value="bearer">Bearer key</option><option value="api-key-header">API key header</option><option value="none">None</option>
          </select></label>
          <label>Catalog URL override<input type="url" value={catalogUrl} onChange={(event) => { setCatalogUrl(event.target.value); invalidateSelection(); }} placeholder="Use proxy default when blank" /></label>
        </div>
      </details>
      <p className="muted">Connecting sends one compatibility check after you accept the destination disclosure. Your proxy must be running and allow this website to connect.</p>
      <button className="button primary" type="submit" disabled={busy || !modelId}>{busy ? 'Checking model…' : 'Connect and use model'}</button>
      {evidence && <p className={evidence.state === 'passed-current-session' ? 'muted' : 'error-message'} role="status">
        {evidence.state}: requested {evidence.requestedModelId}; reported {evidence.reportedModelId ?? 'not reported'}. {evidence.detail}
      </p>}
    </form> : <form className="connection-form" onSubmit={(event) => void saveProfile(event)}>
      <label>Connection name<input value={name} onChange={(event) => setName(event.target.value)} required /></label>
      <label>Protocol<select value={protocol} onChange={(event) => { setProtocol(event.target.value as ConnectionProtocol); invalidateSelection(); }}>
        {Object.entries(protocolLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <label>Base URL<input type="url" value={baseUrl} onChange={(event) => { setBaseUrl(event.target.value); invalidateSelection(); }} required /></label>
      <label>Catalog URL override<input type="url" value={catalogUrl} onChange={(event) => { setCatalogUrl(event.target.value); invalidateSelection(); }} placeholder="Use provider default when blank" /></label>
      {provider === 'custom' && <label>Authentication<select value={authMode} onChange={(event) => { setAuthMode(event.target.value as typeof authMode); setApiKey(''); invalidateSelection(); }}>
        <option value="bearer">Bearer key</option><option value="api-key-header">API key header</option><option value="none">None</option>
      </select></label>}
      {authMode !== 'none' && <label>API key<input type="password" value={apiKey} onChange={(event) => { setApiKey(event.target.value); invalidateSelection(); }} autoComplete="new-password" placeholder={savedKeyUsable ? 'Leave blank to keep saved key' : 'Enter key for this connection'} required={!savedKeyUsable} /></label>}
      <p className="connection-url">Generation endpoint: <code>{endpoints?.generationUrl ?? 'Saved after connection setup'}</code></p>
      <button className="button secondary" type="submit" disabled={busy}>Save connection</button>
    </form>}
    {profile && provider !== 'cliproxy' && <div className="model-controls">
      <p className="muted">{protocolLabels[profile.protocol]} · {endpoints?.generationUrl}</p>
      <button className="button secondary" type="button" onClick={() => void refreshCatalog()} disabled={busy}>Check model catalog</button>
      {catalog && <p className="muted">Catalog: {catalog.state}. {catalog.entries.length} entries; unavailable IDs and capability remain unverified.</p>}
      {catalog?.entries.map((entry) => <button className="model-choice" type="button" key={entry.id} onClick={() => { setModelId(entry.id); invalidateSelection(); }} aria-label={entry.id} aria-pressed={modelId === entry.id}><OpponentLogo modelId={entry.id} /><span>{entry.id}</span></button>)}
      <label>Exact model routing ID<input value={modelId} onChange={(event) => { setModelId(event.target.value); invalidateSelection(); }} spellCheck={false} /></label>
      <p className="muted">The exact ID is preserved. Catalog listing does not establish chess compatibility.</p>
      <button className="button secondary" type="button" onClick={() => { setDisclosureOpen(true); void checkConsent(); }} disabled={busy}>Review request disclosure</button>
      <button className="button secondary" type="button" onClick={() => void runDiagnostic()} disabled={busy || !modelId || !profile || !consented}>Run explicit compatibility check</button>
      {!consented && <p className="muted">Review and accept the disclosure before sending a generation diagnostic.</p>}
      {evidence && <p className={evidence.state === 'passed-current-session' ? 'muted' : 'error-message'} role="status">
        {evidence.state}: requested {evidence.requestedModelId}; reported {evidence.reportedModelId ?? 'not reported'}. {evidence.detail}
      </p>}
      <button className="button primary" type="button" onClick={() => void selectOpponent()} disabled={busy || evidence?.state !== 'passed-current-session'}>{selectLabel}</button>
    </div>}
    </fieldset>
    {disclosureOpen && profile && <div className="disclosure-panel" aria-labelledby={`${idPrefix}-disclosure-title`}>
      {(() => { const disclosure = createFirstRequestDisclosure(profile); return <>
        <h3 id={`${idPrefix}-disclosure-title`}>{disclosure.title}</h3>
        <p>{disclosure.body}</p>
        <p><strong>Generation destination:</strong> {disclosure.destinationUrl}</p>
        {disclosure.catalogUrl && <p><strong>Catalog destination:</strong> {disclosure.catalogUrl}</p>}
        <ul>{disclosure.notices.map((notice) => <li key={notice}>{notice}</li>)}</ul>
        {disclosure.links.map((link) => <a key={link.href} href={link.href} target="_blank" rel="noreferrer">{link.label}</a>)}
        <div className="button-row"><button className="button primary" type="button" onClick={() => void acceptDisclosure(Date.now())} disabled={busy}>{pendingQuickSelection ? 'Accept and check model' : 'Accept and save consent'}</button>
          <button className="button secondary" type="button" disabled={busy} onClick={() => { setDisclosureOpen(false); setPendingQuickSelection(null); setMessage('Connection saved locally. No compatibility request was sent.'); }}>Cancel</button></div>
      </>; })()}
    </div>}
    <p className="feedback-inline" role="status" aria-live="polite">{message}</p>
    {selected && <p className="muted prepared-opponent"><OpponentLogo modelId={selected.modelRoutingId} /><span>Prepared opponent: {selected.modelRoutingId} via {selected.providerId}.</span></p>}
  </section>;
}
