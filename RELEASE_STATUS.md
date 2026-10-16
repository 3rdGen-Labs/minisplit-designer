# V1 release candidate

This is a new repository with fresh history for private review. It includes the existing residential design/estimating UI, evaluation API, importer, original generic illustration source, and bundled equipment data. It does not include decompiled Mitsubishi source, research extracts, extraction tools, old Git history, deployment metadata, environment files, or a running MCP server.

## Scope

M & S single-zone, P-Series, MXZ, and single-phase residential Smart Multi. Three-phase Smart Multi models and dedicated datasets, artwork and code paths have been removed. The importer skips those systems with a warning, and stale outdoor IDs fail evaluation. Mitsubishi does list three-phase equipment with residential indoor-unit compatibility; this project excludes it as a V1 scope decision, not a claim that those applications cannot be residential.

## Remaining limitations

- Branch-box elevations between boxes and between boxes and indoor units are not checked.
- Full shared-controller grouping and M-NET addressing are not modeled.
- Additional refrigerant charge is unavailable for some outdoor units; missing piping inputs can leave charge checks at factory charge only.
- City Multi/VRF, load calculations, partial-load/diversity capacity modes and sensible capacity are outside scope.
- DSB import assumptions need verification against representative actual project files. The missing proprietary template test is skipped; synthetic importer tests run.
- Current HTTP APIs have minimal input validation and no application authentication or rate limiting. Hosting limits and fuller request validation are needed for an advertised public API.

The test suite does not establish engineering certification or agreement with current manufacturer documentation. Before general release, compare representative real designs and boundary cases against current manufacturer tools/manuals: accepted/rejected combinations, controls, accessories, piping, charge, R454B room/mounting requirements, capacities and BOM. Report discrepancies and keep verification notices visible. No claim is made that every manufacturer rule is implemented.

## Public-release blockers

The equipment JSON remains derived from an extracted manufacturer database; removing raw extracts or decompiled code does not establish redistribution rights for these bundles. The engine was implemented from reverse-engineering notes, and its provenance still needs review. Review actual software terms and permissions with an IP lawyer. LICENSE_SCOPE.md excludes uncleared materials from the license grant. Keep this candidate private until the data/implementation review and asset ownership checks are resolved.

The current production dependency audit reports 7 advisories (5 high, 2 moderate), involving sharp and PostCSS. Resolve or document applicability of each against the final deployed dependency versions. Third-party package and asset terms remain applicable.

This candidate is suitable for reviewing a bounded V1 scope; it is not yet cleared for a public open source launch.

## Software checks on this fresh snapshot

A frozen-lockfile install succeeded from a new `node_modules` directory. The test suite passed 55 tests with 1 proprietary-template test skipped. Production build and type checks passed; lint reported 7 warnings and no errors. Regression tests cover physical data removal, retained single-phase models, stale outdoor IDs, DSB import exclusions and regeneration filtering. These checks do not replace the manufacturer-result comparisons described above.
