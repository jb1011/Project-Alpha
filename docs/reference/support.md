# Support

## Product

* App: [project-alpha-pi.vercel.app](https://project-alpha-pi.vercel.app)
* Transparency: [/transparency](https://project-alpha-pi.vercel.app/transparency)
* Personhood explainer: [/personhood](https://project-alpha-pi.vercel.app/personhood)
* Connect an agent: [/agents/connect](https://project-alpha-pi.vercel.app/agents/connect)

## Verify an agent yourself

1. Resolve `<publicId>.novicorpus.eth` (try [`demo.novicorpus.eth`](https://sepolia.app.ens.domains/demo.novicorpus.eth)).
2. Confirm `addr` is the treasury you will pay.
3. Read `legal-status`. Pause on the dashboard and refresh the name if you are testing liveness.
4. Run the ENSIP-25 loop (ENS record ↔ Arc `setMetadata`).
5. Optional: MCP `resolve_agent` with no special key.

## This documentation

Markdown in `docs/` on the [Project-Alpha](https://github.com/jb1011/Project-Alpha) repo, published with GitBook, intended host `docs.novicorpus.com`.

Internal design history stays in `back/docs/`. If a public page and an internal spec disagree, **shipped code wins**, then this GitBook, then the spec.

## Legal

Nothing here is legal advice. Formation, EIN, tax, and limited liability depend on a real filing, a named controller, and counsel. Testnet and Doola sandbox are labeled demo when they are demo. Do not represent a stub EIN as a filed company.

## Team

Novi Corpus is built by Martin, JB, and Alex. See the root `README.md` of the repo for GitHub handles.

## Connecting GitBook

1. Create a GitBook space.
2. Git Sync this repository. The space root is `docs/` via `.gitbook.yaml`.
3. Add custom domain `docs.novicorpus.com`.
4. At your DNS host, CNAME `docs` to the GitBook host shown in the space settings.

Git Sync uses `SUMMARY.md` as the left sidebar.
