export function resolveWorkflowRuntime(config, workflowType) {
  const runtime = config?.runtime || {};
  const workflow = config?.workflows?.[workflowType] || {};
  return {
    default_invocation: runtime.default_invocation,
    adapters: runtime.adapters || {},
    roles: workflow.roles || {},
  };
}
