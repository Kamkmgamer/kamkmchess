export { AgentBridge, agentBridge } from './bridge.js';
export type { AgentGameView, AgentHost, AgentOutcome, AgentSide, AgentStartOptions, AgentTurn } from './bridge.js';
export { AGENT_DEFAULT_NAME, AGENT_TIME_CONTROL, PAGE_AGENT_PROVIDER, cleanAgentName, createAgentSelection, isAgentSelection } from './seat.js';
export { AGENT_INSTRUCTIONS, runAgentTurn } from './turn.js';
export { AGENT_RULES, callAgentTool, createAgentTools } from './tools.js';
export type { AgentTool } from './tools.js';
export { registerAgentTools } from './webmcp.js';
