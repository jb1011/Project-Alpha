# Corps Juridique d'Agent — Récapitulatif du Projet

> Document de présentation (FR) — pour onboarder un nouveau développeur sur le projet.

> ⚖️ **Mise à jour (2026-06-15).** (1) **Modèle juridique** : le cadre « mécanisme bavarois / entité
> sans humain » est **juridiquement écarté** (vérifié sur sources primaires) — un **contrôleur personne
> physique (KYC) est obligatoire** (triple verrou : statut WY DAO LLC W.S. 17-31-114 + prong de contrôle
> FinCEN CDD + conditions Circle). Modèle retenu = **contrôleur humain + agent opérateur borné** (le
> « gardien » on-chain EST ce contrôleur). Ne plus présenter « sans humain / totalement autonome ».
> (2) **Avancement** : la Phase 2 (backend) est en réalité **quasi terminée** — voir le
> [README racine](../README.md) pour l'état à jour. Détails juridiques : `research/LEGAL_OPERATIONS.md`.

## En une phrase
On donne aux agents IA autonomes un **vrai corps juridique** : une LLC DAO du Wyoming, une identité on-chain, et une trésorerie en USDC gouvernée par des règles — pour qu'un agent puisse légalement *posséder, signer, être payé et être partie prenante d'un contrat*, sans qu'un humain soit derrière chaque signature.

## Pourquoi c'est important
Aujourd'hui, chaque transaction d'un agent IA se ramène à la signature d'un humain — les agents ne peuvent rien détenir ni s'engager juridiquement *en toute sécurité et de façon redevable*. La loi sur les DAO LLC du Wyoming permet une entité gérée de façon algorithmique sous un **contrôleur humain mince mais obligatoire** (qui passe le KYC et garde l'entité en vie), l'agent opérant de façon autonome **dans des limites définies on-chain**. Jeremy Allaire (Circle) a publiquement dit qu'il adorerait voir une équipe construire exactement ça sur **Circle Agent Stack**. C'est l'opportunité qu'on vise (la subvention Circle / DevRel est notre première cible).

## Comment ça marche
Un développeur amène un agent IA ; notre protocole lui donne un corps en un seul flux :
- **Identité on-chain** — enregistrée sur le registre **ERC-8004** déjà déployé sur Arc (identité + réputation).
- **Trésorerie** *(mis à jour le 2026-06-08)* — une **trésorerie on-chain non-custodiale** : un contrat immuable `AgentTreasury` (par agent) détient l'USDC et applique l'accord d'exploitation on-chain (plafond glissant + allowlist) ; l'agent signe via une **clé non-custodiale Turnkey** dans la limite du plafond ; le registrant humain est **gardien on-chain** (pause / révocation / récupération). *(Plus de wallet de custody Circle — voir `docs/design/2026-06-08-*`.)*
- **Un contrat « constitution »** — notre unique contrat custom, **LegalManager** (un par agent, évolutif), qui détient le hash de l'accord d'exploitation, lie l'identité, et applique les amendements de règles + la dissolution via un processus à délai différé, avec droit de veto d'un gardien.
- **La couche novatrice** — une **traduction droit ⇄ code** : le texte juridique (« ≤ X $/jour vers des contreparties approuvées ») devient des **règles on-chain dans `AgentTreasury`** (plafond glissant + allowlist) appliquées automatiquement, et le hash de l'accord d'exploitation signé est ancré on-chain.
- **Preuve de vie** — l'agent réalise de façon autonome un **job ERC-8183** sur Arc : il accepte une tâche → USDC mis sous séquestre → il soumet un livrable → le règlement verse de l'USDC réel dans son propre wallet → il gagne de la réputation. Tout est vérifiable sur Arcscan.

## La stack
**Arc** (la L1 de Circle, USDC comme gas) · **Circle Agent Stack** (wallets, nanopaiements Gateway/x402, Marketplace) · **ERC-8004** (identité/réputation) + **ERC-8183** (jobs), tous deux réutilisés tels quels sur Arc · un seul contrat custom **LegalManager + Factory** (Solidity/Foundry, proxies beacon OpenZeppelin). Le backend sera en **TypeScript/Node** (SDK Circle), exposé via un assistant web **et** un serveur MCP.

## État d'avancement
- ✅ **Phase 1 — Smart contracts : terminée et auditée.** LegalManager + AgentTreasury (vault immuable) + Factory + intégration ERC-8004/8183, 159 tests au vert (unitaires + fuzz + invariants + sécurité), aucune faille Critical/High, script de déploiement Arc prêt.
- ✅ **Phase 2 — Backend (le cerveau) : quasi terminée.** Construit et testé de bout en bout sur chaîne locale (anvil) : `config`/`secrets`/persistance SQLite, le **traducteur droit→code**, le **générateur d'accord d'exploitation**, l'**adaptateur Arc** (`createEntity` + liaison `setAgentWallet` EIP-712), le **signataire opérateur Turnkey** (non-custodial), la **saga d'onboarding** idempotente/reprenable, et une **CLI**. Reste : le premier run **live sur Arc testnet**.
- ⬜ **Phase 3 — Serveur MCP + assistant web** (deux interfaces fines au-dessus du backend).
- ⬜ **Phase 4 — Agent de démo** (la preuve de vie autonome via ERC-8183).

## Réel vs. simulé (en toute transparence)
Tout ce qui est on-chain + Circle est **réel sur testnet**. Le dépôt officiel auprès de l'État du Wyoming, l'EIN, le KYC et les documents juridiquement validés sont **simulés** et seront activés avec le financement de la Phase 2 + un cabinet juridique.

## Où un nouveau dev s'intègre
Le backend de la Phase 2 est grand ouvert : intégration des wallets Circle, orchestration on-chain (viem/ethers), le moteur de traduction droit→règles, et la génération de documents — des frontières de modules bien nettes, du TDD, et beaucoup à s'approprier.
