"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryOptions,
} from "@tanstack/react-query";
import { useCallback } from "react";
import { useAuth } from "@/components/onboarding/AuthProvider";
import {
  bootstrapConnection,
  createConnectionPackage,
  createFormationParty,
  entityAgentBook,
  executePolicyUpdate,
  fetchAgentSchema,
  fundEntity,
  getEntity,
  getEntityReputation,
  getEntityRuns,
  getEntityTreasury,
  getNonce,
  getPasskeyChallenge,
  getPublicConfig,
  listApiKeys,
  listEntities,
  listEntityJobs,
  listPasskeys,
  onboardEntity,
  patchPerTxCap,
  patchTrustPolicy,
  revokeApiKey,
  revokePasskey,
  schedulePolicyUpdate,
  storePasskey,
  verifySiwe,
  worldIdAttestContext,
  worldIdAttestVerify,
  worldIdContext,
  worldIdMe,
  worldIdVerify,
  worldIdWaiver,
} from "./client";
import {
  deriveFormationEnvironment,
  type FormationEnvironment,
} from "./formationEnvironment";
import { apiKeys } from "./keys";
import { TERMINAL } from "./poll";
import type {
  AgentSpec,
  BootstrapPackage,
  Capability,
  ConnectionPackage,
  EntityStatus,
  EntityView,
  FormationPartyInput,
  GuardianPasskey,
  JobView,
  ReputationView,
  WorldIdAttestContext,
  WorldIdContext,
  WorldIdMe,
} from "./types";

function useAuthToken() {
  const { session } = useAuth();
  return session?.token;
}

function useEnsureAuthToken() {
  const { ensureSession } = useAuth();
  return useCallback(async () => {
    const auth = await ensureSession();
    return auth.token;
  }, [ensureSession]);
}

/* ── Public reads ─────────────────────────────────────────────────────────── */

export function usePublicConfigQuery() {
  return useQuery({
    queryKey: apiKeys.publicConfig(),
    queryFn: getPublicConfig,
    // A deployment's capabilities do not change under a running page: what it can custody and
    // which environment it files in are decided by the box's env at boot. Refetching them on every
    // mount put the wizard back into `loading` — i.e. back into the NEUTRAL state — every time a
    // step remounted, for an answer that could not have changed. `refetch()` still works and is
    // what the retry affordance calls.
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/**
 * THE one question every filing surface asks: which environment is this? (design §2/§8.)
 *
 * Four states, two of which are "we don't know" — see `lib/api/formationEnvironment.ts` for what
 * the two-valued predicate this replaces got wrong, in both directions. The rule callers owe it:
 * `sandbox` alone may render demo claims, `production` alone may render real-filing claims, and
 * `loading`/`unknown` render neutral with every consequential action disabled.
 */
export function useFormationEnvironment(): FormationEnvironment {
  const { data, isError } = usePublicConfigQuery();
  return deriveFormationEnvironment({ data, isError });
}

/**
 * The retry affordance the neutral state owes the user.
 *
 * A screen that says "can't verify this deployment's filing environment" and offers no way to ask
 * again is a dead end — the user's only move is a full page reload, which throws away the wizard
 * state they were half way through.
 */
export function useRetryPublicConfig(): { retry: () => void; retrying: boolean } {
  const { refetch, isFetching } = usePublicConfigQuery();
  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);
  return { retry, retrying: isFetching };
}

export function useAgentSchemaQuery(enabled = true) {
  return useQuery({
    queryKey: apiKeys.agentSchema(),
    queryFn: fetchAgentSchema,
    enabled,
    retry: false,
  });
}

/* ── Entity reads ─────────────────────────────────────────────────────────── */

export function useEntitiesQuery() {
  const token = useAuthToken();
  return useQuery({
    queryKey: apiKeys.entities(token ?? ""),
    queryFn: () => listEntities(token!),
    enabled: !!token,
  });
}

export function useEntityQuery(
  entityId: string | null | undefined,
  options?: {
    enabled?: boolean;
    refetchInterval?: number | false | ((entity: EntityView | undefined) => number | false);
    refetchUntil?: EntityStatus[];
  },
) {
  const token = useAuthToken();
  const refetchUntil = options?.refetchUntil;
  const enabled = (options?.enabled ?? true) && !!token && !!entityId;

  return useQuery({
    queryKey: apiKeys.entity(token ?? "", entityId ?? ""),
    queryFn: () => getEntity(token!, entityId!),
    enabled,
    refetchInterval: (query) => {
      const entity = query.state.data;
      if (refetchUntil && entity && refetchUntil.includes(entity.status)) return false;
      if (typeof options?.refetchInterval === "function") {
        return options.refetchInterval(entity);
      }
      return options?.refetchInterval ?? false;
    },
  });
}

export function useEntityTreasuryQuery(
  entityId: string | null | undefined,
  enabled = true,
) {
  const token = useAuthToken();
  return useQuery({
    queryKey: apiKeys.entityTreasury(token ?? "", entityId ?? ""),
    queryFn: () => getEntityTreasury(token!, entityId!),
    enabled: enabled && !!token && !!entityId,
  });
}

export function useEntityRunsQuery(
  entityId: string | null | undefined,
  enabled = true,
  refetchInterval: number | false | (() => number | false) = false,
) {
  const token = useAuthToken();
  return useQuery({
    queryKey: apiKeys.entityRuns(token ?? "", entityId ?? ""),
    queryFn: async () => (await getEntityRuns(token!, entityId!)).runs,
    enabled: enabled && !!token && !!entityId,
    refetchInterval,
  });
}

export function useEntityReputationQuery(entityId: string, refetchInterval = 5000) {
  const token = useAuthToken();
  return useQuery({
    queryKey: apiKeys.entityReputation(token ?? "", entityId),
    queryFn: async () => (await getEntityReputation(token!, entityId)).reputation,
    enabled: !!token,
    refetchInterval,
  });
}

export function useEntityJobsQuery(entityId: string, refetchInterval = 5000) {
  const token = useAuthToken();
  return useQuery({
    queryKey: apiKeys.entityJobs(token ?? "", entityId),
    queryFn: () => listEntityJobs(token!, entityId),
    enabled: !!token,
    refetchInterval,
  });
}

export function useEntityAgentBookQuery(entityId: string) {
  const token = useAuthToken();
  return useQuery({
    queryKey: apiKeys.entityAgentBook(token ?? "", entityId),
    queryFn: () => entityAgentBook(token!, entityId),
    enabled: !!token,
    retry: false,
  });
}

function visibilityPollInterval() {
  return typeof document !== "undefined" && document.visibilityState === "hidden" ? false : 5000;
}

export function useAgentDashboardQueries(entityId: string) {
  const entity = useEntityQuery(entityId, { refetchInterval: visibilityPollInterval });
  const treasuryReady = !!entity.data?.treasury;
  const treasury = useEntityTreasuryQuery(entityId, treasuryReady);
  const runs = useEntityRunsQuery(entityId, treasuryReady, visibilityPollInterval);
  const agentBook = useEntityAgentBookQuery(entityId);

  return { entity, treasury, runs, agentBook };
}

/* ── Connections & passkeys ───────────────────────────────────────────────── */

export function useApiKeysQuery() {
  const token = useAuthToken();
  return useQuery({
    queryKey: apiKeys.apiKeys(token ?? ""),
    queryFn: () => listApiKeys(token!),
    enabled: !!token,
  });
}

export function usePasskeysQuery() {
  const token = useAuthToken();
  return useQuery({
    queryKey: apiKeys.passkeys(token ?? ""),
    queryFn: () => listPasskeys(token!),
    enabled: !!token,
  });
}

/* ── World ID reads ───────────────────────────────────────────────────────── */

export function useWorldIdMeQuery(
  options?: Pick<UseQueryOptions<WorldIdMe>, "enabled" | "retry">,
) {
  const token = useAuthToken();
  return useQuery({
    queryKey: apiKeys.worldIdMe(token ?? ""),
    queryFn: () => worldIdMe(token!),
    enabled: (options?.enabled ?? true) && !!token,
    retry: options?.retry ?? false,
  });
}

/* ── Auth mutations ───────────────────────────────────────────────────────── */

export function useSiweLoginMutation() {
  return useMutation({
    mutationFn: async ({
      message,
      signature,
    }: {
      message: string;
      signature: `0x${string}`;
    }) => verifySiwe(message, signature),
  });
}

export function useAuthNonceMutation() {
  return useMutation({
    mutationFn: getNonce,
  });
}

/* ── Entity mutations ─────────────────────────────────────────────────────── */

export function useOnboardEntityMutation() {
  const queryClient = useQueryClient();
  const ensureToken = useEnsureAuthToken();

  return useMutation({
    mutationFn: async ({
      spec,
      guardianPasskey,
      idempotencyKey,
      custody,
      partyId,
    }: {
      spec: AgentSpec;
      guardianPasskey: GuardianPasskey;
      idempotencyKey?: string;
      custody?: "turnkey" | "circle";
      /** The opaque formation-party handle. Never the identity — that never reaches this layer. */
      partyId?: string;
    }) => {
      const token = await ensureToken();
      return onboardEntity(token, spec, guardianPasskey, idempotencyKey, custody, partyId);
    },
    onSuccess: async () => {
      const token = await ensureToken();
      await queryClient.invalidateQueries({ queryKey: apiKeys.entities(token) });
    },
  });
}

/**
 * Record the responsible natural person and get back a handle (design §3/§5).
 *
 * A MUTATION and never a query, for a reason beyond the HTTP verb: React Query keys are held in
 * memory for the life of the page and are the first thing a devtools panel prints. Personal data
 * must never become one — so this hook takes the identity as an argument, hands it to the client,
 * and keeps nothing. Nothing is invalidated on success either: the response is one opaque handle,
 * and no cached view of the account changed.
 */
export function useCreateFormationPartyMutation() {
  const ensureToken = useEnsureAuthToken();

  return useMutation({
    mutationFn: async (body: { synthetic: true } | FormationPartyInput) => {
      const token = await ensureToken();
      return createFormationParty(token, body);
    },
  });
}

export function useFundEntityMutation() {
  const queryClient = useQueryClient();
  const ensureToken = useEnsureAuthToken();

  return useMutation({
    mutationFn: async ({
      entityId,
      amountAtomic,
    }: {
      entityId: string;
      amountAtomic: string;
    }) => {
      const token = await ensureToken();
      return fundEntity(token, entityId, amountAtomic);
    },
    onSuccess: async (_data, { entityId }) => {
      const token = await ensureToken();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: apiKeys.entity(token, entityId) }),
        queryClient.invalidateQueries({ queryKey: apiKeys.entityTreasury(token, entityId) }),
        queryClient.invalidateQueries({ queryKey: apiKeys.entities(token) }),
      ]);
    },
  });
}

export function useSchedulePolicyUpdateMutation(entityId: string) {
  const queryClient = useQueryClient();
  const ensureToken = useEnsureAuthToken();

  return useMutation({
    mutationFn: async (body: {
      capUsdc: string;
      periodSeconds: number;
      allowlistOn: boolean;
      payoutAddress: string;
    }) => {
      const token = await ensureToken();
      return schedulePolicyUpdate(token, entityId, body);
    },
    onSuccess: async () => {
      const token = await ensureToken();
      await queryClient.invalidateQueries({ queryKey: apiKeys.entity(token, entityId) });
    },
  });
}

export function useExecutePolicyUpdateMutation(entityId: string) {
  const queryClient = useQueryClient();
  const ensureToken = useEnsureAuthToken();

  return useMutation({
    mutationFn: async (policyId: string) => {
      const token = await ensureToken();
      return executePolicyUpdate(token, entityId, policyId);
    },
    onSuccess: async () => {
      const token = await ensureToken();
      await queryClient.invalidateQueries({ queryKey: apiKeys.entity(token, entityId) });
    },
  });
}

export function usePatchTrustPolicyMutation(entityId: string) {
  const queryClient = useQueryClient();
  const ensureToken = useEnsureAuthToken();

  return useMutation({
    mutationFn: async (
      trustPolicy: "open" | "verified-sellers-only" | "verified-legal-bodies-only" | null,
    ) => {
      const token = await ensureToken();
      return patchTrustPolicy(token, entityId, trustPolicy);
    },
    onSuccess: async () => {
      const token = await ensureToken();
      await queryClient.invalidateQueries({ queryKey: apiKeys.entity(token, entityId) });
    },
  });
}

export function usePatchPerTxCapMutation(entityId: string) {
  const queryClient = useQueryClient();
  const ensureToken = useEnsureAuthToken();

  return useMutation({
    mutationFn: async (perTxCapUsdc: string | null) => {
      const token = await ensureToken();
      return patchPerTxCap(token, entityId, perTxCapUsdc);
    },
    onSuccess: async () => {
      const token = await ensureToken();
      await queryClient.invalidateQueries({ queryKey: apiKeys.entity(token, entityId) });
    },
  });
}

/* ── Connection & passkey mutations ───────────────────────────────────────── */

export function useCreateConnectionPackageMutation() {
  const queryClient = useQueryClient();
  const ensureToken = useEnsureAuthToken();

  return useMutation({
    mutationFn: async ({
      entityId,
      capability,
    }: {
      entityId: string;
      capability: Capability;
    }): Promise<ConnectionPackage> => {
      const token = await ensureToken();
      return createConnectionPackage(token, entityId, capability);
    },
    onSuccess: async () => {
      const token = await ensureToken();
      await queryClient.invalidateQueries({ queryKey: apiKeys.apiKeys(token) });
    },
  });
}

export function useBootstrapConnectionMutation() {
  const queryClient = useQueryClient();
  const ensureToken = useEnsureAuthToken();

  return useMutation({
    mutationFn: async ({
      passkeyId,
      capability,
    }: {
      passkeyId: string;
      capability: Capability;
    }): Promise<BootstrapPackage> => {
      const token = await ensureToken();
      return bootstrapConnection(token, passkeyId, capability);
    },
    onSuccess: async () => {
      const token = await ensureToken();
      await queryClient.invalidateQueries({ queryKey: apiKeys.apiKeys(token) });
    },
  });
}

export function usePasskeyChallengeMutation() {
  const ensureToken = useEnsureAuthToken();

  return useMutation({
    mutationFn: async () => {
      const token = await ensureToken();
      return getPasskeyChallenge(token);
    },
  });
}

export function useStorePasskeyMutation() {
  const queryClient = useQueryClient();
  const ensureToken = useEnsureAuthToken();

  return useMutation({
    mutationFn: async (passkey: GuardianPasskey) => {
      const token = await ensureToken();
      return storePasskey(token, passkey);
    },
    onSuccess: async () => {
      const token = await ensureToken();
      await queryClient.invalidateQueries({ queryKey: apiKeys.passkeys(token) });
    },
  });
}

export function useRevokeApiKeyMutation() {
  const queryClient = useQueryClient();
  const ensureToken = useEnsureAuthToken();

  return useMutation({
    mutationFn: async (id: string) => {
      const token = await ensureToken();
      await revokeApiKey(token, id);
    },
    onSuccess: async () => {
      const token = await ensureToken();
      await queryClient.invalidateQueries({ queryKey: apiKeys.apiKeys(token) });
    },
  });
}

export function useRevokePasskeyMutation() {
  const queryClient = useQueryClient();
  const ensureToken = useEnsureAuthToken();

  return useMutation({
    mutationFn: async (id: string) => {
      const token = await ensureToken();
      await revokePasskey(token, id);
    },
    onSuccess: async () => {
      const token = await ensureToken();
      await queryClient.invalidateQueries({ queryKey: apiKeys.passkeys(token) });
    },
  });
}

/* ── World ID mutations ───────────────────────────────────────────────────── */

export function useWorldIdContextMutation() {
  const ensureToken = useEnsureAuthToken();

  return useMutation({
    mutationFn: async (): Promise<WorldIdContext> => {
      const token = await ensureToken();
      return worldIdContext(token);
    },
  });
}

export function useWorldIdVerifyMutation() {
  const queryClient = useQueryClient();
  const ensureToken = useEnsureAuthToken();

  return useMutation({
    mutationFn: async (proof: unknown) => {
      const token = await ensureToken();
      return worldIdVerify(token, proof);
    },
    onSuccess: async () => {
      const token = await ensureToken();
      await queryClient.invalidateQueries({ queryKey: apiKeys.worldIdMe(token) });
    },
  });
}

export function useWorldIdWaiverMutation() {
  const queryClient = useQueryClient();
  const ensureToken = useEnsureAuthToken();

  return useMutation({
    mutationFn: async (code: string) => {
      const token = await ensureToken();
      return worldIdWaiver(token, code);
    },
    onSuccess: async () => {
      const token = await ensureToken();
      await queryClient.invalidateQueries({ queryKey: apiKeys.worldIdMe(token) });
    },
  });
}

export function useWorldIdAttestContextMutation() {
  const ensureToken = useEnsureAuthToken();

  return useMutation({
    mutationFn: async (): Promise<WorldIdAttestContext> => {
      const token = await ensureToken();
      return worldIdAttestContext(token);
    },
  });
}

export function useWorldIdAttestVerifyMutation() {
  const queryClient = useQueryClient();
  const ensureToken = useEnsureAuthToken();

  return useMutation({
    mutationFn: async (proof: unknown) => {
      const token = await ensureToken();
      return worldIdAttestVerify(token, proof);
    },
    onSuccess: async () => {
      const token = await ensureToken();
      await queryClient.invalidateQueries({ queryKey: apiKeys.worldIdMe(token) });
    },
  });
}

/* ── Composite helpers ────────────────────────────────────────────────────── */

export function useJobsReputationQueries(entityId: string) {
  const reputation = useEntityReputationQuery(entityId);
  const jobs = useEntityJobsQuery(entityId);
  return { reputation, jobs };
}

export { TERMINAL };

export function useEntityPollQuery(entityId: string | null | undefined) {
  return useEntityQuery(entityId, {
    refetchInterval: 2500,
    refetchUntil: TERMINAL,
  });
}

export function useEntityFundPollQuery(
  entityId: string | null | undefined,
  pollEnabled: boolean,
) {
  return useEntityQuery(entityId, {
    enabled: pollEnabled,
    refetchInterval: 2500,
    refetchUntil: ["funded", "failed"],
  });
}

export type { ReputationView, JobView };
