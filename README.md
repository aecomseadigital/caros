# Caros

**Caros is an internal AECOM fork of [goose](https://github.com/aaif-goose/goose),** the
open-source AI agent. It is a modified derivative work distributed under the Apache
License, Version 2.0 — see [`LICENSE`](LICENSE) for the full license text and
[`NOTICE`](NOTICE) for attribution and a summary of changes.

Caros is maintained by AECOM SINGAPORE PTE. LTD. for internal use. 
"goose" and the goose logo are marks of their respective owners; this project is not endorsed by or affiliated with the goose project, the Agentic AI Foundation, or Block, Inc.

## Parody: Caros wins Oscar

**Caros** means "expensive" in Spanish and Italian languages. It is an anagram of **Oscar**, AECOM's internal AI assistant. 
The icon avatar features an otter, which is an iconic wild animal in Singapore.

## Installation (Windows)

Get the latest signed build from the [releases page](https://github.com/aecomseadigital/caros/releases/latest):

- **Installer (recommended)** — [Caros-Setup.exe](https://github.com/aecomseadigital/caros/releases/latest/download/Caros-Setup.exe). A setup wizard that lets you install the **Desktop app**, the **CLI**, or both.
- **Portable desktop** — [Caros-win32-x64.zip](https://github.com/aecomseadigital/caros/releases/latest/download/Caros-win32-x64.zip). Unzip anywhere and run `Caros.exe`; it self-updates from future releases.
- **CLI only** — [caros.exe](https://github.com/aecomseadigital/caros/releases/latest/download/caros.exe). Run `caros.exe login` to sign in, then `caros.exe` to start a session.

All binaries are code-signed and gated behind Microsoft Entra sign-in. macOS and Linux builds are not currently published.

## How Caros differs from goose

Caros keeps goose's core agent engine but replaces the bring-your-own-model setup with a locked, AECOM-managed configuration:

- **Single, locked provider.** Caros talks only to the AECOM **Caros gateway** (Azure OpenAI, `gpt-5.4`) — there is no provider selection or BYOK. The gateway performs server-side model routing (a `mini`/`nano` tier chosen per request), prompt-cache optimisation, and per-user usage logging.
- **Microsoft Entra sign-in.** You sign in with your AECOM account — MSAL in the desktop app, `caros login` (device code) in the CLI — instead of pasting provider API keys. Access is gated by an app role.
- **In-app extension browser.** "Browse extensions" opens a built-in, searchable catalog and installs directly via the `caros://` deep link, rather than linking out to an external docs site.
- **400k context window.** The gateway models expose a 400,000-token input context.
- **AECOM branding.** Caros name, otter icon, and AECOM ownership throughout.

This is a derivative work of goose (Apache 2.0). See [`NOTICE`](NOTICE) for the full, authoritative list of changes.
