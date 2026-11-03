import {StringDecoder} from 'node:string_decoder';

export const recipePolicy = {model: 'gpt-6-luna', reasoningEffort: 'none', promptVersion: 'compact-v6'};
export const disabledRecipeFeatures = ['shell_tool', 'unified_exec', 'shell_snapshot', 'apps', 'plugins', 'hooks', 'memories', 'multi_agent', 'multi_agent_v2', 'code_mode', 'code_mode_only', 'context_management', 'current_time_reminder', 'deferred_executor', 'request_permissions_tool', 'standalone_web_search', 'token_budget', 'tool_suggest', 'view_image', 'image_generation', 'goals', 'enable_fanout'];
export function restrictedRecipeConfig(policy = recipePolicy) {
  return {approval_policy: 'never', project_doc_max_bytes: 0, web_search: 'disabled', model_reasoning_effort: policy.reasoningEffort, model_verbosity: 'low', 'skills.include_instructions': false, 'cloud.skills.enabled': false, 'tools.update_plan.enabled': false, 'tools.experimental_request_user_input.enabled': false, ...Object.fromEntries(disabledRecipeFeatures.map(name => [`features.${name}`, false]))};
}
export const elapsed = start => Math.round((performance.now() - start) * 100) / 100;
const tokenCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

// Persist only timing, model identifiers and numeric usage, never raw event text.
export function eventTelemetry(start, metrics, {onMessage = () => {}, onComplete = () => {}} = {}) {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  function line(value) {
    let event;
    try { event = JSON.parse(value); } catch { return; }
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') return;
    metrics.timingsMs.firstEvent ??= elapsed(start);
    if (event.type === 'turn.started') metrics.timingsMs.turnStarted ??= elapsed(start);
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') { metrics.timingsMs.firstMessage ??= elapsed(start); onMessage(event.item.text); }
    if (event.type === 'turn.completed') {
      metrics.timingsMs.turnCompleted = elapsed(start);
      const usage = event.usage ?? {};
      metrics.usage = {inputTokens: tokenCount(usage.input_tokens), cachedInputTokens: tokenCount(usage.cached_input_tokens), outputTokens: tokenCount(usage.output_tokens), reasoningTokens: tokenCount(usage.reasoning_output_tokens)};
      onComplete();
    }
    if (typeof event.model === 'string' && /^[a-zA-Z0-9_.-]{1,100}$/.test(event.model)) metrics.reportedModel = event.model;
  }
  return {
    push(chunk) {
      buffer += decoder.write(chunk);
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) { line(buffer.slice(0, index)); buffer = buffer.slice(index + 1); }
    },
    end() { buffer += decoder.end(); if (buffer.trim()) line(buffer); buffer = ''; },
  };
}
