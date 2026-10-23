import { useEffect, useId, useState } from 'react';
import { Button } from '../components/quartz/ui/button';
import { Icon, Bot, Checkmark, Copy } from '../components/quartz/icon';
import { publicConfig } from '../public-config';
import {
  AGENT_CLIENTS, AGENT_LEVELS, DEFAULT_AGENT_PREFERENCES, fetchMcpAvailability, mcpUrl, setupSteps,
  type AgentClient, type AgentColor, type AgentLevel, type AgentOpponent, type AgentPreferences,
} from '../agents/connect';

type Choice<T extends string> = { value: T; label: string };

function Choices<T extends string>({ label, value, options, onChange, disabled }: {
  label: string; value: T; options: readonly Choice<T>[]; onChange: (value: T) => void; disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="agent-choice-row">
      <span id={id} className="agent-choice-label">{label}</span>
      <div className="agent-choices" role="group" aria-labelledby={id}>
        {options.map(option => (
          <Button key={option.value} variant="ghost" size="sm" className="agent-choice" aria-pressed={value === option.value}
            disabled={disabled} onClick={() => onChange(option.value)}>{option.label}</Button>
        ))}
      </div>
    </div>
  );
}

function CopyBox({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const copy = () => {
    void navigator.clipboard?.writeText(value).then(() => setCopied(true), () => setCopied(false));
  };
  return (
    <div className="agent-copy">
      <pre tabIndex={0}>{value}</pre>
      <Button variant="secondary" size="sm" onClick={copy} aria-live="polite">
        <Icon icon={copied ? Checkmark : Copy} size={16} />{copied ? 'Copied' : label}
      </Button>
    </div>
  );
}

const opponents: readonly Choice<AgentOpponent>[] = [{ value: 'engine', label: 'Stockfish' }, { value: 'human', label: 'Me' }];
const colors: readonly Choice<AgentColor>[] = [{ value: 'white', label: 'White' }, { value: 'black', label: 'Black' }, { value: 'random', label: 'Random' }];
const levels: readonly Choice<AgentLevel>[] = (Object.keys(AGENT_LEVELS) as AgentLevel[]).map(value => ({ value, label: AGENT_LEVELS[value].label }));

/** Copy-ready prompts that get an agent playing in a minute. */
export function AgentConnect() {
  const [preferences, setPreferences] = useState<AgentPreferences>(DEFAULT_AGENT_PREFERENCES);
  const [client, setClient] = useState<AgentClient>('browser');
  const [remote, setRemote] = useState(false);
  const tabsId = useId();

  useEffect(() => {
    let live = true;
    void fetchMcpAvailability(publicConfig.apiBaseUrl).then(available => {
      if (!live || !available) return;
      setRemote(true);
      setClient(current => current === 'browser' ? 'claude-code' : current);
    });
    return () => { live = false; };
  }, []);

  const clients = AGENT_CLIENTS.filter(entry => remote || !entry.remote);
  const browser = client === 'browser';
  // Only a page agent can play the person at the screen; remote agents play the server's Stockfish.
  const effective = browser ? preferences : { ...preferences, opponent: 'engine' as const };
  const steps = setupSteps(client, effective, {
    mcp: remote && publicConfig.apiBaseUrl ? mcpUrl(publicConfig.apiBaseUrl) : null,
    page: `${window.location.origin}/play`,
  });
  const update = (next: Partial<AgentPreferences>) => setPreferences(current => ({ ...current, ...next }));

  return (
    <section id="agents" className="agents-section page-width" aria-labelledby="agents-heading">
      <div className="agents-intro">
        <h2 id="agents-heading">Play with<br />your agent.</h2>
        <p>Let Claude, Codex, ChatGPT or any MCP agent play a full game. It sees only the position and picks its own moves, under the same rules as an AI opponent.</p>
      </div>
      <div className="agents-panel">
        <div className="agent-tabs" role="tablist" aria-label="Your agent">
          {clients.map(entry => (
            <Button key={entry.id} id={`${tabsId}-${entry.id}`} role="tab" variant="ghost" size="sm" className="agent-tab"
              aria-selected={client === entry.id} aria-controls={`${tabsId}-panel`} onClick={() => setClient(entry.id)}>
              {entry.label}
            </Button>
          ))}
        </div>
        <div id={`${tabsId}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-${client}`} className="agent-setup">
          <div className="agent-options">
            {browser && <Choices label="Opponent" value={preferences.opponent} options={opponents} onChange={opponent => update({ opponent })} disabled={preferences.askMe} />}
            <Choices label="Agent plays" value={preferences.color} options={colors} onChange={color => update({ color })} disabled={preferences.askMe} />
            {effective.opponent === 'engine' && <Choices label="Stockfish" value={preferences.level} options={levels} onChange={level => update({ level })} disabled={preferences.askMe} />}
            <label className="agent-ask">
              <input type="checkbox" checked={preferences.askMe} onChange={event => update({ askMe: event.target.checked })} />
              <span>Let my agent ask me first</span>
            </label>
          </div>
          <ol className="agent-steps">
            {steps.map(step => (
              <li key={step.text}>
                <p>{step.text}</p>
                {step.copy && <CopyBox label={step.copy.label} value={step.copy.value} />}
              </li>
            ))}
          </ol>
          {!remote && <p className="agent-note"><Icon icon={Bot} size={16} />Claude Code, Codex, claude.ai and ChatGPT connect through the server, which is not switched on for this site yet. A browser agent works today.</p>}
        </div>
      </div>
    </section>
  );
}
