# V1 release notes

This repository contains a fresh snapshot of the residential V1 reference tool. It includes the existing residential design/estimating UI, evaluation API, importer, original generic illustration source, and bundled equipment data. It does not include decompiled Mitsubishi source, research extracts, extraction tools, old Git history, deployment metadata, environment files, or a running MCP server.

## Scope

M & S single-zone, P-Series, MXZ, and single-phase residential Smart Multi. Three-phase Smart Multi models and dedicated datasets, artwork and code paths have been removed. The importer skips those systems with a warning, and stale outdoor IDs fail evaluation. Mitsubishi does list three-phase equipment with residential indoor-unit compatibility; this project excludes it as a V1 scope decision, not a claim that those applications cannot be residential.

## Remaining limitations

- Branch-box elevations between boxes and between boxes and indoor units are not checked.
- Full shared-controller grouping and M-NET addressing are not modeled.
- Additional refrigerant charge is unavailable for some outdoor units; missing piping inputs can leave charge checks at factory charge only.
- City Multi/VRF, load calculations, partial-load/diversity capacity modes and sensible capacity are outside scope.
- DSB import assumptions need verification against representative actual project files. The missing proprietary template test is skipped; synthetic importer tests run.
- The evaluation API checks request size and shape and returns an error instead of crashing on malformed designs. There is no authentication; rate limiting is left to the host's firewall.

The test suite does not establish engineering certification or agreement with current manufacturer documentation. Before general release, compare representative real designs and boundary cases against current manufacturer tools/manuals: accepted/rejected combinations, controls, accessories, piping, charge, R454B room/mounting requirements, capacities and BOM. Report discrepancies and keep verification notices visible. No claim is made that every manufacturer rule is implemented.

## Maintainer review and reference data

The maintainer confirmed their review and approved public release on October 16, 2026. This records the maintainer's decision; it is not an independent legal opinion, manufacturer approval, or engineering certification.

The bundled equipment JSON is a transformed manufacturer-reference dataset. Decompiled manufacturer source, original installers, raw research extracts and extraction tools are not included. Source and implementation provenance remain documented in the original private development records. See `LICENSE_SCOPE.md` for the boundary between original project work and third-party rights.

The reference snapshot was first recorded on October 15, 2026. The bundled US-market METUS data reports catalog database version 5.14.0.15. This date identifies the recorded snapshot, not a guarantee that every manufacturer specification or rule was current on that day. The app does not automatically update its catalog.

Next.js was updated to 15.5.28 and PostCSS/sharp are pinned to patched versions through pnpm overrides; `pnpm audit --prod` reported no known vulnerabilities on October 16, 2026. Re-run the audit before deploying a fork. Third-party package and asset terms remain applicable.

## Software checks on this fresh snapshot

A frozen-lockfile install succeeded from a new `node_modules` directory. The test suite passed 55 tests with 1 proprietary-template test skipped. Production build and type checks passed; lint reported 7 warnings and no errors. Regression tests cover physical data removal, retained single-phase models, stale outdoor IDs, DSB import exclusions and regeneration filtering. These checks do not replace the manufacturer-result comparisons described above.
