# Architecture critique — Round 4 (final)

## Verdict

**Ready for Phase 3 with three focused, non-blocking polishes.** After the three revision rounds
plus the type-prototype absorption pass, the architecture has converged on a design that is
internally consistent, materially simpler than today's implementation, and concrete where the
original critique called for protocol-level specificity. The four chronic hand-waves the Round-1
critique flagged (LOC inconsistency, service-name escape valves, composite refusal punted,
cross-process safety renamed-not-closed) have each been replaced by concrete prose or concrete
protocols. The remaining issues are doc-shape and small-surface ergonomic questions, not gaps that
require redesign; they can be closed in Phase 3 alongside the first real types without forcing
another round of architecture revision.

The doc is at the upper edge of comfortably-readable length (2602 lines) and shows some seams from
the three rounds of layering, but the seams do not contradict; the Revision-log section
(architecture.md §Revision log, ~L2516–2602) accurately summarises what changed and the new content
slots cleanly into the original structure.

---

## Original critique closure audit

| #   | Issue                                                          | Status                                             | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | -------------------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | LOC budget internally inconsistent with goals doc              | **Resolved (by user directive + Round-2 reframe)** | LOC framing is out by user direction; replaced by the qualitative §Simplicity posture / §Discipline mechanism (~L2449–2513). Per the brief I am not critiquing absence of LOC numbers; the replacement framing is reviewed in its own section below.                                                                                                                                                                                                                                                                                                                                                                              |
| C2  | "Engine knows zero service names" had unenforced escape valves | **Resolved**                                       | The four escape valves named in the original critique are each closed in the doc: (a) manifest envelope is name-blind, with the typed per-service projection delegated to plugins (§Component placement L304, §Manifest L1026–1046); (b) lifeness classification is plugin-emitted via a `LifenessClassifier` capability (Decision §10, L1701–1714); (c) funds-ready is a `gate:funds-ready` strategy-registry slot, not an engine primitive (NetworkResolver §5, L527–537); (d) the cascade formatter is moved to L0 observability as a pure function, callable from CLI, TUI, and prune (Substrate violations §20, L1973–1978). |
| C3  | Composite refusal type-level work was deferred to Phase 3      | **Resolved**                                       | Tension 11 (L1815–1872) now commits to type-level refusal AND runtime refusal, both first-class. The prototype proved it works (mode-narrowed factory namespaces + phantom-typed cross-plugin witnesses). The dual-surface decision (flat + callback) closes the only ergonomic gap. See "Internal consistency" below for one residual nuance.                                                                                                                                                                                                                                                                                    |
| C4  | Cross-process safety lifecycle gap renamed not closed          | **Resolved**                                       | §Cross-process safety protocol (L1328–1495) is now a concrete protocol: `stack.lock` (exclusive advisory), `roster.json` (typed schema, sweep + heartbeat + last-leaver), `snapshot.reservation` (`O_EXCL` file). Every scenario the original critique called out — A-mid-restart-while-B-starts, A-crashes-between-claim-and-release, concurrent snapshot — has its own subsection with the right answer. The previous "shared read locks" muddle is explicitly retracted (L1352–1357).                                                                                                                                          |
| C5  | Capability contracts under-specified at composition points     | **Resolved**                                       | The Walrus 7-contract walkthrough (L2174–2265) is the worked example the critique asked for. It picks up the three specific composition points (label tuples vs composite key; chain-probe shared between codegen and verify; lifted-sibling vs dispatch-id namespacing) and resolves each. ChainProbe is now contract #9 (L740–791); OCA is explicitly named L0 substrate, not a contract (L796–800).                                                                                                                                                                                                                            |
| G1  | Build-container's relationship to ContainerRuntime             | **Resolved**                                       | Decision §5 (L1613–1658): build-container is a _consumer_ of ContainerRuntime, not a sibling sub-runtime. The recreate policy enum (`'on-failure' \| 'never' \| 'on-config-change'`) is added to ContainerRuntime's contract to encode the "reject auto-recreate-on-resume-failed" rule that S1 flagged.                                                                                                                                                                                                                                                                                                                          |
| G2  | Renderer subscribable projection field-list                    | **Resolved**                                       | §Subscribable projection (L860–926) enumerates the top-level state + Row + Endpoint + ErrorEntry + BuildEntry shapes. An explicit "Fields explicitly NOT in the projection" paragraph (L915–919) calls out `title` / `primary` / `extras` and routes them to renderer-derived types. The prototype's Scenario F proved this is enforceable as a type-level invariant.                                                                                                                                                                                                                                                             |
| G3  | Lifted-sibling key conventions                                 | **Resolved**                                       | §Lifted-sibling key conventions (L632–714) gives the four-field key shape `(plugin, kind, scope, inputHash)`, the namespace boundary discipline (typed namespace declaration, not string-match), the dedup contract (first-wins / refuse / never-dedup), and the literal-vs-runtime regime distinction the prototype surfaced.                                                                                                                                                                                                                                                                                                    |

**Net: 8 of 8 closed.** None regressed; none renamed without substantive content. The C1 closure is
by directive rather than by edit, but that was the user's call and is in scope.

---

## Type-prototype absorption audit

The prototype surfaced six items the architecture had to absorb.

| #   | Finding                                      | Landed cleanly?                   | Where                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | -------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Third `Caps` generic on `StackMember`        | **Yes**                           | Plugin instance data model (L978–992) spells out that the substrate-level plugin type carries provided tag + consumed tags + capability set, and that "erasing the capability set to its widened form collapses codegen consumer types to `never`" — direct echo of the prototype's finding #1. Phase 3 type-system rules (L2406–2410) makes it mechanical: "Capability declarations use a typed builder, not raw arrays." |
| 2   | Phantom variance: return-position only       | **Yes**                           | Phase 3 type-system rules (L2394–2405) gives this as a mechanical rule with the exact reasoning ("parameter-position encoding looks superficially equivalent but is contravariant on its phantom; the prototype showed it silently widens to `unknown`"). Explicit list of phantoms it applies to (tag identity, capability emit-shape, cross-plugin witnesses).                                                           |
| 3   | Network threading: callback vs flat variadic | **Yes**                           | Tension 11's resolution (L1837–1864) now lists both surfaces as first-class. Pick-one is replaced with "expose both, they cover disjoint ergonomic cases." Round 3 revision log (L2536–2539) confirms this is intentional.                                                                                                                                                                                                 |
| 4   | Literal vs runtime `inputHash` regimes       | **Yes**                           | Lifted-sibling key conventions (L656–686) describes both regimes explicitly: literal-typed hash → compile-time refusal (strict improvement on the original spec); runtime-computed hash → compose-time refusal. The Pseudo-example (L705–713) shows it concretely.                                                                                                                                                         |
| 5   | Tag covariance soundness gap                 | **Yes, with explicit acceptance** | NodePlugin §Tag usage constraint (L396–410) documents the constraint, names the runtime regime that keeps it sound ("constructed once at the plugin's barrel and imported where needed; tag objects are not passed around as data"), and flags the future direction if the assumption breaks ("a bivariant or invariant phantom encoding closes the gap at the cost of ergonomic ceremony").                               |
| 6   | Typed builder for capabilities               | **Yes**                           | Open question #10 (L2123–2131) commits the default to **yes** with the rationale ("forgetting `as const` silently widens the tuple element types and erases the per-decl narrow information"). Phase 3 type-system rules (L2406–2410) makes it mechanical.                                                                                                                                                                 |

**Net: 6 of 6 absorbed cleanly.** No new contradictions surfaced in adjacent sections; the additions
slot under the right contract or data-model heading.

One minor friction: the Plugin instance data-model paragraph (L978–992) describes capabilities as a
structural part of the substrate-level type, but the NodePlugin contract itself (L349–410) still
describes capabilities loosely ("zero or more capability declarations" — L364). The two are
consistent — the contract is prose; the data-model paragraph is the type-level binding — but a
Phase-3 reader skimming only the contract section won't see the Caps-generic requirement. Not a
contradiction, but worth a cross-link.

---

## Synthesis coverage audit

### 24 first-class concepts

Re-walking the Round-1 table against the current doc: of the seven items the Round-1 critique
flagged as hand-waved (#3 composite refusal key conventions, #4 lifted siblings, #8 one-shot
interplay, #12 Codegenable resolve-once-extras home, #15 display projection, #19 cross-process
safety, #22 resolve-once user extras), **six are now resolved**:

- #3 / #4 — Lifted-sibling key conventions (L632–714) closes both.
- #12 / #22 — Codegenable substrate provides "resolve-once memoization of user extras (one factory
  call per acquire; one resolved blob threaded through every emitter)" (L565–566). Pinned to L3
  acquire by §Decision §1 (manifest writer is L3) and the Walrus walkthrough explicitly says
  "computed once and threaded into both verify and codegen" (L2243–2245).
- #15 — Subscribable projection field-list enumeration (L860–926).
- #19 — Cross-process safety protocol (L1328–1495).

The one remaining hand-wave in the 24-concept list is **#8 one-shot effect interplay with
hot-restart cascade**. The one-shot lifecycle section (L1309–1325) keeps the "optional
discriminator-as-Effect re-yielded on every cycle" behavior, and the Pressure test §5 walkthrough
(L2285–2293) calls this out as "One-shot consumers that are `done` re-evaluate via the optional
discriminator-as-Effect (re-yielded on every cycle; cache hits collapse to immediate `done`)." This
is more than the Round-1 critique credited, but it's still on the prose side of the line — a Phase-3
implementer needs to know whether the re-yield happens _automatically_ (substrate-driven) or whether
the plugin opts in. Worth one sentence in Phase 3; not worth blocking Phase 3 on.

**Net (24 concepts): 23 resolved, 1 lightly hand-waved (1-sentence fix away).**

### 11 deferred layering decisions

All 11 still resolved. The three the original critique flagged as "resolved at decision-level but
hand-waved at contract level" (#5 build-container, #8 renderer mount, #10 state-store boundary) each
have closure prose now:

- #5 — Decision §5 (L1613–1658) now picks "ContainerRuntime consumer, not sibling sub-runtime," with
  the recreate-policy enum encoding the policy difference.
- #8 — Decision §8 (L1674–1678) names the mechanism (process-lifetime state-ref + event stream), and
  §Subscribable projection enumerates contents.
- #10 — Decision §10 (L1686–1727) splits L0 (mechanical file + schema) from L3 (lifeness
  classification dispatched per-plugin). This is the right shape; the original critique's concern
  about L3 knowing classification rules is closed because the rules now live in plugin-emitted
  classifiers.

**Net: 11 of 11 resolved at the contract level.**

### 20 substrate violations

All 20 still structurally prevented. The one the original critique flagged as "addressed but doesn't
compose with the surface boundaries" — #20 cascade formatter — is now in L0 observability as a pure
function (L1973–1978), callable from CLI, TUI, and prune orchestrator without the renderer→CLI
back-import the Round-1 critique worried about.

**Net: 20 of 20 prevented.**

### 15 tensions

All 15 still resolved. The two the Round-1 critique flagged (#11 composite refusal deferred, #12
two-stop-finalizers hand-waved) are now both concrete:

- #11 — Tension 11 (L1815–1872): type + runtime refusal both first-class, dual surface (flat +
  callback) committed.
- #12 — Tension 12 (L1874–1882): explicitly defers to the §Cross-process safety protocol section.

**Net: 15 of 15 resolved.**

---

## Pressure-test audit

The original critique scored 6/11 convincing, 5/11 hand-waved. Walking the same list against the
current doc:

| #   | Hard case                                   | Status now              | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Composite primitives with lifted siblings   | **Pass**                | Now grounded in the §Lifted-sibling key conventions section. The previous S6 hand-wave is closed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 2   | Walrus 4-shard sharing one image build      | **Pass**                | Walrus walkthrough (L2174–2265) shows the two-Walrus-composites case explicitly (L2253–2258); per-app vs per-stack dedup is decided by `scope` field.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 3   | Seal keygen-then-deploy-once                | **Pass**                | Direct OCA + Snapshotable mapping. Untouched and uncontroversial.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 4   | Sui fork-from-live                          | **Pass**                | Pressure test §4 (L2275–2283) explicitly names "fresh scope per compose" as substrate-default ("strategy registries are scope-local; each compose gets a fresh scope by construction"). The Round-1 critique's "the architecture never names the scope boundary" is closed.                                                                                                                                                                                                                                                                                                     |
| 5   | Selective restart through composite         | **Partial → near-pass** | One-shot re-evaluation is named (L2290–2293) but the "automatic or opt-in" question (Round-3 audit, concept #8 above) is still a sentence away.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 6   | Parallel stacks sharing port broker etc.    | **Pass**                | The cross-process case (= #11) and the in-process parallel-stack case (= #6) are correctly separated. Pressure test #6 (L2295–2300) covers in-process; #11 covers cross-process.                                                                                                                                                                                                                                                                                                                                                                                                |
| 7   | Live-network service depending on local     | **Pass**                | Unchanged; uncontroversial.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 8   | Hot-restart mid-TUI                         | **Pass**                | The §Subscribable projection field-list (L860–926) makes the contract concrete.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 9   | Action depending on 5 services              | **Pass**                | OCA one-shot specialization with five upstream keys.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 10  | Codegen artifacts before example dev server | **Pass with caveat**    | Pressure test §10 (L2322–2333) now answers it: "supervisor's `stack.ready` event fires only after codegen has emitted. Vite's start command is gated on `stack.ready` either via the supervisor (when supervisor drives the dev server) or via a polling read of the manifest manifestVersion field (when Vite owns its own startup)." The earlier critique's worry (Vite either engine-aware or polling) is acknowledged and both paths are committed. The caveat: "supervisor drives the dev server" is a non-trivial new supervisor responsibility — see "New issues" below. |
| 11  | Cross-process two-`pnpm dev`                | **Pass**                | Maps to §Cross-process safety protocol cleanly.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

**Net: 10 pass + 1 near-pass (concept #8 sentence away). 0 hand-waved.** This is a substantial
improvement from 6/11. The remaining sliver on #5 is the same one-sentence-fix item that appears in
the 24-concept audit.

---

## New issues surfaced by this round

Issues that didn't exist or weren't visible in the Round-1 critique state of the doc:

### N1. Tension 11's dual-surface decision and the flat form's interaction with composite refusal

The Round-1 critique's C3 closure relied on type-level mode narrowing working. The prototype proved
that **for the callback form**, the mode narrows automatically — `Walrus.localCluster()` isn't on
the fork-mode namespace, full stop, compile-time refusal. But the architecture now also commits to
the **flat-variadic form** as a first-class surface (L1845–1851), where the user threads network
explicitly: `Walrus.for(network).localCluster()`.

The flat form gets type-level refusal _only if the user explicitly threads_. If a user writes
`Walrus.localCluster()` directly in the flat form (no `.for(network)` threading), the factory has no
network-narrowing to do — it returns a value that has to be runtime-refused when the stack composes.
The architecture lists this in passing ("runtime refusal remains as defense-in-depth for dynamic
factory selection" — L1833–1835) but it doesn't make the implication explicit: **the flat form's
type-level refusal is opt-in by ceremony; the callback form's is automatic**. A Phase-3 author who
reads only the Round-1 closure of C3 may believe type-level refusal is universal; it isn't, on the
flat form. Recommend one sentence in Tension 11 saying so.

This is not a regression. It's a fact the dual-surface decision brings with it, that the doc could
state more explicitly.

### N2. "Supervisor drives the dev server" as a new responsibility

Pressure test §10 (L2326) introduces "the supervisor (when supervisor drives the dev server)" as a
way to gate Vite on `stack.ready`. The L0 supervisor section (Decision §3, L1552–1583) does not list
this responsibility. Supervisor's listed scope is "boot identity, consult network resolver, run
scheduler, fire shutdown finalizers, emit lifecycle events" — driving an external dev-server process
isn't in that set.

Two ways to close: (a) say the supervisor doesn't drive dev-servers (Vite always polls the
manifest), (b) add "optional process-spawning for dev-servers" to the supervisor's L0 responsibility
list. Either is fine; the doc as written has it both ways. This is a small incoherence between
Decision §3 and Pressure test §10.

### N3. NodePlugin contract's prose doesn't reflect Caps-generic requirement

Plugin instance data model (L978–992) is the canonical statement of the Caps generic. NodePlugin
contract (L349–410) describes capabilities as "zero or more capability declarations." A Phase-3
implementer reading just the contract section will not realise the capability tuple must be a
generic-typed array; they'll see it in the data-model paragraph (which is the right place) but the
contract section should at least forward-reference it.

### N4. The "fields NOT in projection" list relies on display-rule conventions for `title`

§Subscribable projection L915–919 says `title` is computed by renderers from `key` + display rules.
The display rules for composite vs leaf vs renderer rows are not specified. Today's TUI applies
different display conventions to composites (the composite row shows aggregated narration; the
children are folded). This convention is reachable from the projection (via `kind` and
`compositeChildren`), but the doc doesn't say which renderer is responsible for which convention.
Minor — Phase 3 will surface it naturally when the TUI is rewritten — but worth flagging.

### N5. The Walrus walkthrough mentions OCA "Optional"

L2219–2222: "Walrus calls OnChainArtifactPublisher (L0 substrate) for its deploy receipt — a typed
one-shot…" listed as "Optional." The walkthrough then proceeds as if it's a seventh+ touched
contract (the prose says "seven contracts on one plugin" earlier in the critique's framing). If OCA
is "optional" for Walrus, the worst-case ceiling is the seven listed contracts; if it's effectively
present, the ceiling is eight. The doc doesn't quite commit. Cosmetic; the walkthrough is doing what
was asked.

---

## Simplicity discipline assessment

The §Simplicity posture / §Discipline mechanism block (L2449–2513) replaces the old LOC framing per
user directive. Is it operational?

**Mostly yes.** The four diagnostic prompts in §Discipline mechanism (L2493–2506) are concrete
enough that a Phase-3 implementer can apply them:

1. _"Lift a per-plugin reinvention into a substrate primitive."_ Operational. There's a clear test:
   are two plugins doing the same thing? If yes, that's the substrate primitive.
2. _"Strengthen a capability contract."_ Operational. Test: does an orchestrator want to
   special-case a service? If yes, extend the capability decl.
3. _"Drop an explicitly-listed deferred feature back in scope."_ Operational (and rare, as stated).
4. _"Accept the complexity with a written justification."_ Operational in the social sense (open a
   checkpoint with the user).

The four "what we measure simplicity by" prompts (L2455–2475) are also operational:

- **Concepts to hold** — counted (5 layers, 9 contracts, 1 SM, 1 event stream + command channel).
- **Places a new plugin author looks** — bounded (one folder, one contract, optional caps).
- **Escape hatches the substrate ships** — zero is the target, and the list of removed escape
  hatches makes the count auditable.
- **Capability contracts a typical plugin participates in** — "1–3 for typical; 7 for Walrus, the
  deliberate ceiling."

The one operational gap: there's no explicit test for "this layer is larger than it should be." The
doc says (L2508–2512) "If a layer ends up materially larger than the current implementation's
corresponding piece, that re-opens the design — but the question 'why is this larger?' is the
architectural one, not 'did we breach a budget?'" Fine in principle, but "materially larger" is not
defined. In practice this won't matter — the dispatch is into the four diagnostic prompts, which are
concrete — but a Phase-3 author who finds an ambiguous case has nowhere obvious to triangulate.
Acceptable, but the discipline lever is qualitative; it leans on the implementer's taste, not a
mechanical check.

**Verdict on the simplicity framing: operational, with one acknowledged hand-wave on "how big is too
big" that is unlikely to bite in practice.**

---

## Doc readability

The doc is 2602 lines, organised as:

- Overview + layer model (~L1–290)
- Component placement table (~L290–340)
- Nine capability contracts (~L340–940)
- Data models (~L940–1160)
- Lifecycle / state management (~L1160–1330)
- Cross-process safety protocol (~L1330–1500)
- Decisions on the 11 deferred layering questions (~L1500–1750)
- Tensions resolved (~L1750–1905)
- Substrate violations (~L1905–1980)
- Effect (~L1980–2005)
- Collapsed / deferred / dropped (~L2005–2095)
- Open questions for user (~L2095–2150)
- Pressure-test walkthroughs (~L2150–2350)
- Implementation hint sketch (~L2350–2450)
- Simplicity posture + Discipline mechanism (~L2450–2515)
- Revision log (~L2515–2602)

**Navigability for "I need to understand one decision."** Strong. The TOC-by-heading scheme means
each decision has one canonical home, and the cross-references (e.g., Tension 12 → §Cross-process
safety protocol) point at the right place. The Decisions §1–§11 block is particularly well-organised
— each decision has Question / Decision / Reasoning / Consequence in a consistent shape.

**Cross-section consistency.** Good. Spot-checked: Tension 11's mention of "Walrus localCluster
doesn't exist on fork-mode factory" (L1822–1827) matches §Capability contract 8 / Failure modes
(L727–734) matches Walrus walkthrough §NetworkResolver mode (L2246–2252). All three say the same
thing without contradiction.

**Where the doc shows layering seams.** The Revision log (L2516–2602) is itself a tell that the doc
was assembled over three rounds, but the seams don't contradict; they reflect what was added where.
The Phase 3 type-system rules section (L2387–2413) is the most-obviously-Round-3 addition and sits
awkwardly between the Package directory sketch and the Build order — it's mechanical type-system
rules pretending to be implementation hints. A Phase-3 reader who's looking for "what the
substrate's typing discipline is" will find it under Implementation hint sketch rather than where
the contracts live; cosmetic, not a defect.

**Where re-reading would help.**

- §Capability contract 1 (NodePlugin, L349–410) is dense with the Tag constraint (L396–410) added
  Round-3. A new reader might bounce off it without the data-model paragraph (L978–992) for context.
- Pressure test §10 (L2322–2333) and Decision §3 (L1552–1583) should cross-reference: the
  "supervisor drives the dev server" mention in §10 isn't visible from §3 (see N2 above).

**Overall: navigable. The doc is long but appropriately segmented.**

---

## Recommendations

In priority order. Items 1–3 should be closed before Phase 3 starts; 4–6 are Phase-3 startup polish;
7–9 are nice-to-have.

1. **Make the flat-form vs callback-form refusal regime explicit.** One sentence in Tension 11
   (~L1864) saying "On the flat-variadic form, type-level refusal requires explicit per-factory
   network threading (`Walrus.for(network).localCluster()`); without threading, refusal degrades to
   runtime. The callback form makes refusal automatic." This prevents a Phase-3 author from
   mistakenly believing the flat form gets refusal for free. See N1 above.

2. **Resolve the one-shot re-evaluation question (automatic or opt-in).** The "optional
   discriminator-as-Effect re-yielded on every cycle" behavior is documented (L1316–1320,
   L2290–2293) but doesn't say whether the substrate drives the re-yield or the plugin opts in. One
   sentence in §One-shot effect lifecycle. See the synthesis-coverage audit's 24-concept #8 above.

3. **Close N2's supervisor-drives-dev-server ambiguity.** Either add "optional process-spawning for
   dev-servers" to L0 supervisor's listed responsibilities (Decision §3), or remove the "supervisor
   drives the dev server" path from Pressure test §10 and commit to "Vite always polls
   manifestVersion." The inconsistency itself is small; the responsibility list is what Phase 3 will
   rely on.

4. **Forward-reference the Caps generic from NodePlugin contract.** One line at L364 ("a typed
   plugin runtime context, produces a resolved value plus zero or more capability declarations")
   could add "(see § Plugin instance for the substrate-level type representation including the
   capability tuple)." See N3 above.

5. **Cross-link the Phase 3 type-system rules section.** The three rules in §Phase 3 type-system
   implementation rules (L2387–2413) would be more discoverable as cross-references from the
   relevant contract sections (phantom variance ↔ NodePlugin Tag constraint; typed builder ↔
   NodePlugin contract; witness symbols ↔ CompositePrimitive § Lifted-sibling).

6. **In the Walrus walkthrough, commit on whether OCA counts as "touched" or "optional."** Cosmetic,
   but the walkthrough's framing ("seven contracts on one plugin") doesn't match the listed counting
   once OCA is "Optional." See N5 above.

7. **Spell out display-rule conventions for renderer projection.** §Subscribable projection
   (L915–919) says renderers compute `title` from `key` + display rules. The doc could say where
   "display rules" live (per-renderer? a shared display-rules helper in L2 renderers/?). See N4
   above. Not Phase-3-blocking.

8. **Consider tightening the "materially larger than current implementation" check.** The
   Simplicity-discipline section (L2508–2512) leaves this qualitative. Phase 3 won't need a numeric
   answer, but might benefit from naming a few canonical triangulation cases ("if Sui's port lands
   at 2× today's Sui's complexity by any axis, re-open"). Optional; the qualitative framing is
   acceptable as-is.

9. **Optional: sample plugin in pseudo-TypeScript.** The Round-1 critique's last recommendation was
   "write a sample plugin in pseudo-TS for one canonical case." The Walrus walkthrough (L2174–2265)
   covers the architecture-level composition, but a line-level pseudo-plugin (15–30 lines using all
   the contracts) would let Phase 3 verify the ergonomics target. This is Phase-3 work, not Phase-2
   work; recommend kicking off Phase 3 by writing it as the first artifact (alongside contracts).

---

## On the 9-capability-contracts count

The brief asks: is 9 the right number? Could two be collapsed? Is `ChainProbe` actually a contract
or substrate?

**9 is the right number.** Concretely:

- **NodePlugin, ContainerRuntime, Routable, Snapshotable, NetworkResolver, Codegenable,
  StrategyContributor, CompositePrimitive** are all clear contracts — each has a
  plugin-implementable seam that the orchestrators / substrate / user-facing code dispatches
  against. None can be collapsed without the orchestrators acquiring service-name knowledge.

- **ChainProbe** is the borderline case. The doc justifies it as a contract (L783–790): "Today's
  chain-probe lives inside Sui's folder. Lifting it to a contract lets future chains (non-Sui)
  provide their own implementation and lets cache-key folding in OnChainArtifactPublisher consume
  probes without naming Sui." This is correct in shape — ChainProbe is implementation-shaped per
  chain (the RPC surface differs), so it's a plugin-implementable seam, not name-blind substrate.
  But today there's exactly one in-tree provider (Sui). The contract is paying for one consumer.

  The doc explicitly addresses this (L786–790): the substrate-vs-contract distinction is "substrate
  primitives are name-blind reusable code; contracts are plugin-implementable seams." On that test,
  ChainProbe is correctly a contract. The cost is one extra contract in the surface area; the
  benefit is that OCA never names Sui (which the Round-1 critique said it must).

  I'd keep ChainProbe as a contract. The alternative — folding it into `NetworkResolver` — would
  mean NetworkResolver knows about on-chain reads, which it doesn't and shouldn't (NetworkResolver
  resolves config; it doesn't speak chain).

- **OCA** is correctly substrate, not a contract. Plugin authors _call_ it; no plugin implements it.

- **Renderer** is correctly listed as a sub-shape of NodePlugin, not a separate top-level contract.

The Walrus walkthrough validates the count: Walrus touches 6 contracts + optionally OCA + ChainProbe
consumer + ContainerRuntime consumer. That's a deliberate ceiling, and the doc names it as such
(L2473–2475 in §Simplicity posture). A typical plugin will touch NodePlugin + 1–3 caps. The
9-contract count is justified by the maximum, not the typical; a third-party plugin author lands in
the "1–3 contracts" regime and doesn't have to understand all 9.

**Could any be vestigial?** No. Each contract has at least one in-tree user. StrategyContributor is
the most "general," but its in-tree users (faucet, account selection, renderer enumeration, codegen
discovery) are real and don't reduce to any of the others.
