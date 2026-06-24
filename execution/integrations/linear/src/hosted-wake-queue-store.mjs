export function createHostedWakeQueueStore({ inboxClient, credential } = {}) {
  if (!inboxClient) throw new Error("Hosted inbox client is required for the wake queue store.");
  if (!credential?.credentialId || !credential?.token) {
    throw new Error("Runner inbox credential is required for the wake queue store.");
  }
  const triggerEvents = [];

  const auth = (input = {}) => ({
    workspaceId: input.workspaceId || credential.workspaceId,
    ...input,
    credentialId: credential.credentialId,
    token: credential.token,
  });
  const runnerAuth = (input = {}) => ({
    credentialId: credential.credentialId,
    token: credential.token,
    ...input,
  });

  return {
    triggerEvents,

    async heartbeat(input) {
      return inboxClient.heartbeatRunner(auth(input));
    },

    async claimNextWake(input) {
      const result = await inboxClient.claimNextWake(auth(input));
      if (result?.event) triggerEvents.push(result.event);
      return result;
    },

    async claimWake(input) {
      const result = await inboxClient.claimNextWake(auth(input));
      if (result?.event) triggerEvents.push(result.event);
      return result;
    },

    async renewLease(input) {
      return inboxClient.renewWakeLease(auth(input));
    },

    async markWakeRunning(input) {
      return inboxClient.markWakeRunning(auth(input));
    },

    async releaseWake(input) {
      return inboxClient.releaseWake(runnerAuth({
        wakeId: input?.wakeId,
        leaseToken: input?.leaseToken,
        reason: input?.reason,
      }));
    },

    async markWakeRoutingError(input) {
      return inboxClient.markWakeRoutingError(runnerAuth({
        wakeId: input?.wakeId,
        leaseToken: input?.leaseToken,
        reason: input?.reason,
        candidates: input?.candidates,
      }));
    },

    async requeueWake(input) {
      return inboxClient.requeueWake(auth(input));
    },

    async markMutationStarted(input) {
      return inboxClient.markWakeMutationStarted(auth(input));
    },

    async completeWake(input) {
      return inboxClient.completeWake(auth(input));
    },

    async deadLetterWake(input) {
      return inboxClient.deadLetterWake(auth(input));
    },

    async getWake(wakeIdOrInput) {
      const input =
        typeof wakeIdOrInput === "string" ? { wakeId: wakeIdOrInput } : wakeIdOrInput || {};
      return inboxClient.getWake(auth(input));
    },

    async listWakeViews(input) {
      return inboxClient.listWakeViews(auth(input));
    },
  };
}
