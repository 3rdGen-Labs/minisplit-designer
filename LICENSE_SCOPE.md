# License scope and release status

`LICENSE` uses SPDX identifier **MIT-0** for original project work owned by Devin Osorio. It permits commercial use, modification, redistribution, and removal of UI credits without payment or attribution. See the [OSI license entry](https://opensource.org/license/mit-0). Confirm the named copyright holder owns or is authorized to license the work before release.

This license grants only rights the project author actually holds. It does not relicense dependencies, manufacturer material, third-party artwork, trademarks, or customer data.

The following paths remain **outside the current license grant pending provenance/rights review** and must not be treated as cleared open source:

- `research/`: database extracts, extraction tooling, reverse-engineering notes, and schema research.
- `app/src/data/`: all five generated manufacturer-derived JSON bundles.
- `app/src/lib/engine/`, `app/src/lib/catalog.ts`, and `app/src/lib/dsb-import*`: implementation/data-adapter and interoperability work requiring review against its source material.
- `app/public/brand/`, `app/public/icons/`, `app/src/app/favicon.ico`, and `app/public/units/port-caps.webp`: brand identity and assets whose ownership or source must be established or replaced.

This is a preparation checkout, not yet a completely cleared open source distribution. Remove or replace excluded material, or document an adequate basis for redistribution and update this scope before public release. Simply renaming fields or translating code into prose does not resolve provenance.

Other unit illustrations are described in `design/blender/units.py` as original procedural models. Verify the shipped renders correspond to those original models before release. Dependency packages and starter assets retain their respective licenses; generate and review third-party notices for the exact lockfile used in the public release. Fonts loaded through `next/font` have their own licenses too.

Branding may be removed. No trademark license, endorsement, equipment certification, or manufacturer approval is granted. These scope notes identify rights boundaries; they cannot protect against claims concerning material the author does not own.
