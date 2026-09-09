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
  agentBookRegister,
  agentBookSession,
  bootstrapConnection,
  cancelCompanyPayment,
  createCompany,
  createConnectionPackage,
  createFormationParty,
  entityAgentBook,
  executePolicyUpdate,
  fetchAgentSchema,
  fundEntity,
  getEntity,
  getEntityReputation,
  getEntityRuns,
  getCompany,
  getCompanyCompliance,
  getCompanyPayment,
  getEntityTreasury,
  getNonce,
  getPasskeyChallenge,
  getPublicConfig,
  listApiKeys,
  listCompanies,
  listEntities,
  listEntityJobs,
  fetchFormationRules,
  listPasskeys,
  onboardEntity,
  patchPerTxCap,
  patchTrustPolicy,
  requoteCompanyPayment,
  revokeApiKey,
  revokePasskey,
  schedulePolicyUpdate,
  settleCompanyPayment,
  storePasskey,
  updateCompanyIntake,
  updateCompanyParty,
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
import { ApiError } from "./types";
import type {
  AgentBookRegisterBody,
  AgentSpec,
  BootstrapPackage,
  Capability,
  CompanyIntakeInput,
  CompanyIntakeUpdate,
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
      companyId,
    }: {
      spec: AgentSpec;
      guardianPasskey: GuardianPasskey;
      idempotencyKey?: string;
      custody?: "turnkey" | "circle";
      /** The company this agent ATTACHES to (§7, A3). Never a party handle: that door is gone,
       *  and the backend refuses one rather than ignoring it. */
      companyId?: string;
    }) => {
      const token = await ensureToken();
      return onboardEntity(token, spec, guardianPasskey, idempotencyKey, custody, companyId);
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

/* ── COMPANIES (design §7) ─────────────────────────────────────────────────── */

/**
 * The intake RULES, fetched ONCE per page and never again.
 *
 * Build-time constants on the backend, so they change on a deploy and not on a request — the same
 * reasoning `usePublicConfigQuery` uses, and the same `staleTime`. Public, so no token and no
 * token in the key.
 */
export function useFormationRulesQuery(enabled = true) {
  return useQuery({
    queryKey: apiKeys.formationRules(),
    queryFn: fetchFormationRules,
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/**
 * The tenant's companies, NEWEST FIRST — the ordering the picker's default depends on, taken from
 * the server rather than re-sorted here.
 *
 * `staleTime` because React Query's default is ZERO, which means every mount of every component
 * that asks for this list issues a request: the wizard's legal-body step, the Companies page, and
 * a back-navigation between them. A company list changes when its owner creates or edits one, and
 * both writers already invalidate this exact key — so a refetch on mount is a request that can
 * only ever return what the cache is holding.
 *
 * Five minutes rather than `Infinity`: the FILING moves without anybody clicking (the sub-saga
 * runs on its own clock), so a list left open should eventually catch up on its own.
 */
export const COMPANY_STALE_MS = 5 * 60 * 1000;

export function useCompaniesQuery(enabled = true) {
  const token = useAuthToken();
  return useQuery({
    queryKey: apiKeys.companies(token ?? ""),
    queryFn: () => listCompanies(token!),
    enabled: enabled && !!token,
    staleTime: COMPANY_STALE_MS,
  });
}

/**
 * ONE company, in full.
 *
 * `enabled` is how the wizard SKIPS this fetch entirely: the legal-body step already holds the
 * row the user picked (`session.company`), and the two screens after it need exactly two of its
 * fields — the environment and the state. Handing them the row they have removes a beat of
 * `loading` on the confirm screen, during which the submit is blocked because the environment
 * cannot be named.
 *
 * ⚠ It is `enabled` and NOT React Query's `initialData`, deliberately. The carried row is a LIST
 * row (`CompanyView`); this query's shape is the DETAIL (`CompanyDetailView`), whose extra fields
 * include `park` — three booleans the Companies page destructures. Seeding a partial under this
 * key would write it into the SHARED cache, and the next surface to read that key (the company
 * page, the dashboard's formation card) would read a row whose type promises `park` and whose
 * value has none. Not fetching is the honest version of the same optimisation.
 *
 * The fetch is the fallback and not an optimisation to skip: a freshly CREATED company has no
 * carried row, and a page opened cold has none either.
 */
export function useCompanyQuery(
  companyId: string | null | undefined,
  options?: { enabled?: boolean },
) {
  const token = useAuthToken();
  return useQuery({
    queryKey: apiKeys.company(token ?? "", companyId ?? ""),
    queryFn: () => getCompany(token!, companyId!),
    enabled: (options?.enabled ?? true) && !!token && !!companyId,
    // Same reasoning as the list, and it matters more here: THREE surfaces mount this query for
    // the same company (the dashboard's formation card, the wizard's confirm screen, the company
    // page), and at React Query's default `staleTime: 0` each mount is its own request for a row
    // the cache already has. The two writers that can change it — the intake edit and the party
    // edit — invalidate this key by hand.
    staleTime: COMPANY_STALE_MS,
  });
}

/**
 * The compliance calendar. LAZY BY CONSTRUCTION on both sides.
 *
 * The backend fetches it from the filing agent on view and caches it for a day; this asks only
 * when the section that shows it is mounted, and does not retry a refusal — "the provider did not
 * answer" is a fact worth showing once with a retry button, not a loop against somebody else's
 * outage.
 */
export function useCompanyComplianceQuery(companyId: string | null | undefined, enabled = true) {
  const token = useAuthToken();
  return useQuery({
    queryKey: apiKeys.companyCompliance(token ?? "", companyId ?? ""),
    queryFn: () => getCompanyCompliance(token!, companyId!),
    enabled: enabled && !!token && !!companyId,
    retry: false,
    staleTime: 5 * 60 * 1000,
  });
}

/**
 * Create the legal body (design §5/§7).
 *
 * ⚠ A MUTATION, never a query, and for a reason beyond the HTTP verb: this call may carry an SSN,
 * React Query keys live in memory for the life of the page and are the first thing a devtools
 * panel prints, and a query would put the intake in one. The hook takes the value, hands it to
 * the client, and keeps nothing.
 */
export function useCreateCompanyMutation() {
  const queryClient = useQueryClient();
  const ensureToken = useEnsureAuthToken();
  return useMutation({
    mutationFn: async (intake: CompanyIntakeInput) => createCompany(await ensureToken(), intake),
    onSuccess: async () => {
      const token = await ensureToken();
      // MARK STALE, do not refetch — and do not AWAIT one.
      //
      // `invalidateQueries` refetches every ACTIVE observer of the key and returns a promise that
      // resolves when they have all answered; awaiting it inside `onSuccess` holds
      // `mutation.isPending` open until then. So the wizard's "Create the company" button stayed
      // in its loading state through a second round trip for a list the very next screen does not
      // read — and if that refetch failed, the create looked like it had failed too.
      //
      // The list this marks stale is re-read when something mounts it, which is the next time it
      // is actually looked at.
      queryClient.invalidateQueries({
        queryKey: apiKeys.companies(token),
        refetchType: "none",
      });
    },
  });
}

/** The §4.7 edit-and-retry. A mutation for the same reason the create is one — it can carry an
 *  SSN — and it invalidates the company it reopened, whose park state has just changed. */
export function useUpdateCompanyIntakeMutation(companyId: string) {
  const queryClient = useQueryClient();
  const ensureToken = useEnsureAuthToken();
  return useMutation({
    mutationFn: async (intake: CompanyIntakeUpdate) =>
      updateCompanyIntake(await ensureToken(), companyId, intake),
    onSuccess: async () => {
      const token = await ensureToken();
      await queryClient.invalidateQueries({ queryKey: apiKeys.company(token, companyId) });
      await queryClient.invalidateQueries({ queryKey: apiKeys.companies(token) });
    },
  });
}

/**
 * Correct the responsible person on a filing the provider refused (§7).
 *
 * A mutation for the reason `useCreateFormationPartyMutation` is one: personal data must never
 * become a React Query key. It invalidates the COMPANY, because what visibly changed is that
 * company's park state — the identity itself is never rendered anywhere.
 *
 * `companyId` is REQUIRED, and it is the door's own address since the backend re-keyed it: the
 * party is resolved from the company rather than named by the caller. It was optional, with a
 * `if (!companyId) return` guard in `onSuccess` that no call site could reach — a dead branch
 * that would have silently skipped the invalidation if one ever did.
 */
/**
 * ── FORMATION PAYMENTS (design §6) ──────────────────────────────────────────────────────────
 *
 * The hook layer's whole job here is to make "sign once per quote" the only expressible flow:
 * the query is the ONLY source of a signable quote and stops serving one the instant a broadcast
 * is in flight, and there is no mutation that could produce a second signature for the same
 * nonce.
 *
 * `refetchInterval` is the poll §6 asks for. It runs ONLY while the payment is genuinely in
 * motion — `settling`, or a `quoted` row somebody is looking at — and stops dead on every
 * terminal state, so a settled company does not poll its receipt forever.
 */
export function useCompanyPaymentQuery(
  companyId: string | null | undefined,
  options?: { enabled?: boolean; pollMs?: number },
) {
  const token = useAuthToken();
  return useQuery({
    queryKey: apiKeys.companyPayment(token ?? "", companyId ?? ""),
    queryFn: () => getCompanyPayment(token!, companyId!),
    enabled: (options?.enabled ?? true) && !!token && !!companyId,
    // NO staleTime, unlike its siblings: this row changes underneath the page (the sweeper
    // resolves a stalled settle) and a cached "settling" shown for a minute is the one thing that
    // would make a guardian reach for a second signature.
    staleTime: 0,
    // A 404 is the honest answer on a deployment that does not charge, and on a company with no
    // payment at all. Retrying it is a loop against a fact.
    retry: false,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status === "settling") return options?.pollMs ?? 4000;
      if (status === "quoted") return options?.pollMs ?? 10_000;
      return false;
    },
  });
}

/**
 * Submit the guardian's signature.
 *
 * It invalidates the payment AND the company, because both change at once when a settle
 * confirms: the payment becomes `settled` and the company leaves `draft` for `ready`. A page that
 * refreshed only the first would show a paid payment beside a company still described as unpaid.
 */
export function useSettleCompanyPaymentMutation(companyId: string) {
  const queryClient = useQueryClient();
  const ensureToken = useEnsureAuthToken();
  return useMutation({
    mutationFn: async (body: { signature: `0x${string}`; from: `0x${string}` }) =>
      settleCompanyPayment(await ensureToken(), companyId, body),
    onSuccess: async () => {
      const token = await ensureToken();
      await queryClient.invalidateQueries({ queryKey: apiKeys.companyPayment(token, companyId) });
      await queryClient.invalidateQueries({ queryKey: apiKeys.company(token, companyId) });
      queryClient.invalidateQueries({ queryKey: apiKeys.companies(token), refetchType: "none" });
    },
  });
}

/** The guardian's cancel — a SECOND signature, over a different message. */
export function useCancelCompanyPaymentMutation(companyId: string) {
  const queryClient = useQueryClient();
  const ensureToken = useEnsureAuthToken();
  return useMutation({
    mutationFn: async (body: { signature: `0x${string}` }) =>
      cancelCompanyPayment(await ensureToken(), companyId, body),
    onSuccess: async () => {
      const token = await ensureToken();
      await queryClient.invalidateQueries({ queryKey: apiKeys.companyPayment(token, companyId) });
    },
  });
}

/** A new quote with a new nonce. Refused by the backend while anything is live. */
export function useRequoteCompanyPaymentMutation(companyId: string) {
  const queryClient = useQueryClient();
  const ensureToken = useEnsureAuthToken();
  return useMutation({
    mutationFn: async () => requoteCompanyPayment(await ensureToken(), companyId),
    onSuccess: async () => {
      const token = await ensureToken();
      await queryClient.invalidateQueries({ queryKey: apiKeys.companyPayment(token, companyId) });
    },
  });
}

export function useUpdateCompanyPartyMutation(companyId: string) {
  const queryClient = useQueryClient();
  const ensureToken = useEnsureAuthToken();
  return useMutation({
    mutationFn: async (body: FormationPartyInput) =>
      updateCompanyParty(await ensureToken(), companyId, body),
    onSuccess: async () => {
      const token = await ensureToken();
      await queryClient.invalidateQueries({ queryKey: apiKeys.company(token, companyId) });
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

/* ── AgentBook mutations ──────────────────────────────────────────────────── */

/**
 * Open a vouch session.
 *
 * This DOES move the status view even though nothing is registered yet: the route inserts a
 * `pending` row and the GET serves the latest row, so the chip reads `status: "pending"` from here
 * on. No invalidation is wired in, and `useEntityAgentBookQuery` has no `refetchInterval` — the
 * dialog is the only thing that knows when a session opened and when the flow is still in flight,
 * so Task 9 invalidates `apiKeys.entityAgentBook` after this resolves and polls while in flight,
 * rather than every dashboard paying for a poll it does not need.
 */
export function useAgentBookSessionMutation(entityId: string) {
  const ensureToken = useEnsureAuthToken();

  return useMutation({
    mutationFn: async () => {
      const token = await ensureToken();
      return agentBookSession(token, entityId);
    },
  });
}

/**
 * Submit the World ID proof.
 *
 * `onSettled`, not `onSuccess`: the failures here move the stored row too — a 409 means a
 * registration is already in flight, and a 400 `proof_rejected` fails the row with an `errorCode`
 * (the chip does not render the code; it falls through to the chain's answer, which for a row that
 * never broadcast is the whole truth). Refetching only on success would leave the chip stale in
 * exactly the cases the guardian most needs to see.
 *
 * Two different tokens on purpose. The REQUEST takes the ensured one, because the World App round
 * trip between session and register is minutes long and the session may have been refreshed in
 * between. The invalidation KEY takes the rendered one, which is what `useEntityAgentBookQuery`
 * keyed its cache entry with — an ensured token that had just rotated would build a key matching
 * no cached query and silently invalidate nothing.
 */
export function useAgentBookRegisterMutation(entityId: string) {
  const queryClient = useQueryClient();
  const token = useAuthToken();
  const ensureToken = useEnsureAuthToken();

  return useMutation({
    mutationFn: async (body: AgentBookRegisterBody) => {
      // Ensuring the token can prompt a SIWE signature, and the guardian may dismiss it. That
      // failure is PRE-FLIGHT: no request left the browser. Left as a bare `Error` the classifier
      // would read it as "we do not know" and tell them the registration may still have gone
      // through — a false statement in one of the few cases we positively know nothing was sent.
      let fresh: string;
      try {
        fresh = await ensureToken();
      } catch {
        throw new ApiError(401, { code: "unauthorized", message: "sign-in required" });
      }
      return agentBookRegister(fresh, entityId, body);
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({
        queryKey: apiKeys.entityAgentBook(token ?? "", entityId),
      });
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
