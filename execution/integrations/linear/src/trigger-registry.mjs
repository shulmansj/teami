import "./workflows/decomposition/definition.mjs";
import "./workflows/review/definition.mjs";
import { getWorkflowDefinition, registeredWorkflowTypes } from "../../../engine/workflow-registry.mjs";

export const TRIGGER_REGISTRY = Object.freeze(
  registeredWorkflowTypes().flatMap((workflowType) => {
    const definition = getWorkflowDefinition(workflowType);
    return (definition.triggers || []).map((trigger) => normalizeTriggerDefinition(definition, trigger));
  }),
);

export function candidateTriggersForEvent(event, registry = TRIGGER_REGISTRY) {
  return registry.filter(
    (trigger) =>
      trigger.provider_event_type === event.event_type &&
      trigger.object_type === event.object?.type,
  );
}

export function wakeKeyForTrigger(trigger, event) {
  if (typeof trigger?.build_wake_key === "function") return trigger.build_wake_key(event);
  if (!trigger?.wake_key_template) throw new Error("trigger wake_key_template is required.");
  const projectId = event?.object?.id;
  if (!projectId) throw new Error("event object id is required to build a wake key.");
  return trigger.wake_key_template.replace("{project_id}", projectId);
}

export function requiredCapabilitiesForWorkflow(workflowType, registry = TRIGGER_REGISTRY) {
  if (registry === TRIGGER_REGISTRY) {
    try {
      return [...(getWorkflowDefinition(workflowType).required_capabilities || [])];
    } catch (error) {
      if (String(error?.message || "").startsWith("unknown_workflow_type:")) return [];
      throw error;
    }
  }

  const capabilities = new Set();
  for (const trigger of registry) {
    if ((trigger.candidate_workflow || trigger.workflow_type) === workflowType) {
      for (const capability of trigger.required_capabilities || []) capabilities.add(capability);
    }
  }
  return [...capabilities];
}

function normalizeTriggerDefinition(definition, trigger) {
  return Object.freeze({
    ...trigger,
    candidate_workflow: trigger.candidate_workflow || definition.workflow_type,
    workflow_type: trigger.workflow_type || definition.workflow_type,
    required_capabilities: [...(trigger.required_capabilities || definition.required_capabilities || [])],
  });
}
